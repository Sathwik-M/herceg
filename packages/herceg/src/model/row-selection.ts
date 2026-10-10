// Row selection: a chart bound to channels of selection stores writes the
// rows its brushes, lassos, and clicks select there, and highlights the
// rows each channel holds, whoever selected them (another chart, a grid).
// The chart's own selection (`chart.selection`, the `select` event) stays
// in data values as before; this adds the rows it covers. Which rows a
// gesture selects is selected-rows.ts's; how they are drawn, highlight.ts's.

import { compileExpression } from "../data/expression.ts";
import { RowSet } from "../data/row-set.ts";
import { type DataSelection, type SelectionStore, selectRows } from "../data/selection.ts";
import type { Schema, Table } from "../data/table.ts";
import type { LayoutMark } from "../marks/layout-mark.ts";
import type { Mark } from "../marks/mark.ts";
import type { BrushSpec, SelectionGesture } from "../spec/spec.ts";
import { Highlighter } from "./highlight.ts";
import type { ChartConfig, ChartModel } from "./model.ts";
import {
  type Brushed,
  brushedRows,
  clickedRows,
  cursorRows,
  type PointRows,
} from "./selected-rows.ts";

/** A chart's binding to a channel of a table's selection store. */
export interface SelectionBinding<S extends Schema = Schema> {
  /** The store of the table whose rows the chart selects and highlights. */
  store: SelectionStore<S>;
  /** The store's channel the chart writes its selections to and highlights. */
  channel: string;
  /**
   * The gestures that write to the channel: all three by default; none
   * (`[]`) for a chart that only highlights. Brushes and lassos write where
   * `interaction.brush` draws them, and a brush that writes rows never zooms.
   */
  events?: readonly SelectionGesture[];
  /** "highlight" (the default) dims the rows the channel does not hold; "none" leaves them. */
  effect?: "highlight" | "none";
}

/**
 * What a chart wrote to a channel of a store it is bound to, or found
 * there: the table, the channel, and the selection, null when cleared.
 */
export interface RowSelectionChange {
  table: Table;
  channel: string;
  selection: DataSelection | null;
}

/** The modifier keys of a click or key press, as DOM events carry them. */
export interface Modifiers {
  readonly shiftKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** A key press, as DOM keyboard events carry it. */
export interface KeyPress extends Modifiers {
  readonly key: string;
  readonly target: unknown;
  preventDefault(): void;
}

/**
 * What a bound chart lends its row selection: its brushed selection, which
 * goes when the rows it wrote are replaced, its root element, whose keys
 * select rows under the keyboard cursor, and `render`, which draws pending
 * changes before a key reads what the chart shows.
 */
export interface BrushedChart {
  readonly selection: Brushed | null;
  select(selection: null): void;
  render(): void;
  readonly root: {
    addEventListener(type: "keydown", listener: (event: KeyPress) => void): void;
    removeEventListener(type: "keydown", listener: (event: KeyPress) => void): void;
  };
}

/** Where the keyboard cursor is: a panel, a series' key, and a position in the series' part there. */
export interface Cursor {
  readonly panel: string;
  readonly key: string;
  readonly position: number;
}

/** Reports changes of the bound channels as a chart's `rowSelection` events. */
interface Reporter {
  emit(type: "rowSelection", change: RowSelectionChange): void;
}

/** A binding with its defaults filled in. */
interface Bound {
  store: SelectionStore;
  table: Table;
  channel: string;
  events: ReadonlySet<SelectionGesture>;
  highlight: boolean;
}

const GESTURES: readonly SelectionGesture[] = ["brush", "lasso", "click"];

/**
 * Binds a chart to channels of selection stores, one per table its marks
 * read, for the chart's `rowSelection` option. A brush selects the rows
 * whose values are in its ranges, as a condition that rows appended later
 * meet or not; lassos and clicks select rows (a click on a histogram bin,
 * the rows it counts). The chart dims the rows the channel does not hold.
 *
 * ```ts
 * const focus = selectionStore(trips);
 * createChart(a, {
 *   marks: [point(trips, { x: "distance", y: "fare" })],
 *   interaction: { brush: "xy" },
 *   rowSelection: rowSelection({ store: focus, channel: "focus" }),
 * });
 * createGrid(b, { data: rowView(trips), columns, selection: focus, channel: "focus" });
 * ```
 */
export function rowSelection<const S extends readonly Schema[]>(
  ...bindings: { [K in keyof S]: SelectionBinding<S[K]> }
): RowSelection {
  // Each table's schema types its own binding; the chart reads them alike.
  return new RowSelection(bindings as unknown as readonly SelectionBinding[]);
}

/** Identities of stores, which say whether two row selections bind the same ones. */
const storeIds = new WeakMap<SelectionStore, number>();

export class RowSelection {
  readonly bindings: readonly Readonly<Required<SelectionBinding>>[];
  readonly #bound: readonly Bound[];

  constructor(bindings: readonly SelectionBinding[]) {
    if (bindings.length === 0) throw new Error("rowSelection needs a binding: { store, channel }");
    this.bindings = bindings.map(({ store, channel, events = GESTURES, effect = "highlight" }) => {
      if (typeof store?.get !== "function" || !store.source)
        throw new TypeError(
          "A row selection's store must be a SelectionStore (selectionStore(table))",
        );
      if (typeof channel !== "string" || channel === "")
        throw new TypeError("A row selection's channel must be a name");
      for (const event of events)
        if (!GESTURES.includes(event))
          throw new TypeError(
            `A row selection's events are "brush", "lasso", and "click", not ${JSON.stringify(event)}`,
          );
      if (effect !== "highlight" && effect !== "none")
        throw new TypeError(
          `A row selection's effect is "highlight" or "none", not ${JSON.stringify(effect)}`,
        );
      return Object.freeze({ store, channel, events: Object.freeze([...events]), effect });
    });
    this.#bound = this.bindings.map(({ store, channel, events, effect }) => ({
      store,
      table: store.source,
      channel,
      events: new Set(events),
      highlight: effect === "highlight",
    }));
    const tables = this.#bound.map(({ table }) => table);
    if (tables.some((table, i) => tables.indexOf(table) !== i))
      throw new Error(
        "A row selection binds each table once: give it one store and channel per table",
      );
  }

  /**
   * Refuses charts whose rows cannot be selected yet: layout marks (pies,
   * maps, 3D charts), stores of tables no mark reads, and brushes along an
   * axis of statistics (a histogram's counts, a box plot's values) or
   * lassos over them.
   */
  check(config: ChartConfig, marks: readonly Mark[], layouts: readonly LayoutMark[]): void {
    const [layout] = layouts;
    if (layout)
      throw new Error(
        `Charts of a ${layout.spec.type} mark cannot select rows yet: rowSelection needs marks along x and y axes`,
      );
    const brush = config.interaction?.brush;
    for (const bound of this.#bound) {
      const own = marks.filter((mark) => mark.table === bound.table);
      if (own.length === 0)
        throw new Error(
          `The store bound to channel "${bound.channel}" is of a table no mark of the chart reads`,
        );
      if (brush && bound.events.has(brush === "lasso" ? "lasso" : "brush"))
        for (const mark of own) refuseBrush(mark, brush);
    }
  }

  /**
   * The row selection of a mounted chart: `current`, the chart's so far,
   * when it is this one's, or else a new one. `events` reports changes of
   * the channels, `invalidate` redraws the chart, `cursor` says where its
   * keyboard cursor is, and `live` announces what the keyboard selected.
   */
  mount(
    current: RowLink | undefined,
    model: ChartModel,
    chart: BrushedChart,
    events: Reporter,
    invalidate: () => void,
    cursor: () => Cursor | null,
    live: { textContent: string | null },
  ): RowLink {
    if (current?.selection === this) return current;
    const link = new RowLink(this, this.#bound, model, chart, events, invalidate, cursor, live);
    if (current) link.adopt(current);
    current?.dispose();
    return link;
  }

  /**
   * Framework adapters compare options as JSON: a row selection is the
   * same while it binds the same stores (by identity), channels, events, and effects.
   */
  toJSON(): unknown {
    return this.bindings.map(({ store, channel, events, effect }) => {
      let id = storeIds.get(store);
      if (id === undefined) {
        id = nextStore++;
        storeIds.set(store, id);
      }
      return [id, channel, events, effect];
    });
  }
}

let nextStore = 0;

/** Brushes along an axis of a summary's statistics, and lassos over summaries, select no rows yet. */
function refuseBrush(mark: Mark, brush: BrushSpec) {
  const type = mark.spec.type;
  if (brush === "lasso" && mark.summarizes)
    throw new Error(
      `Lassos cannot select the rows of ${type} marks yet; leave "lasso" out of the row selection's events`,
    );
  if (!mark.summarizes) return;
  // A summary's values axis holds statistics: a histogram's counts, a box plot's quartiles.
  const values = mark.tooltip === "y" ? "x" : "y";
  if (brush === values || brush === "xy")
    throw new Error(
      `A ${type} mark's rows are brushed along its ${values === "y" ? "x" : "y"} axis only: its ${values} axis holds statistics`,
    );
}

/** How a click or key changes a channel: select only what it is on, add it, or add it or take it out. */
type Mode = "only" | "add" | "toggle";

function modeOf(keys: Modifiers): Mode {
  return keys.shiftKey ? "add" : keys.ctrlKey || keys.metaKey ? "toggle" : "only";
}

/**
 * A mounted chart's row selection: it writes what the chart's gestures
 * select to the bound channels and redraws the chart when a channel it
 * highlights changes. The chart calls it as gestures end.
 */
export class RowLink {
  readonly selection: RowSelection;
  readonly #bound: readonly Bound[];
  readonly #model: ChartModel;
  readonly #chart: BrushedChart;
  readonly #events: Reporter;
  readonly #invalidate: () => void;
  readonly #cursor: () => Cursor | null;
  readonly #live: { textContent: string | null };
  /**
   * What each channel held when last seen, and its row set's version, so
   * each change is reported once, also of a set changed in place.
   */
  readonly #seen = new Map<Bound, { selection: DataSelection | null; version: number }>();
  /** What the chart's brush wrote, which clearing the brush clears while the channel still holds it. */
  readonly #brushed = new Map<Bound, DataSelection>();
  readonly #stops: (() => void)[] = [];
  readonly #highlight: ChartModel["highlight"];
  /** How deep in writes of the chart's own selections, which leave its brush in place. */
  #writing = 0;
  #disposed = false;

  constructor(
    selection: RowSelection,
    bound: readonly Bound[],
    model: ChartModel,
    chart: BrushedChart,
    events: Reporter,
    invalidate: () => void,
    cursor: () => Cursor | null,
    live: { textContent: string | null },
  ) {
    this.selection = selection;
    this.#bound = bound;
    this.#model = model;
    this.#chart = chart;
    this.#events = events;
    this.#invalidate = invalidate;
    this.#cursor = cursor;
    this.#live = live;
    for (const b of bound) this.#seen.set(b, seen(b.store.get(b.channel)));
    for (const store of new Set(bound.map((b) => b.store)))
      this.#stops.push(store.subscribe(() => this.#changed(store)));
    // After the chart's own key handling, which moves the cursor and clears its brush on Escape.
    const keys = (event: KeyPress) => this.#key(event);
    chart.root.addEventListener("keydown", keys);
    this.#stops.push(() => chart.root.removeEventListener("keydown", keys));
    const highlighted = bound.filter((b) => b.highlight);
    if (highlighted.length > 0) {
      const highlighter = new Highlighter(highlighted);
      this.#highlight = (mark, series, frame, key, rows) =>
        highlighter.geometry(mark, series, frame, key) ?? mark.geometry(series, frame, key, rows);
      model.highlight = this.#highlight;
    }
  }

  /**
   * Takes over what the brush wrote through the link this one replaces, in
   * channels both bind, so clearing the brush still clears them.
   */
  adopt(previous: RowLink): void {
    for (const [b, written] of previous.#brushed) {
      const same = this.#bound.find((own) => own.store === b.store && own.channel === b.channel);
      if (same) this.#brushed.set(same, written);
    }
    // The replaced link's pending check of another writer's change is this one's now.
    if (this.#brushed.size > 0) queueMicrotask(() => this.#reconcile());
  }

  /** Whether the chart's brush (or lasso) writes rows, and so never zooms. */
  get brushes(): boolean {
    const brush = this.#model.config.interaction?.brush;
    const gesture = brush === "lasso" ? "lasso" : "brush";
    return brush !== undefined && this.#bound.some((b) => b.events.has(gesture));
  }

  /**
   * The chart's brushed selection changed, in the panels of `owner`
   * (every panel's, for null): with `write`, writes the rows it covers, or
   * clears what the brush wrote. The changes made, for the `select` event;
   * undefined for none.
   */
  brushed(
    selection: Brushed | null,
    owner: { readonly panels: readonly string[] } | null,
    write: boolean,
  ): Written | undefined {
    // A selection shown without writing (a synced chart's, another view's)
    // replaces the brush: what that wrote is no longer the chart's to clear.
    if (!write) {
      this.#brushed.clear();
      return undefined;
    }
    if (!selection) {
      const cleared = this.#bound.filter(
        (b) => this.#brushed.has(b) && b.store.get(b.channel) === this.#brushed.get(b),
      );
      this.#brushed.clear();
      return written(this.#write(cleared.map((bound) => ({ bound, selection: null }))));
    }
    const gesture = selection.lasso ? "lasso" : "brush";
    // Every table's rows are found before any channel changes.
    const changes = this.#bound.flatMap((bound) => {
      if (!bound.events.has(gesture)) return [];
      const rows = brushedRows(this.#model, bound.table, selection, owner?.panels ?? null);
      return rows ? [{ bound, selection: rows }] : [];
    });
    this.#brushed.clear();
    for (const { bound, selection } of changes) this.#brushed.set(bound, selection);
    return written(this.#write(changes));
  }

  /**
   * A click at a pixel: selects the rows of the point under it (Shift
   * adds them, Ctrl or Cmd adds or removes them), or clears what clicks
   * select when it is over none. The changes made, for the `click` event;
   * undefined when no binding takes clicks.
   */
  clicked(px: number, py: number, keys: Modifiers): Written | undefined {
    const clickable = this.#bound.filter((b) => b.events.has("click"));
    if (clickable.length === 0) return undefined;
    const tables = new Set(clickable.map((b) => b.table));
    const rows = this.#pick(clickable, clickedRows(this.#model, tables, px, py), modeOf(keys));
    return { rows };
  }

  /**
   * Keys of the chart, after its own handling: Space selects the rows of
   * the point the keyboard cursor is on as a click does (with Shift, Ctrl,
   * or Cmd too) and announces how many are selected; Escape clears what
   * clicks select.
   */
  #key(event: KeyPress) {
    const clickable = this.#bound.filter((b) => b.events.has("click"));
    if (event.target !== this.#chart.root || clickable.length === 0) return;
    if (event.key === "Escape") {
      this.#pick(clickable, undefined, "only");
      return;
    }
    if (event.key !== " " || !this.#cursor()) return;
    // The cursor is on what the chart shows once pending changes are drawn,
    // as the arrow keys move it.
    this.#chart.render();
    const cursor = this.#cursor();
    const tables = new Set(clickable.map((b) => b.table));
    const found = cursor && cursorRows(this.#model, tables, cursor);
    if (!found) return;
    event.preventDefault();
    const [change] = this.#pick(clickable, found, modeOf(event));
    const selected = change?.selection;
    const count = selected?.kind === "rows" ? selected.rows.size : 0;
    // As grids say it.
    this.#live.textContent = `${count} ${count === 1 ? "row" : "rows"} selected`;
  }

  dispose(): undefined {
    this.#disposed = true;
    for (const stop of this.#stops) stop();
    this.#stops.length = 0;
    if (this.#highlight && this.#model.highlight === this.#highlight)
      this.#model.highlight = undefined;
    // The channels keep what the chart wrote: other views may be showing it.
    this.#brushed.clear();
    return undefined;
  }

  /** Changes the channels clicks write as a click on `found` (none: off the data) does. */
  #pick(
    clickable: readonly Bound[],
    found: PointRows | undefined,
    mode: Mode,
  ): RowSelectionChange[] {
    if (!found) {
      // Off the data, a plain click clears; with a modifier, it changes nothing.
      if (mode !== "only") return [];
      const holding = clickable.filter((b) => b.store.get(b.channel) !== null);
      return this.#write(holding.map((bound) => ({ bound, selection: null })));
    }
    const bound = clickable.find((b) => b.table === found.table)!;
    const rows = mode === "only" ? new RowSet(found.table) : held(bound);
    if (mode === "toggle" && found.rows.every((row) => rows.has(row)))
      for (const row of found.rows) rows.delete(row);
    else rows.addAll(found.rows);
    return this.#write([{ bound, selection: selectRows(rows) }]);
  }

  /** Writes selections to their channels; the changes. */
  #write(
    changes: readonly { bound: Bound; selection: DataSelection | null }[],
  ): RowSelectionChange[] {
    this.#writing++;
    try {
      for (const { bound, selection } of changes) bound.store.set(bound.channel, selection);
    } finally {
      this.#writing--;
    }
    // A listener may have replaced what the brush wrote while it was written.
    if (this.#writing === 0) this.#reconcile();
    return changes.map(({ bound, selection }) => ({
      table: bound.table,
      channel: bound.channel,
      selection,
    }));
  }

  /**
   * A store changed: reports the channels that did and redraws the chart
   * for those it highlights. When another writer replaced every selection
   * the chart's brush wrote, the brush goes too: it no longer shows the
   * channels' selection.
   */
  #changed(store: SelectionStore) {
    for (const bound of this.#bound) {
      if (bound.store !== store) continue;
      const now = seen(store.get(bound.channel));
      const before = this.#seen.get(bound);
      if (now.selection === before?.selection && now.version === before.version) continue;
      this.#seen.set(bound, now);
      if (bound.highlight) this.#invalidate();
      this.#events.emit("rowSelection", {
        table: bound.table,
        channel: bound.channel,
        selection: now.selection,
      });
    }
    // Another writer's change is checked once it has been reported and
    // shown: a view showing that writer's brush lets its own go first.
    if (this.#writing === 0) queueMicrotask(() => this.#reconcile());
  }

  /** Lets the brush go once no channel holds what it wrote. */
  #reconcile() {
    if (this.#disposed || this.#brushed.size === 0 || !this.#chart.selection) return;
    const kept = [...this.#brushed].some(([b, written]) => b.store.get(b.channel) === written);
    if (kept) return;
    this.#brushed.clear();
    this.#chart.select(null);
  }
}

/** A channel's selection as last seen, with its row set's version. */
function seen(selection: DataSelection | null) {
  return { selection, version: selection?.kind === "rows" ? selection.rows.version : -1 };
}

/** What a gesture wrote, as its event reports it: undefined when it wrote nothing. */
interface Written {
  rows: readonly RowSelectionChange[];
}

function written(rows: readonly RowSelectionChange[]): Written | undefined {
  return rows.length > 0 ? { rows } : undefined;
}

/** A copy of what a channel holds as rows: a condition's rows as they are now. */
function held(bound: Bound): RowSet {
  const rows = new RowSet(bound.table);
  const current = bound.store.get(bound.channel);
  if (current?.kind === "rows") rows.addAll(current.rows.positions());
  else if (current?.kind === "predicate") {
    const { at } = compileExpression(current.expression, bound.table);
    const matching: number[] = [];
    for (let row = 0; row < bound.table.length; row++) if (at(row) === true) matching.push(row);
    rows.addAll(matching);
  }
  return rows;
}
