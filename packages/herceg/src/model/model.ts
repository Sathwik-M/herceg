// The chart model turns marks and data into a scene. It is independent of the
// DOM: the browser runtime, server rendering, and tests all drive it the same
// way. It keeps per-chart state that must survive between frames: geometry
// buffers, the zoomed x range, hidden series, and layout hysteresis.

import { type Formatter, formatNumber, timeValueFormatter } from "../format/format.ts";
import { fitText, type MeasureText } from "../layout/text.ts";
import { Polyline } from "../lod/polyline.ts";
import {
  type BandContext,
  type BandList,
  type Bands,
  type Frame,
  type Hit,
  type Mark,
  numericBands,
} from "../marks/mark.ts";
import {
  nearestPosition,
  nearestPositionWithin,
  rowOf,
  type Series,
  xAt,
} from "../marks/series.ts";
import { unionExtent } from "../marks/trace.ts";
import type { PositionScale } from "../scale/scale.ts";
import { TIME_UNIT_MS, type TimeUnit } from "../scale/time.ts";
import {
  type AxisGeometry,
  type ColorLegend,
  LEGEND_SWATCH,
  type LegendItem,
  type Rect,
  type Scene,
} from "../scene/scene.ts";
import type { ChartSpec } from "../spec/spec.ts";
import { resolveTheme, type Theme } from "../theme.ts";
import {
  type AxisContext,
  type AxisPlan,
  type AxisType,
  insetDomain,
  niceAxisDomain,
  planAxis,
  planBandAxis,
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
  /** The axis the inspection follows: "y" in nearest-y mode, otherwise "x". */
  axis: "x" | "y";
  /** Data value on that axis, snapped to the nearest data point. */
  value: number;
  /** Pixel position of `value` on that axis. */
  position: number;
  label: string;
  points: InspectedPoint[];
}

export type TooltipMode = "nearest-x" | "nearest-y" | "nearest";

interface MarkSeries {
  mark: Mark;
  series: Series[];
}

interface LastFrame {
  marks: MarkSeries[];
  /** The mark of each series, for how its points are inspected and formatted. */
  markOf: Map<Series, Mark>;
  frame: Frame;
  mode: TooltipMode;
  formatX: Formatter;
  formatY: Formatter;
  formatValue: Formatter;
}

const TICK = 5;
const GAP = 6;
const LEGEND_GAP = 16;
/** Left inset of the title and legend. */
const EDGE = 8;
const RAMP_WIDTH = 120;

export class ChartModel {
  #config: ChartConfig;
  #theme: Theme;
  width = 640;
  height = 400;
  pixelRatio = 1;
  /** Keys of series hidden through the legend. */
  readonly hidden = new Set<string>();
  #viewport: [number, number] | null = null;
  #polylines = new Map<string, Polyline>();
  #floats = new Map<string, Float32Array>();
  #bytes = new Map<string, Uint8ClampedArray<ArrayBuffer>>();
  #used = new Set<string>();
  #left = 0;
  #layoutKey = "";
  #bands: Bands = {};
  #last: LastFrame | undefined;
  /** Palette slot per series key, assigned on first appearance and kept. */
  #slots = new Map<string, number>();

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

  /** The visible x range, or null to fit the data. Band x axes ignore it. */
  get viewport(): readonly [number, number] | null {
    return this.#viewport;
  }

  setViewport(domain: readonly [number, number] | null): void {
    this.#viewport =
      domain && domain[0] !== domain[1] ? [Math.min(...domain), Math.max(...domain)] : null;
  }

  #context(): BandContext {
    return {
      zone: this.#config.timeZone ?? "local",
      locale: this.#config.locale,
      theme: this.#theme,
    };
  }

  #palette = (seriesKey: string): string => {
    let slot = this.#slots.get(seriesKey);
    if (slot === undefined) {
      slot = this.#slots.size;
      this.#slots.set(seriesKey, slot);
    }
    return this.#theme.palette[slot % this.#theme.palette.length]!;
  };

  /**
   * Axis type from the declared type or the marks' fields: a categorical
   * channel gives a band axis, a time field a time axis.
   */
  #axisType(axis: "x" | "y"): AxisType {
    const declared = this.#config[axis]?.type;
    const kinds = this.#config.marks.map((mark) => mark.channelKind(axis));
    if (kinds.includes("category")) {
      // Every mark with a field on this channel must band it.
      const index = kinds.findIndex((kind) => kind !== undefined && kind !== "category");
      if (index >= 0) {
        const mark = this.#config.marks[index]!;
        throw new Error(
          `A ${mark.spec.type} mark with a numeric ${axis} cannot share a categorical ${axis} axis`,
        );
      }
      if (declared)
        throw new Error(`The ${axis} axis is categorical; its type cannot be "${declared}"`);
      return "band";
    }
    if (declared) return declared;
    return kinds.includes("time") ? "time" : "linear";
  }

  /** Union of the marks' bands by key, keeping the previous list while unchanged. */
  #bandList(axis: "x" | "y", context: BandContext): BandList {
    const seen = new Set<string>();
    const keys: string[] = [];
    const labels: string[] = [];
    for (const mark of this.#config.marks) {
      const bands = mark.bands?.(axis, context);
      if (!bands) continue;
      bands.keys.forEach((key, i) => {
        if (seen.has(key)) return;
        seen.add(key);
        keys.push(key);
        labels.push(bands.labels[i]!);
      });
    }
    const previous = this.#bands[axis];
    const same =
      previous?.keys.length === keys.length &&
      previous.keys.every((key, i) => key === keys[i] && previous.labels[i] === labels[i]);
    return same ? previous : { keys, labels };
  }

  #resolveSeries(bands: Bands, context: BandContext): MarkSeries[] {
    return this.#config.marks.map((mark, index) => ({
      mark,
      series: mark.series(mark.spec.id ?? index, this.#palette, this.hidden, bands, context),
    }));
  }

  /** x extent of all data, ignoring the viewport. */
  dataXExtent(): [number, number] | undefined {
    const type = this.#axisType("x");
    if (type === "band") return undefined;
    const marks = this.#resolveSeries(this.#bands, this.#context());
    return unionExtent(
      marks.map(({ mark, series }) => mark.xExtent(this.#xSeries(mark, series), type === "log")),
    );
  }

  /**
   * Series that set a mark's x extent. An x axis measuring values (bar
   * lengths) follows visible series, as y does; other x extents keep hidden
   * series so toggling one does not shift the axis.
   */
  #xSeries(mark: Mark, series: Series[]): Series[] {
    return mark.zero === "x" ? series.filter((s) => !this.hidden.has(s.key)) : series;
  }

  #pooled<T>(pool: Map<string, T>, key: string, create: () => T): T {
    let value = pool.get(key);
    if (value === undefined) {
      value = create();
      pool.set(key, value);
    }
    this.#used.add(key);
    return value;
  }

  // Stage names never contain "|", so `${stage}|${seriesKey}` is unambiguous.
  #polyline = (seriesKey: string, stage: string): Polyline =>
    this.#pooled(this.#polylines, `${stage}|${seriesKey}`, () => new Polyline());

  #floatBuffer = (seriesKey: string, stage: string, length: number): Float32Array => {
    const key = `${stage}|${seriesKey}`;
    let buffer = this.#pooled(this.#floats, key, () => new Float32Array(Math.max(16, length)));
    if (buffer.length < length) {
      buffer = new Float32Array(Math.ceil(length * 1.5));
      this.#floats.set(key, buffer);
    }
    return buffer;
  };

  #byteBuffer = (
    seriesKey: string,
    stage: string,
    length: number,
  ): Uint8ClampedArray<ArrayBuffer> => {
    const key = `${stage}|${seriesKey}`;
    let buffer = this.#pooled(this.#bytes, key, () => new Uint8ClampedArray(length));
    if (buffer.length < length) {
      buffer = new Uint8ClampedArray(length);
      this.#bytes.set(key, buffer);
    }
    return buffer;
  };

  /**
   * Builds the scene for the current data, size, and view state. With
   * `clouds`, large point series are left to a GPU painter (see PointCloud).
   */
  scene(measure: MeasureText, clouds = false): Scene {
    const config = this.#config;
    const theme = this.#theme;
    const { width, height } = this;
    const context = this.#context();
    const { zone, locale } = context;
    const xType = this.#axisType("x");
    const yType = this.#axisType("y");
    const bands: Bands = {};
    if (xType === "band") bands.x = this.#bandList("x", context);
    if (yType === "band") bands.y = this.#bandList("y", context);
    this.#bands = bands;
    const marks = this.#resolveSeries(bands, context);
    const xContext: AxisContext = { type: xType, spec: config.x, zone, locale };
    const yContext: AxisContext = { type: yType, spec: config.y, zone, locale };
    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    const padding = (axis: "x" | "y") =>
      Math.min(
        0.2,
        ...marks
          .filter(({ mark }) => mark.channelKind(axis) === "category")
          .map(({ mark }) => mark.bandPadding ?? 0.2),
      );

    const drawn = marks.filter(({ series }) => series.length > 0);
    // Room for glyphs that reach past their data position at the plot edges.
    const inset = Math.max(0, ...drawn.map(({ mark }) => mark.inset ?? 0));
    // An x axis measuring bar lengths gets the y axis' defaults: zero, round
    // ends, and grid lines.
    const xMeasures = drawn.some(({ mark }) => mark.zero === "x");

    // x domain: viewport, explicit domain, or data extent. Log axes only
    // consider positive values. Band axes take their categories instead.
    let xDomain: [number, number] = [0, 1];
    let hasData = false;
    if (xType === "band") {
      hasData = (bands.x?.keys.length ?? 0) > 0;
    } else {
      const xLog = xType === "log";
      let dataX = unionExtent(
        marks.map(({ mark, series }) => mark.xExtent(this.#xSeries(mark, series), xLog)),
      );
      if ((config.x?.zero ?? xMeasures) && !xLog) dataX = unionExtent([dataX, [0, 0]]);
      hasData = dataX !== undefined;
      xDomain = usableDomain(this.#viewport ?? config.x?.domain ?? dataX, xType);
    }
    const autoX = xType !== "band" && !this.#viewport && !config.x?.domain;
    const dataXDomain = xDomain;

    // y domain from data visible in the x domain, unless it is fixed.
    let yBase: [number, number] = [0, 1];
    if (yType === "band") {
      hasData &&= (bands.y?.keys.length ?? 0) > 0;
    } else if (config.y?.domain) {
      yBase = usableDomain(config.y.domain, yType);
    } else {
      const yLog = yType === "log";
      const visible = marks.map(({ mark, series }) => ({
        mark,
        series: series.filter((s) => !this.hidden.has(s.key)),
      }));
      const [x0, x1] =
        xType === "band" ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY] : xDomain;
      let yData = unionExtent(
        visible.map(({ mark, series }) => mark.yExtent(series, x0, x1, yLog)),
      );
      const zero =
        config.y?.zero ??
        visible.some(({ mark, series }) => mark.zero === "y" && series.length > 0);
      if (zero && !yLog) yData = unionExtent([yData, [0, 0]]);
      yBase = usableDomain(yData, yType);
    }

    // Vertical layout depends only on fonts, titles, and the legends.
    const ramp = marks
      .map(({ mark, series }) => mark.colorRamp?.(series, theme))
      .find((r) => r !== undefined);
    const legendItems = marks
      .filter(({ mark }) => !mark.colorRamp)
      .flatMap(({ series }) => series.map((s) => ({ key: s.key, label: s.label, color: s.color })));
    const showLegend = config.legend ?? legendItems.length > 1;
    let top = config.title ? lineHeight + 14 : Math.ceil(theme.fontSize / 2) + 2;
    const legend = showLegend
      ? this.#layoutLegend(legendItems, top, measure, font, lineHeight)
      : [];
    let colorLegend: ColorLegend | undefined;
    if (ramp && (config.legend ?? true)) {
      const after = legend.at(-1);
      const start = after
        ? after.x + LEGEND_SWATCH + 6 + measure(after.label, font) + LEGEND_GAP
        : EDGE;
      const low = formatNumber(ramp.domain[0], locale);
      const high = formatNumber(ramp.domain[1], locale);
      const titleWidth = measure(ramp.title, font) + 10;
      const lowWidth = measure(low, font) + 6;
      const total = titleWidth + lowWidth + RAMP_WIDTH + 6 + measure(high, font);
      const wrap = start > EDGE && start + total > width - EDGE;
      const x = wrap ? EDGE : start;
      colorLegend = {
        stops: ramp.stops,
        y: wrap ? (after?.y ?? top) + lineHeight + 4 : (after?.y ?? top),
        title: { text: ramp.title, x },
        low: { text: low, x: x + titleWidth },
        ramp: { x: x + titleWidth + lowWidth, width: RAMP_WIDTH },
        high: { text: high, x: x + titleWidth + lowWidth + RAMP_WIDTH + 6 },
      };
    }
    const lastLegendRow = Math.max(legend.at(-1)?.y ?? -Infinity, colorLegend?.y ?? -Infinity);
    if (Number.isFinite(lastLegendRow)) top = lastLegendRow + lineHeight + 8;
    const showX = config.x?.axis ?? true;
    const showY = config.y?.axis ?? true;
    const bottom = showX
      ? TICK + GAP + lineHeight + (config.x?.label ? lineHeight + GAP : 0) + 2
      : 4;
    const plotHeight = Math.max(10, height - top - bottom);
    const measureLabel = (label: string) => measure(label, font);

    // y ticks decide the left margin.
    let yPlan: AxisPlan;
    if (yType === "band") {
      // Categories read top to bottom; bands of numbers rise like a numeric axis.
      const upward = bands.y !== undefined && numericBands(bands.y);
      yPlan = planBandAxis(
        bands.y?.labels ?? [],
        upward ? [top + plotHeight, top] : [top, top + plotHeight],
        padding("y"),
        () => lineHeight,
      );
      // Long category names are shortened rather than squeezing the plot.
      const room = Math.max(48, Math.round(width * 0.3));
      yPlan.labels = yPlan.labels.map((label) => fitText(label, room, measure, font));
    } else {
      const yCount = config.y?.ticks ?? Math.max(2, Math.round(plotHeight / 45));
      const yDomain = config.y?.domain
        ? yBase
        : insetDomain(
            niceAxisDomain(yBase, yContext, yCount, config.y?.nice ?? true),
            inset,
            plotHeight,
            yType,
          );
      yPlan = planAxis(yContext, yDomain, [top + plotHeight, top], yCount);
    }
    const yLabels = hasData ? yPlan.labels : [];
    const labelWidth = Math.max(0, ...yLabels.map(measureLabel));
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
    let xPlan: AxisPlan = planBandAxis([], [0, 1], 0, () => 0);
    for (let pass = 0; pass < 3; pass++) {
      const plotWidth = Math.max(10, width - left - right);
      if (xType === "band") {
        xPlan = planBandAxis(
          bands.x?.labels ?? [],
          [left, left + plotWidth],
          padding("x"),
          measureLabel,
        );
      } else {
        const xCount =
          config.x?.ticks ?? Math.max(2, Math.round(plotWidth / (xType === "time" ? 100 : 80)));
        if (autoX) {
          xDomain = insetDomain(
            niceAxisDomain(dataXDomain, xContext, xCount, config.x?.nice ?? xMeasures),
            inset,
            plotWidth,
            xType,
          );
        }
        xPlan = planAxis(xContext, xDomain, [left, left + plotWidth], xCount);
      }
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
      locale,
      hidden: this.hidden,
      owner: this,
      clouds,
      polyline: this.#polyline,
      floats: this.#floatBuffer,
      bytes: this.#byteBuffer,
    };
    const geometry = marks.flatMap(({ mark, series }, index) =>
      mark.geometry(series, frame, mark.spec.id ?? index),
    );
    // Drop buffers of series that no longer exist.
    for (const pool of [this.#polylines, this.#floats, this.#bytes] as Map<string, unknown>[]) {
      for (const key of pool.keys()) if (!this.#used.has(key)) pool.delete(key);
    }

    let vertices = 0;
    for (const item of geometry) vertices += item.draw.size(item);

    const formatNumbers: Formatter = (v) => formatNumber(v, locale);
    const categoryOf =
      (scale: PositionScale): Formatter =>
      (v) =>
        scale.categories?.[Math.round(v)] ?? "";
    const tooltip = config.tooltip;
    // Cells are always found under the pointer, so charts of cells only
    // (heatmaps) inspect the nearest cell whatever mode is requested.
    const kinds = new Set(drawn.map(({ mark }) => mark.tooltip));
    const only = kinds.size === 1 ? [...kinds][0] : kinds.size === 0 ? "x" : undefined;
    const mode: TooltipMode =
      only === "cell"
        ? "nearest"
        : ((typeof tooltip === "object" ? tooltip.mode : undefined) ??
          (only === "x" ? "nearest-x" : only === "y" ? "nearest-y" : "nearest"));
    const markOf = new Map<Series, Mark>();
    for (const { mark, series } of marks) for (const s of series) markOf.set(s, mark);
    this.#last = {
      marks,
      markOf,
      frame,
      mode,
      formatX:
        xType === "band"
          ? categoryOf(x)
          : xType === "time"
            ? valueFormatter(xContext, timeValueFormatter(timeUnitFor(x, plot.width), zone, locale))
            : valueFormatter(xContext, formatNumbers),
      formatY: yType === "band" ? categoryOf(y) : valueFormatter(yContext, formatNumbers),
      formatValue: formatNumbers,
    };

    return {
      width,
      height,
      pixelRatio: this.pixelRatio,
      theme,
      plot,
      title: config.title ? { text: config.title, x: EDGE, y: lineHeight / 2 + 6 } : undefined,
      grid: {
        x:
          hasData && xType !== "band" && (config.x?.grid ?? xMeasures)
            ? xPlan.ticks.map((t) => x.map(t))
            : [],
        y:
          hasData && yType !== "band" && (config.y?.grid ?? true)
            ? yPlan.ticks.map((t) => y.map(t))
            : [],
      },
      axes,
      legend,
      colorLegend,
      marks: geometry,
      vertices,
    };
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
  xScale(): PositionScale | undefined {
    return this.#last?.frame.x;
  }

  /** y scale of the last scene. */
  yScale(): PositionScale | undefined {
    return this.#last?.frame.y;
  }

  /**
   * The axis data is placed along, which a cursor follows: y when marks are
   * placed along y (horizontal bars), otherwise x.
   */
  cursorAxis(): "x" | "y" {
    const marks = this.#last?.marks ?? [];
    return marks.some(({ mark, series }) => mark.tooltip === "y" && series.length > 0) ? "y" : "x";
  }

  /** Tooltip mode of the last scene: the chart's, or one suited to its marks. */
  tooltipMode(): TooltipMode {
    return this.#last?.mode ?? "nearest-x";
  }

  /** Sentences describing marks without series (annotations), as of the last scene. */
  annotationSummaries(): string[] {
    const last = this.#last;
    const fallback = (value: number) => formatNumber(value, this.#config.locale);
    const format = { x: last?.formatX ?? fallback, y: last?.formatY ?? fallback };
    return this.#config.marks.flatMap((mark) => mark.describe?.(format, this.#config.locale) ?? []);
  }

  /** Series of the last scene, for legends, tooltips, and summaries. */
  series(): Series[] {
    const marks = this.#last?.marks ?? this.#resolveSeries(this.#bands, this.#context());
    return marks.flatMap(({ series }) => series);
  }

  #visibleSeries(last: LastFrame, filter: (mark: Mark) => boolean): Series[] {
    return last.marks
      .filter(({ mark }) => filter(mark))
      .flatMap((entry) => entry.series)
      .filter((s) => !this.hidden.has(s.key) && s.length > 0);
  }

  /**
   * Finds the data under a pointer position for tooltips. "nearest-x" reports
   * every visible series at the data x nearest the pointer, "nearest-y" the
   * same along y; "nearest" reports the single closest point. Sorted series
   * use binary search; marks with their own lookup (grid indexes, cell
   * tables) use it.
   */
  inspect(px: number, py: number, mode?: TooltipMode): Inspection | undefined {
    const last = this.#last;
    if (!last) return undefined;
    const { plot } = last.frame;
    if (px < plot.x || px > plot.x + plot.width || py < plot.y || py > plot.y + plot.height)
      return undefined;
    const requested = mode ?? last.mode;
    // Cells are always found under the pointer, so with nothing placed along
    // an axis (heatmaps only) every mode inspects the nearest cell.
    const series = this.#visibleSeries(last, (mark) => mark.tooltip !== "cell");
    if (requested === "nearest" || series.length === 0) {
      const hit = this.#nearest(px, py, last);
      if (!hit) return undefined;
      const point = this.#point(hit.series, hit.position, last);
      if (!point) return undefined;
      // The heading names where the point is placed: its x, or its y
      // category for marks along y.
      const axis = last.markOf.get(hit.series)?.tooltip === "y" ? "y" : "x";
      return this.#inspection(axis, hit.series[axis][rowOf(hit.series, hit.position)]!, [point]);
    }
    // Snap to the data value nearest the pointer across every visible
    // series, among points drawn in view.
    const axis = requested === "nearest-y" ? "y" : "x";
    const scale = last.frame[axis];
    const target = scale.invert(axis === "x" ? px : py);
    const lo = Math.min(scale.domain[0], scale.domain[1]);
    const hi = Math.max(scale.domain[0], scale.domain[1]);
    let snapped = Number.NaN;
    for (const s of series) {
      const position =
        axis === "x"
          ? nearestPositionWithin(s, target, lo, hi)
          : this.#scanNearest(s, "y", target, lo, hi, last);
      if (position < 0) continue;
      const value = s[axis][rowOf(s, position)]!;
      if (Number.isNaN(snapped) || Math.abs(value - target) < Math.abs(snapped - target))
        snapped = value;
    }
    if (!Number.isFinite(snapped)) return undefined;
    return this.#inspectAt(axis, snapped, series, last);
  }

  /**
   * Position of the point nearest `target` among those whose value on `axis`
   * is in [lo, hi] and that are drawn, by a scan; -1 when none is. Unsorted
   * series may hold several rows at one position (long-format bars), some of
   * them missing, so every row is checked.
   */
  #scanNearest(
    s: Series,
    axis: "x" | "y",
    target: number,
    lo: number,
    hi: number,
    last: LastFrame,
  ): number {
    const column = s[axis];
    let best = -1;
    let bestDistance = Infinity;
    for (let k = 0; k < s.length; k++) {
      const row = rowOf(s, k);
      const at = column[row]!;
      if (!(at >= lo && at <= hi)) continue;
      const distance = Math.abs(at - target);
      if (distance >= bestDistance || !this.#drawn(s, row, last)) continue;
      best = k;
      bestDistance = distance;
    }
    return best;
  }

  /**
   * Whether a point is drawn: its value is finite and both scales can place
   * it. A point of a mark inspected along y (a horizontal bar) also needs
   * part of it, from base to end, inside the x domain; its end may lie
   * outside the plot.
   */
  #drawn(s: Series, row: number, last: LastFrame): boolean {
    const { x, y } = last.frame;
    const end = s.x[row]!;
    if (
      !Number.isFinite(s.values[row]!) ||
      !Number.isFinite(x.map(end)) ||
      !Number.isFinite(y.map(s.y[row]!))
    )
      return false;
    const mark = last.markOf.get(s);
    if (mark?.tooltip !== "y") return true;
    const base = s.x0 ? s.x0[row]! : mark.zero === "x" ? 0 : end;
    const lo = Math.min(x.domain[0], x.domain[1]);
    const hi = Math.max(x.domain[0], x.domain[1]);
    return Math.max(base, end) >= lo && Math.min(base, end) <= hi;
  }

  #nearest(px: number, py: number, last: LastFrame): Hit | undefined {
    const { frame } = last;
    const { x, y } = frame;
    let best: Hit | undefined;
    const consider = (s: Series, k: number) => {
      const row = rowOf(s, k);
      const distance = Math.hypot(x.map(s.x[row]!) - px, y.map(s.y[row]!) - py);
      if (distance < (best?.distance ?? Infinity) && this.#drawn(s, row, last))
        best = { series: s, position: k, distance };
    };
    const target = x.invert(px);
    for (const { mark, series } of last.marks) {
      const visible = series.filter((s) => !this.hidden.has(s.key) && s.length > 0);
      if (mark.pick) {
        // Ties go to later marks, which are drawn on top.
        const hit = mark.pick(visible, px, py, frame);
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
  inspectPosition(seriesKey: string, position: number): Inspection | undefined {
    const last = this.#last;
    if (!last) return undefined;
    const series = this.#visibleSeries(last, () => true);
    const anchor = series.find((s) => s.key === seriesKey);
    if (!anchor || position < 0 || position >= anchor.length) return undefined;
    const axis = last.markOf.get(anchor)?.tooltip === "y" ? "y" : "x";
    const along = this.#visibleSeries(last, (mark) => mark.tooltip === axis);
    return this.#inspectAt(
      axis,
      anchor[axis][rowOf(anchor, position)]!,
      along.includes(anchor) ? along : [anchor],
      last,
      anchor,
      position,
    );
  }

  /** Every series' point at `value` on `axis`. */
  #inspectAt(
    axis: "x" | "y",
    value: number,
    series: readonly Series[],
    last: LastFrame,
    anchor?: Series,
    anchorPosition?: number,
  ): Inspection {
    const points: InspectedPoint[] = [];
    for (const s of series) {
      const position = s === anchor ? anchorPosition! : this.#positionAt(s, axis, value, last);
      if (position < 0) continue;
      const point = this.#point(s, position, last);
      if (point) points.push(point);
    }
    return this.#inspection(axis, value, points);
  }

  /** Position of a drawn point of `s` at `value` on `axis`, or -1. */
  #positionAt(s: Series, axis: "x" | "y", value: number, last: LastFrame): number {
    if (axis === "x" && s.sorted) {
      const k = nearestPosition(s, value);
      return k >= 0 && xAt(s, k) === value ? k : -1;
    }
    return this.#scanNearest(s, axis, value, value, value, last);
  }

  #inspection(axis: "x" | "y", value: number, points: InspectedPoint[]): Inspection {
    const last = this.#last!;
    return {
      axis,
      value,
      position: last.frame[axis].map(value),
      label: axis === "x" ? last.formatX(value) : last.formatY(value),
      points,
    };
  }

  #point(s: Series, position: number, last: LastFrame): InspectedPoint | undefined {
    const { x, y } = last.frame;
    const row = rowOf(s, position);
    const value = s.values[row]!;
    const px = x.map(s.x[row]!);
    const py = y.map(s.y[row]!);
    // Values a scale cannot place (log axes) are not drawn, so not reported.
    if (!(Number.isFinite(value) && Number.isFinite(px) && Number.isFinite(py))) return undefined;
    const tooltip = last.markOf.get(s)?.tooltip;
    // A cell's label is its y category and its value a measure; marks
    // inspected along y (horizontal bars) measure their values on x.
    const low = s.range ? s.y0![row]! : Number.NaN;
    return {
      key: s.key,
      label: tooltip === "cell" ? last.formatY(s.y[row]!) : s.label,
      color: s.color,
      value,
      text: s.range
        ? `${last.formatY(low)} – ${last.formatY(value)}`
        : tooltip === "cell"
          ? last.formatValue(value)
          : tooltip === "y"
            ? last.formatX(value)
            : last.formatY(value),
      px,
      py,
    };
  }

  /** Releases geometry buffers. */
  dispose(): void {
    this.#polylines.clear();
    this.#floats.clear();
    this.#bytes.clear();
    this.#last = undefined;
  }
}

/** Precision for x values in tooltips: finer when each pixel covers less time. */
function timeUnitFor(scale: PositionScale, pixels: number): TimeUnit {
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
