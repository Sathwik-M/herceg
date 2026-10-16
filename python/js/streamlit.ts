// The Streamlit component's front end (st.components.v2): draws the chart
// that herceg.streamlit.chart (python/src/herceg/streamlit.py) sends as one
// binary payload, and reports the selection and clicks to the script.
//
// Streamlit calls the default export on every script run, and when the app's
// theme changes, with the same parent element while the component stays on
// the page. A run that sends the same bytes keeps the chart as it is, zoom
// and brush included; new bytes replace it, keeping the zoom and the brush
// where their values (or category labels) still are.

import {
  type AxisInfo,
  type Camera,
  type Chart,
  createChart,
  type PanelInfo,
  type RowSelectionChange,
  RowSet,
  type SelectionStore,
  selectRows,
  showFailure,
  type ThemeName,
  type ThemeSpec,
  type Viewport,
} from "herceg";
import { type ChartSpec, carryNodePositions, loadSpec } from "herceg/spec";
import {
  CAMERAS,
  DRILLS,
  type DrillPayload,
  drillPayload,
  type ItemPositionsPayload,
  inspectionPayload,
  MOVES,
  PLANES,
  positionsValue,
  recordPosition,
  selectionPayload,
  showDrillRoot,
  showItemPositions,
  statePanels,
  targetOf,
  type ViewportPayload,
  viewportPayload,
} from "./events.ts";
import { planeKeys as planeKeysOf } from "./planes.ts";

/** What Streamlit passes the component, as far as it is used here. */
export interface Component {
  data: Uint8Array | null;
  parentElement: HTMLElement | ShadowRoot;
  setStateValue(name: string, value: unknown): void;
  setTriggerValue(name: string, value: unknown): void;
}

type Event = "camera" | "select" | "click" | "rowSelection" | "drill" | "itemMove" | "viewport";

/** The payload's JSON header. */
export interface Header {
  spec: ChartSpec;
  /** Each buffer's byte offset, from the first buffer, and length. */
  buffers: [number, number][];
  /** Events the script reacts to. Others are not sent: each one reruns the script. */
  events: Event[];
  /**
   * Names this payload's data (not how it is drawn), so the script can tell
   * rows selected in it from rows of data it has replaced since.
   */
  epoch?: string;
  itemEpoch?: string;
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
  epoch: string | undefined;
  /** The row selection's stores, by table name. */
  stores: ReadonlyMap<string, SelectionStore>;
  /** What the chart's brush wrote to them, which comes back only with the brush. */
  brushed: WeakSet<object>;
  /** What the script was last sent of each channel, with its epoch, as JSON, by table and channel. */
  reported: Map<string, string>;
  /** The nodes moved, by panel ("" for the chart's one network or its facet panels'). */
  positions: Map<string, ItemPositionsPayload>;
  itemEpoch: string | undefined;
  /** The key of the chart's one map's or network's plane, without subplots (see `planeKeys`). */
  plane: string | undefined;
  /** The keys of the states subplots' trees, networks, and maps have ("" for the chart's one). */
  cameras: string[];
  cameraDefaults: Map<string, string>;
  sentCamera: string;
  drills: string[];
  moves: string[];
  planes: string[];
  /** Each plane's key, by state, which a rerun's must match for it to keep its view. */
  planeKeys: Map<string, string>;
  sentDrill: string;
  sentViewport: string;
  sentPositions: string;
  itemFrame: number | undefined;
  /**
   * While the chart waits for its first scene to restore what the user had,
   * the latest run since (`queued`), which is drawn once it has, as if it
   * had come then.
   */
  waiting?: { queued: Component | undefined } | undefined;
}

const DEFAULT_HEIGHT = 320;
const instances = new WeakMap<object, Instance>();

/** What says a chart could not be shown, by the component's element, until a run shows one. */
const failures = new WeakMap<object, HTMLElement>();

export default function herceg(component: Component): () => void {
  const { parentElement, data } = component;
  if (!data) throw new Error("herceg: the component received no chart");
  failures.get(parentElement)?.remove();
  let instance = instances.get(parentElement);
  if (instance && sameBytes(instance.bytes, data)) {
    instance.component = component;
    // The chart this run sends again is the one to show.
    if (instance.waiting) instance.waiting.queued = undefined;
    followApp(instance);
  } else if (instance?.waiting) {
    // A chart still restoring what the user had takes this run once it has:
    // what it restored is then what this run keeps.
    instance.component = component;
    instance.waiting.queued = component;
  } else {
    try {
      instance = mount(component, data, instance);
    } catch (error) {
      // A spec the engine refuses shows where the chart goes; the stack stays in the console.
      console.error(error);
      instance?.chart.destroy();
      instance?.element.remove();
      instances.delete(parentElement);
      const box = (
        "host" in parentElement ? parentElement.host : parentElement
      ).getBoundingClientRect();
      const failure = showFailure(parentElement, error, false, {
        width: box.width || 640,
        height: DEFAULT_HEIGHT,
      });
      failures.set(parentElement, failure);
      return cleanupOf(parentElement);
    }
    instances.set(parentElement, instance);
  }
  return cleanupOf(parentElement);
}

/**
 * What Streamlit runs, the cleanup it got last, when the component leaves
 * the page: it takes what the component shows then, a chart or a failure,
 * which a queued run may have drawn.
 */
function cleanupOf(parentElement: Component["parentElement"]): () => void {
  return () => {
    failures.get(parentElement)?.remove();
    failures.delete(parentElement);
    const current = instances.get(parentElement);
    if (!current) return;
    if (current.itemFrame !== undefined) cancelAnimationFrame(current.itemFrame);
    current.chart.destroy();
    current.element.remove();
    instances.delete(parentElement);
  };
}

function mount(component: Component, data: Uint8Array, previous: Instance | undefined): Instance {
  const { bytes, header, buffers } = decodePayload(data);
  const { config, stores } = loadSpec(header.spec, buffers);
  // A run that changes how the chart looks, not its data, keeps the rows
  // clicks and lassos selected; a brush's rows come back with the brush.
  const same = previous?.epoch !== undefined && previous.epoch === header.epoch;
  if (same) carryRows(previous!.stores, stores, previous!.brushed);
  const bindings = config.rowSelection?.bindings ?? [];
  const nameOf = (table: unknown) => [...stores].find(([, store]) => store.source === table)?.[0];
  const element = previous?.element ?? component.parentElement.ownerDocument.createElement("div");
  element.style.width = config.width === undefined ? "100%" : `${config.width}px`;
  element.style.height = `${config.height ?? DEFAULT_HEIGHT}px`;
  if (!previous) component.parentElement.append(element);
  const followsApp = header.spec.theme === undefined;
  const theme = followsApp ? appTheme(element) : undefined;
  const kept = previous && keptView(previous.chart, previous, previous.planeKeys);
  if (previous?.itemFrame !== undefined) cancelAnimationFrame(previous.itemFrame);
  const chart = createChart(element, followsApp ? { ...config, theme: appColors(theme) } : config);
  // Networks of the same marks keep their nodes' places, whatever their data now.
  if (previous && header.itemEpoch !== undefined && header.itemEpoch === previous.itemEpoch)
    carryNodePositions(previous.chart, chart);
  previous?.chart.destroy();
  const unbrushed = bindings.map(({ store, channel }) => store.get(channel));
  const cameras = statePanels(config, CAMERAS);
  const cameraDefaults = new Map(
    cameras.map((panel) => [panel, JSON.stringify(chart.getCamera(targetOf(panel)))]),
  );
  if (kept)
    for (const [panel, camera] of kept.cameras)
      if (cameraDefaults.get(panel) === previous?.cameraDefaults.get(panel))
        chart.setCamera(camera, targetOf(panel));
  const drills = statePanels(config, DRILLS);
  const moves = statePanels(config, MOVES);
  const planes = config.panels ? statePanels(config, PLANES) : [];
  const positions = new Map<string, ItemPositionsPayload>();
  const sameItems = header.itemEpoch !== undefined && header.itemEpoch === previous?.itemEpoch;
  const planeKeys = planeKeysOf(config);
  const plane = planeKeys.get("");
  const compatiblePlane = plane === previous?.plane && (plane?.startsWith("map:") || sameItems);
  const brushed = new WeakSet<object>();
  const settle = () => {
    // Networks of the same items keep their nodes' moves, before views and lassos over them.
    if (sameItems)
      for (const panel of moves) {
        const held: ItemPositionsPayload = {};
        positions.set(panel, held);
        showItemPositions(chart, previous!.positions.get(panel) ?? {}, held, true, panel);
      }
    if (kept)
      restore(chart, kept, drills, compatiblePlane ? plane : undefined, planeKeys, sameItems);
    // What the brush wrote as it was restored, before the chart had listeners.
    bindings.forEach(({ store, channel }, i) => {
      const selection = store.get(channel);
      if (selection && selection !== unbrushed[i]) brushed.add(selection);
    });
  };
  // A subplot chart whose first scene waits for its guides has no panels
  // yet: what the user had comes back once it has, and the script hears
  // then what it would have heard now.
  const waiting = config.panels && chart.getPanels().length === 0 ? chart.loading : undefined;
  if (!waiting) settle();
  const instance: Instance = {
    bytes,
    element,
    chart,
    events: header.events,
    followsApp,
    theme,
    component,
    sent: previous?.sent ?? "null",
    epoch: header.epoch,
    stores,
    brushed,
    reported: previous?.reported ?? new Map(),
    positions,
    itemEpoch: header.itemEpoch,
    plane,
    cameras,
    cameraDefaults,
    sentCamera: previous?.sentCamera ?? "null",
    drills,
    moves,
    planes,
    planeKeys,
    // As if nothing were drilled or moved: the script hears of the first change.
    sentDrill:
      previous?.sentDrill ??
      JSON.stringify(Object.fromEntries(drills.map((panel) => [panel, null]))),
    sentViewport: previous?.sentViewport ?? "null",
    sentPositions: previous?.sentPositions ?? movesSent(header.itemEpoch, new Map(), moves),
    itemFrame: undefined,
  };
  chart.on("select", ({ rows }) => {
    for (const { selection } of rows ?? []) if (selection) brushed.add(selection);
    reportSelection(instance);
  });
  chart.on("click", ({ inspection }) => {
    if (!inspection || !instance.events.includes("click")) return;
    instance.component.setTriggerValue("click", inspectionPayload(chart, inspection));
  });
  chart.on("camera", () => reportCamera(instance));
  chart.on("viewport", () => reportViewport(instance));
  chart.on("drill", () => reportDrill(instance));
  chart.on("itemMove", ({ key, position, panels }) => {
    const panel = panels?.[0] ?? "";
    const held = instance.positions.get(panel) ?? {};
    instance.positions.set(panel, held);
    recordPosition(held, key, position);
    instance.itemFrame ??= requestAnimationFrame(() => {
      instance.itemFrame = undefined;
      reportPositions(instance);
    });
  });
  // What the chart's row selection holds, rows by position in this payload's data.
  const reportRows = ({ table, channel, selection }: RowSelectionChange) => {
    if (!instance.events.includes("rowSelection")) return;
    const value = rowsValue(selection);
    instance.reported.set(
      `${nameOf(table)}\u0000${channel}`,
      JSON.stringify([header.epoch, value]),
    );
    instance.component.setStateValue("rows", {
      table: nameOf(table),
      channel,
      epoch: header.epoch,
      selection: value,
    });
  };
  chart.on("rowSelection", reportRows);
  const report = () => {
    // The script hears if the brush could not be kept, or now covers other categories.
    reportSelection(instance);
    reportCamera(instance);
    reportViewport(instance);
    reportDrill(instance);
    reportPositions(instance);
    // A brush kept across a redraw wrote its rows before the chart had
    // listeners, one that could not be kept took its rows with it, and rows
    // or data may have changed while the script did not listen: it hears what
    // the channels hold, as of this payload, unless it was last sent that
    // (the same rows of the same data).
    if (kept)
      for (const { store, channel } of bindings) {
        const selection = store.get(channel);
        const now = JSON.stringify([header.epoch, rowsValue(selection)]);
        const sent = instance.reported.get(`${nameOf(store.source)}\u0000${channel}`);
        if (now !== (sent ?? JSON.stringify([previous?.epoch, null])))
          reportRows({ table: store.source, channel, selection });
      }
  };
  if (!waiting) report();
  else {
    instance.waiting = { queued: undefined };
    waiting.then(
      () => {
        // Unless the page took the chart away.
        if (!chart.root.isConnected) return;
        const queued = instance.waiting?.queued;
        instance.waiting = undefined;
        chart.render();
        settle();
        report();
        // The run that came meanwhile, from what this chart restored.
        if (queued) herceg(queued);
      },
      () => {
        const queued = instance.waiting?.queued;
        instance.waiting = undefined;
        if (queued && chart.root.isConnected) herceg(queued);
      },
    );
  }
  return instance;
}

/** A channel's selection as the script reads it: rows by position, or a condition. */
function rowsValue(selection: RowSelectionChange["selection"]) {
  return selection?.kind === "rows"
    ? { kind: "rows", rows: Array.from(selection.rows.positions()) }
    : selection && { kind: "predicate", expression: selection.expression };
}

type Range = readonly [number, number];

/**
 * Gives new stores of the same data the rows the old ones' channels hold,
 * at the same positions, but for what the old chart's brush wrote, which
 * it writes again where it can be kept.
 */
function carryRows(
  from: ReadonlyMap<string, SelectionStore>,
  to: ReadonlyMap<string, SelectionStore>,
  brushed: WeakSet<object>,
) {
  for (const [name, store] of to) {
    const before = from.get(name);
    for (const channel of before?.channels ?? []) {
      const held = before!.get(channel)!;
      if (held.kind === "rows" && !brushed.has(held))
        store.set(channel, selectRows(new RowSet(store.source).addAll(held.rows.positions())));
    }
  }
}

/** What the user had: each panel's axes and zoom, and the whole selection, more than the script hears of. */
interface Kept {
  plane: { key: string; view: Viewport } | undefined;
  /** Each subplot's map or network's view, and its plane's key (see `planeKeys`). */
  planes: Map<string, { key: string | undefined; view: Viewport }>;
  panels: (PanelInfo & { view: Viewport })[];
  selection: Chart["selection"];
  selectionPanels: Chart["selectionPanels"];
  /** Current cameras by state, kept across reruns with unchanged configured defaults. */
  cameras: Map<string, Camera>;
  /** Each tree's drill root, by panel ("" for the chart's one). */
  drills: Map<string, DrillPayload | null>;
}

function keptView(chart: Chart, instance: Instance, keys: ReadonlyMap<string, string>): Kept {
  const { plane, drills, planes } = instance;
  return {
    cameras: new Map(instance.cameras.map((panel) => [panel, chart.getCamera(targetOf(panel))!])),
    plane: plane ? { key: plane, view: chart.getViewport() } : undefined,
    planes: new Map(
      planes.map((panel) => [panel, { key: keys.get(panel), view: chart.getViewport({ panel }) }]),
    ),
    // Layout planes keep their view separately from panels with axes.
    panels: chart
      .getPanels()
      .filter((panel) => panel.x)
      .map((panel) => ({ ...panel, view: chart.getViewport({ panel: panel.key }) })),
    selection: chart.selection,
    selectionPanels: chart.selectionPanels,
    drills: new Map(
      drills.map((panel) => [panel, drillPayload(chart.getDrillRoot(targetOf(panel)))]),
    ),
  };
}

/**
 * Restores what the user had in a chart just drawn from new bytes, where its
 * values are still shown. The changes are drawn together, on the next frame.
 * Trees keep their roots where the state is still a tree's (`drills`, see
 * `statePanels`); subplots' maps and networks keep their views where the
 * panel's plane has the same key (`keys`), a network's only in the same
 * layout (`layouts`).
 */
function restore(
  chart: Chart,
  kept: Kept,
  drills: readonly string[],
  plane: string | undefined,
  keys: ReadonlyMap<string, string>,
  layouts: boolean,
) {
  for (const [panel, drill] of kept.drills)
    if (drills.includes(panel)) showDrillRoot(chart, drill, true, panel);
  let lassoed: string | undefined;
  for (const [panel, { key, view }] of kept.planes)
    if (key !== undefined && keys.get(panel) === key && (key !== "graph" || layouts)) {
      chart.setViewport(view, { panel });
      if (kept.selectionPanels?.includes(panel)) lassoed = panel;
    }
  // A lasso on a subplot's plane stays there, drawn over its view and positions.
  if (lassoed !== undefined) {
    chart.render();
    chart.select(kept.selection, { panel: lassoed });
  }
  if (plane && kept.plane?.key === plane) {
    chart.setViewport(kept.plane.view);
    // Positions and viewport must be drawn before replaying a lasso's row selection.
    chart.render();
    chart.select(kept.selection);
    return;
  }
  const panels = chart.getPanels().filter((panel) => panel.x);
  // The chart's own view is of the panels sharing x (an inset may come first).
  const shared = <P extends { x?: { group: string } | undefined }>(list: readonly P[]) =>
    list.find(({ x }) => x?.group === "") ?? list[0];
  const first = shared(kept.panels);
  // A panel's x range carries to the panel of the same key; one every panel
  // shares, also to a panel that is new. Panels sharing a scale take the
  // first one's.
  const zoomed = new Set<string>();
  for (const { key, x } of panels) {
    const group = x!.group;
    const before = kept.panels.find((panel) => panel.key === key) ?? (group ? undefined : first);
    if (!before || zoomed.has(group)) continue;
    zoomed.add(group);
    const range = carry(before.view.x, before.x, x);
    if (range) chart.setViewport({ x: range }, { panel: key });
  }
  // Each y axis keeps its range where it can; charts whose panels have y
  // scales of their own have none.
  const now = shared(panels);
  const y: Partial<Viewport> = {};
  if (now?.y?.canSetViewport) y.y = carry(first?.view.y ?? null, first?.y, now.y);
  if (now?.yRight?.canSetViewport)
    y.yRight = carry(first?.view.yRight ?? null, first?.yRight, now.yRight);
  // Without axes, a change names no plane of the subplots'.
  if (Object.keys(y).length > 0) chart.setViewport(y);
  // The selection carries to a panel it was in, through its scales, or to
  // the scale every panel shares.
  const { selection, selectionPanels } = kept;
  const from = kept.panels.find(({ key }) => selectionPanels?.includes(key));
  const at =
    panels.find(({ key }) => selectionPanels?.includes(key)) ??
    panels.find(({ x }) => x!.group === "");
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

/**
 * A range of an old chart's axis on the new chart's: on category axes, where
 * its categories are now; on others, the same values. Null when the axes
 * differ in type or the categories are gone.
 */
function carry(
  range: Range | null,
  from: AxisInfo | undefined,
  to: AxisInfo | undefined,
): Range | null {
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
function sameCategories(from: AxisInfo | undefined, to: AxisInfo | undefined): boolean {
  const [a, b] = [from?.categories, to?.categories];
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((label, i) => label === b[i]);
}

/** Sends the chart's selection to the script, unless the script has it already. */
function reportSelection(instance: Instance) {
  if (!instance.events.includes("select")) return;
  const { chart } = instance;
  const payload = selectionPayload(chart, chart.selection, selectionPanels(instance));
  const sent = JSON.stringify(payload);
  if (sent === instance.sent) return;
  instance.sent = sent;
  instance.component.setStateValue("selection", payload);
}

/**
 * The panels a selection names, as its event does: a subplot's lasso's, or
 * those whose x scale it is on when other panels have others.
 */
function selectionPanels({ chart, planes }: Instance): readonly string[] | undefined {
  const panels = chart.selectionPanels ?? [];
  const [first] = panels;
  if (first === undefined) return undefined;
  const x = chart.getPanels().find(({ key }) => key === first)?.x;
  return (x ? x.group !== "" : planes.includes(first)) ? panels : undefined;
}

/** The chart's one tree's drill root, and each subplot tree's, by panel. */
function reportDrill(instance: Instance) {
  if (!instance.events.includes("drill")) return;
  const { chart } = instance;
  const roots = Object.fromEntries(
    instance.drills.map((panel) => [panel, drillPayload(chart.getDrillRoot(targetOf(panel)))]),
  );
  const sent = JSON.stringify(roots);
  if (sent === instance.sentDrill) return;
  instance.sentDrill = sent;
  instance.component.setStateValue("drill_root", {
    root: roots[""] ?? null,
    panels: Object.fromEntries(Object.entries(roots).filter(([panel]) => panel !== "")),
  });
}

/** The nodes moved of the chart's one network, and of each subplot's, by panel. */
function reportPositions(instance: Instance) {
  if (!instance.events.includes("itemMove")) return;
  const positions = Object.fromEntries(
    instance.moves.map((panel) => [panel, { ...instance.positions.get(panel) }]),
  );
  const sent = movesSent(instance.itemEpoch, instance.positions, instance.moves);
  if (sent === instance.sentPositions) return;
  instance.sentPositions = sent;
  instance.component.setStateValue("item_positions", {
    epoch: instance.itemEpoch,
    positions: positions[""] ?? {},
    panels: Object.fromEntries(Object.entries(positions).filter(([panel]) => panel !== "")),
  });
}

/** What reporting moved nodes sends, as JSON: their layouts' epoch, and each network's moves. */
function movesSent(
  epoch: string | undefined,
  positions: ReadonlyMap<string, ItemPositionsPayload>,
  moves: readonly string[],
): string {
  return JSON.stringify([
    epoch,
    moves.map((panel) => [panel, positionsValue(positions.get(panel) ?? {})]),
  ]);
}

/** Keeps a chart without a theme of its own in the app's theme, which may have changed. */
function followApp(instance: Instance) {
  if (!instance.followsApp) return;
  const theme = appTheme(instance.element);
  if (theme === instance.theme) return;
  instance.theme = theme;
  instance.chart.update({ theme: appColors(theme) });
}

/**
 * The app's light or dark colors (light where it says neither) on its own
 * background, which the chart shows through.
 */
function appColors(theme: ThemeName | undefined): ThemeSpec {
  return { extends: theme ?? "light", tokens: { background: "transparent" } };
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

/**
 * Report the current view only when it changes, with each subplot map's or
 * network's; graph views belong to their layout.
 */
function reportViewport(instance: Instance): void {
  if (!instance.events.includes("viewport")) return;
  const { chart } = instance;
  // The chart's view is of the x scale its panels share. Subplots' maps and
  // networks have views of their own, as panels with x scales of their own
  // (insets, say) do; a chart of nothing else has no view but theirs.
  const axes = chart.getPanels().filter(({ x }) => x);
  const own = axes.length === 0 ? instance.planes.length === 0 : axes.some(({ x }) => !x!.group);
  const view = own ? viewportPayload(chart, chart.getViewport()) : null;
  const panels: Record<string, ViewportPayload> = Object.fromEntries([
    ...instance.planes.map((panel) => [
      panel,
      viewportPayload(chart, chart.getViewport({ panel }), true),
    ]),
    ...axes
      .filter(({ x }) => x!.group)
      .map(({ key }) => [
        key,
        viewportPayload(chart, chart.getViewport({ panel: key }), false, key),
      ]),
  ]);
  const zoomed = view && (view.x || view.y || view.yRight);
  const planes = Object.values(panels).some(({ x, y }) => x || y);
  const payload = {
    ...view,
    ...((instance.plane === "graph" || instance.moves.length > 0) && { epoch: instance.itemEpoch }),
    ...(Object.keys(panels).length > 0 && { panels }),
  };
  const encoded = JSON.stringify(payload);
  if (encoded === instance.sentViewport || (instance.sentViewport === "null" && !zoomed && !planes))
    return;
  instance.sentViewport = encoded;
  instance.component.setStateValue("viewport", payload);
}

/** Current cameras, independent of data epochs; one or a mapping of subplot states. */
function reportCamera(instance: Instance): void {
  if (!instance.events.includes("camera")) return;
  const cameras = Object.fromEntries(
    instance.cameras.map((panel) => [panel, instance.chart.getCamera(targetOf(panel))]),
  );
  const payload = {
    camera: cameras[""],
    panels: Object.fromEntries(Object.entries(cameras).filter(([panel]) => panel !== "")),
  };
  const sent = JSON.stringify(payload);
  if (sent === instance.sentCamera) return;
  instance.sentCamera = sent;
  instance.component.setStateValue("camera", payload);
}
