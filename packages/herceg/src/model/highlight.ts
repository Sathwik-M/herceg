// Highlighting: a chart bound to a selection store draws the rows a
// channel selects as they are and dims the others (see row-selection.ts).
// Marks draw their own geometry, so layout, stacking, curves, and color
// stay as drawn without a selection; nothing here is in a chart that binds
// no store.
//
// - Marks drawing a glyph per row (points, bars, error bars, candlesticks,
//   rugs): unselected rows dimmed, then selected rows on top, each row
//   drawn once. Their series keep their place in the list, so grouped bars
//   stay in their slots. Point series the GPU draws stay clouds: two, of
//   their unselected and selected rows.
// - Lines and areas: drawn as they are within the x spans of their runs of
//   selected rows and dimmed outside them, so each pixel is painted once and
//   the highlighted part is the same curve and stack. A line's selected rows
//   with no selected neighbor are dots. Lines whose x does not ascend, and
//   runs of rows at one x, draw whole and dimmed with their selected rows'
//   values over them instead.
// - Marks summarizing rows (histograms, box plots, heatmaps) draw their
//   selected rows against the whole themselves (`Mark.selectedGeometry`),
//   through the parts and dimming lent here.
// - Other marks (annotations, custom marks, contours) draw every row as before.
//
// Memberships, splits, and masked values depend only on the selection and
// the data, so charts showing one selection share them.

import { compileExpression, type Expression } from "../data/expression.ts";
import type { DataSelection, SelectionStore } from "../data/selection.ts";
import type { Table } from "../data/table.ts";
import { lineDrawing } from "../draw/line.ts";
import { pointDrawing } from "../draw/point.ts";
import { unmappable } from "../lod/m4.ts";
import { shareSquares } from "../marks/cell-selection.ts";
import { STILL } from "../marks/dodge.ts";
import {
  DIM,
  type Frame,
  type Mark,
  type MarkKey,
  type RowParts,
  type SelectionDrawing,
} from "../marks/mark.ts";
import { placeAt, rowOf, type Series } from "../marks/series.ts";
import { alphaOf } from "../scale/color.ts";
import {
  type AreaGeometry,
  CLOUD_POINTS,
  type Drawing,
  type Geometry,
  type LineGeometry,
  type PointGeometry,
  type RectGeometry,
} from "../scene/scene.ts";

export { DIM };

/** A store channel whose selection a chart highlights, for the marks over its table. */
export interface HighlightedChannel {
  table: Table;
  store: SelectionStore;
  channel: string;
}

/**
 * Whether each of a table's rows is selected, by position: 1 or 0, as of
 * the table's version and, for rows, the set's.
 */
interface Membership {
  version: number;
  generation: number;
  modified: number;
  rowOffset: number;
  /** The row set's version; -1 for a condition. */
  rows: number;
  selected: Uint8Array;
}

/** Positions of a series' rows, split into the selected and the others. */
interface Split {
  on: Uint32Array;
  off: Uint32Array;
}

/** Memberships by table and selection, kept while either lives. */
const memberships = new WeakMap<Table, WeakMap<DataSelection, Membership>>();
/**
 * Splits by membership, then by series rows (the membership itself for
 * series of whole columns), and values with unselected rows missing by
 * membership, then by the column they were read from: kept while the
 * membership lives, so a selection let go takes them with it.
 */
const splits = new WeakMap<Uint8Array, WeakMap<object, Split>>();
const masks = new WeakMap<Uint8Array, WeakMap<object, Float64Array>>();

/** What `cache` keeps for a membership, made on first use. */
function within<V>(cache: WeakMap<Uint8Array, WeakMap<object, V>>, selected: Uint8Array) {
  let kept = cache.get(selected);
  if (!kept) {
    kept = new WeakMap();
    cache.set(selected, kept);
  }
  return kept;
}
/** Dimmed copies of drawings, made once per drawing. */
const dimmedDrawings = new WeakMap<Drawing<Geometry>, Drawing<Geometry>>();
/** Names clip paths of highlighted runs in SVG, unique in a page. */
let clips = 0;

const ON = "\u0001on";
const OFF = "\u0001off";

/** Marks drawing a glyph per row, each drawn dimmed or not. */
const ROWS = new Set(["point", "bar", "errorbar", "rug"]);

/**
 * Which of a table's rows a selection holds, by position. Rows still in the
 * table keep their membership when rows were only appended or dropped
 * since: only appended rows are tested.
 */
export function membership(table: Table, selection: DataSelection): Uint8Array {
  let byTable = memberships.get(table);
  if (!byTable) {
    byTable = new WeakMap();
    memberships.set(table, byTable);
  }
  const known = byTable.get(selection);
  const rows = selection.kind === "rows" ? selection.rows.version : -1;
  const same = known?.generation === table.generation && known.rows === rows;
  if (same && known.version === table.version) return known.selected;
  const selected = new Uint8Array(table.length);
  let from = 0;
  if (same && known.modified === table.modifiedVersion && table.rowOffset >= known.rowOffset) {
    const kept = known.selected.subarray(table.rowOffset - known.rowOffset);
    from = Math.min(kept.length, selected.length);
    selected.set(kept.subarray(0, from));
  }
  if (selection.kind === "rows") {
    const set = selection.rows;
    for (let row = from; row < selected.length; row++) if (set.has(row)) selected[row] = 1;
  } else if (from < selected.length) {
    // Compiled first in any case, which checks it against the table.
    const { at } = compileExpression(selection.expression, table);
    if (!fill(selection.expression, table, from, selected.subarray(from))) {
      selected.fill(0, from);
      for (let row = from; row < selected.length; row++) if (at(row) === true) selected[row] = 1;
    }
  }
  byTable.set(selection, {
    version: table.version,
    generation: table.generation,
    modified: table.modifiedVersion,
    rowOffset: table.rowOffset,
    rows,
    selected,
  });
  return selected;
}

/** Comparisons of a number field with a literal, which conditions test a column at a time. */
const COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);
const FLIP: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=" };

/** How a test's results go into what is there: in place of it, or and-ed or or-ed with it. */
type Into = "set" | "and" | "or";

/**
 * Whether each of rows `from` on (as many as `out` holds) meets condition
 * `e`, 1 or 0 into `out`: worked out a column at a time, for the
 * conditions brushes write (number fields compared with numbers, category
 * fields among labels, and conjunctions, disjunctions, and negations of
 * them), about ten times faster than testing row by row. False, with `out`
 * in any state, for any other condition. It gives what the compiled
 * condition gives: a missing value compares false, though unequal.
 */
function fill(
  e: Expression,
  table: Table,
  from: number,
  out: Uint8Array,
  into: Into = "set",
): boolean {
  const n = out.length;
  if (typeof e === "boolean") {
    const bit = e ? 1 : 0;
    if (into === "set" || (into === "and" && !e) || (into === "or" && e)) out.fill(bit);
    return true;
  }
  if (!Array.isArray(e)) return false;
  const [op, ...args] = e as readonly [string, ...Expression[]];
  const name = (arg: Expression | undefined) =>
    Array.isArray(arg) && arg[0] === "field" && typeof arg[1] === "string" ? arg[1] : undefined;
  // A field between two numbers, as brushes write ranges: one pass.
  const range = op === "and" && args.length === 2 && rangeOf(args[0]!, args[1]!, table);
  if (range) {
    const [v, lo, hi] = range;
    // Without branches: a branch on scattered values mispredicts every other row.
    if (into === "set")
      for (let i = 0; i < n; i++) out[i] = +(v[from + i]! >= lo) & +(v[from + i]! <= hi);
    else if (into === "and")
      for (let i = 0; i < n; i++) out[i]! &= +(v[from + i]! >= lo) & +(v[from + i]! <= hi);
    else for (let i = 0; i < n; i++) out[i]! |= +(v[from + i]! >= lo) & +(v[from + i]! <= hi);
    return true;
  }
  if ((op === "and" || op === "or") && args.length > 0) {
    // Each part goes straight into `out` when it combines as the node does.
    if (into === op || into === "set")
      return args.every((arg, i) => fill(arg, table, from, out, i === 0 ? into : op));
    const own = new Uint8Array(n);
    if (!fill(e, table, from, own)) return false;
    combine(out, own, into);
    return true;
  }
  if (op === "not" && args.length === 1) {
    const own = new Uint8Array(n);
    if (!fill(args[0]!, table, from, own)) return false;
    for (let i = 0; i < n; i++) own[i]! ^= 1;
    combine(out, own, into);
    return true;
  }
  if (COMPARE.has(op) && args.length === 2) {
    const compared = comparisonOf(op, args[0]!, args[1]!, table);
    if (!compared) return false;
    const [v, test, c] = compared;
    const own = into === "set" ? out : new Uint8Array(n);
    // A loop per comparison, without branches: these run over every row.
    if (test === "==") for (let i = 0; i < n; i++) own[i] = +(v[from + i] === c);
    else if (test === "!=") for (let i = 0; i < n; i++) own[i] = +(v[from + i] !== c);
    else if (test === "<") for (let i = 0; i < n; i++) own[i] = +(v[from + i]! < c);
    else if (test === "<=") for (let i = 0; i < n; i++) own[i] = +(v[from + i]! <= c);
    else if (test === ">") for (let i = 0; i < n; i++) own[i] = +(v[from + i]! > c);
    else for (let i = 0; i < n; i++) own[i] = +(v[from + i]! >= c);
    if (own !== out) combine(out, own, into);
    return true;
  }
  const field = name(args[0]);
  if (op !== "in" || field === undefined || table.kind(field) !== "category") return false;
  const candidates = args.slice(1);
  if (!candidates.every((v) => typeof v === "string" || v === null)) return false;
  // Whether each category is a candidate, then each row's.
  const { codes, dictionary } = table.categories(field as never);
  const labels = new Set(candidates);
  const member = Uint8Array.from(dictionary, (label) => (labels.has(label) ? 1 : 0));
  const missing = labels.has(null) ? 1 : 0;
  const own = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const code = codes[from + i]!;
    own[i] = code < 0 ? missing : member[code]!;
  }
  combine(out, own, into);
  return true;
}

/**
 * A comparison of a number field with a number, as a test of the field's
 * values with a literal on the right; undefined for other comparisons.
 */
function comparisonOf(
  op: string,
  left: Expression,
  right: Expression,
  table: Table,
): [values: ArrayLike<number>, op: string, literal: number] | undefined {
  // A literal on the left is the same comparison turned around.
  const flipped = typeof left === "number";
  const [arg, c] = flipped ? [right, left] : [left, right];
  const field = Array.isArray(arg) && arg[0] === "field" ? arg[1] : undefined;
  if (typeof field !== "string" || typeof c !== "number" || table.kind(field) === "category")
    return undefined;
  return [table.numbers(field as never), flipped ? (FLIP[op] ?? op) : op, c];
}

/** A field from one number to another, inclusive (`>=` one and `<=` the other); undefined otherwise. */
function rangeOf(
  a: Expression,
  b: Expression,
  table: Table,
): [values: ArrayLike<number>, lo: number, hi: number] | undefined {
  if (!Array.isArray(a) || !Array.isArray(b)) return undefined;
  const first = comparisonOf(a[0] as string, a[1]!, a[2]!, table);
  const second = comparisonOf(b[0] as string, b[1]!, b[2]!, table);
  if (!first || !second || first[0] !== second[0] || a.length !== 3 || b.length !== 3)
    return undefined;
  const low = first[1] === ">=" ? first : second[1] === ">=" ? second : undefined;
  const high = first[1] === "<=" ? first : second[1] === "<=" ? second : undefined;
  return low && high && low !== high ? [first[0], low[2], high[2]] : undefined;
}

/** `own` into `out`, as `into` says. */
function combine(out: Uint8Array, own: Uint8Array, into: Into): void {
  if (into === "set") out.set(own);
  else if (into === "and") for (let i = 0; i < out.length; i++) out[i]! &= own[i]!;
  else for (let i = 0; i < out.length; i++) out[i]! |= own[i]!;
}

export class Highlighter {
  readonly #channels: readonly HighlightedChannel[];

  constructor(channels: readonly HighlightedChannel[]) {
    this.#channels = channels;
  }

  /**
   * Which of `table`'s rows its channel's selection holds, 1 each, for
   * layout marks to draw highlighted; undefined when it holds none (or
   * rows of a table since reset), or no channel is of the table.
   */
  selected(table: Table): Uint8Array | undefined {
    const selection = this.#selection(table);
    return selection && membership(table, selection);
  }

  /** The selection `table`'s channel holds; undefined for none, or rows of a table since reset. */
  #selection(table: Table): DataSelection | undefined {
    const channel = this.#channels.find((c) => c.table === table);
    const selection = channel?.store.get(channel.channel);
    if (!selection || (selection.kind === "rows" && !selection.rows.current)) return undefined;
    return selection;
  }

  /**
   * The geometry of a mark with the rows its table's channel selects
   * highlighted; undefined when nothing of it is highlighted (the channel
   * holds no selection, or the mark is not one this draws), for the mark
   * to draw as usual.
   */
  geometry(
    mark: Mark,
    series: readonly Series[],
    frame: Frame,
    key: MarkKey,
    rows?: RowParts,
  ): Geometry[] | undefined {
    const type = mark.spec.type;
    if (!ROWS.has(type) && type !== "line" && type !== "area" && !mark.selectedGeometry)
      return undefined;
    const table = mark.table;
    const selected = table && this.selected(table);
    if (!selected) return undefined;
    // Parts of series draw into buffers and keys of their own, hidden as their series are.
    const hidden = (suffix: string) =>
      frame.hidden.size === 0
        ? frame.hidden
        : new Set(series.filter((s) => frame.hidden.has(s.key)).map((s) => s.key + suffix));
    const own = (suffix: string): Frame => ({ ...frame, hidden: hidden(suffix), keyed: false });
    if (mark.selectedGeometry) {
      const byKey = new Map(series.map((s) => [s.key, s]));
      // Each part stands for the drawn series of its key, whose slot it keeps.
      const parts = (list: readonly Series[], suffix: string) =>
        list.map((p) => ({ ...p, key: p.key + suffix, whole: p.whole ?? byKey.get(p.key) }));
      const drawing: SelectionDrawing = {
        selected,
        dimmed: (list) => mark.geometry(parts(list, OFF), own(OFF), key, rows).flatMap(dimLayer),
        lit: (list) => mark.geometry(parts(list, ON), own(ON), key, rows),
        dim: dimLayer,
        squares: shareSquares,
      };
      return mark.selectedGeometry(series, frame, drawing);
    }
    const selection = this.#selection(table)!;
    if (ROWS.has(type)) {
      const clouds: Geometry[] = [];
      let rest = series;
      if (type === "point" && frame.clouds && series.some((s) => s.length >= CLOUD_POINTS)) {
        const big = series.filter((s) => s.length >= CLOUD_POINTS);
        const drawn = (mark.geometry(big, frame, key) as PointGeometry[]).filter((g) => g.cloud);
        for (const g of drawn) {
          const s = big.find(({ key }) => key === g.key)!;
          clouds.push(...lightClouds(g, split(s, selected), selection, table));
        }
        const done = new Set(drawn.map((g) => g.key));
        rest = series.filter((s) => !done.has(s.key));
      }
      const parts = rest.map((s) => split(s, selected));
      const off = rest.map((s, i) => part(s, OFF, parts[i]!.off));
      const on = rest.map((s, i) => part(s, ON, parts[i]!.on));
      return [
        ...clouds,
        ...mark.geometry(off, own(OFF), key).map(dim),
        ...mark.geometry(on, own(ON), key),
      ];
    }
    const drawn = mark.geometry(series, frame, key);
    const byKey = new Map(series.map((s) => [s.key, s]));
    // Lines and areas run along x, or along y (`orient`), which their runs follow.
    const along = mark.tooltip === "y" ? "y" : "x";
    // Stacked areas draw their zeros at a log axis' low end.
    const low =
      type === "area" &&
      Boolean((mark.spec as { stack?: boolean | string }).stack) &&
      frame[along === "x" ? "y" : "x"].type === "log";
    const found = new Map<Series, Runs>();
    const runs = (s: Series) =>
      found.get(s) ?? found.set(s, runsOf(s, selected, frame, low, along)).get(s)!;
    const spansFor = new Map<Geometry, number[] | undefined>();
    // Series spans cannot say: their selected rows' values draw over them instead.
    const others: Series[] = [];
    for (const g of drawn) {
      const s = byKey.get(g.of ?? g.key);
      // Line ends are round caps, half a stroke past the last vertex.
      const stroke =
        g.kind === "line"
          ? (g as LineGeometry).strokeWidth
          : (g as AreaGeometry).stroke
            ? (g as AreaGeometry).strokeWidth
            : 0;
      // Dodged series are drawn off their bands' centers.
      const shift = s && shiftOf(mark, s, frame)[along === "x" ? 0 : 1];
      const spans = s && spansOf(s, runs(s), frame, stroke / 2, shift!, along);
      spansFor.set(g, spans);
      if (!spans && s && !frame.hidden.has(s.key) && !others.includes(s)) others.push(s);
    }
    const lit = new Map<string, Geometry[]>();
    // Geometry of a series with a key of its own (markers) by its series and kind.
    const litKey = (g: Geometry, on = "") =>
      g.of === undefined ? g.key + on : `${g.of}${on}|${g.kind}`;
    if (others.length > 0)
      for (const g of mark.geometry(
        others.map((s) => masked(s, selected, along === "y")),
        own(ON),
        key,
      ))
        lit.set(litKey(g), [...(lit.get(litKey(g)) ?? []), ...over(g)]);
    // In the mark's order, each part as it paints it: an area's fill, then its outline.
    const out: Geometry[] = [];
    const shift = (s: Series) => shiftOf(mark, s, frame);
    for (const g of drawn) {
      const spans = spansFor.get(g);
      // Markers are lit whole, where their observations are in the selected
      // runs or are lone selected rows, which they mark in place of dots.
      if (spans && g.of !== undefined && g.kind === "point") {
        const lone = loneRows(byKey.get(g.of)!, runs, frame, shift);
        const [inside, outside] = pointsIn(g as PointGeometry, spans, lone, along);
        out.push(...dimLayer(outside), inside);
        continue;
      }
      if (spans) {
        // Each pixel is painted once: dimmed outside the selected runs, as drawn inside them.
        for (const dimmed of dimLayer(g))
          out.push(clipped(dimmed, complement(spans, frame, along), frame, along));
        if (spans.length > 0) out.push(clipped(g, spans, frame, along));
        continue;
      }
      // Dimmed, then its selected rows' values over it, part by part.
      const [under, values] = [dimLayer(g), lit.get(litKey(g, ON)) ?? []];
      for (let i = 0; i < Math.max(under.length, values.length); i++) {
        if (under[i]) out.push(under[i]!);
        if (values[i]) out.push(values[i]!);
      }
    }
    // Dots at the opacity each series' line is drawn at, for series without markers.
    const opacity = new Map(
      drawn.filter((g) => g.kind === "line").map((g) => [g.key, g.draw.opacity ?? 1] as const),
    );
    const marked = new Set(drawn.map((g) => (g.kind === "point" ? g.of : undefined)));
    if (type === "line")
      out.push(
        ...dots(
          series.filter((s) => !marked.has(s.key)),
          runs,
          frame,
          shift,
          (s) => opacity.get(s.key) ?? 1,
        ),
      );
    return out;
  }
}

/**
 * Points split by whether they stand at selected rows: their centers along
 * `along` in `spans` (ascending pixel pairs), or within half a pixel of a
 * lone selected row's place (`lone`, x, y pairs). Those in, and the others.
 */
function pointsIn(
  g: PointGeometry,
  spans: readonly number[],
  lone: readonly number[],
  along: "x" | "y",
): [PointGeometry, PointGeometry] {
  const a = along === "x" ? 0 : 1;
  // Lone rows in order along, each found by a search.
  const order = Array.from({ length: lone.length / 2 }, (_, i) => i).sort(
    (i, j) => lone[i * 2 + a]! - lone[j * 2 + a]!,
  );
  const places = order.map((i) => lone[i * 2 + a]!);
  const across = order.map((i) => lone[i * 2 + 1 - a]!);
  const ends = spans.filter((_, j) => j % 2 === 1);
  /** The first of ascending `values` at or past `v`. */
  const search = (values: readonly number[], v: number) => {
    let [lo, hi] = [0, values.length];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (values[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  const parts = [new Float32Array(g.count * 2), new Float32Array(g.count * 2)];
  const counts = [0, 0];
  for (let i = 0; i < g.count; i++) {
    const p = g.coords[i * 2 + a]!;
    const q = g.coords[i * 2 + 1 - a]!;
    // The span ending at or after p, which holds p if it starts by then.
    const k = search(ends, p);
    let inside = k < ends.length && spans[k * 2]! <= p;
    for (
      let j = search(places, p - 0.5);
      !inside && j < places.length && places[j]! <= p + 0.5;
      j++
    )
      inside = Math.abs(across[j]! - q) <= 0.5;
    const part = inside ? 0 : 1;
    parts[part]!.set(g.coords.subarray(i * 2, i * 2 + 2), counts[part]! * 2);
    counts[part]!++;
  }
  const part = (j: number): PointGeometry => ({
    ...g,
    key: `${g.key}${j ? "" : ON}`,
    coords: parts[j]!,
    count: counts[j]!,
  });
  return [part(0), part(1)];
}

/** How far a mark draws a line's or area's series from its values' place (dodged series). */
function shiftOf(mark: Mark, s: Series, frame: Frame): readonly [number, number] {
  return mark.displace?.(s, 0, frame) ?? STILL;
}

/** A series' positions split by whether their rows are selected. */
function split(s: Series, selected: Uint8Array): Split {
  const kept = within(splits, selected);
  const key = s.rows ?? selected;
  const known = kept.get(key);
  if (known) return known;
  let count = 0;
  for (let k = 0; k < s.length; k++) count += selected[rowOf(s, k)]!;
  const on = new Uint32Array(count);
  const off = new Uint32Array(s.length - count);
  // Each row is written to both and kept by the one it belongs to: without
  // a branch, which scattered selections mispredict. Writes past an array's
  // end, of rows that belong to the other, are dropped.
  let [i, j] = [0, 0];
  for (let k = 0; k < s.length; k++) {
    const row = rowOf(s, k);
    const lit = selected[row]!;
    on[i] = row;
    off[j] = row;
    i += lit;
    j += lit ^ 1;
  }
  const found = { on, off };
  kept.set(key, found);
  return found;
}

/** A series cut down to some of its rows, under a key of its own. */
function part(s: Series, suffix: string, rows: Uint32Array): Series {
  return {
    ...s,
    key: s.key + suffix,
    rows,
    length: rows.length,
    stream: undefined,
    edges: undefined,
    whole: s.whole ?? s,
  };
}

/**
 * A point cloud highlighted on the GPU: its unselected and its selected
 * rows as two clouds, so each point composites once. Each part streams as
 * its cloud does: while the selection stays and rows are only appended and
 * dropped, a part loses rows from its front and gains them at its end, so
 * its upload takes appended points rather than being made again.
 */
function lightClouds(
  g: PointGeometry,
  { on, off }: Split,
  selection: DataSelection,
  table: Table,
): Geometry[] {
  const cloud = g.cloud!;
  const rows = (side: "on" | "off", of: Uint32Array, opacity: number): PointGeometry => ({
    ...g,
    key: g.key + (side === "on" ? ON : OFF),
    fillOpacity: opacity,
    opaque: g.opaque && opacity >= 1,
    count: of.length,
    cloud: {
      ...cloud,
      rows: of,
      start: 0,
      end: of.length,
      stream: cloud.stream && partStream(cloud.stream.key, side, of, selection, table),
    },
  });
  return [rows("off", off, g.fillOpacity * DIM), rows("on", on, g.fillOpacity)];
}

/** What a streaming cloud's part was last drawn of, by its cloud's stream key. */
interface PartUpload {
  /** Names the part's upload, as long as it can follow its rows. */
  key: object;
  /** The row set's version; -1 for a condition. */
  version: number;
  generation: number;
  modified: number;
  rowOffset: number;
  rows: Uint32Array;
  /** Rows the part has lost from its front. */
  offset: number;
  /** Counts the times the part changed otherwise, which uploads it again. */
  epoch: number;
}

/** Cloud parts' uploads by selection, then by their cloud's stream key, kept while both live. */
const partUploads = new WeakMap<
  DataSelection,
  WeakMap<object, { on?: PartUpload; off?: PartUpload }>
>();

/**
 * A cloud part's stream (see `PointCloud.stream`): rows dropped from the
 * table's front leave the part's front (its rows are ascending positions),
 * appended rows join its end; any other change starts a new epoch.
 */
function partStream(
  base: object,
  side: "on" | "off",
  rows: Uint32Array,
  selection: DataSelection,
  table: Table,
): NonNullable<NonNullable<PointGeometry["cloud"]>["stream"]> {
  let bySelection = partUploads.get(selection);
  if (!bySelection) {
    bySelection = new WeakMap();
    partUploads.set(selection, bySelection);
  }
  let parts = bySelection.get(base);
  if (!parts) {
    parts = {};
    bySelection.set(base, parts);
  }
  const known = parts[side];
  const version = selection.kind === "rows" ? selection.rows.version : -1;
  let next: PartUpload;
  if (
    known &&
    known.version === version &&
    known.generation === table.generation &&
    known.modified === table.modifiedVersion &&
    table.rowOffset >= known.rowOffset
  ) {
    // Rows of the part before the table's new first row have left.
    const shift = table.rowOffset - known.rowOffset;
    let dropped = 0;
    while (dropped < known.rows.length && known.rows[dropped]! < shift) dropped++;
    next = { ...known, rowOffset: table.rowOffset, rows, offset: known.offset + dropped };
  } else {
    next = {
      key: known?.key ?? {},
      version,
      generation: table.generation,
      modified: table.modifiedVersion,
      rowOffset: table.rowOffset,
      rows,
      offset: 0,
      epoch: (known?.epoch ?? 0) + 1,
    };
  }
  parts[side] = next;
  return { key: next.key, offset: next.offset, modified: next.epoch };
}

/**
 * A line's or area's series with the unselected rows' values (and a
 * stack's or band's bases) missing, so the mark breaks its runs there:
 * values along y, or for marks along y, along x.
 */
function masked(s: Series, selected: Uint8Array, alongY: boolean): Series {
  // Indexes and streams follow the columns, not these values; edges draw a
  // whole layer. A part keeps its whole, whose slot it stands in (dodge).
  const part = { key: s.key + ON, field: undefined, stream: undefined, edges: undefined };
  const whole = s.whole ?? s;
  if (alongY)
    return { ...s, ...part, x: mask(s.x, selected), x0: s.x0 && mask(s.x0, selected), whole };
  return { ...s, ...part, y: mask(s.y, selected), y0: s.y0 && mask(s.y0, selected), whole };
}

function mask(values: Series["y"], selected: Uint8Array): Float64Array {
  const kept = within(masks, selected);
  const known = kept.get(values);
  if (known) return known;
  const out = new Float64Array(selected.length);
  for (let row = 0; row < selected.length; row++)
    out[row] = selected[row] ? values[row]! : Number.NaN;
  kept.set(values, out);
  return out;
}

/** A series' runs of selected rows, as its mark draws them (see `runsOf`). */
interface Runs {
  /**
   * The first and last of each run, as pairs of indices in x order,
   * trimmed to the rows the mark draws through.
   */
  runs: number[];
  /** How many positions are in x order: the series', or a stack layer's with an x. */
  count: number;
  /** The position at an index in x order. */
  at(i: number): number;
  /** Whether the mark draws through the row at an index in x order. */
  drawn(i: number): boolean;
  /** From `i` on by `step`, the first index an axis break does not hide (-1 or `count` past the ends). */
  shown(i: number, step: 1 | -1): number;
}

/**
 * The runs of selected rows of a series, in x order: as its positions are,
 * or for a layer of a stack drawn through its edges, its rows with an x
 * sorted, as the stack orders them. A run ends at its outermost rows the
 * mark draws through, by the rule it draws by: x, y, and a range's or a
 * stack's lower end placed (`low`: zeros at a log axis' low end), rows
 * inside axis breaks hidden, and for a stack's layer drawn through its
 * edges, x alone, since the edges draw what is there. A run goes on across
 * rows a break hides, as the line joins the rows either side, and keeps the
 * rows inside it that the line breaks at: the caps either side are within
 * its span. Only runs' ends and their neighbors are placed, so this costs
 * per run, beyond a scan of the membership.
 */
function runsOf(
  s: Series,
  selected: Uint8Array,
  frame: Frame,
  low: boolean,
  along: "x" | "y",
): Runs {
  const { rows, edges } = s;
  const across = along === "x" ? "y" : "x";
  const bases = along === "x" ? s.y0 : s.x0;
  const sorted = along === "x" ? s.sorted : (s.ySorted ?? false);
  const positionOf = (k: number) => placeAt(s, along, rowOf(s, k));
  let order: Uint32Array | undefined;
  if (!sorted && edges) {
    const placed: number[] = [];
    for (let k = 0; k < s.length; k++) if (Number.isFinite(positionOf(k))) placed.push(k);
    order = Uint32Array.from(placed).sort((a, b) => positionOf(a) - positionOf(b));
  }
  const count = order ? order.length : s.length;
  const at = (i: number) => (order === undefined ? i : order[i]!);
  const [alongMap, acrossMap] = [frame[along].mapping(), frame[across].mapping()];
  // Only time x axes have breaks, which hide positions, or the values of marks along y.
  const breaks = frame.x.breaks;
  const onAlong =
    frame[along].type === "band" ? (v: number) => v >= 0 : (v: number) => !unmappable(alongMap, v);
  const onAcross =
    frame[across].type === "band"
      ? (v: number) => v >= 0
      : (v: number) => (low && v === 0) || !unmappable(acrossMap, v);
  const drawn = (i: number) => {
    const row = rowOf(s, at(i));
    const position = placeAt(s, along, row);
    if (!onAlong(position) || breaks?.hides(placeAt(s, "x", row))) return false;
    // Rows `where` and `continuity.defined` leave out.
    if (s.features?.drawn?.(row) === false) return false;
    return (
      edges !== undefined ||
      (onAcross(placeAt(s, across, row)) && (bases === undefined || onAcross(bases[row]!)))
    );
  };
  const shown = (i: number, step: 1 | -1) => {
    let j = i;
    while (breaks && j >= 0 && j < count && breaks.hides(placeAt(s, "x", rowOf(s, at(j)))))
      j += step;
    return j;
  };
  // Series of whole columns in their own order read the membership directly.
  const direct = order === undefined && rows === undefined;
  const chosen = (i: number) => selected[direct ? i : rowOf(s, at(i))] === 1;
  const runs: number[] = [];
  for (let i = 0; i < count; i++) {
    if (!chosen(i)) continue;
    // Runs start at rows shown: past those a break hides, each read once.
    const from = shown(i, 1);
    if (from !== i) {
      i = from - 1;
      continue;
    }
    const first = i;
    let next = i + 1;
    for (;;) {
      if (i + 1 < count && chosen(i + 1)) i++;
      else {
        // Past rows a break hides, to the row the line joins next.
        next = shown(i + 1, 1);
        if (next === i + 1 || next >= count || !chosen(next)) break;
        i = next;
      }
    }
    let [start, end] = [first, i];
    while (start <= end && !drawn(start)) start++;
    while (end > start && !drawn(end)) end--;
    if (start <= end) runs.push(start, end);
    // The hidden rows after the run were read: go on from the row shown next.
    i = next - 1;
  }
  return { runs, count, at, drawn, shown };
}

/**
 * The pixel spans along the axis a series runs along (`along`: x, or y for
 * lines and areas along y) of its runs of selected rows, in order of
 * position, as pairs: from a run's first row to its last, ascending and
 * merged where they touch, at least a pixel wide, moved `shift` pixels
 * where a dodged series is drawn. Where a run ends a path, its span
 * reaches `cap` pixels further, over the line's round cap. A layer of a
 * stack drawn through its edges (a series field's) fills positions other
 * layers have too: its runs reach the stack's ends past its own first and
 * last rows. Undefined where spans cannot say what is selected: a line
 * whose positions do not ascend, or rows at one position drawn as a run
 * across, all selected or some at a run's end.
 */
function spansOf(
  s: Series,
  found: Runs,
  frame: Frame,
  cap: number,
  shift: number,
  along: "x" | "y",
): number[] | undefined {
  const edges = s.edges;
  const sorted = along === "x" ? s.sorted : (s.ySorted ?? false);
  if (!sorted && !edges) return undefined;
  const { at, drawn, shown, count: n } = found;
  const xAt = (i: number) => placeAt(s, along, rowOf(s, at(i)));
  // Edges hold positions as the series does: bands read through a panel's places.
  const places = s.places?.[along];
  const placed = (value: number) => (places && value >= 0 ? places.at(value) : value);
  // Pixel pairs, in x order, which is pixel order or (reversed axes) its reverse.
  const runs: number[] = [];
  for (let r = 0; r < found.runs.length; r += 2) {
    const [start, end] = [found.runs[r]!, found.runs[r + 1]!];
    let [from, to] = [xAt(start), xAt(end)];
    // Other rows drawn at a run's end, past breaks too: no span tells their segments apart.
    for (let j = start - 1; j >= 0 && xAt(j) === from; j--) if (drawn(j)) return undefined;
    for (let j = end + 1; j < n && xAt(j) === to; j++) if (drawn(j)) return undefined;
    if (edges && edges.x.length > 0) {
      if (start === 0) from = Math.min(from, placed(edges.x[0]!));
      if (end === n - 1) to = Math.max(to, placed(edges.x[edges.x.length - 1]!));
    }
    // A row alone is a dot.
    if (start === end && from === to) continue;
    if (from === to) return undefined;
    let [a, b] = [frame[along].map(from) + shift, frame[along].map(to) + shift];
    // Ends of paths: rows with no row drawn before or after them, past rows breaks hide.
    const [before, after] = [shown(start - 1, -1), shown(end + 1, 1)];
    const sign = a <= b ? 1 : -1;
    if (before < 0 || !drawn(before)) a -= sign * cap;
    if (after >= n || !drawn(after)) b += sign * cap;
    runs.push(Math.min(a, b), Math.max(a, b));
  }
  const reversed = runs.length > 2 && runs[0]! > runs[runs.length - 2]!;
  const spans: number[] = [];
  for (let r = 0; r < runs.length; r += 2) {
    const i = reversed ? runs.length - 2 - r : r;
    let [lo, hi] = [runs[i]!, runs[i + 1]!];
    if (hi - lo < 1) [lo, hi] = [(lo + hi) / 2 - 0.5, (lo + hi) / 2 + 0.5];
    const last = spans.length - 1;
    if (last > 0 && lo <= spans[last]!) spans[last] = Math.max(spans[last]!, hi);
    else spans.push(lo, hi);
  }
  return spans;
}

/** The plot's x (or y, `along`) outside `spans` (ascending pairs), as pairs. */
function complement(spans: readonly number[], frame: Frame, along: "x" | "y"): number[] {
  const { plot } = frame;
  const [start, size] = along === "x" ? [plot.x, plot.width] : [plot.y, plot.height];
  const out: number[] = [];
  let from = start - 1;
  for (let i = 0; i < spans.length; i += 2) {
    if (spans[i]! > from) out.push(from, spans[i]!);
    from = Math.max(from, spans[i + 1]!);
  }
  const end = start + size + 1;
  if (end > from) out.push(from, end);
  return out;
}

/**
 * A geometry drawn only over spans (pairs of pixels) along x, across the
 * plot's height, or with `along` "y" along y, across its width.
 */
function clipped(
  geometry: Geometry,
  spans: readonly number[],
  frame: Frame,
  along: "x" | "y",
): Geometry {
  const { plot } = frame;
  const draw = geometry.draw as Drawing<Geometry> & { canvas: DataCanvas };
  const id = `herceg-runs-${++clips}`;
  // Each span's rectangle: x, y, width, height.
  const rect = (i: number) =>
    along === "x"
      ? [spans[i]!, plot.y, spans[i + 1]! - spans[i]!, plot.height]
      : [plot.x, spans[i]!, plot.width, spans[i + 1]! - spans[i]!];
  const drawing: Drawing<Geometry> = {
    size: draw.size,
    opacity: draw.opacity,
    clip: Array.from({ length: spans.length / 2 }, (_, i) => rect(i * 2)).flat(),
    svg(g, context) {
      let rects = "";
      for (let i = 0; i < spans.length; i += 2) {
        const [x, y, width, height] = rect(i);
        rects += `<rect x="${x}" y="${y}" width="${width}" height="${height}"/>`;
      }
      return `<clipPath id="${id}">${rects}</clipPath><g clip-path="url(#${id})">${draw.svg(g, context)}</g>`;
    },
    canvas(context, g, options) {
      context.save();
      context.beginPath();
      for (let i = 0; i < spans.length; i += 2) {
        const [x, y, width, height] = rect(i);
        context.rect(x!, y!, width!, height!);
      }
      context.clip();
      draw.canvas(context, g, options);
      context.restore();
    },
  };
  return { ...geometry, key: `${geometry.key}${ON}${id}`, draw: drawing };
}

type DataCanvas = Extract<Drawing<Geometry>, { canvas: unknown }>["canvas"];

/** Where a series draws its runs of one selected row, which no span shows: x, y pixels per row. */
function loneRows(
  s: Series,
  runs: (s: Series) => Runs,
  frame: Frame,
  shift: (s: Series) => readonly [number, number],
): number[] {
  const coords: number[] = [];
  const found = runs(s);
  const [dx, dy] = shift(s);
  for (let r = 0; r < found.runs.length; r += 2) {
    if (found.runs[r] !== found.runs[r + 1]) continue;
    const row = rowOf(s, found.at(found.runs[r]!));
    coords.push(frame.x.map(placeAt(s, "x", row)) + dx, frame.y.map(placeAt(s, "y", row)) + dy);
  }
  return coords;
}

/** Dots at runs of one row drawn, which no span shows, where `shift` says each series is drawn. */
function dots(
  series: readonly Series[],
  runs: (s: Series) => Runs,
  frame: Frame,
  shift: (s: Series) => readonly [number, number],
  opacity: (s: Series) => number,
): PointGeometry[] {
  const out: PointGeometry[] = [];
  for (const s of series) {
    if (frame.hidden.has(s.key)) continue;
    const coords = loneRows(s, runs, frame, shift);
    if (coords.length === 0) continue;
    out.push({
      kind: "point",
      draw: pointDrawing,
      key: `${s.key}${ON}-dots`,
      fill: s.color,
      fillOpacity: opacity(s),
      opaque: false,
      radius: Math.max(2.5, frame.theme.style.line.strokeWidth * 1.5),
      symbol: "circle",
      coords: Float32Array.from(coords),
      count: coords.length / 2,
    });
  }
  return out;
}

/** A point's or bar's geometry with its opacity dimmed; anything else (labels) drawn dimmed. */
function dim(geometry: Geometry): Geometry {
  if (geometry.kind === "point") {
    const points = geometry as PointGeometry;
    const dimmed: PointGeometry = {
      ...points,
      fillOpacity: points.fillOpacity * DIM,
      opaque: false,
      opacities: points.opacities?.map((opacity) => opacity * DIM),
      ring: points.ring && { ...points.ring, opacity: (points.ring.opacity ?? 1) * DIM },
    };
    return dimmed;
  }
  if (geometry.kind === "rect") {
    const rects = geometry as RectGeometry;
    const { edge } = rects;
    const dimmed: RectGeometry = {
      ...rects,
      fillOpacity: rects.fillOpacity * DIM,
      ...(edge && { edge: { ...edge, opacity: edge.opacity * DIM } }),
    };
    return dimmed;
  }
  let draw = dimmedDrawings.get(geometry.draw);
  if (!draw) {
    draw = faded(geometry.draw, DIM);
    dimmedDrawings.set(geometry.draw, draw);
  }
  return { ...geometry, draw };
}

/**
 * A geometry dimmed, for any kind: an area's fill at a fraction of its
 * opacity and its outline drawn apart as a dimmed line, since areas paint
 * their outline at full opacity (and set the canvas' alpha, which a faded
 * drawing would multiply).
 */
function dimLayer(geometry: Geometry): Geometry[] {
  if (geometry.kind !== "area") return [dim(geometry)];
  const area = geometry as AreaGeometry;
  const fill: AreaGeometry = { ...area, fillOpacity: area.fillOpacity * DIM, stroke: null };
  return area.stroke ? [fill, dim(outlineOf(area))] : [fill];
}

/** An area's outline as a line of its own, which areas otherwise paint opaque, at its own opacity. */
function outlineOf(area: AreaGeometry): LineGeometry {
  const opacity = area.strokeOpacity ?? 1;
  return {
    kind: "line",
    key: `${area.key}-outline`,
    draw: opacity === 1 ? lineDrawing : (faded(lineDrawing as Drawing<Geometry>, opacity) as never),
    stroke: area.stroke!,
    strokeWidth: area.strokeWidth,
    dash: undefined,
    path: area.upper,
  };
}

/** A drawing of the same marks at `fraction` of their opacity. */
function faded(draw: Drawing<Geometry>, fraction: number): Drawing<Geometry> {
  const elements = draw.elements;
  const copy = {
    ...draw,
    opacity: (draw.opacity ?? 1) * fraction,
    svg: (geometry, context) => `<g opacity="${fraction}">${draw.svg(geometry, context)}</g>`,
    elements:
      elements &&
      ((geometry, context) =>
        elements(geometry, context)?.map(({ tag, attributes }) => ({
          tag,
          attributes: {
            ...attributes,
            opacity: String(fraction * Number(attributes.opacity ?? 1)),
          },
        }))),
    ...(!draw.guide && {
      canvas(context, geometry, options) {
        const alpha = context.globalAlpha;
        context.globalAlpha = alpha * fraction;
        draw.canvas(context, geometry, options);
        context.globalAlpha = alpha;
      },
    }),
  } as Drawing<Geometry>;
  return copy;
}

/**
 * Selected rows' values drawn over their series dimmed (where spans cannot
 * say what is selected), at the opacity that, over the dimmed drawing in
 * the same color, shows the mark's own: a color of alpha `a` (its own
 * alpha times the mark's opacity) over itself at `a * DIM` composites to
 * `a` when drawn at `(1 - DIM) a / (1 - DIM a)`. An area's outline is
 * drawn as a line of its own, so each is drawn at its own alpha.
 */
function over(geometry: Geometry): Geometry[] {
  const at = (a: number) => (a >= 1 ? 1 : ((1 - DIM) * a) / (1 - DIM * a));
  if (geometry.kind === "line") {
    const line = geometry as LineGeometry;
    // The line's alpha: its color's, at the opacity it is drawn at.
    const c = alphaOf(line.stroke) * (line.draw.opacity ?? 1);
    return [
      c >= 1 || c <= 0
        ? line
        : {
            ...line,
            draw: faded(line.draw as Drawing<Geometry>, at(c) / c) as LineGeometry["draw"],
          },
    ];
  }
  if (geometry.kind === "point") {
    // Markers: their fill and ring, each at its own alpha.
    const points = geometry as PointGeometry;
    const fill = alphaOf(points.fill);
    const ring = points.ring;
    const edge = ring && alphaOf(ring.color);
    return [
      {
        ...points,
        fillOpacity: fill > 0 ? at(points.fillOpacity * fill) / fill : points.fillOpacity,
        ...(ring &&
          edge! > 0 && { ring: { ...ring, opacity: at((ring.opacity ?? 1) * edge!) / edge! } }),
      } as PointGeometry,
    ];
  }
  if (geometry.kind !== "area") return [geometry];
  const area = geometry as AreaGeometry;
  const c = alphaOf(area.fill);
  const fill: AreaGeometry = {
    ...area,
    fillOpacity: c > 0 ? at(area.fillOpacity * c) / c : area.fillOpacity,
    stroke: null,
  };
  return area.stroke ? [fill, ...over(outlineOf(area))] : [fill];
}
