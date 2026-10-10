// The notebook widget's front end, loaded by anywidget: draws a ChartWidget
// (python/src/herceg/widget.py), applies the updates Python sends, and
// reports interaction back.
//
// A widget shown in several outputs has one view per output. The views share
// the widget's tables and marks, so each update is decoded once and every
// view redraws from the same data.

import {
  type Chart,
  type ChartOptions,
  createChart,
  type DataSelection,
  RowSet,
  type SelectionStore,
  selectRows,
  selectWhere,
  type Table,
} from "herceg";
import {
  type ChartSpec,
  type ColumnSpec,
  type Expression,
  loadSpec,
  type SpecBuffer,
} from "herceg/spec";
import {
  chartSelection,
  chartViewport,
  type DrillPayload,
  drillPayload,
  type ItemPositionsPayload,
  inspectionPayload,
  namesCategories,
  positionsValue,
  recordPosition,
  type SelectionPayload,
  selectionPayload,
  showDrillRoot,
  showItemPositions,
  type ViewportPayload,
  viewportPayload,
} from "./events.ts";
import { mapPlaneKey } from "./planes.ts";
import { resetColumns } from "./tables.ts";

/** The parts of an anywidget model this module uses. */
export interface Model {
  get(name: string): unknown;
  send(content: object, callbacks?: unknown, buffers?: ArrayBuffer[] | ArrayBufferView[]): void;
  on(event: string, callback: (...args: never[]) => void): void;
}

/** Interaction state shared by Python and every display. */
interface ViewStates {
  select: SelectionPayload | null;
  viewport: ViewportPayload | null;
  drill: DrillPayload | null;
  itemMove: ItemPositionsPayload;
}
type ViewEvent = keyof ViewStates;
type ViewState = ViewStates[ViewEvent];
const stateKeys = {
  select: "selection",
  viewport: "viewport",
  drill: "drill_root",
  itemMove: "item_positions",
} as const;

/**
 * A channel's selection between Python and the browser: a condition, or
 * rows, whose positions (Python to the browser) or identities (back) travel
 * as a buffer.
 */
export type RowsPayload =
  | { kind: "predicate"; expression: Expression }
  | { kind: "rows"; rows?: number; generation?: number };

/** What a bound channel holds, as a snapshot restores it. */
export interface HeldRows {
  table: string;
  channel: string;
  selection: RowsPayload | null;
}

/** The whole chart as Python sends it when a browser connects. */
export interface Snapshot {
  /** Counts the changes Python sent; every update carries the next number. */
  revision: number;
  spec: ChartSpec;
  buffers: SpecBuffer[];
  selection: SelectionPayload | null;
  viewport: ViewportPayload | null;
  drill_root: DrillPayload | null;
  item_positions: ItemPositionsPayload;
  /**
   * Per table a row selection binds, how Python numbers its rows: the rows
   * dropped from its front since it was last replaced, and how many times
   * it was. Rows reported to Python are numbered so.
   */
  rows?: Record<string, [number, number]>;
  /** What the bound channels hold, rows indexing `buffers`. */
  rowSelections?: HeldRows[];
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
  | { type: "drill"; drill_root: DrillPayload | null; origin?: string }
  | { type: "itemMove"; item_positions: ItemPositionsPayload; origin?: string }
  | { type: "rows"; table: string; channel: string; selection: RowsPayload | null; origin?: string }
);

interface View {
  host: HTMLElement;
  element: HTMLDivElement;
  chart: Chart | undefined;
  positions: ItemPositionsPayload;
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
  #mapPlane: string | undefined;
  /** The spec's chart options, which option updates change. */
  #options: Record<string, unknown> = {};
  #error: unknown;
  /** Interaction state Python and the browser last agreed on, to drop echoes. */
  #states: ViewStates = { select: null, viewport: null, drill: null, itemMove: {} };
  /** The stores the views' row selections bind, by table name, which the views share. */
  #stores = new Map<string, SelectionStore>();
  /** Python's numbering of each bound table's rows, as of the snapshot (see `Snapshot.rows`). */
  #numbering: Record<string, [number, number]> = {};
  #unsubscribe: (() => void)[] = [];
  /** Applying a row selection from Python, which goes back to no one. */
  #applying = false;
  #itemsFrame: number | undefined;
  #pendingPositions: ItemPositionsPayload | undefined;
  #itemSource: View | undefined;

  constructor(model: Model) {
    this.#model = model;
    // Rows travel as buffers beside the message.
    this.#outbox = new Throttle((content) => {
      const { buffers, ...rest } = content as { buffers?: ArrayBuffer[] };
      model.send(rest, undefined, buffers);
    });
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
    const view: View = { host, element, chart: undefined, positions: {}, error: undefined };
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
    this.#cancelItems();
    this.#outbox.dispose();
    for (const stop of this.#unsubscribe) stop();
  }

  #load(snapshot: Snapshot) {
    this.#revision = snapshot.revision;
    this.#resyncing = false;
    // Views and rows waiting to be reported predate the snapshot's.
    this.#outbox.cancel("select");
    this.#outbox.cancel("viewport");
    this.#outbox.cancel("drill");
    this.#cancelItems();
    this.#outbox.cancelAll("rows:");
    this.#states = {
      select: snapshot.selection,
      viewport: snapshot.viewport,
      drill: snapshot.drill_root,
      itemMove: snapshot.item_positions,
    };
    // Option updates never change the row selection: it binds the tables loaded here.
    const {
      data: _data,
      marks: _marks,
      version: _version,
      facet: _facet,
      panels: _panels,
      grid: _grid,
      rowSelection: _rowSelection,
      ...options
    } = snapshot.spec;
    this.#options = options;
    for (const stop of this.#unsubscribe) stop();
    this.#unsubscribe = [];
    try {
      const loaded = loadSpec(snapshot.spec, snapshot.buffers);
      this.#tables = loaded.tables;
      this.#config = loaded.config;
      this.#stores = loaded.stores;
      this.#error = undefined;
    } catch (error) {
      this.#tables = new Map();
      this.#config = undefined;
      this.#stores = new Map();
      this.#error = error;
    }
    this.#numbering = snapshot.rows ?? {};
    for (const { table, channel, selection } of snapshot.rowSelections ?? []) {
      const rows = selection?.kind === "rows" ? snapshot.buffers[selection.rows!] : undefined;
      this.#setRows(table, channel, selection, rows && view(rows));
    }
    // Changes of the channels by any view go to Python, as Python numbers rows.
    for (const [name, store] of this.#stores) {
      const channels = (this.#config?.rowSelection?.bindings ?? [])
        .filter((binding) => binding.store === store)
        .map(({ channel }) => channel);
      const seen = new Map(channels.map((channel) => [channel, store.get(channel)]));
      this.#unsubscribe.push(
        store.subscribe(() => {
          for (const channel of channels) {
            const now = store.get(channel);
            if (now === seen.get(channel)) continue;
            seen.set(channel, now);
            if (!this.#applying) this.#reportRows(name, channel, now);
          }
        }),
      );
    }
    this.#keepMapView();
  }

  /** Reports a channel's selection to Python: rows by identity, as Python numbers them. */
  #reportRows(name: string, channel: string, selection: DataSelection | null) {
    const table = this.#tables.get(name)!;
    const [dropped, generation] = this.#numbering[name] ?? [0, 0];
    // The revision tells Python which of its changes this one was made after.
    const content = {
      type: "rowSelection",
      table: name,
      channel,
      origin: this.#origin,
      revision: this.#revision,
    };
    if (selection?.kind !== "rows") {
      const payload = selection && { kind: "predicate", expression: selection.expression };
      this.#outbox.post(`rows:${name}:${channel}`, { ...content, selection: payload });
      return;
    }
    const positions = selection.rows.positions();
    // Python numbers rows from the snapshot's first, until a reset numbers them afresh.
    const base = (table.generation === 0 ? dropped : 0) + table.rowOffset;
    const identities = Float64Array.from(positions, (position) => position + base);
    this.#outbox.post(`rows:${name}:${channel}`, {
      ...content,
      selection: { kind: "rows", generation: generation + table.generation },
      buffers: [identities.buffer],
    });
  }

  /** Sets a channel from Python: a condition, rows by position (`rows`), or nothing. */
  #setRows(
    name: string,
    channel: string,
    selection: RowsPayload | null,
    rows: Uint32Array | undefined,
  ) {
    const store = this.#stores.get(name);
    const table = this.#tables.get(name);
    if (!store || !table) return;
    let held: DataSelection | null = null;
    if (selection?.kind === "predicate") held = selectWhere(selection.expression);
    else if (selection?.kind === "rows") held = selectRows(new RowSet(table).addAll(rows ?? []));
    this.#applying = true;
    try {
      store.set(channel, held);
    } finally {
      this.#applying = false;
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
    view.positions = {};
    // Restored before listening, so restoring does not echo back to Python.
    this.#show(view, "viewport", this.#states.viewport);
    this.#show(view, "drill", this.#states.drill, true);
    this.#show(view, "itemMove", this.#states.itemMove, true);
    this.#show(view, "select", this.#states.select);
    chart.on("select", (selection) =>
      this.#report("select", view, selectionPayload(chart, selection)),
    );
    chart.on("viewport", (viewport) =>
      this.#report("viewport", view, viewportPayload(chart, viewport)),
    );
    chart.on("drill", (root) => {
      if (!this.#applying) this.#report("drill", view, drillPayload(root));
    });
    chart.on("itemMove", ({ key, position }) => {
      if (this.#applying) return;
      recordPosition(view.positions, key, position);
      this.#pendingPositions ??= { ...this.#states.itemMove };
      recordPosition(this.#pendingPositions, key, position);
      this.#itemSource = view;
      this.#itemsFrame ??= requestAnimationFrame(() => {
        this.#itemsFrame = undefined;
        const positions = this.#pendingPositions!;
        const source = this.#itemSource!;
        this.#pendingPositions = undefined;
        this.#itemSource = undefined;
        this.#report("itemMove", source, positions);
      });
    });
    chart.on("visibility", () => this.#show(view, "itemMove", this.#states.itemMove, true));
    this.#report("drill", view, drillPayload(chart.drillRoot));
    if (!chart.getHiddenKeys().length) this.#report("itemMove", view, { ...view.positions });
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

  #cancelItems() {
    if (this.#itemsFrame !== undefined) cancelAnimationFrame(this.#itemsFrame);
    this.#itemsFrame = undefined;
    this.#pendingPositions = undefined;
    this.#itemSource = undefined;
    this.#outbox.cancel("itemMove");
  }

  /** A view's interaction state changed: the other views follow, and Python hears of it. */
  #report<K extends ViewEvent>(event: K, source: View | undefined, payload: ViewStates[K]) {
    const same = valuesOf(event, payload) === valuesOf(event, this.#states[event]);
    // The same values, perhaps saying better which axes hold times.
    if (payload || !same) this.#states[event] = payload;
    if (same) return;
    for (const view of this.#views) {
      if (!view.chart || (view === source && event !== "itemMove")) continue;
      try {
        this.#show(view, event, payload, event === "itemMove");
      } catch (error) {
        showError(view, error);
      }
    }
    // The revision tells Python which of its changes this one was made after.
    const value = { [stateKeys[event]]: payload };
    const report = { type: event, ...value, origin: this.#origin, revision: this.#revision };
    this.#outbox.post(event, report);
  }

  /**
   * Shows interaction state in a chart. Category labels are found in
   * the bands of the current data, so the chart first draws any data
   * changes it has not drawn yet. A selection shown here writes no rows:
   * the view brushed wrote them to the stores every view shares.
   */
  #show(view: View, event: ViewEvent, payload: ViewState, restore = false) {
    const chart = view.chart!;
    if (event === "drill" || event === "itemMove") {
      this.#applying = true;
      try {
        if (event === "drill") showDrillRoot(chart, payload as DrillPayload | null, restore);
        else showItemPositions(chart, payload as ItemPositionsPayload, view.positions, restore);
      } finally {
        this.#applying = false;
      }
      return;
    }
    if (event === "select") {
      const selection = payload as SelectionPayload | null;
      if (namesCategories(selection) || selection?.lasso) chart.render();
      chart.select(chartSelection(chart, selection), { rows: false });
      if (selection?.lasso && !selection.categories) this.#learnCategories(chart, selection);
      return;
    }
    const viewport = payload as ViewportPayload | null;
    const labels = [viewport?.x, viewport?.y].some((ends) => typeof ends?.[0] === "string");
    if (labels) chart.render();
    const restored = chartViewport(chart, viewport);
    // Charts whose panels have y scales of their own have no y viewport.
    const [first] = chart.getPanels();
    chart.setViewport({
      x: restored.x,
      y:
        this.#config?.marks.some((mark) =>
          ["geoshape", "geopoint", "graph"].includes(mark.spec.type),
        ) || first?.y?.canSetViewport
          ? restored.y
          : null,
      yRight: first?.yRight?.canSetViewport ? restored.yRight : null,
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
        this.#cancelItems();
        this.#states.itemMove = {};
        for (const view of this.#views) view.positions = {};
        this.#keepMapView();
        this.#keepCategorySelection();
        return;
      }
      case "replace": {
        const table = this.#table(message.table);
        table.reset(resetColumns(table, decode(message.columns, buffers)));
        this.#cancelItems();
        this.#states.itemMove = {};
        for (const view of this.#views) view.positions = {};
        this.#keepMapView();
        this.#keepCategorySelection();
        return;
      }
      case "options":
        this.#updateOptions(message.options);
        return;
      case "rows":
        // A browser's own selection, back from Python: it holds it already.
        if (message.origin === this.#origin) return;
        this.#outbox.cancel(`rows:${message.table}:${message.channel}`);
        this.#setRows(
          message.table,
          message.channel,
          message.selection,
          buffers[0] && view(buffers[0]),
        );
        return;
      case "itemMove": {
        if (message.origin === this.#origin) return;
        this.#cancelItems();
        const known = this.#states.itemMove;
        const next = message.item_positions;
        this.#states.itemMove = next;
        const applied = new Set<string>();
        for (const view of this.#views) {
          if (!view.chart) continue;
          // Another display may have hidden a node. Keep its desired override
          // and apply it when that display shows the node again.
          this.#show(view, "itemMove", next, true);
          for (const key of Object.keys(view.positions)) applied.add(key);
        }
        const unknown = Object.keys(next).filter(
          (key) => !applied.has(key) && !Object.hasOwn(known, key),
        );
        const source = [...this.#views].find((view) => view.chart);
        if (unknown.length && source) {
          const invalid = new Set(unknown);
          const kept = Object.fromEntries(
            Object.entries(next).filter(([key]) => !invalid.has(key)),
          );
          this.#report("itemMove", source, kept);
          throw new Error(
            `widget.item_positions: no displayed node for ${JSON.stringify(unknown[0])}; use a reported item key`,
          );
        }
        return;
      }
      case "select":
      case "viewport":
      case "drill": {
        // This browser's own view, back from Python: it is already drawn,
        // and newer ones may be on their way.
        if (message.origin === this.#origin) return;
        // A view from Python or another browser replaces any not yet reported.
        this.#outbox.cancel(message.type);
        const payload =
          message.type === "select"
            ? message.selection
            : message.type === "viewport"
              ? message.viewport
              : message.drill_root;
        Object.assign(this.#states, { [message.type]: payload });
        // Rows travel apart ("rows"): the browser whose view was brushed wrote
        // them, and Python sets them with `row_selection`.
        for (const view of this.#views) {
          if (!view.chart) continue;
          try {
            this.#show(view, message.type, payload);
          } catch (error) {
            if (message.type !== "drill") throw error;
            this.#report("drill", view, drillPayload(view.chart.drillRoot));
            throw new Error(
              `widget.drill_root: ${error instanceof Error ? error.message : String(error)}; use a reported item key`,
            );
          }
          if (message.type === "drill")
            this.#report("drill", view, drillPayload(view.chart.drillRoot));
        }
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
    for (const view of this.#views) if (view.chart) this.#show(view, "select", selection);
  }

  /** Ranges and lassos belong to the resolved projection, which a data update can change. */
  #keepMapView() {
    const next = this.#config && mapPlaneKey(this.#config);
    const previous = this.#mapPlane;
    this.#mapPlane = next;
    if (previous === undefined || previous === next) return;
    this.#outbox.cancel("viewport");
    this.#outbox.cancel("select");
    this.#report("viewport", undefined, null);
    this.#report("select", undefined, null);
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
    // Checked as loadSpec checks a whole spec, with the same errors.
    const { config } = loadSpec({ ...next, marks: [] } as ChartSpec);
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

/** Rows' positions from Python: little-endian uint32, copied where unaligned. */
function view(buffer: SpecBuffer): Uint32Array {
  const bytes = ArrayBuffer.isView(buffer)
    ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    : new Uint8Array(buffer);
  const aligned = bytes.byteOffset % 4 === 0 ? bytes : bytes.slice();
  return new Uint32Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 4);
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
function valuesOf(event: ViewEvent, state: ViewState): string {
  if (event === "drill") return JSON.stringify(state);
  if (event === "itemMove") return positionsValue(state as ItemPositionsPayload);
  const ranges = state as SelectionPayload | ViewportPayload | null;
  const { x = null, y = null } = ranges ?? {};
  const yRight = ranges && "yRight" in ranges ? ranges.yRight : null;
  const lasso = ranges && "lasso" in ranges ? ranges.lasso : null;
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

  /** Drops the messages of every kind starting with `prefix` still waiting to be sent. */
  cancelAll(prefix: string) {
    for (const kind of [...this.#pending.keys()])
      if (kind.startsWith(prefix)) this.#pending.delete(kind);
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
