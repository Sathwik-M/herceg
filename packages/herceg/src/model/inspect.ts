// Inspection: finding the data under a pointer or keyboard cursor, for
// tooltips, hover events, and the accessible live region. An Inspector holds
// what one scene drew; the chart model makes one per scene.

import type { Formatter } from "../format/format.ts";
import { STILL } from "../marks/dodge.ts";
import type { Frame, Hit, Mark, RowParts } from "../marks/mark.ts";
import {
  lowerPosition,
  placeAt,
  rowOf,
  type Series,
  samePositions,
  valueAt,
  xAt,
} from "../marks/series.ts";
import type { FieldReader, InspectedField } from "../marks/tooltip-fields.ts";

/** One point of an inspection: a series' point, or a layout mark's item. */
export interface InspectedPoint {
  /** The point's mark: its index in the chart's `marks`. */
  mark: number;
  /** The mark's `id`, when it has one. */
  markId: string | undefined;
  /** Identifies the point's series, or a layout mark's item, in the chart. */
  key: string;
  /** What the tooltip names the point by: its series' name, a heatmap cell's row category, or an item's name. */
  label: string;
  /**
   * The position in the mark's table of the row the point is, which
   * `table.value(field, row)` reads (rows dropped from the front renumber
   * the others). Undefined when no one row is the point: histogram bins,
   * box plot and violin groups, pie slices, funnel stages, tree nodes, and
   * network and Sankey nodes and links summarize rows.
   */
  row: number | undefined;
  color: string;
  /** Formatted value, or "low – high" for bands. */
  text: string;
  value: number;
  px: number;
  py: number;
  /** The fields of `row` its mark's tooltip shows besides its value (the mark's `tooltip.fields`). */
  fields?: readonly InspectedField[];
}

/** What a tooltip, hover event, or keyboard cursor is on. */
export type Inspection = AxisInspection | ItemInspection;

/** Points at a position along an axis, in charts with axes. */
export interface AxisInspection {
  /** The axis the inspection follows: "y" in nearest-y mode, otherwise "x". */
  axis: "x" | "y";
  /** Data value on that axis, snapped to the nearest data point. */
  value: number;
  /** Pixel position of `value` on that axis. */
  position: number;
  label: string;
  points: InspectedPoint[];
  /**
   * In charts with facets, the key of the panel inspected: its facet value,
   * or with row and column facets both values as a JSON array.
   */
  panel?: string;
}

/** One item of a chart without axes, such as a pie slice. */
export interface ItemInspection {
  axis: "item";
  key: string;
  /** The item's value. */
  value: number;
  /** What the values measure: the value field, or "Count". */
  label: string;
  /** The item, as one point. */
  points: InspectedPoint[];
  /** SVG path data outlining the item. */
  outline: string;
  /** The item's data by field, for items of several values (a 3D chart's points): numbers, times in epoch ms, and categories. */
  values?: Readonly<Record<string, number | string>>;
  panel?: string;
}

/** Points a nearest-x search steps over to leave a gap of points not drawn. */
const GAP_WALK = 1024;

export type TooltipMode = "nearest-x" | "nearest-y" | "nearest";

/**
 * A mark and the series it resolved for a scene; for a mark that reads its
 * table's rows without series (annotations), the rows drawn when not all.
 */
export interface MarkSeries {
  mark: Mark;
  series: Series[];
  rows?: RowParts | undefined;
}

/** A mark a panel inspects: its series there, and its index in the chart's marks. */
export interface InspectedMark extends MarkSeries {
  index: number;
}

/** A y axis: the frame its marks draw with and the formatter of its values. */
export interface YAxisView {
  frame: Frame;
  formatY: Formatter;
}

/** What an Inspector needs from the scene it inspects. */
export interface DrawnScene {
  marks: InspectedMark[];
  /** The frame of marks on the left y axis; its x scale is every mark's. */
  frame: Frame;
  /** The right y axis and the marks on it, when any are. */
  right?: (YAxisView & { marks: ReadonlySet<Mark> }) | undefined;
  mode: TooltipMode;
  /** Series the user hid; they are never inspected. */
  hidden: ReadonlySet<string>;
  formatX: Formatter;
  formatY: Formatter;
  formatValue: Formatter;
  /** Reads the fields marks' tooltips show of rows, once the chart has loaded what reads them. */
  fields?: FieldReader | undefined;
}

interface ReadableMark extends InspectedMark {
  axis: YAxisView;
  visible: Series[];
}

export class Inspector {
  readonly marks: ReadableMark[];
  readonly #frame: Frame;
  readonly mode: TooltipMode;
  readonly #formatX: Formatter;
  readonly #formatValue: Formatter;
  readonly #fields: FieldReader | undefined;
  readonly #left: YAxisView;
  readonly #right: DrawnScene["right"];

  get frame(): Frame {
    return this.#frame;
  }

  get formatX(): Formatter {
    return this.#formatX;
  }

  get formatValue(): Formatter {
    return this.#formatValue;
  }

  /** The frame of marks on the right y axis, when any are. */
  get rightFrame(): Frame | undefined {
    return this.#right?.frame;
  }

  /** How values of the right y axis are formatted, when marks are on it. */
  get formatRight(): Formatter | undefined {
    return this.#right?.formatY;
  }
  /** The scene entry owning each series, including its mark and chart index. */
  readonly #ownerOf = new Map<Series, ReadableMark>();

  constructor(scene: DrawnScene) {
    this.#frame = scene.frame;
    this.mode = scene.mode;
    this.#formatX = scene.formatX;
    this.#formatValue = scene.formatValue;
    this.#fields = scene.fields;
    this.#left = { frame: scene.frame, formatY: scene.formatY };
    this.#right = scene.right;
    this.marks = scene.marks.map((entry) => {
      const axis = this.axisOf(entry.mark);
      const series = entry.mark.readSeries?.(entry.series, axis.frame) ?? entry.series;
      const visible = series.filter((s) => !scene.hidden.has(s.key) && s.length > 0);
      const owner = { ...entry, series, axis, visible };
      for (const s of series) this.#ownerOf.set(s, owner);
      return owner;
    });
  }

  #visibleSeries(filter: (mark: Mark) => boolean): Series[] {
    return this.marks.flatMap(({ mark, visible }) => (filter(mark) ? visible : []));
  }

  /**
   * Finds the data under a pointer position for tooltips. "nearest-x" reports
   * every visible series at the data x nearest the pointer, "nearest-y" the
   * same along y; "nearest" reports the single closest point. Sorted series
   * use binary search; marks with their own lookup (grid indexes, cell
   * tables) use it.
   */
  inspect(px: number, py: number, mode?: TooltipMode): AxisInspection | undefined {
    const { plot } = this.#frame;
    if (px < plot.x || px > plot.x + plot.width || py < plot.y || py > plot.y + plot.height)
      return undefined;
    const requested = mode ?? this.mode;
    // Cells are always found under the pointer, so with nothing placed along
    // an axis (heatmaps only) every mode inspects the nearest cell.
    const axis = requested === "nearest-y" ? "y" : "x";
    let series = this.#visibleSeries(
      (mark) => mark.tooltip !== "cell" && (!mark.place || mark.tooltip === axis),
    );
    if (requested === "nearest" || series.length === 0) {
      const hit = this.#nearest(px, py);
      if (!hit) return undefined;
      const point = this.#point(hit.series, hit.position, hit.at);
      if (!point) return undefined;
      // The heading names where the point is placed: its x, or its y
      // category for marks along y; for a line or region, where it was found.
      const axis = this.#ownerOf.get(hit.series)!.mark.tooltip === "y" ? "y" : "x";
      const value = hit.at
        ? this.#frame[axis].invert(hit.at[axis === "x" ? 0 : 1])
        : placeAt(hit.series, axis, rowOf(hit.series, hit.position));
      return this.#inspection(axis, value, [point]);
    }
    // Snap to the data value nearest the pointer across every visible
    // series, among points drawn in view. Values along y compare within one
    // y axis: the left one, or the right one when only it has series.
    let yAxis = this.#left;
    if (axis === "y" && this.#right) {
      const left = series.filter((s) => this.#ownerOf.get(s)!.axis === this.#left);
      if (left.length > 0) series = left;
      else yAxis = this.#right;
    }
    const scale = yAxis.frame[axis];
    const target = scale.invert(axis === "x" ? px : py);
    const lo = Math.min(scale.domain[0], scale.domain[1]);
    const hi = Math.max(scale.domain[0], scale.domain[1]);
    // Distances are compared on screen, where an axis with breaks shows no break.
    const at = scale.map(target);
    let closest = Infinity;
    let snapped = Number.NaN;
    for (const s of series) {
      const { mark, axis: markAxis } = this.#ownerOf.get(s)!;
      const position =
        mark.place && mark.pick
          ? (mark.pick([s], px, py, markAxis.frame)?.position ?? -1)
          : axis === "x" && s.sorted
            ? this.#drawnNear(s, this.#nearestWithin(s, target, lo, hi), target, lo, hi)
            : this.#scanNearest(s, axis, target, lo, hi, scale);
      if (position < 0) continue;
      const value = placeAt(s, axis, rowOf(s, position));
      const distance = Math.abs(scale.map(value) - at);
      if (distance < closest) {
        closest = distance;
        snapped = value;
      }
    }
    if (!Number.isFinite(snapped)) return undefined;
    return this.#inspectAt(axis, snapped, series, yAxis);
  }

  /**
   * In a sorted series, the position nearest `target` in x among those in
   * [lo, hi] (and, on an axis with breaks, shown), or -1 when none is.
   */
  #nearestWithin(s: Series, target: number, lo: number, hi: number): number {
    const breaks = this.#frame.x.breaks;
    let after = lowerPosition(s, target);
    let before = after - 1;
    if (breaks) {
      after = breaks.shownFrom(s.x, after, s.length, s.rows);
      before = breaks.shownBefore(s.x, before, s.rows);
    }
    if (!this.#inView(s, before, lo, hi)) return this.#inView(s, after, lo, hi) ? after : -1;
    return this.#inView(s, after, lo, hi) ? this.#closer(s, before, after, target) : before;
  }

  #inView(s: Series, position: number, lo: number, hi: number): boolean {
    if (position < 0 || position >= s.length) return false;
    const at = xAt(s, position);
    return at >= lo && at <= hi;
  }

  /**
   * In a sorted series, `position`, or when its point is not drawn (a
   * missing value, a candle missing a price), the drawn point nearest
   * `target` in x within [lo, hi], looking at most GAP_WALK points either
   * way (points an axis break hides are jumped, however many); -1 for none.
   * Inside a longer gap no point is near enough.
   */
  #drawnNear(s: Series, position: number, target: number, lo: number, hi: number): number {
    if (position < 0 || this.#drawn(s, rowOf(s, position))) return position;
    const breaks = this.#frame.x.breaks;
    const usable = (k: number) => this.#inView(s, k, lo, hi) && this.#drawn(s, rowOf(s, k));
    const step = (k: number, by: number) => {
      const next = k + by;
      if (!breaks || next < 0 || next >= s.length) return next;
      return by < 0
        ? breaks.shownBefore(s.x, next, s.rows)
        : breaks.shownFrom(s.x, next, s.length, s.rows);
    };
    let left = step(position, -1);
    for (let walked = 1; left >= 0 && walked < GAP_WALK && !usable(left); walked++)
      left = step(left, -1);
    let right = step(position, 1);
    for (let walked = 1; right < s.length && walked < GAP_WALK && !usable(right); walked++)
      right = step(right, 1);
    const leftOK = usable(left);
    const rightOK = usable(right);
    if (!leftOK) return rightOK ? right : -1;
    return rightOK ? this.#closer(s, left, right, target) : left;
  }

  /** Of positions `a` before `b` in a sorted series, the one nearer `target` on screen; `a` on ties. */
  #closer(s: Series, a: number, b: number, target: number): number {
    const x = this.#frame.x;
    const at = x.map(target);
    return Math.abs(at - x.map(xAt(s, a))) <= Math.abs(x.map(xAt(s, b)) - at) ? a : b;
  }

  /**
   * Position of the point nearest `target` on screen (through `scale`) among
   * those whose value on `axis` is in [lo, hi] and that are drawn, by a
   * scan; -1 when none is. Unsorted series may hold several rows at one
   * position (long-format bars), some of them missing, so every row is
   * checked.
   */
  #scanNearest(
    s: Series,
    axis: "x" | "y",
    target: number,
    lo: number,
    hi: number,
    scale = this.#frame[axis],
  ): number {
    const at0 = scale.map(target);
    let best = -1;
    let bestDistance = Infinity;
    for (let k = 0; k < s.length; k++) {
      const row = rowOf(s, k);
      const at = placeAt(s, axis, row);
      if (!(at >= lo && at <= hi)) continue;
      const distance = Math.abs(scale.map(at) - at0);
      if (distance >= bestDistance || !this.#drawn(s, row)) continue;
      best = k;
      bestDistance = distance;
    }
    return best;
  }

  /** The y axis a mark is on. */
  axisOf(mark: Mark | undefined): YAxisView {
    return mark && this.#right?.marks.has(mark) ? this.#right : this.#left;
  }

  /**
   * Whether a point is drawn: its value is finite and both scales can place
   * it. A point of a mark inspected along y (a horizontal bar) also needs
   * part of it, from base to end, inside the x domain; its end may lie
   * outside the plot.
   */
  #drawn(s: Series, row: number): readonly [number, number] | undefined {
    const pixels = this.#pixels(s, row);
    const mark = this.#ownerOf.get(s)!.mark;
    if (!pixels || mark.place || mark.tooltip !== "y") return pixels;
    const { x } = this.#frame;
    const end = s.x[row]!;
    const base = s.x0?.[row] ?? (mark.zero === "x" ? 0 : end);
    const [from, to] = mark.span?.(s, row) ?? [Math.min(base, end), Math.max(base, end)];
    const lo = Math.min(x.domain[0], x.domain[1]);
    const hi = Math.max(x.domain[0], x.domain[1]);
    return to >= lo && from <= hi ? pixels : undefined;
  }

  /**
   * Whether a point can be placed: its value is finite, both scales place
   * it (rows without a band, index -1, have no place), and so does the low
   * end of a range.
   */
  #pixels(s: Series, row: number): readonly [number, number] | undefined {
    const { mark, axis } = this.#ownerOf.get(s)!;
    if (mark.place) return mark.place(s, row, axis.frame);
    const finite = Number.isFinite;
    if (!finite(s.values[row]!)) return undefined;
    const { x, y } = axis.frame;
    const at = placeAt(s, "x", row);
    const across = placeAt(s, "y", row);
    const px = x.map(at);
    const py = y.map(across);
    if (!finite(px) || !finite(py)) return undefined;
    if ((x.type === "band" && at < 0) || (y.type === "band" && across < 0)) return undefined;
    if (x.breaks?.hides(at) || !(mark.shows?.(s, row, y, x) ?? true)) return undefined;
    if (s.range) {
      const along = mark.tooltip === "y";
      const low = (along ? s.x0 : s.y0)?.[row] ?? Number.NaN;
      const scale = along ? x : y;
      if (!finite(scale.map(low)) || (scale.type === "band" && low < 0)) return undefined;
    }
    // A heatmap's cell is at its center, which its value need not be.
    if (mark.pointAnchor) return mark.pointAnchor(s, row, axis.frame);
    // Marks spreading rows across their bands (dodge, jitter) draw them off their values' place.
    const [dx, dy] = mark.displace?.(s, row, axis.frame) ?? STILL;
    return [px + dx, py + dy];
  }

  #nearest(px: number, py: number): Hit | undefined {
    const { x } = this.#frame;
    let best: Hit | undefined;
    const consider = (s: Series, k: number) => {
      const row = rowOf(s, k);
      const pixels = this.#drawn(s, row);
      if (!pixels) return;
      const distance = Math.hypot(pixels[0] - px, pixels[1] - py);
      if (distance < (best?.distance ?? Infinity)) best = { series: s, position: k, distance };
    };
    const target = x.invert(px);
    for (const { mark, visible: series, axis } of this.marks) {
      if (mark.pick) {
        // Ties go to later marks, which are drawn on top.
        const hit = mark.pick(series, px, py, axis.frame);
        if (hit && hit.distance <= (best?.distance ?? Infinity)) best = hit;
        continue;
      }
      for (const s of series) {
        // Marks spreading rows across their bands draw them up to `reach` off their x.
        const reach = mark.maxDisplacement?.(s, axis.frame) ?? 0;
        if (!s.sorted || reach === Infinity) {
          for (let k = 0; k < s.length; k++) consider(s, k);
          continue;
        }
        // Walk outward from the pointer's x on each side until points are
        // horizontally farther than the best match: screen distance grows
        // away from it either way, on any scale.
        const after = lowerPosition(s, target);
        const within = (k: number) =>
          Math.abs(x.map(xAt(s, k)) - px) - reach <= (best?.distance ?? Infinity);
        // Hidden points all sit at their break's seam: they are jumped.
        const breaks = x.breaks;
        const back = (k: number) => (breaks ? breaks.shownBefore(s.x, k, s.rows) : k);
        const ahead = (k: number) => (breaks ? breaks.shownFrom(s.x, k, s.length, s.rows) : k);
        for (let k = back(after - 1); k >= 0 && within(k); k = back(k - 1)) consider(s, k);
        for (let k = ahead(after); k < s.length && within(k); k = ahead(k + 1)) consider(s, k);
      }
    }
    return best;
  }

  /**
   * Inspects one point of a series, identified by position, plus the other
   * visible series at its x (or its y, for marks inspected along y). Used by
   * keyboard navigation, which must reach every point even when values repeat.
   */
  inspectPosition(seriesKey: string, position: number): AxisInspection | undefined {
    const series = this.#visibleSeries(() => true);
    const anchor = series.find((s) => s.key === seriesKey);
    if (!anchor || position < 0 || position >= anchor.length) return undefined;
    const axis = this.#ownerOf.get(anchor)!.mark.tooltip === "y" ? "y" : "x";
    const value = placeAt(anchor, axis, rowOf(anchor, position));
    // The cursor needs a place along its axis; a point that is not drawn
    // there (a zero on a log axis, say) leaves the other series' points.
    const scale = this.#frame[axis];
    if (!Number.isFinite(scale.map(value)) || (scale.type === "band" && value < 0))
      return undefined;
    const along = series.filter((s) => this.#ownerOf.get(s)!.mark.tooltip === axis);
    const inspection = this.#inspectAt(
      axis,
      value,
      along.includes(anchor) ? along : [anchor],
      this.#left,
      anchor,
      position,
    );
    // Nothing drawn at this position: no tooltip rather than an empty one.
    return inspection.points.length > 0 ? inspection : undefined;
  }

  /** Every series' point at `value` on `axis` (for "y", a value of `yAxis`). */
  #inspectAt(
    axis: "x" | "y",
    value: number,
    series: readonly Series[],
    yAxis = this.#left,
    anchor?: Series,
    anchorPosition?: number,
  ): AxisInspection {
    const points: InspectedPoint[] = [];
    for (const s of series) {
      // Series sharing the anchor's positions are read at its row: at an x
      // several rows share, the first would hide the others. Marks pairing
      // rows of their series say which to read.
      const position =
        anchor && (s === anchor || samePositions(s, anchor, axis))
          ? anchorPosition!
          : ((anchor && this.#ownerOf.get(s)!.mark.alongside?.(s, anchor, anchorPosition!)) ??
            this.#positionAt(s, axis, value));
      if (position < 0) continue;
      const point = this.#point(s, position);
      if (point) points.push(point);
    }
    return this.#inspection(axis, value, points, yAxis);
  }

  /** Position of a drawn point of `s` at `value` on `axis`, or -1. */
  #positionAt(s: Series, axis: "x" | "y", value: number): number {
    if (s.sorted && (axis === "x" || this.#ownerOf.get(s)!.mark.place)) {
      // Of several points at this x, the first one drawn.
      for (let k = lowerPosition(s, value); k < s.length && xAt(s, k) === value; k++)
        if (this.#drawn(s, rowOf(s, k))) return k;
      return -1;
    }
    return this.#scanNearest(s, axis, value, value, value);
  }

  #inspection(
    axis: "x" | "y",
    value: number,
    points: InspectedPoint[],
    yAxis = this.#left,
  ): AxisInspection {
    return {
      axis,
      value,
      position: yAxis.frame[axis].map(value),
      label: axis === "x" ? this.#formatX(value) : yAxis.formatY(value),
      points,
    };
  }

  #point(s: Series, position: number, at?: readonly [number, number]): InspectedPoint | undefined {
    const row = rowOf(s, position);
    const value = valueAt(s, row);
    // What a scale cannot place (log axes, missing ends) is not drawn, so not reported.
    const pixels = at ?? this.#pixels(s, row);
    if (!pixels) return undefined;
    const [px, py] = pixels;
    const { mark, index, axis } = this.#ownerOf.get(s)!;
    // Marks inspected along y (horizontal bars) measure their values on x;
    // marks of cells name and measure their points themselves.
    const along = mark.tooltip === "y";
    const formatY = axis.formatY;
    const formatValue = along ? this.#formatX : formatY;
    const format = { x: this.#formatX, y: formatY, value: this.#formatValue };
    // Summarizing marks' series index rows of their summaries.
    const fields = mark.summarizes ? undefined : this.#fields?.(mark.table, mark.spec.tooltip, row);
    return {
      mark: index,
      markId: mark.spec.id,
      key: s.key,
      label: mark.pointLabel?.(s, row, format) ?? s.label,
      row: mark.summarizes ? undefined : row,
      ...(fields && { fields }),
      color: mark.pointColor?.(s, row, this.#frame.theme) ?? s.color,
      value,
      text:
        mark.pointText?.(s, row, format) ??
        (s.range
          ? `${formatValue((along ? s.x0 : s.y0)![row]!)} – ${formatValue(value)}`
          : formatValue(value)),
      px,
      py,
    };
  }
}
