// The rows a chart's gestures select, for charts bound to selection stores
// (see row-selection.ts). A brush's ranges become a condition on the fields
// of the marks it covers, which rows appended later meet or not; where no
// condition says what is drawn (a stack's tops), and for lassos and
// clicks, the rows themselves. Each table is selected on its own: nothing
// joins tables.
//
// Rules, per table:
// - A row is in a brush when its place along each brushed axis is in the
//   brush's range there: its field's value, or for marks drawing a span
//   (error bars, bands, candles) the span overlapping the range. Several y
//   fields of a mark are its series: a row is in when any shown one is.
//   Rows of every mark of the table in the brushed panels are selected.
// - On category axes the condition lists the brushed categories' values
//   (labels, or the numbers or times of banded fields), never band indices.
// - Series hidden through the legend leave the condition; a row view's
//   filter joins it; facet panels the brush leaves out (panels with x
//   scales of their own) leave their rows out.
// - A stack's rows are drawn at their tops, not their values: a brush
//   along a stack's value axis selects the rows drawn in it, as a row set,
//   and then the table's whole selection is a row set. So do calendar
//   heatmaps, whose weekdays and months no field holds.
// - Histograms are brushed along their bins' axis, box plots and violins
//   along their categories' (the chart refuses the others; see `check` in
//   row-selection.ts).
// - A lasso selects the rows whose drawn point is inside it: a point's
//   center, a line's or area's vertex, a bar's end, a span's middle, a
//   cell's center. Rows not drawn (a point missing a value it encodes, a
//   time inside an axis break) are not selected by lassos or clicks.
// - A click selects the row of the point or bar under the pointer, the
//   rows a histogram bin counts, those of a box plot's or violin's group,
//   or those of a heatmap's cell. A summary's index is never a row.

import { compileExpression, Expr, type Expression } from "../data/expression.ts";
import { RowSet } from "../data/row-set.ts";
import { type DataSelection, selectRows, selectWhere } from "../data/selection.ts";
import type { Table } from "../data/table.ts";
import type { BarMark } from "../marks/bar.ts";
import type { HistogramMark } from "../marks/histogram.ts";
import type { BandList, Frame, Mark } from "../marks/mark.ts";
import { type BandPlaces, placeAt, rowOf, type Series } from "../marks/series.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { ChartModel, DrawnPanel } from "./model.ts";

/**
 * What a brush selected, in data values (as the chart keeps it: see
 * dom/brushed.ts): ranges along x and y, ascending (whole band places on
 * category axes), and a lasso's outline.
 */
export interface Brushed {
  readonly x: readonly [number, number] | null;
  readonly y: readonly [number, number] | null;
  readonly lasso: readonly (readonly [number, number])[] | null;
}

/** Marks whose rows a chart selects: those drawing rows along x and y. */
const SELECTS = new Set([
  "line",
  "area",
  "bar",
  "point",
  "errorbar",
  "candlestick",
  "histogram",
  "boxplot",
  "violin",
  "heatmap",
]);

/** Marks drawing areas of the plot, whose rows are clicked inside them. */
const REGIONS = new Set(["bar", "histogram", "boxplot", "violin", "heatmap"]);

/** Pixels from a point's edge a click may land and still select it. */
const CLICK_SLOP = 4;

/** A series a panel draws, with the scales it is drawn with. */
interface Drawn {
  mark: Mark;
  series: Series;
  panel: DrawnPanel;
  x: PositionScale;
  y: PositionScale;
  hidden: boolean;
}

/** Where a row is placed along an axis: a field's value, or the span between two values. */
type Place = { field: string } | { low: Expression; high: Expression };

/** What one series of a mark places along x and y; `id` names the series, for marks of several fields. */
interface Reading {
  id?: string;
  x?: Place;
  y?: Place;
}

/** The series of the marks over `table` (any table without one) that `panels` draw, in drawing order. */
function drawnIn(model: ChartModel, panels: readonly DrawnPanel[], table?: Table): Drawn[] {
  const out: Drawn[] = [];
  for (const panel of panels) {
    for (const series of model.panelSeries(panel.key)) {
      const mark = model.markOf(series);
      if (!mark || !SELECTS.has(mark.spec.type) || (table && mark.table !== table)) continue;
      const y = model.onRight(series) ? panel.yRight : panel.y;
      if (!y) continue;
      out.push({ mark, series, panel, x: panel.x, y, hidden: model.hidden.has(series.key) });
    }
  }
  return out;
}

/** The source a series key names: the field or category it was split by (see `seriesKey`). */
function sourceOf(series: Series): string {
  return String((JSON.parse(series.key) as unknown[])[1]);
}

const field = (name: string): Place => ({ field: name });
const list = (fields: string | readonly string[]) =>
  typeof fields === "string" ? [fields] : [...fields];

/** What a mark's series place along x and y, as conditions read them. */
function readingsOf(mark: Mark): Reading[] {
  const spec = mark.spec as unknown as Record<string, string | readonly string[] | undefined>;
  const f = (name: string) => ["field", spec[name] as string] as const;
  const along = mark.tooltip === "y" ? "y" : "x";
  const across = along === "x" ? "y" : "x";
  // Several fields on the value axis are a series each, unless a series field splits rows.
  const byField = (position: Place, values: readonly string[]): Reading[] =>
    spec.series === undefined && values.length > 1
      ? values.map((name) => ({ id: name, [along]: position, [across]: field(name) }))
      : [{ [along]: position, [across]: field(values[0]!) }];
  switch (mark.spec.type) {
    case "line":
    case "point":
      return byField(field(spec.x as string), list(spec.y!));
    case "area":
      return spec.y1 !== undefined
        ? [{ x: field(spec.x as string), y: { low: f("y1"), high: f("y2") } }]
        : byField(field(spec.x as string), list(spec.y!));
    case "bar":
      return byField(field(list(spec[along]!)[0]!), list(spec[across]!));
    case "errorbar": {
      const position = field(spec[along] as string);
      const [a, b] = along === "x" ? ["y1", "y2"] : ["x1", "x2"];
      const error = along === "x" ? "yError" : "xError";
      const span: Place =
        spec[a] !== undefined
          ? { low: f(a), high: f(b) }
          : { low: ["-", f(across), f(error)], high: ["+", f(across), f(error)] };
      return [{ [along]: position, [across]: span }];
    }
    case "candlestick":
      return [{ x: field(spec.x as string), y: { low: f("low"), high: f("high") } }];
    case "histogram":
      return [{ x: field(spec.x as string) }];
    case "boxplot":
    case "violin":
      return [{ [along]: field(spec[along] as string) }];
    case "heatmap":
      return [{ x: field(spec.x as string), y: field(spec.y as string) }];
    default:
      return [];
  }
}

/** Whether the mark stacks its values, so they are drawn at the stack's tops. */
function stacked(mark: Mark): boolean {
  return (mark.spec as { stack?: boolean }).stack === true;
}

/** Whether a series' zeros are drawn at its log y axis' low end, as stacked areas draw them. */
function zeroAtLow(d: Drawn): boolean {
  return d.y.type === "log" && d.mark.spec.type === "area" && stacked(d.mark);
}

/** Where a row's y is drawn: its place, or a stacked area's zero at a log axis' low end. */
function drawnY(d: Drawn, row: number): number {
  const y = placeAt(d.series, "y", row);
  return y === 0 && zeroAtLow(d) ? Math.min(...d.y.domain) : y;
}

/** The axis a mark's values are measured along: y, or x for marks placed along y. */
function valueAxis(mark: Mark): "x" | "y" {
  return mark.tooltip === "y" ? "x" : "y";
}

/** The values of bands `from` to `to` of an axis, as its field holds them: labels, numbers, or times. */
function bandValues(
  bands: BandList | undefined,
  places: BandPlaces | undefined,
  from: number,
  to: number,
): (string | number)[] {
  const values: (string | number)[] = [];
  for (let place = from; place <= to; place++) {
    const band = places ? places.band(place) : place;
    const key = bands?.keys[band];
    if (key === undefined) continue;
    values.push(key.startsWith("c:") ? key.slice(2) : Number(key.slice(2)));
  }
  return values;
}

/** The condition that a row's place is within `range` of an axis drawn with `scale`. */
function within(
  place: Place,
  range: readonly [number, number],
  scale: PositionScale,
  bands: () => (string | number)[],
): Expression {
  const [a, b] = range;
  if (scale.type === "band") {
    if (!("field" in place)) throw new Error("A span cannot be placed on a category axis");
    const values = bands();
    return values.length === 0 ? false : ["in", ["field", place.field], ...values];
  }
  if ("field" in place)
    return ["and", [">=", ["field", place.field], a], ["<=", ["field", place.field], b]];
  // A span overlaps the range: it starts before the range ends and ends after it starts.
  return [
    "and",
    ["<=", ["min", place.low, place.high], b],
    [">=", ["max", place.low, place.high], a],
  ];
}

const all = (parts: Expression[]): Expression =>
  parts.length === 0 ? true : parts.length === 1 ? parts[0]! : ["and", ...parts];
const any = (parts: Expression[]): Expression =>
  parts.length === 0 ? false : parts.length === 1 ? parts[0]! : ["or", ...parts];

/**
 * A range of the left y axis as the same pixels read on the axis `y` (the
 * right one). A range of categories covers their slots, as the brush draws
 * it: half a step past their centers, within the axis.
 */
function onAxis(
  range: readonly [number, number],
  left: PositionScale,
  y: PositionScale,
): readonly [number, number] {
  if (y === left) return range;
  let [lo, hi] = [
    Math.min(...range.map((v) => left.map(v))),
    Math.max(...range.map((v) => left.map(v))),
  ];
  if (left.type === "band") {
    const half = Math.abs(left.map(1) - left.map(0)) / 2;
    lo = Math.max(Math.min(...left.range), lo - half);
    hi = Math.min(Math.max(...left.range), hi + half);
  }
  const [a, b] = [y.invert(lo), y.invert(hi)];
  return a <= b ? [a, b] : [b, a];
}

/**
 * The condition that a row is among the facet panels `keys` (those a brush
 * covers, when it covers only some), for a mark split by the facet's fields.
 */
function panelCondition(model: ChartModel, mark: Mark, keys: readonly string[]): Expression {
  const facet = model.config.facet;
  if (!facet?.splits(mark)) return true;
  const fields = facet.fields;
  if (keys.length === model.panels().length) return true;
  return any(
    keys.map((key) => {
      const values = fields.length === 1 ? [key] : (JSON.parse(key) as string[]);
      return all(fields.map((name, i): Expression => ["==", ["field", name], values[i]!]));
    }),
  );
}

/** A row view's filter as a condition, or true for a mark over its whole table. */
function viewCondition(mark: Mark): Expression {
  const filter = mark.view?.query.filter;
  if (filter === undefined) return true;
  return filter instanceof Expr ? filter.expression : filter;
}

/**
 * The condition a range brush puts on `mark`'s rows (drawn as `parts`),
 * or "rows" when only its drawn rows can say what the brush covers (a
 * stack brushed along its values).
 */
function brushCondition(
  model: ChartModel,
  mark: Mark,
  parts: readonly Drawn[],
  selection: Brushed,
  keys: readonly string[],
): Expression | "rows" {
  const value = valueAxis(mark);
  // A stack is drawn at its tops, a calendar's days by their weekday or
  // month, and a view's row set is no condition: their drawn rows say.
  const calendar = (mark.spec as { date?: string }).date !== undefined;
  if ((stacked(mark) && selection[value]) || calendar || mark.view?.restriction) return "rows";
  const [first] = parts;
  const shown = parts.filter((d) => !d.hidden);
  if (!first || shown.length === 0) return false;
  const ids = new Set(shown.map(({ series }) => sourceOf(series)));
  const seriesField = (mark.spec as { series?: string }).series;
  const readings = readingsOf(mark).filter((r) => r.id === undefined || ids.has(r.id));
  // What the brush puts on the rows drawn as `d`, read through its panel's scales.
  const condition = (d: Drawn) =>
    any(
      readings.map((reading) => {
        const parts: Expression[] = [];
        for (const axis of ["x", "y"] as const) {
          const range = selection[axis];
          if (!range) continue;
          const place = reading[axis];
          if (!place)
            throw new Error(`A ${mark.spec.type} mark's rows cannot be brushed along ${axis} yet`);
          const scale = axis === "x" ? d.x : d.y;
          const ranged = axis === "y" ? onAxis(range, d.panel.y, scale) : range;
          const bands = () =>
            bandValues(model.bands[axis], d.series.places?.[axis], range[0], range[1]);
          parts.push(within(place, ranged, scale, bands));
        }
        return all(parts);
      }),
    );
  // On right axes, which panels may have of their own, each panel's rows meet
  // the brush's range as read on that panel's axis.
  const own = new Map<string, Drawn>();
  if (selection.y && first.y !== first.panel.y)
    for (const d of shown) if (!own.has(d.panel.key)) own.set(d.panel.key, d);
  const conditions =
    own.size > 1
      ? [...own].map(([key, d]) => all([condition(d), panelCondition(model, mark, [key])]))
      : [condition(first)];
  const restrictions: Expression[] = [];
  // Series hidden through the legend leave the selection.
  if (seriesField !== undefined && shown.length < parts.length) {
    restrictions.push(["in", ["field", seriesField], ...ids]);
  }
  const view = viewCondition(mark);
  if (view !== true) restrictions.push(view);
  const panels = panelCondition(model, mark, keys);
  if (panels !== true) restrictions.push(panels);
  return all([any(conditions), ...restrictions]);
}

/** Whether a value is in a range (a band's place in a range of places); always without one. */
function inRange(value: number, range: readonly [number, number] | null): boolean {
  return !range || (value >= range[0] && value <= range[1]);
}

/**
 * The rows of `parts` drawn inside a range brush, for stacks brushed along
 * their values and for calendars: where each row is placed, its stack's top
 * on the value axis, or its cell's center.
 */
function rowsInRanges(parts: readonly Drawn[], selection: Brushed, out: number[]): void {
  for (const d of parts) {
    if (d.hidden) continue;
    const y = selection.y && onAxis(selection.y, d.panel.y, d.y);
    const s = d.series;
    // A calendar's cells are found at their centers (see `anchorOf`), read back as values.
    const cells = d.mark.tooltip === "cell";
    const frame = { x: d.x, y: d.y } as Frame;
    const value = (scale: PositionScale, pixel: number) =>
      scale.type === "band" ? Math.round(scale.invert(pixel)) : scale.invert(pixel);
    for (let k = 0; k < s.length; k++) {
      const row = rowOf(s, k);
      if (!drawnRow(d, row)) continue;
      const anchor = cells ? d.mark.pointAnchor!(s, row, frame) : undefined;
      if (cells && !anchor) continue;
      const at = anchor ? value(d.x, anchor[0]) : placeAt(s, "x", row);
      const top = anchor ? value(d.y, anchor[1]) : drawnY(d, row);
      if (
        Number.isFinite(at) &&
        Number.isFinite(top) &&
        inRange(at, selection.x) &&
        inRange(top, y)
      )
        out.push(row);
    }
  }
}

/**
 * What a brush (a range, a rectangle, or a lasso) in the panels `keys`
 * selects of `table`'s rows; undefined when no mark of the table is drawn
 * in them, so its selection stays as it is.
 */
export function brushedRows(
  model: ChartModel,
  table: Table,
  selection: Brushed,
  keys: readonly string[] | null,
): DataSelection | undefined {
  const panels = model.panels().filter(({ key }) => !keys || keys.includes(key));
  // Summaries' rows are not where their statistics are drawn: lassos, and
  // brushes along their statistics, select none of them (charts refuse
  // such gestures; a selection set through `select` may still be one).
  const drawn = drawnIn(model, panels, table).filter(
    ({ mark }) => !mark.summarizes || (!selection.lasso && !selection[valueAxis(mark)]),
  );
  if (drawn.length === 0) return undefined;
  if (selection.lasso) return selectRows(lassoed(model, drawn, selection.lasso, table));
  const owners = keys ?? panels.map(({ key }) => key);
  const marks = [...new Set(drawn.map(({ mark }) => mark))];
  const conditions: Expression[] = [];
  const rows: number[] = [];
  let snapshot = false;
  for (const mark of marks) {
    const parts = drawn.filter((d) => d.mark === mark);
    const condition = brushCondition(model, mark, parts, selection, owners);
    if (condition === "rows") {
      snapshot = true;
      rowsInRanges(parts, selection, rows);
    } else conditions.push(condition);
  }
  const condition = any(conditions);
  if (!snapshot) return selectWhere(condition);
  // One stack needs rows, so the table's selection is rows: those meeting
  // the other marks' conditions as well.
  if (conditions.length > 0) {
    const { at } = compileExpression(condition, table);
    for (let row = 0; row < table.length; row++) if (at(row) === true) rows.push(row);
  }
  return selectRows(new RowSet(table).addAll(rows));
}

/** The series of one mark in one panel, and what the mark's own lookups read of the panel. */
interface MarkParts {
  mark: Mark;
  parts: Drawn[];
  series: Series[];
  frame: Frame;
}

/** `drawn` by mark and panel, in drawing order. */
function byMark(model: ChartModel, drawn: readonly Drawn[]): MarkParts[] {
  const out: MarkParts[] = [];
  for (const d of drawn) {
    let entry = out.find((e) => e.mark === d.mark && e.parts[0]!.panel === d.panel);
    if (!entry) {
      // What marks' lookups (picks, anchors) read of a frame: scales, plot, hidden series.
      const frame = { x: d.x, y: d.y, plot: d.panel.plot, hidden: model.hidden };
      entry = { mark: d.mark, parts: [], series: [], frame: frame as unknown as Frame };
      out.push(entry);
    }
    entry.parts.push(d);
    entry.series.push(d.series);
  }
  return out;
}

/**
 * The pixel a row of a drawn series is at, as lassos and clicks test it:
 * where the mark says (a grouped bar's end), or else at its values, a
 * span's middle; undefined when it is not drawn.
 */
function anchorOf(entry: MarkParts, d: Drawn, row: number): readonly [number, number] | undefined {
  const { mark } = entry;
  const s = d.series;
  if (mark.spec.type === "bar") return barAnchor(mark as unknown as BarMark, entry, s, row);
  if (!drawnRow(d, row)) return undefined;
  // A heatmap's cell is at its center, which its value need not be.
  if (mark.tooltip === "cell") return mark.pointAnchor!(s, row, entry.frame);
  const along = mark.tooltip === "y" ? "y" : "x";
  const low = s.range ? (along === "y" ? s.x0 : s.y0)?.[row] : undefined;
  const middle = (axis: "x" | "y") => {
    const at = axis === "y" ? drawnY(d, row) : placeAt(s, axis, row);
    return low !== undefined && axis !== along ? (at + low) / 2 : at;
  };
  const px = d.x.map(middle("x"));
  const py = d.y.map(middle("y"));
  return Number.isFinite(px) && Number.isFinite(py) ? [px, py] : undefined;
}

/**
 * Whether a row of a drawn series is drawn: placed on both axes (a band
 * for category axes), shown by its mark (a point whose encoded values are
 * there, a candle with its prices), and not inside an axis break.
 */
function drawnRow(d: Drawn, row: number): boolean {
  const { series: s, mark } = d;
  // Placed by its scale: a band for category axes, a positive value on log
  // axes, where stacked areas draw their zeros at the low end.
  const placed = (value: number, scale: PositionScale, zero = false) =>
    scale.type === "band" ? value >= 0 : Number.isFinite(scale.map(value)) || (zero && value === 0);
  const low = zeroAtLow(d);
  if (!placed(placeAt(s, "x", row), d.x) || !placed(placeAt(s, "y", row), d.y, low)) return false;
  // Lower ends too, of ranges (error bars, bands) and of stacked areas (bars
  // without a placed base grow from the axis' end).
  const area = s.range || (mark.spec.type === "area" && stacked(mark));
  if (area && ((s.y0 && !placed(s.y0[row]!, d.y, low)) || (s.x0 && !placed(s.x0[row]!, d.x))))
    return false;
  if (d.x.breaks?.hides(placeAt(s, "x", row))) return false;
  // A heatmap's row without a value colors no cell.
  if (mark.tooltip === "cell" && !Number.isFinite(s.values[row]!)) return false;
  return mark.shows?.(s, row, d.y) ?? true;
}

/** The rows of drawn series whose point is inside a lasso, an outline in data values. */
function lassoed(
  model: ChartModel,
  drawn: readonly Drawn[],
  outline: NonNullable<Brushed["lasso"]>,
  table: Table,
): RowSet {
  const found: number[] = [];
  for (const entry of byMark(model, drawn)) {
    const { panel } = entry.parts[0]!;
    const { plot } = panel;
    const polygon = outline.map(([x, y]) => [panel.x.map(x), panel.y.map(y)] as const);
    const xs = polygon.map(([x]) => x);
    const ys = polygon.map(([, y]) => y);
    const [left, right] = [Math.min(...xs, plot.x + plot.width), Math.max(...xs, plot.x)];
    const [top, bottom] = [Math.min(...ys, plot.y + plot.height), Math.max(...ys, plot.y)];
    // Only the plot's part of the outline selects: what is outside the plot is not drawn.
    const box = {
      left: Math.max(left, plot.x),
      right: Math.min(right, plot.x + plot.width),
      top: Math.max(top, plot.y),
      bottom: Math.min(bottom, plot.y + plot.height),
    };
    for (const d of entry.parts) {
      if (d.hidden) continue;
      const s = d.series;
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        const point = anchorOf(entry, d, row);
        if (!point) continue;
        const [px, py] = point;
        if (px < box.left || px > box.right || py < box.top || py > box.bottom) continue;
        if (inside(polygon, px, py)) found.push(row);
      }
    }
  }
  return new RowSet(table).addAll(found);
}

/** Whether a pixel is inside a polygon, by the even-odd rule. */
function inside(polygon: readonly (readonly [number, number])[], px: number, py: number): boolean {
  let odd = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i]!;
    const [xj, yj] = polygon[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) odd = !odd;
  }
  return odd;
}

/** Rows a click or the keyboard selects: those of one point of a mark over `table`. */
export interface PointRows {
  table: Table;
  rows: Uint32Array;
}

/**
 * The rows of the point drawn under a pixel, among marks over `tables`:
 * the topmost mark's, inside a bar, bin, box, violin, or cell, or within a
 * few pixels of a point or vertex. Undefined over none.
 */
export function clickedRows(
  model: ChartModel,
  tables: ReadonlySet<Table>,
  px: number,
  py: number,
): PointRows | undefined {
  const panel = model.panels().find(({ plot }) => contains(plot, px, py));
  if (!panel) return undefined;
  const drawn = drawnIn(model, [panel]).filter(
    (d) => !d.hidden && d.mark.table && tables.has(d.mark.table),
  );
  // Marks drawn later are on top.
  for (const entry of byMark(model, drawn).reverse()) {
    const { mark, series, frame } = entry;
    let found: { series: Series; position: number } | undefined;
    const type = mark.spec.type;
    if (type === "bar") found = barHit(mark as unknown as BarMark, entry, px, py);
    else if (type === "histogram") found = binHit(mark as unknown as HistogramMark, entry, px, py);
    else if (REGIONS.has(type)) {
      // Boxes, violins, and cells pick what is under the pointer at distance 0.
      const hit = mark.pick?.(series, px, py, frame);
      if (hit?.distance === 0) found = hit;
    } else {
      const reach = Math.max(mark.inset?.x ?? 0, mark.inset?.y ?? 0, 3) + CLICK_SLOP;
      found = nearest(entry, px, py, reach);
    }
    if (found) return rowsOf(model, mark, found.series, found.position, panel);
  }
  return undefined;
}

/** The point of a mark's series nearest a pixel, within `reach` pixels of it. */
function nearest(
  entry: MarkParts,
  px: number,
  py: number,
  reach: number,
): { series: Series; position: number } | undefined {
  let best: { series: Series; position: number } | undefined;
  let distance = reach;
  for (const d of entry.parts) {
    const s = d.series;
    let [start, end] = [0, s.length];
    // Sorted series need only the points within reach along x.
    if (s.sorted && d.x.type !== "band") {
      const [a, b] = [d.x.invert(px - reach), d.x.invert(px + reach)];
      start = lower(s, Math.min(a, b));
      end = lower(s, Math.max(a, b), true);
    }
    const glyph = entry.mark.reach;
    for (let k = start; k < end; k++) {
      const row = rowOf(s, k);
      const point = anchorOf(entry, d, row);
      if (!point) continue;
      const away = Math.hypot(point[0] - px, point[1] - py);
      // Glyphs sized by a field are clicked within their own size.
      const within = glyph ? glyph.call(entry.mark, row) + CLICK_SLOP : reach;
      if (away <= Math.min(distance, within)) {
        distance = away;
        best = { series: s, position: k };
      }
    }
  }
  return best;
}

/** The scales a bar mark's bars are placed along and measured across, and the shown series. */
function barAxes(mark: BarMark, entry: MarkParts) {
  const { frame } = entry;
  const horizontal = mark.tooltip === "y";
  return {
    horizontal,
    along: horizontal ? frame.y : frame.x,
    across: horizontal ? frame.x : frame.y,
    visible: entry.series.filter((s) => !frame.hidden.has(s.key)),
  };
}

/** The middle of a bar's end, where lassos find it, among its grouped neighbors. */
function barAnchor(
  mark: BarMark,
  entry: MarkParts,
  s: Series,
  row: number,
): readonly [number, number] | undefined {
  const { horizontal, along, across, visible } = barAxes(mark, entry);
  const group = visible.indexOf(s);
  const ends = group < 0 ? undefined : mark.ends(s, row, along, across);
  if (!ends) return undefined;
  const { width, offset } = mark.placement(visible, along);
  const middle = ends.center + offset(group) + width / 2;
  return horizontal ? [ends.tip, middle] : [middle, ends.tip];
}

/** The bar under a pixel: the topmost, as later series and rows are drawn over earlier ones. */
function barHit(
  mark: BarMark,
  entry: MarkParts,
  px: number,
  py: number,
): { series: Series; position: number } | undefined {
  const { horizontal, along, across, visible } = barAxes(mark, entry);
  const [pa, pc] = horizontal ? [py, px] : [px, py];
  const { width, offset } = mark.placement(visible, along);
  for (let group = visible.length - 1; group >= 0; group--) {
    const s = visible[group]!;
    const from = offset(group);
    const [start, end] = mark.range(s, entry.frame);
    for (let k = end - 1; k >= start; k--) {
      const ends = mark.ends(s, rowOf(s, k), along, across);
      if (!ends) continue;
      const { center, tip, root } = ends;
      if (
        pa >= center + from &&
        pa <= center + from + width &&
        pc >= Math.min(tip, root) &&
        pc <= Math.max(tip, root)
      )
        return { series: s, position: k };
    }
  }
  return undefined;
}

/** The histogram bin under a pixel, between its edges and from its base to its top: the topmost series'. */
function binHit(
  mark: HistogramMark,
  entry: MarkParts,
  px: number,
  py: number,
): { series: Series; position: number } | undefined {
  const { x, y, hidden } = entry.frame;
  const zero = y.type === "log" ? y.range[0] : y.map(0);
  for (let i = entry.series.length - 1; i >= 0; i--) {
    const s = entry.series[i]!;
    if (hidden.has(s.key)) continue;
    const edges = mark.edgesOf(s);
    for (let b = 0; b < s.length; b++) {
      const [a, c] = [x.map(edges[b]!), x.map(edges[b + 1]!)];
      if (!(px >= Math.min(a, c) && px <= Math.max(a, c))) continue;
      const tip = y.map(s.y[b]!);
      const root = s.y0 ? y.map(s.y0[b]!) : zero;
      if (py >= Math.min(tip, root) && py <= Math.max(tip, root)) return { series: s, position: b };
    }
  }
  return undefined;
}

/** The first position whose x is at least (`past`: more than) `value`, in a sorted series. */
function lower(s: Series, value: number, past = false): number {
  let lo = 0;
  let hi = s.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const x = s.x[rowOf(s, mid)]!;
    if (x < value || (past && x === value)) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function contains(plot: DrawnPanel["plot"], px: number, py: number): boolean {
  return px >= plot.x && px <= plot.x + plot.width && py >= plot.y && py <= plot.y + plot.height;
}

/**
 * The rows the keyboard cursor is on: the point at `position` of the
 * series keyed `key` in panel `panel`, when its mark is over one of `tables`.
 */
export function cursorRows(
  model: ChartModel,
  tables: ReadonlySet<Table>,
  cursor: { panel: string; key: string; position: number },
): PointRows | undefined {
  const panel = model.panels().find(({ key }) => key === cursor.panel);
  const drawn = panel && drawnIn(model, [panel]).find((d) => d.series.key === cursor.key);
  if (!drawn?.mark.table || !tables.has(drawn.mark.table) || drawn.hidden) return undefined;
  const { position } = cursor;
  if (!(position >= 0 && position < drawn.series.length)) return undefined;
  if (!drawnRow(drawn, rowOf(drawn.series, position))) return undefined;
  return rowsOf(model, drawn.mark, drawn.series, cursor.position, panel!);
}

/**
 * The table rows a point of a series is: its row, the rows a summary's
 * point summarizes (a bin, a group) in its panel, or every row of a
 * heatmap's cell.
 */
function rowsOf(
  model: ChartModel,
  mark: Mark,
  series: Series,
  position: number,
  panel: DrawnPanel,
): PointRows {
  const table = mark.table!;
  const row = rowOf(series, position);
  if (!mark.summarizes && mark.tooltip !== "cell") return { table, rows: Uint32Array.of(row) };
  const found: number[] = [];
  if (mark.tooltip === "cell") {
    // Every row drawn in the cell (with a value), not only the one it shows.
    const [x, y] = [series.x[row]!, series.y[row]!];
    for (let k = 0; k < series.length; k++) {
      const other = rowOf(series, k);
      if (series.x[other] === x && series.y[other] === y && Number.isFinite(series.values[other]!))
        found.push(other);
    }
    return { table, rows: Uint32Array.from(found) };
  }
  const member = mark.summarized!(series, position);
  const condition = panelCondition(model, mark, [panel.key]);
  const shown = condition === true ? undefined : compileExpression(condition, table).at;
  const view = mark.view?.read().indices;
  const length = view ? view.length : table.length;
  for (let k = 0; k < length; k++) {
    const at = view ? view[k]! : k;
    if (member(at) && (!shown || shown(at) === true)) found.push(at);
  }
  return { table, rows: Uint32Array.from(found) };
}
