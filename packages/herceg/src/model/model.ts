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
  type Mark,
  numericBands,
} from "../marks/mark.ts";
import type { Series } from "../marks/series.ts";
import { unionExtent } from "../marks/trace.ts";
import type { PositionScale } from "../scale/scale.ts";
import { TIME_UNIT_MS, type TimeUnit } from "../scale/time.ts";
import {
  type AxisGeometry,
  type ColorLegend,
  LEGEND_SWATCH,
  type LegendItem,
  type Panel,
  type Rect,
  type Scene,
} from "../scene/scene.ts";
import type { AxisSpec, ChartSpec } from "../spec/spec.ts";
import { resolveTheme, type Theme } from "../theme.ts";
import {
  type AxisContext,
  type AxisPlan,
  type AxisType,
  headroomDomain,
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

import { type Inspection, Inspector, type MarkSeries, type TooltipMode } from "./inspect.ts";

export type { InspectedPoint, Inspection, TooltipMode } from "./inspect.ts";

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
  #right = 0;
  #layoutKey = "";
  #bands: Bands = {};
  #last: Inspector | undefined;
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
  #axisType(axis: "x" | "y" | "yRight"): AxisType {
    const declared = this.#config[axis]?.type;
    const channel = axis === "x" ? "x" : "y";
    // The y axes take the marks on their side.
    const marks = this.#config.marks.filter(
      (mark) => axis === "x" || (sideOf(mark) === "right") === (axis === "yRight"),
    );
    const kinds = marks.map((mark) => mark.channelKind(channel));
    if (kinds.includes("category")) {
      if (axis === "yRight") throw new Error("Category y values cannot go on the right axis");
      // Every mark with a field on this channel must band it.
      const index = kinds.findIndex((kind) => kind !== undefined && kind !== "category");
      if (index >= 0) {
        const mark = marks[index]!;
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
    return mark.tooltip === "y" ? series.filter((s) => !this.hidden.has(s.key)) : series;
  }

  /**
   * The extent of the y values `marks` show inside the x range [x0, x1], of
   * visible series only, with zero when the axis asks for it or a mark
   * stands on it; undefined when they show none.
   */
  #yData(
    marks: readonly MarkSeries[],
    type: AxisType,
    spec: AxisSpec | undefined,
    x0: number,
    x1: number,
  ): [number, number] | undefined {
    const log = type === "log";
    const visible = marks.map(({ mark, series }) => ({
      mark,
      series: series.filter((s) => !this.hidden.has(s.key)),
    }));
    const data = unionExtent(visible.map(({ mark, series }) => mark.yExtent(series, x0, x1, log)));
    const zero =
      spec?.zero ?? visible.some(({ mark, series }) => mark.zero === "y" && series.length > 0);
    return zero && !log && data ? unionExtent([data, [0, 0]]) : data;
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
    const inset = (axis: "x" | "y", among = drawn) =>
      Math.max(0, ...among.map(({ mark }) => mark.inset?.[axis] ?? 0));
    // An x axis measuring bar lengths gets the y axis' defaults: zero, round
    // ends, and grid lines.
    const xMeasures = drawn.some(({ mark }) => mark.zero === "x");
    // Room past the far ends of value axes for what marks draw there (bar labels).
    const headroom = (axis: "x" | "y", among = drawn) =>
      Math.max(
        0,
        ...among
          .filter(({ mark }) => mark.zero === axis && mark.headroom)
          .map(({ mark, series }) =>
            mark.headroom!(
              series.filter((s) => !this.hidden.has(s.key)),
              context,
            ),
          ),
      );

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

    // y domains from data visible in the x domain, unless they are fixed;
    // marks with `axis: "right"` have their own.
    const leftMarks = marks.filter(({ mark }) => sideOf(mark) === "left");
    const rightMarks = marks.filter(({ mark }) => sideOf(mark) === "right");
    const [x0, x1] =
      xType === "band" ? [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY] : xDomain;
    // A y axis is shown when one of its marks places values along y, and
    // the left one also when the right one is not.
    const placesY = (side: readonly MarkSeries[]) => side.some(({ mark }) => usesY(mark));
    const rightUsed = placesY(rightMarks);
    const yRightType = rightUsed ? this.#axisType("yRight") : "linear";
    let yBase: [number, number] = [0, 1];
    let leftUsed = true;
    // Whether the left axis has anything to label: a band axis may have no bands.
    let leftData = true;
    if (yType === "band") {
      leftData = (bands.y?.keys.length ?? 0) > 0;
      hasData &&= leftData || rightUsed;
    } else {
      leftUsed = !rightUsed || placesY(leftMarks);
      yBase = usableDomain(
        config.y?.domain ?? this.#yData(leftMarks, yType, config.y, x0, x1),
        yType,
      );
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
    /** A continuous y axis for the marks on one side, from their data domain `base`. */
    const planValueAxis = (
      axisContext: AxisContext,
      base: [number, number],
      sideMarks: readonly MarkSeries[],
    ): AxisPlan => {
      const spec = axisContext.spec;
      const count = spec?.ticks ?? Math.max(2, Math.round(plotHeight / 45));
      const sideDrawn = sideMarks.filter(({ series }) => series.length > 0);
      const domain = spec?.domain
        ? base
        : insetDomain(
            headroomDomain(
              niceAxisDomain(base, axisContext, count, spec?.nice ?? true),
              headroom("y", sideDrawn),
              plotHeight,
              axisContext.type,
            ),
            inset("y", sideDrawn),
            plotHeight,
            axisContext.type,
          );
      return planAxis(axisContext, domain, [top + plotHeight, top], count);
    };

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
      yPlan = planValueAxis(yContext, yBase, leftMarks);
    }
    const yRightContext: AxisContext = { type: yRightType, spec: config.yRight, zone, locale };
    const yRightPlan = rightUsed
      ? planValueAxis(
          yRightContext,
          usableDomain(
            config.yRight?.domain ?? this.#yData(rightMarks, yRightType, config.yRight, x0, x1),
            yRightType,
          ),
          rightMarks,
        )
      : undefined;
    const showLeft = showY && leftUsed;
    const yLabels = hasData && showLeft && leftData ? yPlan.labels : [];
    const labelWidth = Math.max(0, ...yLabels.map(measureLabel));
    let left = showLeft ? Math.ceil(labelWidth) + GAP + 2 : 8;
    if (showLeft && config.y?.label) left += lineHeight + GAP;
    // Avoid layout jitter while data streams: margins grow at once but only
    // shrink when the size or configuration changes.
    const layoutKey = `${width}x${height}`;
    const sameLayout = layoutKey === this.#layoutKey;
    if (sameLayout) left = Math.max(left, this.#left);
    this.#layoutKey = layoutKey;

    // The right axis' labels decide the right margin, as the left one's do the left.
    const showRight = yRightPlan !== undefined && (config.yRight?.axis ?? true);
    const yRightLabels = showRight && hasData ? yRightPlan.labels : [];
    let right = 12;
    if (showRight) {
      right = Math.ceil(Math.max(0, ...yRightLabels.map(measureLabel))) + GAP + 2;
      if (config.yRight?.label) right += lineHeight + GAP;
    }
    if (sameLayout) right = Math.max(right, this.#right);

    // x ticks; widen the margins if the first or last label would be clipped,
    // by up to a quarter of the width a side: labels that cannot fit must not
    // squeeze the plot away.
    const edgeRoom = Math.floor(width / 4);
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
            headroomDomain(
              niceAxisDomain(dataXDomain, xContext, xCount, config.x?.nice ?? xMeasures),
              headroom("x"),
              plotWidth,
              xType,
            ),
            inset("x"),
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
      if (overflowRight > 0.5)
        right = Math.max(right, Math.min(right + Math.ceil(overflowRight), edgeRoom));
      if (overflowLeft > 0.5)
        left = Math.max(left, Math.min(left + Math.ceil(overflowLeft), edgeRoom));
    }
    this.#left = left;
    this.#right = right;
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
    // A y axis along one edge of the plot, its title outside the labels.
    const yAxis = (
      orient: "left" | "right",
      plan: AxisPlan,
      labels: string[],
      title: string | undefined,
      titleX: number,
    ): AxisGeometry => ({
      orient,
      offset: orient === "left" ? plot.x : plot.x + plot.width,
      start: plot.y + plot.height,
      end: plot.y,
      line: false,
      ticks: labels.map((label, i) => ({ position: plan.scale.map(plan.ticks[i]!), label })),
      title: title ? { text: title, x: titleX, y: plot.y + plot.height / 2 } : undefined,
    });
    if (showLeft) {
      axes.push(yAxis("left", yPlan, yLabels, config.y?.label, lineHeight / 2 + 2));
    }
    if (showRight) {
      axes.push(
        yAxis("right", yRightPlan, yRightLabels, config.yRight?.label, width - lineHeight / 2 - 2),
      );
    }

    // Horizontal grid lines follow the left axis, or the right one when the left is unused.
    const gridPlan = leftUsed
      ? yType !== "band" && (config.y?.grid ?? true) && yPlan
      : (config.yRight?.grid ?? true) && yRightPlan;

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
    // Marks on the right axis draw with its scale.
    const rightFrame: Frame | undefined = yRightPlan && { ...frame, y: yRightPlan.scale };
    const frameOf = (mark: Mark) => (sideOf(mark) === "right" && rightFrame) || frame;
    const geometry = marks.flatMap(({ mark, series }, index) =>
      mark.geometry(series, frameOf(mark), mark.spec.id ?? index),
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
    const valueFormat = (context: AxisContext, scale: PositionScale): Formatter =>
      context.type === "time"
        ? valueFormatter(context, timeValueFormatter(timeUnitFor(scale, plot.height), zone, locale))
        : valueFormatter(context, formatNumbers);
    this.#last = new Inspector({
      marks,
      frame,
      right: rightFrame && {
        marks: new Set(rightMarks.map(({ mark }) => mark)),
        frame: rightFrame,
        formatY: valueFormat(yRightContext, rightFrame.y),
      },
      mode,
      hidden: this.hidden,
      formatX:
        xType === "band"
          ? categoryOf(x)
          : xType === "time"
            ? valueFormatter(xContext, timeValueFormatter(timeUnitFor(x, plot.width), zone, locale))
            : valueFormatter(xContext, formatNumbers),
      formatY: yType === "band" ? categoryOf(y) : valueFormat(yContext, y),
      formatValue: formatNumbers,
    });

    const panel: Panel = {
      key: "",
      plot,
      grid: {
        x:
          hasData && xType !== "band" && (config.x?.grid ?? xMeasures)
            ? xPlan.ticks.map((t) => x.map(t))
            : [],
        y: hasData && gridPlan ? gridPlan.ticks.map((t) => gridPlan.scale.map(t)) : [],
      },
      axes,
      marks: geometry,
    };
    return {
      width,
      height,
      pixelRatio: this.pixelRatio,
      theme,
      title: config.title ? { text: config.title, x: EDGE, y: lineHeight / 2 + 6 } : undefined,
      panels: [panel],
      legend,
      colorLegend,
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

  /** Scale of the right y axis in the last scene, when marks use it. */
  yRightScale(): PositionScale | undefined {
    return this.#last?.rightFrame?.y;
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
    return this.#config.marks.flatMap((mark) => {
      const format = { x: last?.formatX ?? fallback, y: last?.axisOf(mark).formatY ?? fallback };
      return mark.describe?.(format, this.#config.locale) ?? [];
    });
  }

  /** Whether a series of the last scene is on the right y axis. */
  onRight(series: Series): boolean {
    return this.#last?.onRight(series) ?? false;
  }

  /** Series of the last scene, for legends, tooltips, and summaries. */
  series(): Series[] {
    const marks = this.#last?.marks ?? this.#resolveSeries(this.#bands, this.#context());
    return marks.flatMap(({ series }) => series);
  }

  /**
   * Finds the data under a pointer position for tooltips; see
   * `Inspector.inspect`.
   */
  inspect(px: number, py: number, mode?: TooltipMode): Inspection | undefined {
    return this.#last?.inspect(px, py, mode);
  }

  /** Inspects one point of a series by position; see `Inspector.inspectPosition`. */
  inspectPosition(seriesKey: string, position: number): Inspection | undefined {
    return this.#last?.inspectPosition(seriesKey, position);
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

/** The y axis a mark's values are on. */
function sideOf(mark: Mark): "left" | "right" {
  return mark.spec.axis === "right" ? "right" : "left";
}

/**
 * Whether a mark places values along y: a y position in its spec or a y
 * field, whatever its data and the view. Vertical rules and custom marks
 * without fields do not.
 */
function usesY(mark: Mark): boolean {
  const { y, y1, y2 } = mark.spec as { y?: unknown; y1?: unknown; y2?: unknown };
  return y !== undefined || y1 !== undefined || y2 !== undefined || !!mark.channelKind("y");
}

/** Rejects configurations whose mark identities would collide or cannot be laid out. */
function validate(config: ChartConfig): void {
  const ids = new Set<string>();
  for (const mark of config.marks) {
    // The right axis measures values; marks placed along y belong on the left.
    if (sideOf(mark) === "right" && (mark.tooltip === "y" || mark.tooltip === "cell"))
      throw new Error(`A ${mark.spec.type} mark placed along y cannot use the right axis`);
    const id = mark.spec.id;
    if (id === undefined) continue;
    if (ids.has(id)) throw new Error(`Duplicate mark id "${id}"`);
    ids.add(id);
  }
}
