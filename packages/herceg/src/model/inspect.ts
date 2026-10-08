// Inspection: finding the data under a pointer or keyboard cursor, for
// tooltips, hover events, and the accessible live region. An Inspector holds
// what one scene drew; the chart model makes one per scene.

import type { Formatter } from "../format/format.ts";
import type { Frame, Hit, Mark } from "../marks/mark.ts";
import {
  nearestPosition,
  nearestPositionWithin,
  rowOf,
  type Series,
  xAt,
} from "../marks/series.ts";
import type { PositionScale } from "../scale/scale.ts";

export interface InspectedPoint {
  key: string;
  label: string;
  color: string;
  /** Formatted value, or "low – high" for bands. */
  text: string;
  value: number;
  px: number;
  py: number;
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
  /** In charts with facets, the facet value of the panel inspected. */
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
  panel?: string;
}

/** Points a nearest-x search steps over to leave a gap of points not drawn. */
const GAP_WALK = 1024;

export type TooltipMode = "nearest-x" | "nearest-y" | "nearest";

/** A mark and the series it resolved for a scene. */
export interface MarkSeries {
  mark: Mark;
  series: Series[];
}

/** A y axis: the frame its marks draw with and the formatter of its values. */
export interface YAxisView {
  frame: Frame;
  formatY: Formatter;
}

/** What an Inspector needs from the scene it inspects. */
export interface DrawnScene {
  marks: MarkSeries[];
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
}

export class Inspector {
  readonly marks: MarkSeries[];
  readonly frame: Frame;
  readonly mode: TooltipMode;
  readonly formatX: Formatter;
  readonly formatY: Formatter;
  readonly formatValue: Formatter;
  readonly #hidden: ReadonlySet<string>;
  readonly #left: YAxisView;
  readonly #right: DrawnScene["right"];

  /** The frame of marks on the right y axis, when any are. */
  get rightFrame(): Frame | undefined {
    return this.#right?.frame;
  }
  /** The mark of each series, for how its points are inspected and formatted. */
  readonly #markOf = new Map<Series, Mark>();

  constructor(scene: DrawnScene) {
    this.marks = scene.marks;
    this.frame = scene.frame;
    this.mode = scene.mode;
    this.formatX = scene.formatX;
    this.formatY = scene.formatY;
    this.formatValue = scene.formatValue;
    this.#hidden = scene.hidden;
    this.#left = { frame: scene.frame, formatY: scene.formatY };
    this.#right = scene.right;
    for (const { mark, series } of scene.marks) for (const s of series) this.#markOf.set(s, mark);
  }

  #visibleSeries(filter: (mark: Mark) => boolean): Series[] {
    return this.marks
      .filter(({ mark }) => filter(mark))
      .flatMap((entry) => entry.series)
      .filter((s) => !this.#hidden.has(s.key) && s.length > 0);
  }

  /**
   * Finds the data under a pointer position for tooltips. "nearest-x" reports
   * every visible series at the data x nearest the pointer, "nearest-y" the
   * same along y; "nearest" reports the single closest point. Sorted series
   * use binary search; marks with their own lookup (grid indexes, cell
   * tables) use it.
   */
  inspect(px: number, py: number, mode?: TooltipMode): AxisInspection | undefined {
    const { plot } = this.frame;
    if (px < plot.x || px > plot.x + plot.width || py < plot.y || py > plot.y + plot.height)
      return undefined;
    const requested = mode ?? this.mode;
    // Cells are always found under the pointer, so with nothing placed along
    // an axis (heatmaps only) every mode inspects the nearest cell.
    let series = this.#visibleSeries((mark) => mark.tooltip !== "cell");
    if (requested === "nearest" || series.length === 0) {
      const hit = this.#nearest(px, py);
      if (!hit) return undefined;
      const point = this.#point(hit.series, hit.position);
      if (!point) return undefined;
      // The heading names where the point is placed: its x, or its y
      // category for marks along y.
      const axis = this.#markOf.get(hit.series)?.tooltip === "y" ? "y" : "x";
      return this.#inspection(axis, hit.series[axis][rowOf(hit.series, hit.position)]!, [point]);
    }
    // Snap to the data value nearest the pointer across every visible
    // series, among points drawn in view. Values along y compare within one
    // y axis: the left one, or the right one when only it has series.
    const axis = requested === "nearest-y" ? "y" : "x";
    let yAxis = this.#left;
    if (axis === "y" && this.#right) {
      const left = series.filter((s) => this.#axisOf(s) === this.#left);
      if (left.length > 0) series = left;
      else yAxis = this.#right;
    }
    const scale = yAxis.frame[axis];
    const target = scale.invert(axis === "x" ? px : py);
    const lo = Math.min(scale.domain[0], scale.domain[1]);
    const hi = Math.max(scale.domain[0], scale.domain[1]);
    let snapped = Number.NaN;
    for (const s of series) {
      const position =
        axis === "x"
          ? s.sorted
            ? this.#drawnNear(s, nearestPositionWithin(s, target, lo, hi), target, lo, hi)
            : this.#scanNearest(s, "x", target, lo, hi)
          : this.#scanNearest(s, "y", target, lo, hi);
      if (position < 0) continue;
      const value = s[axis][rowOf(s, position)]!;
      if (Number.isNaN(snapped) || Math.abs(value - target) < Math.abs(snapped - target))
        snapped = value;
    }
    if (!Number.isFinite(snapped)) return undefined;
    return this.#inspectAt(axis, snapped, series, yAxis);
  }

  /**
   * In a sorted series, `position`, or when its point is not drawn (a
   * missing value, a candle missing a price), the drawn point nearest
   * `target` in x within [lo, hi], looking at most GAP_WALK points either
   * way; -1 for none. Inside a longer gap no point is near enough.
   */
  #drawnNear(s: Series, position: number, target: number, lo: number, hi: number): number {
    if (position < 0 || this.#drawn(s, rowOf(s, position))) return position;
    const usable = (k: number) =>
      k >= 0 && k < s.length && xAt(s, k) >= lo && xAt(s, k) <= hi && this.#drawn(s, rowOf(s, k));
    let left = position - 1;
    while (left >= 0 && position - left <= GAP_WALK && !usable(left)) left--;
    let right = position + 1;
    while (right < s.length && right - position <= GAP_WALK && !usable(right)) right++;
    const [l, r] = [usable(left), usable(right)];
    if (!l) return r ? right : -1;
    if (!r) return left;
    return target - xAt(s, left) <= xAt(s, right) - target ? left : right;
  }

  /**
   * Position of the point nearest `target` among those whose value on `axis`
   * is in [lo, hi] and that are drawn, by a scan; -1 when none is. Unsorted
   * series may hold several rows at one position (long-format bars), some of
   * them missing, so every row is checked.
   */
  #scanNearest(s: Series, axis: "x" | "y", target: number, lo: number, hi: number): number {
    const column = s[axis];
    let best = -1;
    let bestDistance = Infinity;
    for (let k = 0; k < s.length; k++) {
      const row = rowOf(s, k);
      const at = column[row]!;
      if (!(at >= lo && at <= hi)) continue;
      const distance = Math.abs(at - target);
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

  #axisOf(s: Series): YAxisView {
    return this.axisOf(this.#markOf.get(s));
  }

  #yOf(s: Series): PositionScale {
    return this.#axisOf(s).frame.y;
  }

  /**
   * Whether a point is drawn: its value is finite and both scales can place
   * it. A point of a mark inspected along y (a horizontal bar) also needs
   * part of it, from base to end, inside the x domain; its end may lie
   * outside the plot.
   */
  #drawn(s: Series, row: number): boolean {
    if (!this.#placeable(s, row)) return false;
    const { x } = this.frame;
    const end = s.x[row]!;
    const mark = this.#markOf.get(s);
    if (mark?.tooltip !== "y") return true;
    const base = s.x0 ? s.x0[row]! : mark.zero === "x" ? 0 : end;
    const [from, to] = mark.span?.(s, row) ?? [Math.min(base, end), Math.max(base, end)];
    const lo = Math.min(x.domain[0], x.domain[1]);
    const hi = Math.max(x.domain[0], x.domain[1]);
    return to >= lo && from <= hi;
  }

  /**
   * Whether a point can be placed: its value is finite, both scales place
   * it (rows without a band, index -1, have no place), and so does the low
   * end of a range.
   */
  #placeable(s: Series, row: number): boolean {
    const { x } = this.frame;
    const y = this.#yOf(s);
    const placed = (scale: PositionScale, value: number) =>
      Number.isFinite(scale.map(value)) && !(scale.type === "band" && value < 0);
    if (!Number.isFinite(s.values[row]!) || !placed(x, s.x[row]!) || !placed(y, s.y[row]!))
      return false;
    const mark = this.#markOf.get(s);
    if (mark?.shows && !mark.shows(s, row, y)) return false;
    if (!s.range) return true;
    const along = mark?.tooltip === "y";
    const low = (along ? s.x0 : s.y0)?.[row];
    return low !== undefined && placed(along ? x : y, low);
  }

  #nearest(px: number, py: number): Hit | undefined {
    const { x } = this.frame;
    let best: Hit | undefined;
    const consider = (s: Series, k: number) => {
      const row = rowOf(s, k);
      const distance = Math.hypot(x.map(s.x[row]!) - px, this.#yOf(s).map(s.y[row]!) - py);
      if (distance < (best?.distance ?? Infinity) && this.#drawn(s, row))
        best = { series: s, position: k, distance };
    };
    const target = x.invert(px);
    for (const { mark, series } of this.marks) {
      const visible = series.filter((s) => !this.#hidden.has(s.key) && s.length > 0);
      if (mark.pick) {
        // Ties go to later marks, which are drawn on top.
        const hit = mark.pick(visible, px, py, this.axisOf(mark).frame);
        if (hit && hit.distance <= (best?.distance ?? Infinity)) best = hit;
        continue;
      }
      for (const s of visible) {
        if (!s.sorted) {
          for (let k = 0; k < s.length; k++) consider(s, k);
          continue;
        }
        // Walk outward from the nearest x until points are horizontally
        // farther than the best match.
        const center = nearestPosition(s, target);
        const within = (k: number) =>
          Math.abs(x.map(xAt(s, k)) - px) <= (best?.distance ?? Infinity);
        for (let k = center; k >= 0 && within(k); k--) consider(s, k);
        for (let k = center + 1; k < s.length && within(k); k++) consider(s, k);
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
    const axis = this.#markOf.get(anchor)?.tooltip === "y" ? "y" : "x";
    const value = anchor[axis][rowOf(anchor, position)]!;
    // The cursor needs a place along its axis; a point that is not drawn
    // there (a zero on a log axis, say) leaves the other series' points.
    const scale = this.frame[axis];
    if (!Number.isFinite(scale.map(value)) || (scale.type === "band" && value < 0))
      return undefined;
    const along = this.#visibleSeries((mark) => mark.tooltip === axis);
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
      const position = s === anchor ? anchorPosition! : this.#positionAt(s, axis, value);
      if (position < 0) continue;
      const point = this.#point(s, position);
      if (point) points.push(point);
    }
    return this.#inspection(axis, value, points, yAxis);
  }

  /** Position of a drawn point of `s` at `value` on `axis`, or -1. */
  #positionAt(s: Series, axis: "x" | "y", value: number): number {
    if (axis === "x" && s.sorted) {
      let k = nearestPosition(s, value);
      // Of several points at this x, the first one drawn.
      while (k >= 0 && k < s.length && xAt(s, k) === value && !this.#drawn(s, rowOf(s, k))) k++;
      return k >= 0 && k < s.length && xAt(s, k) === value ? k : -1;
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
      label: axis === "x" ? this.formatX(value) : yAxis.formatY(value),
      points,
    };
  }

  #point(s: Series, position: number): InspectedPoint | undefined {
    const { x } = this.frame;
    const y = this.#yOf(s);
    const row = rowOf(s, position);
    const value = s.values[row]!;
    // What a scale cannot place (log axes, missing ends) is not drawn, so not reported.
    if (!this.#placeable(s, row)) return undefined;
    const px = x.map(s.x[row]!);
    const py = y.map(s.y[row]!);
    const mark = this.#markOf.get(s);
    const tooltip = mark?.tooltip;
    // A cell's label is its y category and its value a measure; marks
    // inspected along y (horizontal bars) measure their values on x.
    const along = tooltip === "y";
    const formatValue = along ? this.formatX : this.#axisOf(s).formatY;
    const low = s.range ? (along ? s.x0 : s.y0)![row]! : Number.NaN;
    return {
      key: s.key,
      label: tooltip === "cell" ? this.formatY(s.y[row]!) : s.label,
      color: mark?.pointColor ? mark.pointColor(s, row, this.frame.theme) : s.color,
      value,
      text: mark?.pointText
        ? mark.pointText(s, row, {
            x: this.formatX,
            y: this.#axisOf(s).formatY,
            value: this.formatValue,
          })
        : s.range
          ? `${formatValue(low)} – ${formatValue(value)}`
          : tooltip === "cell"
            ? this.formatValue(value)
            : formatValue(value),
      px,
      py,
    };
  }
}
