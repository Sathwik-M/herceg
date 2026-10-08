// The Streamlit component's front end (st.components.v2): draws the chart
// that herceg.streamlit.chart (python/src/herceg/streamlit.py) sends as one
// binary payload, and reports the brushed range and clicks to the script.
//
// Streamlit calls the default export on every script run, and when the app's
// theme changes, with the same parent element while the component stays on
// the page. A run that sends the same bytes keeps the chart as it is, zoom
// and brush included; new bytes replace it, keeping the zoom, and the brush
// where its values (or category labels) still are.

import { type Chart, createChart, type ThemeName } from "herceg";
import { type ChartSpec, loadSpec } from "herceg/spec";
import { chartRange, inspectionPayload, rangePayload } from "./events.ts";

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
  // What the user had: the zoom, and the brush as values or category labels,
  // which may sit at other positions in the new data.
  const kept = previous && {
    scale: previous.chart.model.xScale()?.type,
    viewport: previous.chart.model.viewport,
    selection: rangePayload(previous.chart, previous.chart.selection),
  };
  previous?.chart.destroy();
  const chart = createChart(element, theme ? { ...config, theme } : config);
  if (kept && kept.scale === chart.model.xScale()?.type) {
    chart.setViewport(kept.viewport);
    chart.select(chartRange(chart, kept.selection?.x ?? null));
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

/** Sends the chart's selection to the script, unless the script has it already. */
function reportSelection(instance: Instance) {
  if (!instance.events.includes("select")) return;
  const payload = rangePayload(instance.chart, instance.chart.selection);
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
