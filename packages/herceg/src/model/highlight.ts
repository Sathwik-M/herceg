// Highlighting: a chart bound to a selection store draws the rows a
// channel selects as they are and dims the others (see row-selection.ts).
// Marks draw their own geometry, so layout, stacking, curves, and color
// stay as drawn without a selection; nothing here is in a chart that binds
// no store.
//
// - Points and bars: unselected rows dimmed, then selected rows on top,
//   each row drawn once. Their series keep their place in the list, so
//   grouped bars stay in their slots. Point series the GPU draws stay
//   clouds: two, of their unselected and selected rows.
// - Lines and areas: drawn as they are within the x spans of their runs of
//   selected rows and dimmed outside them, so each pixel is painted once and
//   the highlighted part is the same curve and stack. A line's selected rows
//   with no selected neighbor are dots. Lines whose x does not ascend, and
//   runs of rows at one x, draw whole and dimmed with their selected rows'
//   values over them instead.
// - Other marks draw every row as before.
//
// Memberships, splits, and masked values depend only on the selection and
// the data, so charts showing one selection share them.

import { compileExpression } from "../data/expression.ts";
import type { DataSelection, SelectionStore } from "../data/selection.ts";
import type { Table } from "../data/table.ts";
import { lineDrawing } from "../draw/line.ts";
import { pointDrawing } from "../draw/point.ts";
import { unmappable } from "../lod/m4.ts";
import { DIM, type Frame, type Mark, type MarkKey } from "../marks/mark.ts";
import { placeAt, rowOf, type Series } from "../marks/series.ts";
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
    const { at } = compileExpression(selection.expression, table);
    for (let row = from; row < selected.length; row++) if (at(row) === true) selected[row] = 1;
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
    const channel = this.#channels.find((c) => c.table === table);
    const selection = channel?.store.get(channel.channel);
    if (!selection || (selection.kind === "rows" && !selection.rows.current)) return undefined;
    return membership(table, selection);
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
  ): Geometry[] | undefined {
    const type = mark.spec.type;
    if (type !== "point" && type !== "bar" && type !== "line" && type !== "area") return undefined;
    const channel = this.#channels.find(({ table }) => table === mark.table);
    const selection = channel?.store.get(channel.channel);
    // Rows selected before the table was reset are gone: nothing is selected.
    if (!selection || (selection.kind === "rows" && !selection.rows.current)) return undefined;
    const selected = membership(channel!.table, selection);
    // Parts of series draw into buffers and keys of their own, hidden as their series are.
    const hidden = (suffix: string) =>
      frame.hidden.size === 0
        ? frame.hidden
        : new Set(series.filter((s) => frame.hidden.has(s.key)).map((s) => s.key + suffix));
    const own = (suffix: string): Frame => ({ ...frame, hidden: hidden(suffix), keyed: false });
    if (type === "point" || type === "bar") {
      const clouds: Geometry[] = [];
      let rest = series;
      if (type === "point" && frame.clouds && series.some((s) => s.length >= CLOUD_POINTS)) {
        const big = series.filter((s) => s.length >= CLOUD_POINTS);
        const drawn = (mark.geometry(big, frame, key) as PointGeometry[]).filter((g) => g.cloud);
        for (const g of drawn) {
          const s = big.find(({ key }) => key === g.key)!;
          clouds.push(...lightClouds(g, split(s, selected), selection, channel!.table));
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
    // Stacked areas draw their zeros at a log axis' low end.
    const low =
      type === "area" &&
      (mark.spec as { stack?: boolean }).stack === true &&
      frame.y.type === "log";
    const found = new Map<Series, Runs>();
    const runs = (s: Series) =>
      found.get(s) ?? found.set(s, runsOf(s, selected, frame, low)).get(s)!;
    const spansFor = new Map<Geometry, number[] | undefined>();
    // Series spans cannot say: their selected rows' values draw over them instead.
    const others: Series[] = [];
    for (const g of drawn) {
      const s = byKey.get(g.key);
      // Line ends are round caps, half a stroke past the last vertex.
      const stroke =
        g.kind === "line"
          ? (g as LineGeometry).strokeWidth
          : (g as AreaGeometry).stroke
            ? (g as AreaGeometry).strokeWidth
            : 0;
      const spans = s && spansOf(s, runs(s), frame, stroke / 2);
      spansFor.set(g, spans);
      if (!spans && s && !frame.hidden.has(s.key) && !others.includes(s)) others.push(s);
    }
    const lit = new Map<string, Geometry[]>();
    if (others.length > 0)
      for (const g of mark.geometry(
        others.map((s) => masked(s, selected)),
        own(ON),
        key,
      ))
        lit.set(g.key, [...(lit.get(g.key) ?? []), ...over(g)]);
    // In the mark's order, each part as it paints it: an area's fill, then its outline.
    const out: Geometry[] = [];
    for (const g of drawn) {
      const spans = spansFor.get(g);
      if (spans) {
        // Each pixel is painted once: dimmed outside the selected runs, as drawn inside them.
        for (const dimmed of dimLayer(g))
          out.push(clipped(dimmed, complement(spans, frame), frame));
        if (spans.length > 0) out.push(clipped(g, spans, frame));
        continue;
      }
      // Dimmed, then its selected rows' values over it, part by part.
      const [under, values] = [dimLayer(g), lit.get(g.key + ON) ?? []];
      for (let i = 0; i < Math.max(under.length, values.length); i++) {
        if (under[i]) out.push(under[i]!);
        if (values[i]) out.push(values[i]!);
      }
    }
    if (type === "line") out.push(...dots(series, runs, frame));
    return out;
  }
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
  let [i, j] = [0, 0];
  for (let k = 0; k < s.length; k++) {
    const row = rowOf(s, k);
    if (selected[row]) on[i++] = row;
    else off[j++] = row;
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
 * stack's or band's bases) missing, so the mark breaks its runs there.
 */
function masked(s: Series, selected: Uint8Array): Series {
  return {
    ...s,
    key: s.key + ON,
    y: mask(s.y, selected),
    y0: s.y0 && mask(s.y0, selected),
    // Indexes and streams follow the columns, not these values; edges draw a whole layer.
    field: undefined,
    stream: undefined,
    edges: undefined,
  };
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
function runsOf(s: Series, selected: Uint8Array, frame: Frame, low: boolean): Runs {
  const { rows, y0, edges } = s;
  const xOf = (k: number) => placeAt(s, "x", rowOf(s, k));
  let order: Uint32Array | undefined;
  if (!s.sorted && edges) {
    const placed: number[] = [];
    for (let k = 0; k < s.length; k++) if (Number.isFinite(xOf(k))) placed.push(k);
    order = Uint32Array.from(placed).sort((a, b) => xOf(a) - xOf(b));
  }
  const count = order ? order.length : s.length;
  const at = (i: number) => (order === undefined ? i : order[i]!);
  const [xMap, yMap] = [frame.x.mapping(), frame.y.mapping()];
  const { breaks } = frame.x;
  const onX = frame.x.type === "band" ? (v: number) => v >= 0 : (v: number) => !unmappable(xMap, v);
  const onY =
    frame.y.type === "band"
      ? (v: number) => v >= 0
      : (v: number) => (low && v === 0) || !unmappable(yMap, v);
  const drawn = (i: number) => {
    const row = rowOf(s, at(i));
    const x = placeAt(s, "x", row);
    if (!onX(x) || breaks?.hides(x)) return false;
    return (
      edges !== undefined || (onY(placeAt(s, "y", row)) && (y0 === undefined || onY(y0[row]!)))
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
 * The pixel spans along x of a series' runs of selected rows, in x order,
 * as pairs: from a run's first row to its last, ascending and merged where
 * they touch, at least a pixel wide. Where a run ends a path, its span
 * reaches `cap` pixels further, over the line's round cap. A layer of a
 * stack drawn through its edges (a series field's) fills x positions other
 * layers have too: its runs reach the stack's ends past its own first and
 * last rows. Undefined where spans cannot say what is selected: a line
 * whose x does not ascend, or rows at one x drawn as a vertical run, all
 * selected or some at a run's end.
 */
function spansOf(s: Series, found: Runs, frame: Frame, cap: number): number[] | undefined {
  const edges = s.edges;
  if (!s.sorted && !edges) return undefined;
  const { at, drawn, shown, count: n } = found;
  const xAt = (i: number) => placeAt(s, "x", rowOf(s, at(i)));
  // Pixel pairs, in x order, which is pixel order or (reversed axes) its reverse.
  const runs: number[] = [];
  for (let r = 0; r < found.runs.length; r += 2) {
    const [start, end] = [found.runs[r]!, found.runs[r + 1]!];
    let [from, to] = [xAt(start), xAt(end)];
    // Other rows drawn at a run's end, past breaks too: no span tells their segments apart.
    for (let j = start - 1; j >= 0 && xAt(j) === from; j--) if (drawn(j)) return undefined;
    for (let j = end + 1; j < n && xAt(j) === to; j++) if (drawn(j)) return undefined;
    if (edges && edges.x.length > 0) {
      if (start === 0) from = Math.min(from, edges.x[0]!);
      if (end === n - 1) to = Math.max(to, edges.x[edges.x.length - 1]!);
    }
    // A row alone is a dot.
    if (start === end && from === to) continue;
    if (from === to) return undefined;
    let [a, b] = [frame.x.map(from), frame.x.map(to)];
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

/** The plot's x outside `spans` (ascending pairs), as pairs. */
function complement(spans: readonly number[], frame: Frame): number[] {
  const { plot } = frame;
  const out: number[] = [];
  let from = plot.x - 1;
  for (let i = 0; i < spans.length; i += 2) {
    if (spans[i]! > from) out.push(from, spans[i]!);
    from = Math.max(from, spans[i + 1]!);
  }
  const end = plot.x + plot.width + 1;
  if (end > from) out.push(from, end);
  return out;
}

/** A geometry drawn only over x spans (pairs of pixels), across the plot's height. */
function clipped(geometry: Geometry, spans: readonly number[], frame: Frame): Geometry {
  const { plot } = frame;
  const draw = geometry.draw as Drawing<Geometry> & { canvas: DataCanvas };
  const id = `herceg-runs-${++clips}`;
  const drawing: Drawing<Geometry> = {
    size: draw.size,
    svg(g, context) {
      let rects = "";
      for (let i = 0; i < spans.length; i += 2)
        rects += `<rect x="${spans[i]}" y="${plot.y}" width="${spans[i + 1]! - spans[i]!}" height="${plot.height}"/>`;
      return `<clipPath id="${id}">${rects}</clipPath><g clip-path="url(#${id})">${draw.svg(g, context)}</g>`;
    },
    canvas(context, g, options) {
      context.save();
      context.beginPath();
      for (let i = 0; i < spans.length; i += 2)
        context.rect(spans[i]!, plot.y, spans[i + 1]! - spans[i]!, plot.height);
      context.clip();
      draw.canvas(context, g, options);
      context.restore();
    },
  };
  return { ...geometry, key: `${geometry.key}${ON}${id}`, draw: drawing };
}

type DataCanvas = Extract<Drawing<Geometry>, { canvas: unknown }>["canvas"];

/** Dots at runs of one row drawn, which no span shows. */
function dots(series: readonly Series[], runs: (s: Series) => Runs, frame: Frame): PointGeometry[] {
  const out: PointGeometry[] = [];
  for (const s of series) {
    if (frame.hidden.has(s.key)) continue;
    const coords: number[] = [];
    const found = runs(s);
    for (let r = 0; r < found.runs.length; r += 2) {
      if (found.runs[r] !== found.runs[r + 1]) continue;
      const row = rowOf(s, found.at(found.runs[r]!));
      coords.push(frame.x.map(placeAt(s, "x", row)), frame.y.map(placeAt(s, "y", row)));
    }
    if (coords.length === 0) continue;
    out.push({
      kind: "point",
      draw: pointDrawing,
      key: `${s.key}${ON}-dots`,
      fill: s.color,
      fillOpacity: 1,
      opaque: false,
      radius: Math.max(2.5, frame.theme.lineWidth * 1.5),
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
    const dimmed: RectGeometry = { ...rects, fillOpacity: rects.fillOpacity * DIM };
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
 * A line's or area's geometry dimmed: an area's fill at a fraction of its
 * opacity, its outline drawn apart as a dimmed line, since areas paint
 * their outline at full opacity.
 */
function dimLayer(geometry: Geometry): Geometry[] {
  if (geometry.kind !== "area") return [dim(geometry)];
  const area = geometry as AreaGeometry;
  const fill: AreaGeometry = { ...area, fillOpacity: area.fillOpacity * DIM, stroke: null };
  return area.stroke ? [fill, dim(outlineOf(area))] : [fill];
}

/** An area's outline as a line of its own, which areas otherwise paint opaque. */
function outlineOf(area: AreaGeometry): LineGeometry {
  return {
    kind: "line",
    key: `${area.key}-outline`,
    draw: lineDrawing,
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
    svg: (geometry, context) => `<g opacity="${fraction}">${draw.svg(geometry, context)}</g>`,
    elements:
      elements &&
      ((geometry, context) =>
        elements(geometry, context)?.map(({ tag, attributes }) => ({
          tag,
          attributes: { ...attributes, opacity: String(fraction) },
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
    const c = alphaOf(line.stroke);
    return [
      c >= 1 || c <= 0
        ? line
        : {
            ...line,
            draw: faded(line.draw as Drawing<Geometry>, at(c) / c) as LineGeometry["draw"],
          },
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

/**
 * A CSS color's own alpha: of `transparent`, `#rgba` and `#rrggbbaa`, and
 * functions with one (`rgba(…)`, `rgb(… / a)`, `oklch(… / a)`); 1 for
 * others, named colors and variables, which are taken as opaque.
 */
function alphaOf(color: string): number {
  const c = color.trim().toLowerCase();
  if (c === "transparent") return 0;
  const hex = /^#(?:[0-9a-f]{3}([0-9a-f])|[0-9a-f]{6}([0-9a-f]{2}))$/.exec(c);
  if (hex)
    return hex[1] ? Number.parseInt(hex[1] + hex[1], 16) / 255 : Number.parseInt(hex[2]!, 16) / 255;
  const args = /^[a-z-]+\((.*)\)$/.exec(c)?.[1];
  if (args === undefined) return 1;
  const slash = args.lastIndexOf("/");
  const parts = args.split(",");
  const alpha = slash >= 0 ? args.slice(slash + 1) : parts.length === 4 ? parts[3]! : undefined;
  if (alpha === undefined) return 1;
  const value = Number.parseFloat(alpha) / (alpha.trim().endsWith("%") ? 100 : 1);
  return value >= 0 && value <= 1 ? value : 1;
}
