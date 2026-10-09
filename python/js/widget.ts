// The notebook widget's front end, loaded by anywidget: draws a ChartWidget
// (python/src/herceg/widget.py), applies the updates Python sends, and
// reports interaction back.
//
// A widget shown in several outputs has one view per output. The views share
// the widget's tables and marks, so each update is decoded once and every
// view redraws from the same data.

import { type Chart, type ChartOptions, createChart, type Table } from "herceg";
import {
  type ChartSpec,
  type ColumnSpec,
  loadSpec,
  SPEC_VERSION,
  type SpecBuffer,
} from "herceg/spec";
import {
  chartSelection,
  chartViewport,
  inspectionPayload,
  namesCategories,
  type SelectionPayload,
  selectionPayload,
  type ViewportPayload,
  viewportPayload,
} from "./events.ts";
import { resetColumns } from "./tables.ts";

/** The parts of an anywidget model this module uses. */
export interface Model {
  get(name: string): unknown;
  send(content: object, callbacks?: unknown, buffers?: ArrayBuffer[] | ArrayBufferView[]): void;
  on(event: string, callback: (...args: never[]) => void): void;
}

/** The events whose state Python keeps: the selection and the viewport. */
type ViewEvent = "select" | "viewport";
type ViewState = SelectionPayload | ViewportPayload | null;

/** The whole chart as Python sends it when a browser connects. */
export interface Snapshot {
  /** Counts the changes Python sent; every update carries the next number. */
  revision: number;
  spec: ChartSpec;
  buffers: SpecBuffer[];
  selection: SelectionPayload | null;
  viewport: ViewportPayload | null;
}

type Columns = Record<string, ColumnSpec>;

/**
 * Updates from Python. Columns index the buffers sent with the message. A
 * selection or viewport comes from Python or, with its `origin`, from a browser.
 */
export type Update = { revision: number } & (
  | { type: "append"; table: string; columns: Columns; maxRows?: number }
  | { type: "replace"; table: string; columns: Columns }
  | { type: "options"; options: Record<string, unknown> }
  | { type: "select"; selection: SelectionPayload | null; origin?: string }
  | { type: "viewport"; viewport: ViewportPayload | null; origin?: string }
);

interface View {
  host: HTMLElement;
  element: HTMLDivElement;
  chart: Chart | undefined;
  /** The last error shown above the chart. */
  error: HTMLElement | undefined;
}

const DEFAULT_HEIGHT = 320;
/** Hover, zoom, and selection reach Python at most this often, the latest last. */
const THROTTLE_MS = 100;

class Widget {
  readonly #model: Model;
  readonly #views = new Set<View>();
  readonly #outbox: Throttle;
  /**
   * Tells this browser's range reports from those of other browsers on the
   * same widget, so Python's broadcast of them does not move this one back.
   */
  readonly #origin = Math.random().toString(36).slice(2);
  #revision = 0;
  /** Waiting for the whole chart after missing an update; updates until then are dropped. */
  #resyncing = false;
  #tables = new Map<string, Table>();
  #config: ChartOptions | undefined;
  /** The spec's chart options, which option updates change. */
  #options: Record<string, unknown> = {};
  #error: unknown;
  /** The selection and viewport Python and the browser last agreed on, to drop echoes. */
  #states: Record<ViewEvent, ViewState> = { select: null, viewport: null };

  constructor(model: Model) {
    this.#model = model;
    this.#outbox = new Throttle((content) => model.send(content));
    this.#load(model.get("_chart") as Snapshot);
    model.on("change:_chart", () => {
      const snapshot = model.get("_chart") as Snapshot;
      // Python sends the chart to every browser when one asks; a browser
      // that has applied as many changes already draws the same chart.
      if (!this.#resyncing && snapshot.revision <= this.#revision) return;
      this.#load(snapshot);
      for (const view of this.#views) this.#mount(view);
    });
    model.on("msg:custom", (message: Update, buffers: DataView[]) =>
      this.#receive(message, buffers ?? []),
    );
    // Python sends the whole chart again if this one is out of date.
    model.send({ type: "ready", revision: this.#revision });
  }

  render(host: HTMLElement): () => void {
    const element = host.ownerDocument.createElement("div");
    const view: View = { host, element, chart: undefined, error: undefined };
    host.append(element);
    this.#views.add(view);
    this.#mount(view);
    return () => {
      view.chart?.destroy();
      view.error?.remove();
      element.remove();
      this.#views.delete(view);
    };
  }

  dispose(): void {
    this.#outbox.dispose();
  }

  #load(snapshot: Snapshot) {
    this.#revision = snapshot.revision;
    this.#resyncing = false;
    // Views waiting to be reported predate the snapshot's.
    this.#outbox.cancel("select");
    this.#outbox.cancel("viewport");
    this.#states = { select: snapshot.selection, viewport: snapshot.viewport };
    const {
      data: _data,
      marks: _marks,
      version: _version,
      facet: _facet,
      panels: _panels,
      grid: _grid,
      ...options
    } = snapshot.spec;
    this.#options = options;
    try {
      const loaded = loadSpec(snapshot.spec, snapshot.buffers);
      this.#tables = loaded.tables;
      this.#config = loaded.config;
      this.#error = undefined;
    } catch (error) {
      this.#tables = new Map();
      this.#config = undefined;
      this.#error = error;
    }
  }

  #mount(view: View) {
    view.chart?.destroy();
    view.chart = undefined;
    view.error?.remove();
    view.element.replaceChildren();
    this.#size(view);
    if (!this.#config) {
      showError(view, this.#error);
      return;
    }
    let chart: Chart;
    try {
      chart = createChart(view.element, this.#config);
    } catch (error) {
      showError(view, error);
      return;
    }
    view.chart = chart;
    // Restored before listening, so restoring does not echo back to Python.
    this.#show(chart, "viewport", this.#states.viewport);
    this.#show(chart, "select", this.#states.select);
    chart.on("select", (selection) =>
      this.#report("select", view, selectionPayload(chart, selection)),
    );
    chart.on("viewport", (viewport) =>
      this.#report("viewport", view, viewportPayload(chart, viewport)),
    );
    // A selection whose categories are gone, or moved under its lasso, goes,
    // and Python hears so.
    if (this.#states.select && !chart.selection) this.#report("select", view, null);
    chart.on("hover", ({ inspection }) => {
      if (!this.#listening("hover")) return;
      this.#outbox.post("hover", {
        type: "hover",
        inspection: inspectionPayload(chart, inspection),
      });
    });
    chart.on("click", ({ inspection }) => {
      if (!inspection || !this.#listening("click")) return;
      this.#model.send({ type: "click", inspection: inspectionPayload(chart, inspection) });
    });
    // A drag turns the camera every frame: Python hears of it at most once a throttle interval.
    chart.on("camera", ({ camera }) => {
      if (this.#listening("camera")) this.#outbox.post("camera", { type: "camera", camera });
    });
  }

  #size({ element }: View) {
    const { width, height } = this.#config ?? {};
    element.style.width = width === undefined ? "100%" : `${width}px`;
    element.style.height = `${height ?? DEFAULT_HEIGHT}px`;
  }

  #listening(event: string): boolean {
    return ((this.#model.get("_listening") as string[] | undefined) ?? []).includes(event);
  }

  /** A view's selection or viewport changed: the other views follow, and Python hears of it. */
  #report(event: ViewEvent, source: View, payload: ViewState) {
    const same = valuesOf(payload) === valuesOf(this.#states[event]);
    // The same values, perhaps saying better which axes hold times.
    if (payload || !same) this.#states[event] = payload;
    if (same) return;
    for (const view of this.#views)
      if (view !== source && view.chart) this.#show(view.chart, event, payload);
    // The revision tells Python which of its changes this one was made after.
    const value = event === "select" ? { selection: payload } : { viewport: payload };
    const report = { type: event, ...value, origin: this.#origin, revision: this.#revision };
    this.#outbox.post(event, report);
  }

  /**
   * Shows a selection or viewport in a chart. Category labels are found in
   * the bands of the current data, so the chart first draws any data
   * changes it has not drawn yet.
   */
  #show(chart: Chart, event: ViewEvent, payload: ViewState) {
    if (event === "select") {
      const selection = payload as SelectionPayload | null;
      if (namesCategories(selection) || selection?.lasso) chart.render();
      chart.select(chartSelection(chart, selection));
      if (selection?.lasso && !selection.categories) this.#learnCategories(chart, selection);
      return;
    }
    const viewport = payload as ViewportPayload | null;
    const labels = [viewport?.x, viewport?.y].some((ends) => typeof ends?.[0] === "string");
    if (labels) chart.render();
    const view = chartViewport(chart, viewport);
    // Charts whose panels have y scales of their own have no y viewport.
    const [first] = chart.getPanels();
    chart.setViewport({
      x: view.x,
      y: first?.y?.canSetViewport ? view.y : null,
      yRight: first?.yRight?.canSetViewport ? view.yRight : null,
    });
  }

  /**
   * A lasso from Python is over the categories a chart draws when it first
   * shows it: they are kept with it, here and in Python, so that it goes
   * when they move.
   */
  #learnCategories(chart: Chart, selection: SelectionPayload) {
    const categories = selectionPayload(chart, chart.selection)?.categories;
    if (!categories) return;
    const known = { ...selection, categories };
    this.#states.select = known;
    const report = { type: "select", selection: known, origin: this.#origin };
    this.#outbox.post("select", { ...report, revision: this.#revision });
  }

  #receive(message: Update, buffers: readonly DataView[]) {
    // Already applied: a duplicate.
    if (this.#resyncing || message.revision <= this.#revision) return;
    if (message.revision > this.#revision + 1) {
      // An update was missed (this browser connected after it was sent, say).
      this.#resyncing = true;
      this.#model.send({ type: "resync" });
      return;
    }
    this.#revision = message.revision;
    try {
      this.#apply(message, buffers);
    } catch (error) {
      console.error("herceg: could not apply an update from Python", error);
      for (const view of this.#views) showError(view, error);
    }
  }

  #apply(message: Update, buffers: readonly DataView[]) {
    switch (message.type) {
      case "append": {
        const table = this.#table(message.table);
        table.append(appendBatch(table, decode(message.columns, buffers)));
        const excess = message.maxRows === undefined ? 0 : table.length - message.maxRows;
        if (excess > 0) table.dropFirst(excess);
        this.#keepCategorySelection();
        return;
      }
      case "replace": {
        const table = this.#table(message.table);
        table.reset(resetColumns(table, decode(message.columns, buffers)));
        this.#keepCategorySelection();
        return;
      }
      case "options":
        this.#updateOptions(message.options);
        return;
      case "select":
      case "viewport": {
        // This browser's own view, back from Python: it is already drawn,
        // and newer ones may be on their way.
        if (message.origin === this.#origin) return;
        // A view from Python or another browser replaces any not yet reported.
        this.#outbox.cancel(message.type);
        const payload = message.type === "select" ? message.selection : message.viewport;
        this.#states[message.type] = payload;
        for (const view of this.#views)
          if (view.chart) this.#show(view.chart, message.type, payload);
        return;
      }
    }
  }

  /**
   * A selection on a category axis is its labels: when the data changes, the
   * brush moves to where they are now, or goes (and Python hears so) when
   * they are gone. A lasso's outline is in band positions, so it goes when
   * the categories change.
   */
  #keepCategorySelection() {
    const selection = this.#states.select as SelectionPayload | null;
    if (!namesCategories(selection)) return;
    for (const { chart } of this.#views) if (chart) this.#show(chart, "select", selection);
  }

  #table(name: string): Table {
    const table = this.#tables.get(name);
    if (!table) throw new Error(`The chart has no table named "${name}"`);
    return table;
  }

  /** Changes chart options; null removes one. */
  #updateOptions(changes: Record<string, unknown>) {
    const next = { ...this.#options };
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) delete next[key];
      else next[key] = value;
    }
    if (!this.#config) throw new Error("the chart did not load");
    // Checked as loadSpec checks a whole spec, with the same errors; Python
    // writes the current version, so options of any version are allowed.
    const { config } = loadSpec({ version: SPEC_VERSION, ...next, marks: [] } as ChartSpec);
    const update = Object.fromEntries(
      Object.keys(changes).map((key) => [key, (config as Record<string, unknown>)[key]]),
    ) as Partial<ChartOptions>;
    this.#options = next;
    this.#config = { ...this.#config, ...update };
    for (const view of this.#views) {
      view.chart?.update(update);
      this.#size(view);
      // Drawn at once: views shown next read the panels' axes as drawn,
      // which options such as `resolve` change.
      view.chart?.render();
    }
  }
}

/** Columns of an update, read like a spec's table: checked, and viewed without copying. */
function decode(columns: Columns, buffers: readonly DataView[]): Table {
  return loadSpec({ data: { rows: { columns } }, marks: [] }, buffers).tables.get("rows")!;
}

/**
 * Records keyed by field have no prototype, so fields such as "__proto__"
 * stay ordinary keys.
 */
function fieldRecord(): Record<string, unknown> {
  return Object.create(null);
}

/** Appended values per field; categories as labels, since codes index the update's dictionary. */
function appendBatch(table: Table, rows: Table): Parameters<Table["append"]>[0] {
  const batch = fieldRecord();
  for (const field of table.fields()) {
    // Python sends tables of shapes whole (replace), never appended.
    if (table.kind(field) === "geometry") throw new Error(`Field "${field}" holds shapes`);
    if (table.kind(field) !== "category") {
      batch[field] = rows.numbers(field);
      continue;
    }
    const { codes, dictionary } = rows.categories(field);
    batch[field] = Array.from(codes, (code) => (code < 0 ? null : dictionary[code]!));
  }
  return batch as Parameters<Table["append"]>[0];
}

/**
 * A selection's or viewport's values, whichever axes hold times: equal for
 * an echo of the same state. A viewport of no zoom is no viewport.
 */
function valuesOf(state: ViewState): string {
  const { x = null, y = null } = state ?? {};
  const yRight = state && "yRight" in state ? state.yRight : null;
  const lasso = state && "lasso" in state ? state.lasso : null;
  return JSON.stringify([x, y, yRight, lasso]);
}

function showError(view: View, error: unknown) {
  view.error?.remove();
  const message = view.host.ownerDocument.createElement("pre");
  message.setAttribute("role", "alert");
  message.style.cssText = "color:#b3261e;white-space:pre-wrap;margin:4px 0";
  message.textContent = `herceg: ${error instanceof Error ? error.message : String(error)}`;
  view.host.prepend(message);
  view.error = message;
}

/** Sends each kind of message at most every THROTTLE_MS, always ending with the latest. */
class Throttle {
  readonly #send: (content: object) => void;
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly #pending = new Map<string, object>();

  constructor(send: (content: object) => void) {
    this.#send = send;
  }

  post(kind: string, content: object) {
    if (this.#timers.has(kind)) {
      this.#pending.set(kind, content);
      return;
    }
    this.#send(content);
    this.#timers.set(
      kind,
      setTimeout(() => {
        this.#timers.delete(kind);
        const latest = this.#pending.get(kind);
        this.#pending.delete(kind);
        if (latest) this.post(kind, latest);
      }, THROTTLE_MS),
    );
  }

  /** Drops a message of this kind still waiting to be sent. */
  cancel(kind: string) {
    this.#pending.delete(kind);
  }

  dispose() {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    this.#pending.clear();
  }
}

/**
 * anywidget calls this once per widget, so the views of a widget share one
 * Widget: `initialize` runs first, then `render` for each output.
 */
export default () => {
  let widget: Widget | undefined;
  return {
    initialize({ model }: { model: Model }) {
      widget = new Widget(model);
      return () => widget?.dispose();
    },
    render({ model, el }: { model: Model; el: HTMLElement }) {
      widget ??= new Widget(model);
      return widget.render(el);
    },
  };
};
