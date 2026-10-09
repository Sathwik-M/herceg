// The Streamlit component's front end (st.components.v2): draws the chart
// that herceg.streamlit.chart (python/src/herceg/streamlit.py) sends as one
// binary payload, and reports the brushed range and clicks to the script.
//
// Streamlit calls the default export on every script run, and when the app's
// theme changes, with the same parent element while the component stays on
// the page. A run that sends the same bytes keeps the chart as it is, zoom
// and brush included; new bytes replace it, keeping the zoom and the brush
// where their values (or category labels) still are.

import { type Chart, createChart, type ThemeName } from "herceg";
import { type ChartSpec, loadSpec } from "herceg/spec";
import { inspectionPayload, rangePayload } from "./events.ts";

/** What Streamlit passes the component, as far as it is used here. */
export interface Component {
  data: Uint8Array | null;
  parentElement: HTMLElement | ShadowRoot;
  setStateValue(name: string, value: unknown): void;
  setTriggerValue(name: string, value: unknown): void;
}

type Event = "select" | "click";

/** The payload's JSON header. */
export interface Header {
  spec: ChartSpec;
  /** Each buffer's byte offset, from the first buffer, and length. */
  buffers: [number, number][];
  /** Events the script reacts to. Others are not sent: each one reruns the script. */
  events: Event[];
}

interface Instance {
  bytes: Uint8Array;
  element: HTMLDivElement;
  chart: Chart;
  events: Event[];
  /** Whether the chart takes the app's light or dark theme, having none of its own. */
  followsApp: boolean;
  theme: ThemeName | undefined;
  /** Streamlit hands over new callbacks on every run; the latest are used. */
  component: Component;
  /** The selection last sent, as JSON: an unchanged one would rerun the script for nothing. */
  sent: string;
}

const DEFAULT_HEIGHT = 320;
const instances = new WeakMap<object, Instance>();

export default function herceg(component: Component): () => void {
  const { parentElement, data } = component;
  if (!data) throw new Error("herceg: the component received no chart");
  let instance = instances.get(parentElement);
  if (instance && sameBytes(instance.bytes, data)) {
    instance.component = component;
    followApp(instance);
  } else {
    instance = mount(component, data, instance);
    instances.set(parentElement, instance);
  }
  // Streamlit runs the cleanup it got last, when the component leaves the page.
  const current = instance;
  return () => {
    current.chart.destroy();
    current.element.remove();
    if (instances.get(parentElement) === current) instances.delete(parentElement);
  };
}

function mount(component: Component, data: Uint8Array, previous: Instance | undefined): Instance {
  const { bytes, header, buffers } = decodePayload(data);
  const { config } = loadSpec(header.spec, buffers);
  const element = previous?.element ?? component.parentElement.ownerDocument.createElement("div");
  element.style.width = config.width === undefined ? "100%" : `${config.width}px`;
  element.style.height = `${config.height ?? DEFAULT_HEIGHT}px`;
  if (!previous) component.parentElement.append(element);
  const followsApp = header.spec.theme === undefined;
  const theme = followsApp ? appTheme(element) : undefined;
  // What the user had: each panel's zoom and the whole selection, more than
  // the script hears of.
  const kept = previous && {
    panels: previous.chart.model.panels().map(({ key, x, y }) => ({
      key,
      x,
      y,
      viewport: previous.chart.model.viewportOf(key),
    })),
    yRight: previous.chart.model.yRightScale(),
    yViewport: previous.chart.model.yViewport,
    selection: previous.chart.selection,
    selectionPanels: previous.chart.selectionPanels,
  };
  previous?.chart.destroy();
  const chart = createChart(element, theme ? { ...config, theme } : config);
  if (kept) {
    const { model } = chart;
    const panels = model.panels();
    const [first] = kept.panels;
    // A panel's x range carries to the panel of the same key; one every panel
    // shares, also to a panel that is new. Panels sharing a scale take the
    // first one's. Set on the model, nothing is drawn yet: setYViewport
    // below draws them all at once.
    const zoomed = new Set<string>();
    for (const { key, x: scale, xGroup } of panels) {
      const before =
        kept.panels.find((panel) => panel.key === key) ?? (model.sharesX ? first : undefined);
      if (!before || zoomed.has(xGroup)) continue;
      zoomed.add(xGroup);
      const range = carry(before.viewport, before.x, scale);
      if (range) model.setViewport(range, key);
    }
    const y = (range: Range | null) => carry(range, first?.y, model.yScale());
    const left = y(kept.yViewport?.y ?? null);
    const right = carry(kept.yViewport?.yRight ?? null, kept.yRight, model.yRightScale());
    // Both axes keep their ranges, or neither: one alone would show other values.
    chart.setYViewport(
      left && (!kept.yViewport?.yRight || right) ? left : null,
      right ?? undefined,
    );
    // The selection carries to a panel it was in, through its scales, or to
    // the scale every panel shares.
    const { selection, selectionPanels } = kept;
    const from = kept.panels.find(({ key }) => selectionPanels?.includes(key));
    const at =
      panels.find(({ key }) => selectionPanels?.includes(key)) ??
      (model.sharesX ? panels[0] : undefined);
    const next = selection &&
      from &&
      at && {
        x: carry(selection.x, from.x, at.x),
        y: carry(selection.y, from.y, at.y),
        lasso: selection.lasso,
      };
    // A selection keeps all its ranges or goes: part of a rectangle is another
    // selection. A lasso's outline cannot follow categories that moved.
    const whole = next && (!selection.x || next.x) && (!selection.y || next.y);
    const moved =
      selection?.lasso && (!sameCategories(from?.x, at?.x) || !sameCategories(from?.y, at?.y));
    if (whole && !moved) chart.select(next, { panel: at!.key });
  }
  const instance: Instance = {
    bytes,
    element,
    chart,
    events: header.events,
    followsApp,
    theme,
    component,
    sent: previous?.sent ?? "null",
  };
  // The script hears if the brush could not be kept, or now covers other categories.
  reportSelection(instance);
  chart.on("select", () => reportSelection(instance));
  chart.on("click", ({ inspection }) => {
    if (!inspection || !instance.events.includes("click")) return;
    instance.component.setTriggerValue("click", inspectionPayload(chart, inspection));
  });
  return instance;
}

type Range = readonly [number, number];
/** What `carry` reads of an axis' scale. */
type Axis = { type: string; categories?: readonly string[] } | undefined;

/**
 * A range of an old chart's axis on the new chart's: on category axes, where
 * its categories are now; on others, the same values. Null when the axes
 * differ in type or the categories are gone.
 */
function carry(range: Range | null, from: Axis, to: Axis): Range | null {
  if (!range || !from || !to || from.type !== to.type) return null;
  const before = from.categories;
  const after = to.categories;
  if (!before || !after) return range;
  const at = (index: number) => {
    const label = before[Math.round(index)];
    return label === undefined ? -1 : after.indexOf(label);
  };
  const [start, end] = [at(range[0]), at(range[1])];
  return start >= 0 && end >= 0 ? [start, end] : null;
}

/** Whether two axes have the same categories in the same order, or none. */
function sameCategories(from: Axis, to: Axis): boolean {
  const [a, b] = [from?.categories, to?.categories];
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((label, i) => label === b[i]);
}

/** Sends the chart's selection to the script, unless the script has it already. */
function reportSelection(instance: Instance) {
  if (!instance.events.includes("select")) return;
  const payload = rangePayload(instance.chart, instance.chart.selection?.x ?? null);
  const sent = JSON.stringify(payload);
  if (sent === instance.sent) return;
  instance.sent = sent;
  instance.component.setStateValue("selection", payload);
}

/** Keeps a chart without a theme of its own in the app's theme, which may have changed. */
function followApp(instance: Instance) {
  if (!instance.followsApp) return;
  const theme = appTheme(instance.element);
  if (theme === instance.theme) return;
  instance.theme = theme;
  instance.chart.update({ theme: theme ?? "light" });
}

/**
 * The app's theme, from the background color Streamlit gives components as
 * a CSS variable; undefined outside Streamlit. Python cannot tell reliably:
 * `st.context.theme` may be unknown on the first run.
 */
function appTheme(element: HTMLElement): ThemeName | undefined {
  const background = getComputedStyle(element).getPropertyValue("--st-background-color").trim();
  if (!background) return undefined;
  // The browser resolves any CSS color to rgb() on an element.
  const probe = element.ownerDocument.createElement("span");
  probe.style.color = background;
  element.append(probe);
  const [r = 255, g = 255, b = 255] = (getComputedStyle(probe).color.match(/[\d.]+/g) ?? []).map(
    Number,
  );
  probe.remove();
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128 ? "dark" : "light";
}

/**
 * Splits a payload: a little-endian uint32 header length, the JSON header,
 * and the buffers from the next multiple of 8 bytes, each at an 8-byte
 * aligned offset so typed arrays view them in place.
 */
export function decodePayload(data: Uint8Array): {
  bytes: Uint8Array;
  header: Header;
  buffers: Uint8Array[];
} {
  // Streamlit hands over a view into a larger message, at any offset; one
  // copy aligns it.
  const bytes = data.byteOffset % 8 === 0 ? data : data.slice();
  const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + length))) as Header;
  const start = Math.ceil((4 + length) / 8) * 8;
  const buffers = header.buffers.map(([offset, size]) =>
    bytes.subarray(start + offset, start + offset + size),
  );
  return { bytes, header, buffers };
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
