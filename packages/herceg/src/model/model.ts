// The chart model turns marks and data into a scene. It is independent of the
// DOM: the browser runtime, server rendering, and tests all drive it the same
// way. It keeps per-chart state that must survive between frames: geometry
// buffers, the zoomed x range, hidden series, and layout hysteresis.

import { type Formatter, formatNumber, timeValueFormatter } from "../format/format.ts";
import type { MeasureText } from "../layout/text.ts";
import { Polyline } from "../lod/polyline.ts";
import type { Frame, Mark } from "../marks/mark.ts";
import { nearestPosition, rowOf, type Series, xAt } from "../marks/series.ts";
import { unionExtent } from "../marks/trace.ts";
import type { ContinuousScale } from "../scale/scale.ts";
import { TIME_UNIT_MS, type TimeUnit } from "../scale/time.ts";
import {
  type AxisGeometry,
  LEGEND_SWATCH,
  type LegendItem,
  type Rect,
  type Scene,
} from "../scene/scene.ts";
import type { ChartSpec } from "../spec/spec.ts";
import { resolveTheme, type Theme } from "../theme.ts";
import {
  type AxisContext,
  type AxisType,
  niceAxisDomain,
  planAxis,
  usableDomain,
  valueFormatter,
} from "./axis.ts";

/** Chart options with marks bound to their data. */
export type ChartConfig = Omit<ChartSpec, "marks" | "data" | "width" | "height" | "version"> & {
  marks: readonly Mark[];
};

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

export interface Inspection {
  /** Data x of the inspected position, snapped to the nearest data point. */
  x: number;
  px: number;
  label: string;
  points: InspectedPoint[];
}

interface MarkSeries {
  mark: Mark;
  series: Series[];
}

interface LastFrame {
  marks: MarkSeries[];
  x: ContinuousScale;
  y: ContinuousScale;
  plot: Rect;
  formatX: Formatter;
  formatY: Formatter;
}

const TICK = 5;
const GAP = 6;
const LEGEND_GAP = 16;
/** Left inset of the title and legend. */
const EDGE = 8;

export class ChartModel {
  #config: ChartConfig;
  #theme: Theme;
  width = 640;
  height = 400;
  pixelRatio = 1;
  /** Keys of series hidden through the legend. */
  readonly hidden = new Set<string>();
  #viewport: [number, number] | null = null;
  #buffers = new Map<string, Polyline>();
  #used = new Set<string>();
  #left = 0;
  #layoutKey = "";
  #last: LastFrame | undefined;

  constructor(config: ChartConfig) {
    validate(config);
    this.#config = config;
    this.#theme = resolveTheme(config.theme);
  }

  get config(): ChartConfig {
    return this.#config;
  }

  get theme(): Theme {
    return this.#theme;
  }

  update(config: ChartConfig): void {
    validate(config);
    this.#config = config;
    this.#theme = resolveTheme(config.theme);
    this.#layoutKey = "";
  }

  setSize(width: number, height: number, pixelRatio = this.pixelRatio): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = pixelRatio;
  }

  /** The visible x range, or null to fit the data. */
  get viewport(): readonly [number, number] | null {
    return this.#viewport;
  }

  setViewport(domain: readonly [number, number] | null): void {
    this.#viewport =
      domain && domain[0] !== domain[1] ? [Math.min(...domain), Math.max(...domain)] : null;
  }

  /** x extent of all data, ignoring the viewport. */
  dataXExtent(): [number, number] | undefined {
    const marks = this.#resolveSeries();
    const log = this.#xType(marks) === "log";
    return unionExtent(marks.map(({ mark, series }) => mark.xExtent(series, log)));
  }

  /** Palette slot per series key, assigned on first appearance and kept. */
  #slots = new Map<string, number>();

  #palette = (seriesKey: string): string => {
    let slot = this.#slots.get(seriesKey);
    if (slot === undefined) {
      slot = this.#slots.size;
      this.#slots.set(seriesKey, slot);
    }
    return this.#theme.palette[slot % this.#theme.palette.length]!;
  };

  #resolveSeries(): MarkSeries[] {
    return this.#config.marks.map((mark, index) => ({
      mark,
      series: mark.series(mark.spec.id ?? index, this.#palette, this.hidden),
    }));
  }

  #xType(marks: readonly MarkSeries[]): AxisType {
    const declared = this.#config.x?.type;
    if (declared) return declared;
    return marks.some(({ mark }) => mark.xKind() === "time") ? "time" : "linear";
  }

  #polyline = (seriesKey: string, stage: string): Polyline => {
    // Stage names never contain "|", so the combined key is unambiguous.
    const key = `${stage}|${seriesKey}`;
    let buffer = this.#buffers.get(key);
    if (!buffer) {
      buffer = new Polyline();
      this.#buffers.set(key, buffer);
    }
    this.#used.add(key);
    return buffer;
  };

  /** Builds the scene for the current data, size, and view state. */
  scene(measure: MeasureText): Scene {
    const config = this.#config;
    const theme = this.#theme;
    const { width, height } = this;
    const marks = this.#resolveSeries();
    const zone = config.timeZone ?? "local";
    const locale = config.locale;
    const xContext: AxisContext = { type: this.#xType(marks), spec: config.x, zone, locale };
    const yContext: AxisContext = {
      type: config.y?.type ?? "linear",
      spec: config.y,
      zone,
      locale,
    };
    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);

    // x domain: viewport, explicit domain, or data extent. Log axes only
    // consider positive values.
    const xLog = xContext.type === "log";
    const yLog = yContext.type === "log";
    let dataX = unionExtent(marks.map(({ mark, series }) => mark.xExtent(series, xLog)));
    if (config.x?.zero && !xLog) dataX = unionExtent([dataX, [0, 0]]);
    const hasData = dataX !== undefined;
    let xDomain = usableDomain(this.#viewport ?? config.x?.domain ?? dataX, xContext.type);

    // y domain from data visible in the x domain, unless it is fixed.
    let yBase: [number, number];
    if (config.y?.domain) {
      yBase = usableDomain(config.y.domain, yContext.type);
    } else {
      const visible = marks.map(({ mark, series }) => ({
        mark,
        series: series.filter((s) => !this.hidden.has(s.key)),
      }));
      let yData = unionExtent(
        visible.map(({ mark, series }) => mark.yExtent(series, xDomain[0], xDomain[1], yLog)),
      );
      const zero =
        config.y?.zero ?? visible.some(({ mark, series }) => mark.zero && series.length > 0);
      if (zero && !yLog) yData = unionExtent([yData, [0, 0]]);
      yBase = usableDomain(yData, yContext.type);
    }

    // Vertical layout depends only on fonts, titles, and the legend.
    const legendItems = this.#legendItems(marks);
    const showLegend = config.legend ?? legendItems.length > 1;
    let top = config.title ? lineHeight + 14 : Math.ceil(theme.fontSize / 2) + 2;
    const legendTop = top;
    const legend = showLegend
      ? this.#layoutLegend(legendItems, legendTop, measure, font, lineHeight)
      : [];
    if (legend.length > 0) top = legend[legend.length - 1]!.y + lineHeight + 8;
    const showX = config.x?.axis ?? true;
    const showY = config.y?.axis ?? true;

    const bottom = showX
      ? TICK + GAP + lineHeight + (config.x?.label ? lineHeight + GAP : 0) + 2
      : 4;
    const plotHeight = Math.max(10, height - top - bottom);

    // y ticks decide the left margin.
    const yCount = config.y?.ticks ?? Math.max(2, Math.round(plotHeight / 45));
    const yDomain = config.y?.domain
      ? yBase
      : niceAxisDomain(yBase, yContext, yCount, config.y?.nice ?? true);
    const yPlan = planAxis(yContext, yDomain, [top + plotHeight, top], yCount);
    const yLabels = hasData ? yPlan.labels : [];
    const labelWidth = Math.max(0, ...yLabels.map((label) => measure(label, font)));
    let left = showY ? Math.ceil(labelWidth) + GAP + 2 : 8;
    if (config.y?.label) left += lineHeight + GAP;
    // Avoid layout jitter while data streams: the margin grows at once but
    // only shrinks when the size or configuration changes.
    const layoutKey = `${width}x${height}`;
    if (layoutKey === this.#layoutKey) left = Math.max(left, this.#left);
    this.#left = left;
    this.#layoutKey = layoutKey;

    // x ticks; widen the margins if the first or last label would be clipped.
    let right = 12;
    let xPlan = planAxis(xContext, xDomain, [left, width - right], 1);
    for (let pass = 0; pass < 3; pass++) {
      const plotWidth = Math.max(10, width - left - right);
      const xCount =
        config.x?.ticks ??
        Math.max(2, Math.round(plotWidth / (xContext.type === "time" ? 100 : 80)));
      if (!this.#viewport && !config.x?.domain && config.x?.nice) {
        xDomain = niceAxisDomain(xDomain, xContext, xCount, true);
      }
      xPlan = planAxis(xContext, xDomain, [left, left + plotWidth], xCount);
      const last = xPlan.ticks.length - 1;
      if (last < 0 || !hasData || !showX) break;
      const half = (index: number) => measure(xPlan.labels[index]!, font) / 2;
      const overflowRight = xPlan.scale.map(xPlan.ticks[last]!) + half(last) - (width - 2);
      const overflowLeft = 2 - (xPlan.scale.map(xPlan.ticks[0]!) - half(0));
      if (overflowRight <= 0.5 && overflowLeft <= 0.5) break;
      if (overflowRight > 0.5) right += Math.ceil(overflowRight);
      if (overflowLeft > 0.5) left += Math.ceil(overflowLeft);
    }
    const plot: Rect = {
      x: left,
      y: top,
      width: Math.max(10, width - left - right),
      height: plotHeight,
    };
    const x = xPlan.scale;
    const y = yPlan.scale;

    const axes: AxisGeometry[] = [];
    if (showX) {
      axes.push({
        orient: "bottom",
        offset: plot.y + plot.height,
        start: plot.x,
        end: plot.x + plot.width,
        line: true,
        ticks: hasData
          ? xPlan.ticks.map((t, i) => ({ position: x.map(t), label: xPlan.labels[i]! }))
          : [],
        title: config.x?.label
          ? { text: config.x.label, x: plot.x + plot.width / 2, y: height - lineHeight / 2 - 2 }
          : undefined,
      });
    }
    if (showY) {
      axes.push({
        orient: "left",
        offset: plot.x,
        start: plot.y + plot.height,
        end: plot.y,
        line: false,
        ticks: yLabels.map((label, i) => ({ position: y.map(yPlan.ticks[i]!), label })),
        title: config.y?.label
          ? { text: config.y.label, x: lineHeight / 2 + 2, y: plot.y + plot.height / 2 }
          : undefined,
      });
    }

    this.#used.clear();
    const frame: Frame = {
      x,
      y,
      plot,
      pixelRatio: this.pixelRatio,
      theme,
      hidden: this.hidden,
      polyline: this.#polyline,
    };
    const geometry = marks.flatMap(({ mark, series }) => mark.geometry(series, frame));
    // Drop buffers of series that no longer exist.
    for (const key of this.#buffers.keys()) if (!this.#used.has(key)) this.#buffers.delete(key);

    let vertices = 0;
    for (const item of geometry) {
      if (item.kind === "line") vertices += item.path.count;
      else if (item.kind === "area") vertices += item.upper.count + (item.lower?.count ?? 0);
    }

    this.#last = {
      marks,
      x,
      y,
      plot,
      formatX:
        xContext.type === "time"
          ? valueFormatter(xContext, timeValueFormatter(timeUnitFor(x, plot.width), zone, locale))
          : valueFormatter(xContext, (v) => formatNumber(v, locale)),
      formatY: valueFormatter(yContext, (v) => formatNumber(v, locale)),
    };

    return {
      width,
      height,
      pixelRatio: this.pixelRatio,
      theme,
      plot,
      title: config.title ? { text: config.title, x: EDGE, y: lineHeight / 2 + 6 } : undefined,
      grid: {
        x: hasData && config.x?.grid ? xPlan.ticks.map((t) => x.map(t)) : [],
        y: hasData && (config.y?.grid ?? true) ? yPlan.ticks.map((t) => y.map(t)) : [],
      },
      axes,
      legend,
      marks: geometry,
      vertices,
    };
  }

  #legendItems(marks: readonly MarkSeries[]) {
    return marks.flatMap(({ series }) =>
      series.map((s) => ({ key: s.key, label: s.label, color: s.color })),
    );
  }

  #layoutLegend(
    items: readonly { key: string; label: string; color: string }[],
    top: number,
    measure: MeasureText,
    font: string,
    lineHeight: number,
  ): LegendItem[] {
    const out: LegendItem[] = [];
    let x = EDGE;
    let y = top;
    for (const item of items) {
      const width = LEGEND_SWATCH + 6 + measure(item.label, font);
      if (x > EDGE && x + width > this.width - EDGE) {
        x = EDGE;
        y += lineHeight + 4;
      }
      out.push({ ...item, hidden: this.hidden.has(item.key), x, y });
      x += width + LEGEND_GAP;
    }
    return out;
  }

  /** x scale of the last scene, for mapping between data and pixels. */
  xScale(): ContinuousScale | undefined {
    return this.#last?.x;
  }

  /** y scale of the last scene. */
  yScale(): ContinuousScale | undefined {
    return this.#last?.y;
  }

  /** Series of the last scene, for legends, tooltips, and summaries. */
  series(): Series[] {
    return (this.#last?.marks ?? this.#resolveSeries()).flatMap(({ series }) => series);
  }

  /**
   * Finds the data under a pointer position for tooltips. "nearest-x" reports
   * every visible series at the data x nearest the pointer; "nearest" reports
   * the single closest point. Uses binary search on sorted series.
   */
  inspect(
    px: number,
    py: number,
    mode: "nearest-x" | "nearest" = "nearest-x",
  ): Inspection | undefined {
    const last = this.#last;
    if (!last) return undefined;
    const { plot, x, y } = last;
    if (px < plot.x || px > plot.x + plot.width || py < plot.y || py > plot.y + plot.height)
      return undefined;
    const series = last.marks
      .flatMap((entry) => entry.series)
      .filter((s) => !this.hidden.has(s.key) && s.length > 0);
    if (series.length === 0) return undefined;
    const target = x.invert(px);

    if (mode === "nearest") {
      let best: { series: Series; position: number; distance: number } | undefined;
      const consider = (s: Series, k: number) => {
        const row = rowOf(s, k);
        const distance = Math.hypot(x.map(s.x[row]!) - px, y.map(s.y[row]!) - py);
        if (distance < (best?.distance ?? Infinity)) best = { series: s, position: k, distance };
      };
      for (const s of series) {
        if (!s.sorted) {
          for (let k = 0; k < s.length; k++) consider(s, k);
          continue;
        }
        // Walk outward from the nearest x until points are horizontally
        // farther than the best match.
        const center = nearestPosition(s, target);
        for (
          let k = center;
          k >= 0 && Math.abs(x.map(xAt(s, k)) - px) <= (best?.distance ?? Infinity);
          k--
        ) {
          consider(s, k);
        }
        for (
          let k = center + 1;
          k < s.length && Math.abs(x.map(xAt(s, k)) - px) <= (best?.distance ?? Infinity);
          k++
        ) {
          consider(s, k);
        }
      }
      const found = best as { series: Series; position: number } | undefined;
      if (!found) return undefined;
      const xValue = xAt(found.series, found.position);
      const point = this.#point(found.series, found.position, last);
      return point
        ? { x: xValue, px: x.map(xValue), label: last.formatX(xValue), points: [point] }
        : undefined;
    }

    // Snap to the data x nearest the pointer across all series.
    let snapped = Number.NaN;
    for (const s of series) {
      const value = xAt(s, nearestPosition(s, target));
      if (Number.isNaN(snapped) || Math.abs(value - target) < Math.abs(snapped - target))
        snapped = value;
    }
    if (!Number.isFinite(snapped)) return undefined;
    return this.#inspectAt(snapped, series, last);
  }

  /**
   * Inspects one point of a series, identified by position, plus the other
   * visible series at its x. Used by keyboard navigation, which must reach
   * every point even when x values repeat.
   */
  inspectPosition(seriesKey: string, position: number): Inspection | undefined {
    const last = this.#last;
    if (!last) return undefined;
    const series = last.marks
      .flatMap((entry) => entry.series)
      .filter((s) => !this.hidden.has(s.key) && s.length > 0);
    const anchor = series.find((s) => s.key === seriesKey);
    if (!anchor || position < 0 || position >= anchor.length) return undefined;
    return this.#inspectAt(xAt(anchor, position), series, last, anchor, position);
  }

  #inspectAt(
    x: number,
    series: readonly Series[],
    last: LastFrame,
    anchor?: Series,
    anchorPosition?: number,
  ): Inspection {
    const points: InspectedPoint[] = [];
    for (const s of series) {
      const position = s === anchor ? anchorPosition! : nearestPosition(s, x);
      if (xAt(s, position) !== x) continue;
      const point = this.#point(s, position, last);
      if (point) points.push(point);
    }
    return { x, px: last.x.map(x), label: last.formatX(x), points };
  }

  #point(s: Series, position: number, last: LastFrame): InspectedPoint | undefined {
    const row = rowOf(s, position);
    const value = s.values[row]!;
    if (!Number.isFinite(value)) return undefined;
    const low = s.range ? s.y0![row]! : Number.NaN;
    return {
      key: s.key,
      label: s.label,
      color: s.color,
      value,
      text: s.range ? `${last.formatY(low)} – ${last.formatY(value)}` : last.formatY(value),
      px: last.x.map(s.x[row]!),
      py: last.y.map(s.y[row]!),
    };
  }

  /** Releases geometry buffers. */
  dispose(): void {
    this.#buffers.clear();
    this.#last = undefined;
  }
}

/** Precision for x values in tooltips: finer when each pixel covers less time. */
function timeUnitFor(scale: ContinuousScale, pixels: number): TimeUnit {
  const perPixel = Math.abs(scale.domain[1] - scale.domain[0]) / Math.max(1, pixels);
  if (perPixel < TIME_UNIT_MS.second) return "millisecond";
  if (perPixel < TIME_UNIT_MS.minute) return "second";
  if (perPixel < TIME_UNIT_MS.day) return "minute";
  return "day";
}

/** Rejects configurations whose mark identities would collide. */
function validate(config: ChartConfig): void {
  const ids = new Set<string>();
  for (const mark of config.marks) {
    const id = mark.spec.id;
    if (id === undefined) continue;
    if (ids.has(id)) throw new Error(`Duplicate mark id "${id}"`);
    ids.add(id);
  }
}
