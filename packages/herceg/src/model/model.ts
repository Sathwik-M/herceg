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
  shiftPlan,
  usableDomain,
  valueFormatter,
} from "./axis.ts";
import type { Facet, PanelSplit, Splitter } from "./facet.ts";

/** Chart options with marks bound to their data. */
export type ChartConfig = Omit<
  ChartSpec,
  "marks" | "data" | "width" | "height" | "version" | "facet"
> & {
  marks: readonly Mark[];
  /** Small multiples: a panel per value of a category field (see `facet`). */
  facet?: Facet | undefined;
};

import { type Inspection, Inspector, type MarkSeries, type TooltipMode } from "./inspect.ts";

/** A panel of the last scene and what inspects it. */
interface PanelView {
  key: string;
  plot: Rect;
  inspector: Inspector;
}

/** A panel of the last scene, as the browser runtime reads it. */
export interface PanelInfo {
  /** The facet value; "" without facets. */
  key: string;
  plot: Rect;
  x: PositionScale;
}

export type { InspectedPoint, Inspection, TooltipMode } from "./inspect.ts";

const TICK = 5;
/** Smallest plot side, in pixels, of a panel among several. */
const MIN_PANEL = 20;
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
  #columnGap = 0;
  #layoutKey = "";
  /** Scenes built so far. */
  #scenes = 0;
  #bands: Bands = {};
  /** Splits series into the panels of the chart's facet. */
  #splitter: { facet: Facet; splitter: Splitter } | undefined;
  /** Each panel of the last scene, for inspection and scales. */
  #views: PanelView[] = [];
  /** Every mark's series in the last scene: those of all panels. */
  #drawn: MarkSeries[] = [];
  /** Every mark's series before facets split them, for legends and summaries. */
  #base: MarkSeries[] | undefined;
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

  /** The chart's panels and what each draws: without facets, one panel with every series. */
  #split(base: MarkSeries[]): PanelSplit {
    const facet = this.#config.facet;
    if (!facet) {
      // A previous facet's splits would keep its tables alive.
      this.#splitter = undefined;
      return { keys: [""], panels: [base], all: base };
    }
    if (this.#splitter?.facet !== facet) this.#splitter = { facet, splitter: facet.splitter() };
    return this.#splitter.splitter.split(base);
  }

  /** x extent of all data drawn, ignoring the viewport. */
  dataXExtent(): [number, number] | undefined {
    const type = this.#axisType("x");
    if (type === "band") return undefined;
    const marks = this.#split(this.#resolveSeries(this.#bands, this.#context())).all;
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
   * Buffer pools for panel `index`: each panel draws into buffers of its own.
   * Kept out of `scene` so frames, which inspectors keep, hold no scene state.
   */
  #pools(index: number): Pick<Frame, "polyline" | "floats" | "bytes"> {
    if (index === 0) {
      return { polyline: this.#polyline, floats: this.#floatBuffer, bytes: this.#byteBuffer };
    }
    const at = (stage: string) => `${stage}~${index}`;
    return {
      polyline: (key, stage) => this.#polyline(key, at(stage)),
      floats: (key, stage, length) => this.#floatBuffer(key, at(stage), length),
      bytes: (key, stage, length) => this.#byteBuffer(key, at(stage), length),
    };
  }

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
    const base = this.#resolveSeries(bands, context);
    const split = this.#split(base);
    // Domains and layout consider what every panel draws.
    const marks = split.all;
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
    const ramp = base
      .map(({ mark, series }) => mark.colorRamp?.(series, theme))
      .find((r) => r !== undefined);
    const legendItems = base
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
    // Panels fill a grid of `columns`; without facets, one cell. Each facet
    // panel has a header with its value, and rows leave room below for the
    // x labels of panels above an empty cell.
    const panelCount = split.keys.length;
    const facet = config.facet;
    const columns = facet
      ? Math.min(panelCount, facet.columns ?? Math.ceil(Math.sqrt(panelCount)))
      : 1;
    const rows = Math.ceil(panelCount / columns);
    const header = facet ? lineHeight + 4 : 0;
    const rowGap = rows > 1 ? (showX ? TICK + GAP + lineHeight : 0) + 8 : 0;
    const rowHeight = (height - top - bottom - (rows - 1) * rowGap) / rows - header;
    if (panelCount > 1 && rowHeight < MIN_PANEL) throw tooSmall(panelCount, columns, width, height);
    const plotHeight = Math.max(10, rowHeight);
    const plotTop = top + header;
    const rowOffset = (row: number) => row * (header + plotHeight + rowGap);
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
      return planAxis(axisContext, domain, [plotTop + plotHeight, plotTop], count);
    };

    // y ticks decide the left margin.
    let yPlan: AxisPlan;
    if (yType === "band") {
      // Categories read top to bottom; bands of numbers rise like a numeric axis.
      const upward = bands.y !== undefined && numericBands(bands.y);
      yPlan = planBandAxis(
        bands.y?.labels ?? [],
        upward ? [plotTop + plotHeight, plotTop] : [plotTop, plotTop + plotHeight],
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
    // and the gap between columns of panels if labels at the edges of
    // neighboring panels would meet, by up to a quarter of the width each:
    // labels that cannot fit must not squeeze the plots away.
    const edgeRoom = Math.floor(width / 4);
    let columnGap = columns > 1 ? Math.max(16, sameLayout ? this.#columnGap : 0) : 0;
    const widthOf = () => (width - left - right - (columns - 1) * columnGap) / columns;
    // The x plan for panels `plotWidth` wide, the first starting at `left`.
    const planX = (plotWidth: number): AxisPlan => {
      if (xType === "band") {
        return planBandAxis(
          bands.x?.labels ?? [],
          [left, left + plotWidth],
          padding("x"),
          measureLabel,
        );
      }
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
      return planAxis(xContext, xDomain, [left, left + plotWidth], xCount);
    };
    let plotWidth = Math.max(10, widthOf());
    let xPlan = planX(plotWidth);
    // Widen until the labels fit or the limits are reached. Whatever still
    // needs more after a few passes goes straight to its limit, so the margins
    // kept for the next scene are ones that scene keeps too.
    for (let pass = 0; pass < 10; pass++) {
      const last = xPlan.ticks.length - 1;
      if (last < 0 || !hasData || !showX) break;
      const half = (index: number) => measure(xPlan.labels[index]!, font) / 2;
      const lastEnd = xPlan.scale.map(xPlan.ticks[last]!) + half(last);
      const firstStart = xPlan.scale.map(xPlan.ticks[0]!) - half(0);
      const overflowRight = lastEnd + (columns - 1) * (plotWidth + columnGap) - (width - 2);
      const overflowLeft = 2 - firstStart;
      // How far labels reach past a panel's sides, into the gap between columns.
      const spill = Math.max(0, lastEnd - (left + plotWidth)) + Math.max(0, left - firstStart);
      const widen = (current: number, need: number) =>
        need <= current
          ? current
          : Math.max(current, pass < 3 ? Math.min(need, edgeRoom) : edgeRoom);
      const nextLeft = overflowLeft > 0.5 ? widen(left, left + Math.ceil(overflowLeft)) : left;
      const nextRight =
        overflowRight > 0.5 ? widen(right, right + Math.ceil(overflowRight)) : right;
      const nextGap = columns > 1 ? widen(columnGap, Math.ceil(spill) + 8) : 0;
      if (nextLeft === left && nextRight === right && nextGap === columnGap) break;
      left = nextLeft;
      right = nextRight;
      columnGap = nextGap;
      plotWidth = Math.max(10, widthOf());
      xPlan = planX(plotWidth);
    }
    if (panelCount > 1 && widthOf() < MIN_PANEL) throw tooSmall(panelCount, columns, width, height);
    this.#left = left;
    this.#right = right;
    this.#columnGap = columnGap;
    const columnOffset = (column: number) => column * (plotWidth + columnGap);

    // Every panel shares the x and y plans, moved to its column and row.
    const xPlans = Array.from({ length: columns }, (_, c) =>
      shiftPlan(xPlan, xContext, columnOffset(c)),
    );
    const yPlans = Array.from({ length: rows }, (_, r) => shiftPlan(yPlan, yContext, rowOffset(r)));
    const gridWidth = columns * plotWidth + (columns - 1) * columnGap;
    const gridHeight = rows * (header + plotHeight) + (rows - 1) * rowGap;
    const xGrid = hasData && xType !== "band" && (config.x?.grid ?? xMeasures);
    // Horizontal grid lines follow the left axis, or the right one when the left is unused.
    const gridPlan = leftUsed
      ? yType !== "band" && (config.y?.grid ?? true) && yPlan
      : (config.yRight?.grid ?? true) && yRightPlan;
    // A y axis along one side of a plot, its title outside the labels, centered on the grid.
    const yAxis = (
      orient: "left" | "right",
      plot: Rect,
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
      title: title ? { text: title, x: titleX, y: top + gridHeight / 2 } : undefined,
    });

    // Inspectors keep these formatters, so they come from outside this scope.
    const formatNumbers = numberFormatter(locale);
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
        ? valueFormatter(context, timeValueFormatter(timeUnitFor(scale, plotHeight), zone, locale))
        : valueFormatter(context, formatNumbers);
    const formatX =
      xType === "band"
        ? categoryOf(xPlan.scale)
        : xType === "time"
          ? valueFormatter(
              xContext,
              timeValueFormatter(timeUnitFor(xPlan.scale, plotWidth), zone, locale),
            )
          : valueFormatter(xContext, formatNumbers);
    const formatY = yType === "band" ? categoryOf(yPlan.scale) : valueFormat(yContext, yPlan.scale);
    const formatRight = yRightPlan && valueFormat(yRightContext, yRightPlan.scale);
    const rightSet = new Set(rightMarks.map(({ mark }) => mark));

    this.#used.clear();
    const scene = ++this.#scenes;
    const views: PanelView[] = [];
    const panels = split.keys.map((key, i): Panel => {
      const row = Math.floor(i / columns);
      const column = i % columns;
      const xAt = xPlans[column]!;
      const yAt = yPlans[row]!;
      const x = xAt.scale;
      const plot: Rect = {
        x: left + columnOffset(column),
        y: plotTop + rowOffset(row),
        width: plotWidth,
        height: plotHeight,
      };
      const axes: AxisGeometry[] = [];
      // x labels go under the lowest panel of each column, the x title once under them all.
      if (showX && i + columns >= panelCount) {
        axes.push({
          orient: "bottom",
          offset: plot.y + plot.height,
          start: plot.x,
          end: plot.x + plot.width,
          line: true,
          ticks: hasData
            ? xAt.ticks.map((t, k) => ({ position: x.map(t), label: xAt.labels[k]! }))
            : [],
          title:
            config.x?.label && i === panelCount - 1
              ? { text: config.x.label, x: left + gridWidth / 2, y: height - lineHeight / 2 - 2 }
              : undefined,
        });
      }
      if (showLeft && column === 0) {
        const title = i === 0 ? config.y?.label : undefined;
        axes.push(yAxis("left", plot, yAt, yLabels, title, lineHeight / 2 + 2));
      }
      if (showRight) {
        const title = i === 0 ? config.yRight?.label : undefined;
        axes.push(
          yAxis("right", plot, yRightPlan, yRightLabels, title, width - lineHeight / 2 - 2),
        );
      }
      const gridAt = gridPlan === yPlan ? yAt : gridPlan;

      const frame: Frame = {
        x,
        y: yAt.scale,
        plot,
        pixelRatio: this.pixelRatio,
        theme,
        locale,
        hidden: this.hidden,
        owner: this,
        scene,
        clouds,
        ...this.#pools(i),
      };
      // Marks on the right axis draw with its scale.
      const rightFrame: Frame | undefined = yRightPlan && { ...frame, y: yRightPlan.scale };
      const frameOf = (mark: Mark) => (sideOf(mark) === "right" && rightFrame) || frame;
      const panelMarks = split.panels[i]!;
      const geometry = panelMarks.flatMap(({ mark, series }, index) =>
        mark.geometry(series, frameOf(mark), mark.spec.id ?? index),
      );
      const inspector = new Inspector({
        marks: panelMarks,
        frame,
        right: rightFrame && { marks: rightSet, frame: rightFrame, formatY: formatRight! },
        mode,
        hidden: this.hidden,
        formatX,
        formatY,
        formatValue: formatNumbers,
      });
      views.push({ key, plot, inspector });
      return {
        key,
        plot,
        grid: {
          x: xGrid ? xAt.ticks.map((t) => x.map(t)) : [],
          y: hasData && gridAt ? gridAt.ticks.map((t) => gridAt.scale.map(t)) : [],
        },
        axes,
        marks: geometry,
        title: facet
          ? { text: fitText(key, plotWidth, measure, font), x: plot.x, y: plot.y - header / 2 }
          : undefined,
      };
    });
    // Drop buffers of series that no longer exist.
    for (const pool of [this.#polylines, this.#floats, this.#bytes] as Map<string, unknown>[]) {
      for (const key of pool.keys()) if (!this.#used.has(key)) pool.delete(key);
    }
    this.#views = views;
    this.#drawn = marks;
    this.#base = base;

    let vertices = 0;
    for (const panel of panels) for (const item of panel.marks) vertices += item.draw.size(item);

    return {
      width,
      height,
      pixelRatio: this.pixelRatio,
      theme,
      title: config.title ? { text: config.title, x: EDGE, y: lineHeight / 2 + 6 } : undefined,
      panels,
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

  /** x scale of the last scene's first panel (the only one without facets). */
  xScale(): PositionScale | undefined {
    return this.#views[0]?.inspector.frame.x;
  }

  /** y scale of the last scene's first panel. */
  yScale(): PositionScale | undefined {
    return this.#views[0]?.inspector.frame.y;
  }

  /** Scale of the right y axis in the last scene, when marks use it. */
  yRightScale(): PositionScale | undefined {
    return this.#views[0]?.inspector.rightFrame?.y;
  }

  /** The last scene's panels: each one's key, plot, and x scale. */
  panels(): PanelInfo[] {
    return this.#views.map(({ key, plot, inspector }) => ({ key, plot, x: inspector.frame.x }));
  }

  /** The series a panel of the last scene draws; with facets, the parts of series in it. */
  panelSeries(panel: string): Series[] {
    const view = this.#views.find(({ key }) => key === panel);
    return view ? view.inspector.marks.flatMap(({ series }) => series) : [];
  }

  /** The panel whose plot holds a pixel, if any. */
  #viewAt(px: number, py: number): PanelView | undefined {
    return this.#views.find(
      ({ plot }) =>
        px >= plot.x && px <= plot.x + plot.width && py >= plot.y && py <= plot.y + plot.height,
    );
  }

  /**
   * The axis data is placed along, which a cursor follows: y when marks are
   * placed along y (horizontal bars), otherwise x.
   */
  cursorAxis(): "x" | "y" {
    return this.#drawn.some(({ mark, series }) => mark.tooltip === "y" && series.length > 0)
      ? "y"
      : "x";
  }

  /** Tooltip mode of the last scene: the chart's, or one suited to its marks. */
  tooltipMode(): TooltipMode {
    return this.#views[0]?.inspector.mode ?? "nearest-x";
  }

  /** Sentences describing marks without series (annotations), as of the last scene. */
  annotationSummaries(): string[] {
    const last = this.#views[0]?.inspector;
    const fallback = (value: number) => formatNumber(value, this.#config.locale);
    return this.#config.marks.flatMap((mark) => {
      const format = { x: last?.formatX ?? fallback, y: last?.axisOf(mark).formatY ?? fallback };
      return mark.describe?.(format, this.#config.locale) ?? [];
    });
  }

  /** Whether a series of the last scene is on the right y axis. */
  onRight(series: Series): boolean {
    const owner = this.#base?.find((entry) => entry.series.some((s) => s.key === series.key));
    return owner !== undefined && sideOf(owner.mark) === "right";
  }

  /** The parts of a series drawn in the last scene: one per panel with facets, else itself. */
  parts(series: Series): Series[] {
    if (!this.#base) return [series];
    return this.#drawn.flatMap((entry) => entry.series.filter((s) => s.key === series.key));
  }

  /**
   * Series of the last scene, for legends, tooltips, and summaries; with
   * facets, each series whole, before panels split it.
   */
  series(): Series[] {
    const marks = this.#base ?? this.#resolveSeries(this.#bands, this.#context());
    return marks.flatMap(({ series }) => series);
  }

  /**
   * Finds the data under a pointer position for tooltips, in the panel under
   * it; see `Inspector.inspect`.
   */
  inspect(px: number, py: number, mode?: TooltipMode): Inspection | undefined {
    const view = this.#viewAt(px, py);
    return view && this.#inPanel(view, view.inspector.inspect(px, py, mode));
  }

  /**
   * Inspects one point of a series by its position in a panel (the first by
   * default); see `Inspector.inspectPosition`.
   */
  inspectPosition(seriesKey: string, position: number, panel?: string): Inspection | undefined {
    const view =
      panel === undefined ? this.#views[0] : this.#views.find(({ key }) => key === panel);
    return view && this.#inPanel(view, view.inspector.inspectPosition(seriesKey, position));
  }

  /** With facets, the inspection names its panel. */
  #inPanel(view: PanelView, inspection: Inspection | undefined): Inspection | undefined {
    return inspection && this.#config.facet ? { ...inspection, panel: view.key } : inspection;
  }

  /** Releases geometry buffers. */
  dispose(): void {
    this.#polylines.clear();
    this.#floats.clear();
    this.#bytes.clear();
    this.#views = [];
    this.#drawn = [];
    this.#base = undefined;
    this.#splitter = undefined;
  }
}

/** Refuses a grid of panels the chart has no room for. */
function tooSmall(panels: number, columns: number, width: number, height: number): RangeError {
  const rows = Math.ceil(panels / columns);
  return new RangeError(
    `${panels} panels in ${rows} rows of ${columns} do not fit a ${width}×${height} chart; make it larger or set the facet's columns`,
  );
}

function numberFormatter(locale: string | undefined): Formatter {
  return (value) => formatNumber(value, locale);
}

/** The category at a band index. */
function categoryOf(scale: PositionScale): Formatter {
  return (value) => scale.categories?.[Math.round(value)] ?? "";
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
  config.facet?.check(config.marks);
}
