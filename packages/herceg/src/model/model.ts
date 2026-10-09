// The chart model turns marks and data into a scene. It is independent of the
// DOM: the browser runtime, server rendering, and tests all drive it the same
// way. It keeps per-chart state that must survive between frames: geometry
// buffers, the zoomed x range, hidden series, and layout hysteresis.

import { type Formatter, formatNumber, timeValueFormatter } from "../format/format.ts";
import { fitText, type MeasureText } from "../layout/text.ts";
import { Polyline } from "../lod/polyline.ts";
import {
  isLayoutMark,
  type LayoutItem,
  type LayoutMark,
  type LayoutResult,
} from "../marks/layout-mark.ts";
import {
  type AxisFormat,
  type BandContext,
  type BandList,
  type Bands,
  type ChartMark,
  type Frame,
  type Mark,
  numericBands,
} from "../marks/mark.ts";
import { type Series, samePositions } from "../marks/series.ts";
import { unionExtent } from "../marks/trace.ts";
import type { TimeBreaks } from "../scale/breaks.ts";
import type { PositionScale } from "../scale/scale.ts";
import { TIME_UNIT_MS, type TimeUnit } from "../scale/time.ts";
import {
  type AxisGeometry,
  type Panel,
  type Rect,
  type Scene,
  type SceneText,
  tickLabelGap,
} from "../scene/scene.ts";
import type {
  AnimationSpec,
  AxisSpec,
  CameraSpec,
  ChartSpec,
  ScaleResolution,
  XAxisSpec,
} from "../spec/spec.ts";
import { resolveTheme, type Theme, type ThemeEnvironment } from "../theme.ts";
import type { Camera } from "../three/camera.ts";
import {
  type AxisBreaks,
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
import type { Facet } from "./facet.ts";
import { EDGE, type LegendEntry, type LegendPart, layoutLegends } from "./legend.ts";
import type { Navigator } from "./navigator.ts";
import type { PanelGrid, PanelLayout, PanelSplit } from "./panel-layout.ts";
import type { Panels } from "./panels.ts";

/** Chart options with marks bound to their data. */
export type ChartConfig = Omit<
  ChartSpec,
  | "marks"
  | "data"
  | "width"
  | "height"
  | "version"
  | "facet"
  | "panels"
  | "grid"
  | "x"
  | "navigator"
> & {
  /** Marks along axes, or one layout mark (a pie) that has the chart to itself. */
  marks: readonly ChartMark[];
  x?: XAxisConfig | undefined;
  /** Small multiples: a panel per value of a category field (see `facet`). */
  facet?: Facet | undefined;
  /** Subplots: panels drawing the marks that name them (see `panels`). */
  panels?: Panels | undefined;
  /** A strip under the plot to see and move the x range by (see `rangeNavigator`). */
  navigator?: Navigator | undefined;
};

/** The x axis' options: its `breaks` are built with `timeBreaks`. */
export type XAxisConfig = Omit<XAxisSpec, "breaks"> & { breaks?: TimeBreaks | undefined };

import {
  type AxisInspection,
  type Inspection,
  Inspector,
  type MarkSeries,
  type TooltipMode,
} from "./inspect.ts";

/** A panel of the last scene and what inspects it. */
interface PanelView {
  key: string;
  label: string;
  plot: Rect;
  xGroup: string;
  yGroup: string;
  inspector: Inspector;
  plans: PanelPlans;
}

/**
 * The plans of a panel's axes: x, the left and right y, and the one its
 * horizontal grid lines follow, if any. Value transitions plan ticks from
 * them for the domains between two scenes.
 */
export interface PanelPlans {
  x: AxisPlan;
  y: AxisPlan;
  yRight: AxisPlan | undefined;
  grid: AxisPlan | false | undefined;
}

/** What a y extent reads: marks' series, within an x range (and its breaks). */
interface YPart {
  marks: readonly MarkSeries[];
  x0: number;
  x1: number;
  breaks?: AxisBreaks | undefined;
}

/** A panel of the last scene, as the browser runtime reads it. */
export interface DrawnPanel {
  /**
   * The facet value; with row and column facets, both as a JSON array;
   * "" without facets.
   */
  key: string;
  /** The panel's facet values for people: "North", or "North, A" in a grid. */
  label: string;
  plot: Rect;
  x: PositionScale;
  /** Names the x scale the panel shares with others, and its viewport: "" when every panel does. */
  xGroup: string;
  /** The left y axis' scale, and the right's when the chart has one. */
  y: PositionScale;
  /** Names the left y scale the panel shares with others: "" when every panel does. */
  yGroup: string;
  yRight?: PositionScale | undefined;
  plans: PanelPlans;
}

/**
 * What a chart shows when zoomed: the visible x range, and the left and
 * right y axes' ranges, each ascending (axes with a reversed domain show
 * them reversed), and null for an axis that is not zoomed, which shows its
 * configured domain or its data.
 */
export interface Viewport {
  x: readonly [number, number] | null;
  y: readonly [number, number] | null;
  yRight: readonly [number, number] | null;
}

/** The y ranges of a viewport, which every panel shares. */
export type YViewport = Pick<Viewport, "y" | "yRight">;

const NO_Y_VIEW: YViewport = { y: null, yRight: null };

/**
 * Ascending x and y ranges drawn while a change of view plays; null for an
 * axis without one (a category axis, or no right axis).
 */
export interface ViewDomains {
  x: readonly [number, number] | null;
  y: readonly [number, number] | null;
  yRight: readonly [number, number] | null;
}

export type {
  AxisInspection,
  InspectedPoint,
  Inspection,
  ItemInspection,
  TooltipMode,
} from "./inspect.ts";

/**
 * Raster pixels per CSS pixel in static SVG and PDF, which are zoomed,
 * printed, and rasterized larger (Python's PNG export at twice the size).
 */
export const STATIC_RASTER_RATIO = 2;

const TICK = 5;
/** Smallest plot side, in pixels, of a panel among several. */
const MIN_PANEL = 20;
const GAP = 6;
/** Left inset of the title and legend. */

export class ChartModel {
  #config: ChartConfig;
  /** The chart's marks along axes, and its layout marks: one kind or the other. */
  #marks: readonly Mark[] = [];
  #layouts: readonly LayoutMark[] = [];
  /**
   * What the layout mark drew in the last scene, with what its items are
   * reported with: its measure, and the chart's marks then.
   */
  #layout: { result: LayoutResult; measure: string; marks: readonly ChartMark[] } | undefined;
  #theme: Theme;
  width = 640;
  height = 400;
  pixelRatio = 1;
  /** Pixels per CSS pixel of the images marks draw (heatmaps); see `setSize`. */
  rasterRatio = 1;
  /** Keys of series hidden through the legend. */
  readonly hidden = new Set<string>();
  /** Visible x ranges by x scale (see `xGroupOf`). */
  readonly #viewports = new Map<string, [number, number]>();
  #yViewport: YViewport = NO_Y_VIEW;
  #transition: ViewDomains | null = null;
  #polylines = new Map<string, Polyline>();
  #floats = new Map<string, Float32Array>();
  #doubles = new Map<string, Float64Array>();
  #bytes = new Map<string, Uint8ClampedArray<ArrayBuffer>>();
  #used = new Set<string>();
  #labelWidths = new WeakMap<
    readonly string[],
    { measure: MeasureText; font: string; width: number }
  >();
  #left = 0;
  #right = 0;
  #columnGap = 0;
  #layoutKey = "";
  /** Scenes built so far. */
  #scenes = 0;
  #bands: Bands = {};
  /** Splits series into the panels of the chart's facet or subplots. */
  #splitter: { layout: PanelLayout; splitter: ReturnType<PanelLayout["splitter"]> } | undefined;
  /** Each panel of the last scene, for inspection and scales. */
  #views: PanelView[] = [];
  /** What `panels` last returned, and the views it read: read again once they change. */
  #panelList: { views: PanelView[]; panels: readonly DrawnPanel[] } | undefined;
  /** The legend's entries in the last scene, the built-in legend shown or not. */
  #entries: readonly LegendEntry[] = [];
  /** Whether the last scene had facets or subplots, whose inspections name their panel. */
  #namesPanels = false;
  /** The hidden keys the last scene drew with. */
  #drawnHidden: ReadonlySet<string> = new Set();
  /** Every mark's series in the last scene: those of all panels. */
  #drawn: MarkSeries[] = [];
  /** Every mark's series before facets split them, for legends and summaries. */
  #base: MarkSeries[] | undefined;
  /** The color scales and size and shape keys the last scene's legends show. */
  /** The last scene's legends of color scales, sizes, and shapes. */
  #legendParts: readonly LegendPart[] = [];
  /** Palette slot per series key, assigned on first appearance and kept. */
  #slots = new Map<string, number>();

  /** A 3D chart's camera, and the configured one it starts from; undefined for other charts. */
  #camera: Camera | undefined;
  #configured: Camera | undefined;

  /** `page` resolves themes that follow the page: "auto" and CSS variables. */
  constructor(config: ChartConfig, page?: ThemeEnvironment) {
    [this.#marks, this.#layouts] = validate(config);
    this.#config = config;
    this.#theme = resolveTheme(config.theme, page);
    this.#configured = this.#layouts[0]?.camera?.(config.camera);
    this.#camera = this.#configured;
  }

  get config(): ChartConfig {
    return this.#config;
  }

  get theme(): Theme {
    return this.#theme;
  }

  /** Resolves a theme that follows the page again; whether it changed. */
  refreshTheme(page: ThemeEnvironment): boolean {
    const theme = resolveTheme(this.#config.theme, page);
    if (JSON.stringify(theme) === JSON.stringify(this.#theme)) return false;
    this.#theme = theme;
    this.#layoutKey = "";
    return true;
  }

  update(config: ChartConfig, page?: ThemeEnvironment): void {
    [this.#marks, this.#layouts] = validate(config);
    // A camera configured differently is shown; the same one keeps the view turned.
    const configured = this.#layouts[0]?.camera?.(config.camera);
    if (
      !this.#camera ||
      !configured ||
      JSON.stringify(configured) !== JSON.stringify(this.#configured)
    )
      this.#camera = configured;
    this.#configured = configured;
    this.#config = config;
    if (!this.sharesY) this.#yViewport = NO_Y_VIEW;
    this.#theme = resolveTheme(config.theme, page);
    this.#layoutKey = "";
  }

  /** The camera of a 3D chart (a copy), which the pointer and keyboard turn; undefined for other charts. */
  get camera(): Camera | undefined {
    return this.#camera && { ...this.#camera };
  }

  /**
   * Moves a 3D chart's camera: settings given replace the current ones; null
   * goes back to the configured camera. Whether the camera changed.
   */
  setCamera(camera: CameraSpec | null): boolean {
    const resolve = this.#layouts[0]?.camera;
    if (!resolve || !this.#camera)
      throw new Error("Only 3D charts (point3d, line3d, and surface marks) have a camera");
    const next = camera ? resolve.call(this.#layouts[0], camera, this.#camera) : this.#configured!;
    if (JSON.stringify(next) === JSON.stringify(this.#camera)) return false;
    this.#camera = next;
    return true;
  }

  /**
   * The chart's size in CSS pixels and the device pixels per CSS pixel.
   * Images marks draw have `rasterRatio` pixels per CSS pixel: by default the
   * device's, and more for static output (STATIC_RASTER_RATIO).
   */
  setSize(
    width: number,
    height: number,
    pixelRatio = this.pixelRatio,
    rasterRatio = pixelRatio,
  ): void {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.pixelRatio = pixelRatio;
    this.rasterRatio = rasterRatio;
  }

  /**
   * The visible x range, ascending, or null to fit the data. Axes with a
   * reversed domain show it reversed; band x axes ignore it. Charts whose
   * panels have x scales of their own have one per scale, which
   * `viewportOf` reads; for them this throws.
   */
  get viewport(): readonly [number, number] | null {
    return this.viewportOf();
  }

  /** The visible x range of the x scale panel `panel` draws with (see `xGroupOf`). */
  viewportOf(panel?: string): readonly [number, number] | null {
    return this.#viewports.get(this.xGroupOf(panel)) ?? null;
  }

  /** Whether every panel shares one x scale: unless the chart's `resolve.x` says otherwise. */
  get sharesX(): boolean {
    return this.#resolutionX === "shared";
  }

  /**
   * Names the x scale panel `panel` of the last scene draws with: "" for one
   * every panel shares, which is the one without a panel. Throws for a
   * panel the chart does not have, and without one when panels have x
   * scales of their own.
   */
  xGroupOf(panel?: string): string {
    if (panel === undefined) {
      if (this.sharesX) return "";
      throw new Error("Charts whose panels have x scales of their own need a panel");
    }
    const view = this.#views.find(({ key }) => key === panel);
    if (!view) throw new RangeError(`The chart has no panel "${panel}"`);
    return view.xGroup;
  }

  /**
   * Shows an x range, or fits the data with null, on the x scale of `panel`
   * (see `xGroupOf`); null without a panel fits every scale.
   */
  setViewport(domain: readonly [number, number] | null, panel?: string): void {
    const shown = range(domain);
    if (panel === undefined && !shown) this.#viewports.clear();
    else if (shown) this.#viewports.set(this.xGroupOf(panel), shown);
    else this.#viewports.delete(this.xGroupOf(panel));
  }

  /** The visible y ranges, each null when not zoomed. Band y axes ignore them. */
  get yViewport(): YViewport {
    return this.#yViewport;
  }

  /** Shows y ranges; throws for ranges the chart cannot show (see `checkYViewport`). */
  setYViewport(viewport: YViewport): void {
    this.checkYViewport(viewport);
    this.#yViewport = { y: range(viewport.y), yRight: range(viewport.yRight) };
  }

  /** Throws for y ranges in charts whose panels have y scales of their own: they have no one y viewport. */
  checkYViewport(viewport: Partial<YViewport>): void {
    if ((viewport.y || viewport.yRight) && !this.sharesY)
      throw new Error("Charts whose panels have y scales of their own have no one y viewport");
  }

  /**
   * Draws these ranges in place of the viewports and fitted domains while a
   * change of view plays: as they are, not rounded, and not reported as the
   * viewport. Null ends it.
   */
  setTransitionDomains(domains: ViewDomains | null): void {
    this.#transition = domains;
  }

  /** Whether every panel shares the y scale: without facets, or without `resolve.y`. */
  get sharesY(): boolean {
    return !this.#config.panels && this.#resolutionY === "shared";
  }

  /** How the chart's panels share y: one scale without panels. */
  get #resolutionY(): ScaleResolution {
    const layout = this.#panels;
    return layout ? (this.#config.resolve?.y ?? layout.yDefault) : "shared";
  }

  /** How the chart's panels share x: one scale unless `resolve.x` says otherwise. */
  get #resolutionX(): ScaleResolution {
    return (this.#panels && this.#config.resolve?.x) || "shared";
  }

  /** What lays the chart out in panels, if anything does. */
  get #panels(): PanelLayout | undefined {
    return this.#config.facet ?? this.#config.panels;
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
    const marks = this.#marks.filter(
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
    for (const mark of this.#marks) {
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
    // Frozen: axes share the labels with the chart's panels, which show them to applications.
    return same ? previous : { keys, labels: Object.freeze(labels) };
  }

  #resolveSeries(bands: Bands, context: BandContext): MarkSeries[] {
    const layout = this.#panels;
    return this.#marks.map((mark, index) => ({
      mark,
      series: mark.series(
        mark.spec.id ?? index,
        this.#palette,
        this.hidden,
        bands,
        context,
        layout?.splits(mark),
      ),
    }));
  }

  /**
   * The chart's panels and what each draws: without facets, one panel with
   * every series. Bands are the chart's last (`#bands`).
   */
  #split(base: MarkSeries[], context: BandContext): PanelSplit {
    const layout = this.#panels;
    if (!layout) {
      // A previous facet's splits would keep its tables alive.
      this.#splitter = undefined;
      return { keys: [""], values: [[]], dimensions: [], panels: [base], all: base };
    }
    if (this.#splitter?.layout !== layout) this.#splitter = { layout, splitter: layout.splitter() };
    // Panels that could never fit are refused before they are listed.
    const { width, height } = this;
    return this.#splitter.splitter.split(
      base,
      ({ rows, columns }, panels) => {
        if (rows > height / MIN_PANEL || columns > width / MIN_PANEL)
          throw tooSmall(panels, columns, width, height, layout.remedy);
      },
      this,
      this.#bands,
      context,
    );
  }

  /** x extent of all data drawn, ignoring the viewport. */
  dataXExtent(): [number, number] | undefined {
    const type = this.#axisType("x");
    if (type === "band") return undefined;
    const context = this.#context();
    const marks = this.#split(this.#resolveSeries(this.#bands, context), context).all;
    const breaks = this.#xBreaks(type, context.zone);
    return unionExtent(
      marks.map(({ mark, series }) =>
        mark.xExtent(this.#xSeries(mark, series), type === "log", breaks),
      ),
    );
  }

  /**
   * The x axis' breaks resolved in the chart's zone, for an x scale of
   * `type`: every time x scale of a chart leaves the same time out (with x
   * scales of their own, panels over numbers have none).
   */
  #xBreaks(type: AxisType, zone: string): AxisBreaks | undefined {
    const breaks = this.#config.x?.breaks;
    return breaks && type === "time" ? breaks.calendar(zone) : undefined;
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
   * The extent of the y values each part's marks show inside its x range,
   * of visible series only, with zero when the axis asks for it or a mark
   * stands on it; undefined when they show none.
   */
  #yData(
    parts: readonly YPart[],
    type: AxisType,
    spec: AxisSpec | undefined,
  ): [number, number] | undefined {
    const log = type === "log";
    let stands = false;
    const data = unionExtent(
      parts.flatMap(({ marks, x0, x1, breaks }) =>
        marks.map(({ mark, series }) => {
          const visible = series.filter((s) => !this.hidden.has(s.key));
          if (mark.zero === "y" && visible.length > 0) stands = true;
          return mark.yExtent(visible, x0, x1, log, breaks);
        }),
      ),
    );
    const zero = spec?.zero ?? stands;
    return zero && !log && data ? unionExtent([data, [0, 0]]) : data;
  }

  /**
   * The width of the widest of `labels`, measured once per list of band
   * labels (the chart keeps a list while its bands are unchanged), since
   * band axes may have thousands of them.
   */
  #widest(labels: readonly string[], measure: MeasureText, font: string): number {
    const cached = this.#labelWidths.get(labels);
    if (cached?.measure === measure && cached.font === font) return cached.width;
    let width = 0;
    for (const label of labels) width = Math.max(width, measure(label, font));
    this.#labelWidths.set(labels, { measure, font, width });
    return width;
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

  #doubleBuffer = (seriesKey: string, stage: string, length: number): Float64Array => {
    const key = `${stage}|${seriesKey}`;
    let buffer = this.#pooled(this.#doubles, key, () => new Float64Array(Math.max(16, length)));
    if (buffer.length < length) {
      buffer = new Float64Array(Math.ceil(length * 1.5));
      this.#doubles.set(key, buffer);
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
  #pools(index: number): Pick<Frame, "polyline" | "floats" | "doubles" | "bytes"> {
    if (index === 0) {
      return {
        polyline: this.#polyline,
        floats: this.#floatBuffer,
        doubles: this.#doubleBuffer,
        bytes: this.#byteBuffer,
      };
    }
    const at = (stage: string) => `${stage}~${index}`;
    return {
      polyline: (key, stage) => this.#polyline(key, at(stage)),
      floats: (key, stage, length) => this.#floatBuffer(key, at(stage), length),
      doubles: (key, stage, length) => this.#doubleBuffer(key, at(stage), length),
      bytes: (key, stage, length) => this.#byteBuffer(key, at(stage), length),
    };
  }

  /**
   * Builds the scene for the current data, size, and view state. With
   * `clouds`, large point series are left to a GPU painter (see PointCloud).
   */
  scene(measure: MeasureText, clouds = false): Scene {
    if (this.#layouts.length > 0) return this.#layoutScene(measure, clouds);
    this.#layout = undefined;
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
    const split = this.#split(base, context);
    // Each panel's bands on a band axis: the chart's, or its group's own (see PanelBands).
    const bandsOf = (axis: "x" | "y", panel: number) =>
      (split.bands?.[axis]?.[panel] ?? bands[axis])!;
    // Domains and layout consider what every panel draws.
    const marks = split.all;
    const layout = this.#panels;
    // Subplots take their first panel's x settings when every panel shares x.
    const xSpec = layout ? layout.panelAxis("x", 0, config.x) : config.x;
    const xContext: AxisContext = {
      type: xType === "band" ? xType : (xSpec?.type ?? xType),
      spec: xSpec,
      zone,
      locale,
    };
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

    // Panels fill a grid of `columns`; without facets, one cell.
    const panelCount = split.keys.length;
    const grid = layout ? layout.grid(split, lineHeight) : ONE_PANEL;
    const { columns, rows, header, columnHeader, rowHeader } = grid;
    const rowOf = (panel: number) => Math.floor(panel / columns);

    // x scales: one for every panel, or with `resolve.x` one per group of
    // panels (each alone, a row, or a column), from what the group draws.
    const xResolution = this.#resolutionX;
    const xGroups =
      xResolution === "shared" ? undefined : layout!.groups(xResolution, split, columns, "x");
    const xGroupAt = xGroups?.groupOf ?? new Array<number>(panelCount).fill(0);
    // Each group's marks, with every mark's series in the group's panels.
    const xMarks = xGroups?.drawn ?? [marks];
    const xContexts = (
      xGroups
        ? xMarks.map(
            (among, h): AxisContext => ({
              ...layout!.groupAxis("x", xGroupAt.indexOf(h), among, config.x, xType),
              zone,
              locale,
            }),
          )
        : [xContext]
    ).map((context) => ({ ...context, breaks: this.#xBreaks(context.type, zone) }));
    const seams = config.x?.seams;
    if (config.x?.breaks && !xContexts.some(({ breaks }) => breaks))
      throw new Error(`Axis breaks need a time x axis, not a ${xContexts[0]!.type} one`);
    if (seams && !config.x?.breaks) throw new Error("x axis seams need x axis breaks to mark");
    // Viewports are kept by group, named by its panels: a group whose panels
    // change (a facet value appears and the panels wrap anew) starts over.
    const xKeys = xGroups?.keys ?? [""];
    const xDrawn = xMarks.map((among) => among.filter(({ series }) => series.length > 0));
    // An x axis measuring bar lengths gets the y axis' defaults: zero, round
    // ends, and grid lines.
    const xMeasures = xDrawn.map((among) => among.some(({ mark }) => mark.zero === "x"));

    // x domains: viewport, explicit domain, or data extent. Log axes only
    // consider positive values. Band axes take their categories instead.
    // A playing change of view draws its own ranges.
    const shown = this.#transition;
    const yView = shown?.y ?? this.#yViewport.y ?? undefined;
    const yRightView = shown?.yRight ?? this.#yViewport.yRight ?? undefined;
    // Whether each group has data to label, and its domain before rounding.
    const xHas: boolean[] = [];
    const xDomains: [number, number][] = [];
    const autoX: boolean[] = [];
    xContexts.forEach(({ type, spec }, h) => {
      // y extents read band axes' every category.
      xDomains[h] = [-Infinity, Infinity];
      autoX[h] = false;
      if (type === "band") {
        xHas[h] = bandsOf("x", xGroupAt.indexOf(h)).keys.length > 0;
        return;
      }
      const log = type === "log";
      const breaks = xContexts[h]!.breaks;
      let dataX = unionExtent(
        xMarks[h]!.map(({ mark, series }) =>
          mark.xExtent(this.#xSeries(mark, series), log, breaks),
        ),
      );
      if ((spec?.zero ?? xMeasures[h]) && !log) dataX = unionExtent([dataX, [0, 0]]);
      xHas[h] = dataX !== undefined;
      const view = shown?.x ?? this.#viewports.get(xKeys[h]!);
      xDomains[h] = usableDomain(
        view ? oriented(view, spec?.domain) : (spec?.domain ?? dataX),
        type,
      );
      if (breaks) xDomains[h] = breaks.showing(xDomains[h]!, !view && spec?.domain !== undefined);
      autoX[h] = !view && !spec?.domain;
    });
    for (const key of this.#viewports.keys()) if (!xKeys.includes(key)) this.#viewports.delete(key);
    // What y extents read: marks' series within an x scale's domain.
    const part = (among: readonly MarkSeries[], h: number): YPart => {
      const [x0, x1] = xDomains[h]!;
      return { marks: among, x0, x1, breaks: xContexts[h]!.breaks };
    };

    // y domains from data visible in the x domains, unless they are fixed;
    // marks with `axis: "right"` (in charts of one panel) have their own.
    const leftMarks = marks.filter(({ mark }) => sideOf(mark) === "left");
    const rightMarks = marks.filter(({ mark }) => sideOf(mark) === "right");
    // With x scales of their own, what panels draw counts within their own x
    // domain, so zooming one group can change a y scale it shares; category
    // x scales show all of theirs.
    const byX = xType !== "band" && xGroups;
    const leftParts = byX ? xMarks.map(part) : [part(leftMarks, 0)];
    // A y axis is shown when one of its marks places values along y, and
    // the left one also when the right one is not.
    const placesY = (side: readonly MarkSeries[]) => side.some(({ mark }) => usesY(mark));
    const rightUsed = placesY(rightMarks);
    const yRightType = rightUsed ? this.#axisType("yRight") : "linear";
    // Facet panels share one y scale unless `resolve.y` groups them.
    const sharedY = this.sharesY;
    let yBase: [number, number] = [0, 1];
    let leftUsed = true;
    // Whether the left axis has anything to label: a band axis may have no bands.
    let leftData = true;
    if (yType === "band") {
      leftData = (bands.y?.keys.length ?? 0) > 0;
      if (!(leftData || rightUsed)) xHas.fill(false);
    } else {
      leftUsed = !rightUsed || placesY(leftMarks);
      if (sharedY)
        yBase = usableDomain(
          yView
            ? oriented(yView, config.y?.domain)
            : (config.y?.domain ?? this.#yData(leftParts, yType, config.y)),
          yType,
        );
    }
    const hasData = xHas.includes(true);

    // Vertical layout depends only on fonts, titles, and the legends.
    // One legend per distinct scale or key: marks sharing a scale share one.
    const legends = config.legend ?? true;
    const format = (value: number) => formatNumber(value, locale);
    const parts = new Map<string, LegendPart>();
    for (const { mark, series } of legends ? base : []) {
      for (const part of mark.legends?.(series, theme, format) ?? [])
        if (!parts.has(part.key)) parts.set(part.key, part);
    }
    const entries = base.flatMap(({ mark, series }) =>
      series.flatMap((s) => {
        const entry = mark.legendEntry ? mark.legendEntry(s, theme) : { color: s.color };
        if (!entry) return [];
        const item: LegendEntry = { key: s.key, label: s.label, color: entry.color };
        if (entry.glyph) item.glyph = entry.glyph;
        if (entry.stroke) item.stroke = entry.stroke;
        return [item];
      }),
    );
    const head = this.#header(entries, [...parts.values()], measure);
    const top = head.top;
    const showY = config.y?.axis ?? true;
    // x labels go under the lowest panel of each column, and under every
    // panel when the panels of a column have x scales of their own, as
    // each panel's `axis` setting (a subplot's own over the chart's) says.
    const xBetween = xResolution === "independent" || xResolution === "rows";
    const panelX = (i: number) => (layout ? layout.panelAxis("x", i, config.x) : config.x);
    const labelsX = (i: number) =>
      (panelX(i)?.axis ?? true) && (xBetween || i + columns >= panelCount);
    const showX = split.keys.some((_, i) => labelsX(i));
    // Room under the plot before the x labels' line of text: more for large
    // text, whose labels sit further below the axis.
    const xLabels = TICK + GAP + tickLabelGap(theme.fontSize) - tickLabelGap(0);
    // Each x scale's title goes once, under its lowest labels (see xTitleOf).
    const xTitle = xContexts.some(({ spec }) => spec?.label) ? lineHeight + GAP : 0;
    // A navigator's strip goes under the x axis, when there is room for it.
    const navigator = config.navigator;
    const below = showX ? xLabels + lineHeight + xTitle + 2 : 4;
    const strip = navigator ? navigator.room(height - top - below) : 0;
    const bottom = below + strip;
    // A wrapped facet's panels each have a header with their value, and rows
    // leave room below for the x labels of panels above an empty cell. A
    // grid of facets has a column per value of its column field, headed
    // once above the top row, and a row per value of its row field, headed
    // once beside the last column. Rows leave room between them for the y
    // labels at their ends, and for x labels and titles between them.
    const aboveEmpty = showX && panelCount % columns !== 0;
    const titleRoom = xGroups ? xTitle : 0;
    const rowGap =
      rows <= 1
        ? 0
        : xBetween && showX
          ? xLabels + lineHeight + titleRoom + (header ? 8 : Math.ceil(lineHeight / 2) + 4)
          : header
            ? (aboveEmpty ? xLabels + lineHeight + titleRoom : Math.ceil(lineHeight / 2)) + 8
            : lineHeight + 10;
    // Rows share the height left for plots equally, or by the grid's weights.
    const free = height - top - bottom - columnHeader - (rows - 1) * rowGap - rows * header;
    const heights = trackSizes(free, rows, grid.rowWeights);
    if (panelCount > 1 && Math.min(...heights) < MIN_PANEL)
      throw tooSmall(panelCount, columns, width, height, layout!.remedy);
    const rowHeights = heights.map((h) => Math.max(10, h));
    // The first row's height plans the axes of charts with equal rows.
    const plotHeight = rowHeights[0]!;
    const tickCount = (spec: AxisSpec | undefined, size: number) =>
      spec?.ticks ?? Math.max(2, Math.round(size / 45));
    const plotTop = top + columnHeader + header;
    const rowOffset = (row: number) => {
      let offset = 0;
      for (let r = 0; r < row; r++) offset += rowHeights[r]! + header + rowGap;
      return offset;
    };
    const measureLabel = (label: string) => measure(label, font);
    /** A continuous y axis for the marks on one side, from their data domain `base`. */
    const planValueAxis = (
      axisContext: AxisContext,
      base: [number, number],
      sideMarks: readonly MarkSeries[],
      zoomed: boolean,
      size = plotHeight,
    ): AxisPlan => {
      const spec = axisContext.spec;
      const count = tickCount(spec, size);
      const sideDrawn = sideMarks.filter(({ series }) => series.length > 0);
      // Fixed and zoomed domains are shown as they are; others are rounded,
      // their ticks on the rounded values, then widened for what marks draw
      // past their values.
      if (spec?.domain || zoomed)
        return planAxis(axisContext, base, [plotTop + size, plotTop], count);
      const nice = spec?.nice ?? true;
      const rounded = niceAxisDomain(base, axisContext, count, nice);
      const domain = insetDomain(
        headroomDomain(rounded, headroom("y", sideDrawn), size, axisContext.type),
        inset("y", sideDrawn),
        size,
        axisContext.type,
      );
      return planAxis(
        axisContext,
        domain,
        [plotTop + size, plotTop],
        count,
        nice ? rounded : domain,
      );
    };

    // y ticks decide the left margin. Panels share one plan unless their
    // resolution gives each panel, row, or column its own, from what those
    // panels draw. Each group's axis is the chart's with its first panel's
    // settings; subplots take their type from their own marks.
    const resolution = this.#resolutionY;
    // Subplots always plan by group, to read each panel's own settings; a
    // shared category axis is the one plan.
    const byGroup = config.panels ? yType !== "band" || resolution !== "shared" : !sharedY;
    const groups = byGroup ? layout!.groups(resolution, split, columns, "y") : undefined;
    const groupOf = groups?.groupOf ?? new Array<number>(panelCount).fill(0);
    const contexts = groups
      ? groups.drawn.map(
          (drawn, g): AxisContext => ({
            ...layout!.groupAxis("y", groupOf.indexOf(g), drawn, config.y, yType),
            zone,
            locale,
          }),
        )
      : [yContext];
    /** The category y axis of panel `i` over the plot from `y`, `size` tall. */
    const planCategories = (y: number, size: number, i: number): AxisPlan => {
      // Categories read top to bottom; bands of numbers rise like a numeric axis.
      const upward = bands.y !== undefined && numericBands(bands.y);
      const plan = planBandAxis(
        bandsOf("y", i).labels,
        upward ? [y + size, y] : [y, y + size],
        padding("y"),
        lineHeight,
      );
      // Long category names are shortened rather than squeezing the plot.
      const room = Math.max(48, Math.round(width * 0.3));
      plan.labels = plan.labels.map((label) => fitText(label, room, measure, font));
      return plan;
    };
    // Each group is planned over its shortest row, so what marks draw past
    // their values (points, bar labels) fits in every row.
    const groupHeights = contexts.map(() => Number.POSITIVE_INFINITY);
    groupOf.forEach((g, i) => {
      groupHeights[g] = Math.min(groupHeights[g]!, rowHeights[rowOf(i)]!);
    });
    const groupHeight = (g: number) => groupHeights[g]!;
    const groupPlans: AxisPlan[] = [];
    // Groups of panels with nothing to show along y have no y labels.
    const emptyGroups = new Set<number>();
    if (yType === "band") {
      contexts.forEach((_, g) => {
        groupPlans[g] = planCategories(plotTop, groupHeight(g), groupOf.indexOf(g));
      });
    } else if (!groups) {
      groupPlans.push(
        planValueAxis(yContext, yBase, leftMarks, yView !== undefined, groupHeight(0)),
      );
    } else {
      // With x scales of their own, a y group's panels are read by x group:
      // what the panels of both draw, within that x group's domain.
      const crossed = byX && layout!.across(split, groupOf, xGroupAt);
      groups.drawn.forEach((drawn, g) => {
        const parts = crossed ? crossed[g]!.map(([h, among]) => part(among, h)) : [part(drawn, 0)];
        // A group shows something when its marks place a value along y,
        // annotations included.
        const { type, spec } = contexts[g]!;
        const extent = this.#yData(parts, type, spec);
        if (!extent) emptyGroups.add(g);
        const domain = spec?.domain ?? extent;
        const base = usableDomain(domain, type);
        groupPlans[g] = planValueAxis(contexts[g]!, base, drawn, false, groupHeight(g));
      });
    }
    const yPlan = groupPlans[0]!;
    // Every panel's y plan: its group's moved to its row. A row of another
    // height than the group's keeps the group's domain with ticks for its height.
    const yPlans = split.keys.map((_, i) => {
      const row = rowOf(i);
      const g = groupOf[i]!;
      const plan = groupPlans[g]!;
      const context = contexts[g]!;
      const size = rowHeights[row]!;
      if (size === groupHeight(g)) return shiftPlan(plan, context, rowOffset(row));
      const y = plotTop + rowOffset(row);
      if (yType === "band") return planCategories(y, size, i);
      const [d0, d1] = plan.scale.domain;
      const count = tickCount(context.spec, size);
      return planAxis(context, [d0!, d1!], [y + size, y], count, plan.within);
    });
    // Panels in other columns than the first show their own y labels when
    // their scales differ from their row's; subplots always label their own.
    const columnLabels =
      config.panels !== undefined || resolution === "independent" || resolution === "columns";
    // Subplots show, title, and grid each panel's y axis as its own settings
    // say; other charts title the chart's once.
    const panelAxis = (i: number) => (layout ? layout.panelAxis("y", i, config.y) : config.y);
    const titleOf = (i: number) =>
      config.panels ? panelAxis(i)?.label : i === 0 ? config.y?.label : undefined;
    const titled = split.keys.some((_, i) => titleOf(i));
    const yRightContext: AxisContext = { type: yRightType, spec: config.yRight, zone, locale };
    const yRightPlan = rightUsed
      ? planValueAxis(
          yRightContext,
          usableDomain(
            yRightView
              ? oriented(yRightView, config.yRight?.domain)
              : (config.yRight?.domain ??
                  this.#yData([part(rightMarks, 0)], yRightType, config.yRight)),
            yRightType,
          ),
          rightMarks,
          yRightView !== undefined,
        )
      : undefined;
    const showLeft = showY && leftUsed;
    const labelsOf = (plan: AxisPlan) => (hasData && showLeft && leftData ? plan.labels : []);
    const labelWidth = Math.max(0, ...yPlans.flatMap(labelsOf).map(measureLabel));
    // The widest label starts at the chart's edge inset, in line with the title.
    let left = showLeft ? Math.ceil(labelWidth) + GAP + 2 + EDGE : EDGE;
    if (showLeft && titled) left += lineHeight + GAP;
    // Avoid layout jitter while data streams: margins grow at once but only
    // shrink when the size or configuration changes.
    const layoutKey = `${width}x${height}`;
    const sameLayout = layoutKey === this.#layoutKey;
    // A change of view playing keeps the margins of the view it ends at,
    // planned on its first frame: passing tick labels move nothing, and are
    // never kept for later scenes.
    const moving = this.#transition !== null;
    const frozen = sameLayout && moving;
    if (frozen) left = this.#left;
    else if (sameLayout) left = Math.max(left, this.#left);
    this.#layoutKey = layoutKey;

    // The right axis' labels decide the right margin, as the left one's do the left.
    const showRight = yRightPlan !== undefined && (config.yRight?.axis ?? true);
    const yRightLabels = showRight && hasData ? yRightPlan.labels : [];
    let right = rowHeader ? rowHeader + GAP + EDGE : 12;
    if (showRight) {
      right = Math.ceil(Math.max(0, ...yRightLabels.map(measureLabel))) + GAP + 2 + EDGE;
      if (config.yRight?.label) right += lineHeight + GAP;
    }
    if (frozen) right = this.#right;
    else if (sameLayout) right = Math.max(right, this.#right);

    // x ticks; widen the margins if the first or last label would be clipped,
    // and the gap between columns of panels if labels at the edges of
    // neighboring panels would meet, by up to a quarter of the width each:
    // labels that cannot fit must not squeeze the plots away.
    const edgeRoom = Math.floor(width / 4);
    const labelRoom =
      columnLabels && showLeft
        ? Math.ceil(labelWidth) + GAP + 2 + 8 + (titled && config.panels ? lineHeight + GAP : 0)
        : 0;
    let columnGap = columns > 1 ? Math.max(16, labelRoom, sameLayout ? this.#columnGap : 0) : 0;
    if (frozen) columnGap = this.#columnGap;
    // Columns share the width left for plots as rows share the height.
    const weighted = grid.columnWeights !== undefined;
    const widthsOf = () =>
      trackSizes(width - left - right - (columns - 1) * columnGap, columns, grid.columnWeights);
    let widths: number[] = [];
    // Where each column starts, from `left`; equal columns a whole step apart.
    let offsets: number[] = [];
    // Each x group is planned over its narrowest column, so what marks draw
    // past their values fits in every column.
    let groupWidths: number[] = [];
    const xTicks = ({ type, spec }: AxisContext, size: number) =>
      spec?.ticks ?? Math.max(2, Math.round(size / (type === "time" ? 100 : 80)));
    // Each x group's plan for panels `plotWidth` wide, the first starting at `left`.
    const planCategoriesX = (h: number, range: readonly [number, number]): AxisPlan => {
      const categories = bandsOf("x", xGroupAt.indexOf(h)).labels;
      const widest = this.#widest(categories, measure, font);
      return planBandAxis(categories, range, padding("x"), widest);
    };
    // A domain other than the group's, as a navigator's strip plans the unzoomed one.
    const planX = (
      plotWidth: number,
      h: number,
      shown = xDomains[h]!,
      auto = autoX[h],
    ): AxisPlan => {
      const context = xContexts[h]!;
      const { type, spec } = context;
      if (type === "band") return planCategoriesX(h, [left, left + plotWidth]);
      const count = xTicks(context, plotWidth);
      const range = [left, left + plotWidth] as const;
      if (!auto) return planAxis(context, shown, range, count);
      // As for y: ticks on the rounded domain, inside the room for glyphs.
      const nice = spec?.nice ?? xMeasures[h]!;
      const rounded = niceAxisDomain(shown, context, count, nice);
      // Room at the ends is time shown: on axes with breaks, positions.
      const room = (d: [number, number], as: AxisType) =>
        insetDomain(
          headroomDomain(d, headroom("x", xDrawn[h]), plotWidth, as),
          inset("x", xDrawn[h]),
          plotWidth,
          as,
        );
      const { breaks } = context;
      const domain = breaks
        ? breaks.inPositions(rounded, (d) => room(d, "linear"))
        : room(rounded, type);
      return planAxis(context, domain, range, count, nice ? rounded : domain);
    };
    let xPlans: AxisPlan[] = [];
    // Where each group's first label starts and last one ends, by column
    // width, as if the column started at `left`; undefined without labels.
    const ends = new Map<string, readonly [number, number] | undefined>();
    const layoutColumns = () => {
      widths = widthsOf().map((w) => Math.max(10, w));
      offsets = widths.map((_, c) => (weighted ? 0 : c * (widths[0]! + columnGap)));
      for (let c = 1; weighted && c < columns; c++)
        offsets[c] = offsets[c - 1]! + widths[c - 1]! + columnGap;
      groupWidths = xContexts.map(() => Number.POSITIVE_INFINITY);
      for (let i = 0; i < panelCount; i++) {
        const h = xGroupAt[i]!;
        groupWidths[h] = Math.min(groupWidths[h]!, widths[i % columns]!);
      }
      xPlans = xContexts.map((_, h) => planX(groupWidths[h]!, h));
      ends.clear();
    };
    layoutColumns();
    /**
     * Group `h`'s plan over a column `size` wide starting at `left`: the
     * group's own, or for a wider column, the group's domain with ticks for it.
     */
    const sizedPlan = (h: number, size: number): AxisPlan => {
      const plan = xPlans[h]!;
      if (size === groupWidths[h]) return plan;
      const context = xContexts[h]!;
      const range = [left, left + size] as const;
      if (context.type === "band") return planCategoriesX(h, range);
      const [d0, d1] = plan.scale.domain;
      return planAxis(context, [d0!, d1!], range, xTicks(context, size), plan.within);
    };
    const labelEnds = (h: number, size: number) => {
      const key = `${h} ${size}`;
      if (!ends.has(key)) {
        const { scale, ticks, labels } = sizedPlan(h, size);
        const last = ticks.length - 1;
        const half = (index: number) => measure(labels[index]!, font) / 2;
        ends.set(
          key,
          last < 0
            ? undefined
            : [scale.map(ticks[0]!) - half(0), scale.map(ticks[last]!) + half(last)],
        );
      }
      return ends.get(key);
    };
    // Widen until the labels fit or the limits are reached. Whatever still
    // needs more after a few passes goes straight to its limit, so the margins
    // kept for the next scene are ones that scene keeps too.
    for (let pass = 0; pass < 10; pass++) {
      if (!hasData || !showX || frozen) break;
      // How far labeled panels' labels pass the chart's sides, and reach past
      // their panels' sides into the gaps between columns.
      let overflowLeft = 0;
      let overflowRight = 0;
      let spillLeft = 0;
      let spillRight = 0;
      let labeled = false;
      for (let i = 0; i < panelCount; i++) {
        const h = xGroupAt[i]!;
        if (!labelsX(i) || !xHas[h]) continue;
        const column = i % columns;
        const end = labelEnds(h, widths[column]!);
        if (!end) continue;
        labeled = true;
        const [firstStart, lastEnd] = end;
        if (column > 0) spillLeft = Math.max(spillLeft, left - firstStart);
        else overflowLeft = Math.max(overflowLeft, 2 - firstStart);
        if (column < columns - 1)
          spillRight = Math.max(spillRight, lastEnd - (left + widths[column]!));
        else overflowRight = Math.max(overflowRight, lastEnd + offsets[column]! - (width - 2));
      }
      if (!labeled) break;
      const spill = spillRight + spillLeft;
      const widen = (current: number, need: number) =>
        need <= current
          ? current
          : Math.max(current, pass < 3 ? Math.min(need, edgeRoom) : edgeRoom);
      const nextLeft = overflowLeft > 0.5 ? widen(left, left + Math.ceil(overflowLeft)) : left;
      const nextRight =
        overflowRight > 0.5 ? widen(right, right + Math.ceil(overflowRight)) : right;
      // Panels with their own y labels need room for those and the x labels
      // that reach past the panel before them.
      const nextGap = columns > 1 ? widen(columnGap, Math.ceil(spill) + (labelRoom || 8)) : 0;
      if (nextLeft === left && nextRight === right && nextGap === columnGap) break;
      left = nextLeft;
      right = nextRight;
      columnGap = nextGap;
      layoutColumns();
    }
    if (panelCount > 1 && Math.min(...widthsOf()) < MIN_PANEL)
      throw tooSmall(panelCount, columns, width, height, layout!.remedy);
    if (!moving) {
      this.#left = left;
      this.#right = right;
      this.#columnGap = columnGap;
    }

    // Panels share their scale's x plan and their y plans, moved to their column and row.
    const shifted: AxisPlan[] = [];
    const xPlanOf = (h: number, column: number) =>
      (shifted[h * columns + column] ??= shiftPlan(
        sizedPlan(h, widths[column]!),
        xContexts[h]!,
        offsets[column]!,
      ));
    const gridWidth = offsets[columns - 1]! + widths[columns - 1]!;
    const gridHeight =
      rowHeights.reduce((sum, h) => sum + h, 0) + rows * header + (rows - 1) * rowGap;
    // Vertical grid lines where a group has data, as a subplot's own settings say.
    const xGrid = (i: number) => {
      const h = xGroupAt[i]!;
      return xHas[h]! && xContexts[h]!.type !== "band" && (panelX(i)?.grid ?? xMeasures[h]!);
    };
    // Horizontal grid lines follow the left axis, or the right one when the left is unused.
    const gridPlan = leftUsed
      ? yType !== "band" && (config.y?.grid ?? true) && yPlan
      : (config.yRight?.grid ?? true) && yRightPlan;
    // A y axis along one side of a plot, its title outside the labels,
    // centered on the grid, or on the plot for a subplot's own title.
    const yAxis = (
      orient: "left" | "right",
      plot: Rect,
      plan: AxisPlan,
      labels: string[],
      title: string | undefined,
      titleX: number,
      titleY = top + gridHeight / 2,
    ): AxisGeometry => ({
      orient,
      offset: orient === "left" ? plot.x : plot.x + plot.width,
      start: plot.y + plot.height,
      end: plot.y,
      line: false,
      ticks: labels.map((label, i) => ({ position: plan.scale.map(plan.ticks[i]!), label })),
      title: title ? { text: title, x: titleX, y: titleY } : undefined,
    });

    // Inspectors keep these formatters, so they come from outside this scope.
    const formatNumbers = numberFormatter(locale);
    const tooltip = config.tooltip;
    // Cells are always found under the pointer, so charts of cells only
    // (heatmaps) inspect the nearest cell whatever mode is requested.
    // Subplots choose by the marks in each panel.
    const modeOf = (among: readonly MarkSeries[]): TooltipMode => {
      const kinds = new Set(among.map(({ mark }) => mark.tooltip));
      const only = kinds.size === 1 ? [...kinds][0] : kinds.size === 0 ? "x" : undefined;
      return only === "cell"
        ? "nearest"
        : ((typeof tooltip === "object" ? tooltip.mode : undefined) ??
            (only === "x" ? "nearest-x" : only === "y" ? "nearest-y" : "nearest"));
    };
    const mode = modeOf(drawn);
    const valueFormat = (context: AxisContext, scale: PositionScale): Formatter =>
      context.type === "time"
        ? valueFormatter(context, timeValueFormatter(timeUnitFor(scale), zone, locale))
        : valueFormatter(context, formatNumbers);
    // Tooltips show values as precisely as their panel resolves them: x
    // values by one formatter per x group and column width, y values per y
    // group and row height.
    const xFormats = new Map<string, Formatter>();
    const formatXOf = (h: number, column: number): Formatter => {
      const key = `${h} ${widths[column]}`;
      let format = xFormats.get(key);
      if (!format) {
        const context = xContexts[h]!;
        const { scale } = xPlanOf(h, column);
        format = context.type === "band" ? categoryOf(scale) : valueFormat(context, scale);
        xFormats.set(key, format);
      }
      return format;
    };
    const formats = new Map<string, Formatter>();
    const formatOf = (i: number): Formatter => {
      const g = groupOf[i]!;
      const size = rowHeights[rowOf(i)]!;
      const key = `${g} ${size}`;
      let format = formats.get(key);
      if (!format) {
        const { scale } = yPlans[i]!;
        format = yType === "band" ? categoryOf(scale) : valueFormat(contexts[g]!, scale);
        formats.set(key, format);
      }
      return format;
    };
    const formatRight = yRightPlan && valueFormat(yRightContext, yRightPlan.scale);
    const rightSet = new Set(rightMarks.map(({ mark }) => mark));

    // Each x scale's title goes once, under the last panel labeled with it:
    // centered under the grid when every panel shares x, else under its
    // panel's column, or for a row's scale under all the row's panels.
    const titleAt = xContexts.map(() => -1);
    for (let i = 0; i < panelCount; i++) if (labelsX(i)) titleAt[xGroupAt[i]!] = i;
    const xTitleOf = (h: number, i: number, plot: Rect): AxisGeometry["title"] => {
      const text = xContexts[h]!.spec?.label;
      if (!text || titleAt[h] !== i) return undefined;
      const rowEnd = Math.min(panelCount, (rowOf(i) + 1) * columns) - 1;
      const end = left + offsets[rowEnd % columns]! + widths[rowEnd % columns]!;
      return {
        text,
        x: xGroups
          ? xResolution === "rows"
            ? (left + end) / 2
            : plot.x + plot.width / 2
          : left + gridWidth / 2,
        y:
          rowOf(i) === rows - 1
            ? height - strip - lineHeight / 2 - 2
            : plot.y + plot.height + xLabels + lineHeight * 1.5 + GAP,
      };
    };

    this.#used.clear();
    const scene = ++this.#scenes;
    const keyed = keyedBy(config);
    // A copy for the frames and inspectors this scene keeps: what they find
    // before the next scene is what was drawn, whatever has been hidden since.
    const hidden: ReadonlySet<string> = new Set(this.hidden);
    this.#drawnHidden = hidden;
    const views: PanelView[] = [];
    const headers: SceneText[] = [];
    const panels = split.keys.map((key, i): Panel => {
      const row = Math.floor(i / columns);
      const column = i % columns;
      const h = xGroupAt[i]!;
      const xAt = xPlanOf(h, column);
      const yAt = yPlans[i]!;
      const x = xAt.scale;
      const plot: Rect = {
        x: left + offsets[column]!,
        y: plotTop + rowOffset(row),
        width: widths[column]!,
        height: rowHeights[row]!,
      };
      const axes: AxisGeometry[] = [];
      if (labelsX(i)) {
        axes.push({
          orient: "bottom",
          offset: plot.y + plot.height,
          start: plot.x,
          end: plot.x + plot.width,
          line: true,
          ticks: xHas[h]
            ? xAt.ticks.map((t, k) => ({ position: x.map(t), label: xAt.labels[k]! }))
            : [],
          title: xTitleOf(h, i, plot),
        });
      }
      if (showLeft && (panelAxis(i)?.axis ?? true) && (column === 0 || columnLabels)) {
        const labels = emptyGroups.has(groupOf[i]!) ? [] : labelsOf(yAt);
        // A subplot's title sits as far left of its plot as the first column's does.
        const titleX = lineHeight / 2 + 2 + (config.panels ? plot.x - left : 0);
        const titleY = config.panels ? plot.y + plot.height / 2 : undefined;
        axes.push(yAxis("left", plot, yAt, labels, titleOf(i), titleX, titleY));
      }
      if (showRight) {
        const title = i === 0 ? config.yRight?.label : undefined;
        axes.push(
          yAxis("right", plot, yRightPlan, yRightLabels, title, width - lineHeight / 2 - 2),
        );
      }
      // A subplot may turn its own grid lines on or off.
      const ownGrid = config.panels !== undefined && leftUsed && yType !== "band";
      const gridAt = ownGrid
        ? (panelAxis(i)?.grid ?? true) && yAt
        : gridPlan === yPlan
          ? yAt
          : gridPlan;

      const frame: Frame = {
        x,
        y: yAt.scale,
        plot,
        pixelRatio: this.pixelRatio,
        rasterRatio: this.rasterRatio,
        theme,
        locale,
        hidden,
        owner: this,
        scene,
        clouds,
        measure,
        keyed,
        ...this.#pools(i),
      };
      // Marks on the right axis draw with its scale.
      const rightFrame: Frame | undefined = yRightPlan && { ...frame, y: yRightPlan.scale };
      const frameOf = (mark: Mark) => (sideOf(mark) === "right" && rightFrame) || frame;
      // Marks keep their index in the chart as their identity in every panel.
      const members = split.members?.[i];
      const panelMarks = split.panels[i]!;
      const geometry = panelMarks.flatMap(({ mark, series }, index) =>
        members && !members[index]
          ? []
          : mark.geometry(series, frameOf(mark), mark.spec.id ?? index),
      );
      if (seams) {
        const segments = xContexts[h]!.breaks?.seams?.(x, plot, seams, theme.grid);
        if (segments) geometry.unshift(segments);
      }
      const inspected = panelMarks.flatMap((entry, index) =>
        members && !members[index] ? [] : [{ ...entry, index }],
      );
      const inspector = new Inspector({
        marks: inspected,
        frame,
        right: rightFrame && { marks: rightSet, frame: rightFrame, formatY: formatRight! },
        mode: members ? modeOf(inspected.filter(({ series }) => series.length > 0)) : mode,
        hidden,
        formatX: formatXOf(h, column),
        formatY: formatOf(i),
        formatValue: formatNumbers,
      });
      const values = split.values[i]!;
      if (layout) {
        const fit = (text: string, room: number) => fitText(text, room, measure, font);
        headers.push(...layout.headers(i, values, row, column, plot, grid, fit));
      }
      views.push({
        key,
        label: values.join(", "),
        plot,
        xGroup: xKeys[h]!,
        yGroup: groups?.keys[groupOf[i]!] ?? "",
        inspector,
        plans: { x: xAt, y: yAt, yRight: yRightPlan, grid: gridAt },
      });
      return {
        key,
        plot,
        grid: {
          x: xGrid(i) ? xAt.ticks.map((t) => x.map(t)) : [],
          y: hasData && gridAt ? gridAt.ticks.map((t) => gridAt.scale.map(t)) : [],
        },
        axes,
        marks: geometry,
      };
    });
    // Drop buffers of series that no longer exist.
    const pools = [this.#polylines, this.#floats, this.#doubles, this.#bytes];
    for (const pool of pools as Map<string, unknown>[]) {
      for (const key of pool.keys()) if (!this.#used.has(key)) pool.delete(key);
    }
    this.#views = views;
    this.#namesPanels = layout !== undefined;
    this.#drawn = marks;
    this.#base = base;
    // Charts with a navigator have one panel.
    if (strip)
      panels.push(navigator!.panel(this, views[0]!.inspector, planX, xContexts[0]!, strip));

    let vertices = 0;
    for (const panel of panels) for (const item of panel.marks) vertices += item.draw.size(item);

    return {
      width,
      height,
      pixelRatio: this.pixelRatio,
      theme,
      title: head.title,
      headers,
      panels,
      legend: head.legend,
      colorLegends: head.colorLegends,
      glyphLegends: head.glyphLegends,
      vertices,
    };
  }

  /** The title and legends at the top of a chart, and where the panels start below them. */
  #header(entries: readonly LegendEntry[], parts: readonly LegendPart[], measure: MeasureText) {
    const { title, legend, locale } = this.#config;
    this.#entries = entries;
    // Parts that start rows of their own (keys) follow the others (ramps),
    // in the legend and in the chart's description alike.
    this.#legendParts = [
      ...parts.filter((part) => !part.breaks),
      ...parts.filter((part) => part.breaks),
    ];
    const theme = this.#theme;
    const font = `${theme.fontSize}px ${theme.font}`;
    const lineHeight = Math.round(theme.fontSize * 1.25);
    // A title larger than two pixels over the text size takes the extra room.
    const titleExtra = Math.max(0, Math.round((theme.titleSize - theme.fontSize - 2) * 1.25));
    let top = title ? lineHeight + 14 + titleExtra : Math.ceil(theme.fontSize / 2) + 2;
    const legends = layoutLegends(
      {
        // Without an explicit setting, one series needs no legend.
        entries: (legend ?? entries.length > 1) ? entries : [],
        parts: this.#legendParts,
        hidden: this.hidden,
      },
      top - lineHeight / 2,
      this.width,
      { measure, font, lineHeight, locale },
    );
    if (legends.bottom !== undefined) top = legends.bottom + lineHeight / 2 + 8;
    return {
      ...legends,
      top,
      title: title ? { text: title, x: EDGE, y: (lineHeight + titleExtra) / 2 + 6 } : undefined,
    };
  }

  /** A chart of one layout mark: the header, and the mark in the room below it. */
  #layoutScene(measure: MeasureText, clouds: boolean): Scene {
    const { width, height } = this;
    const theme = this.#theme;
    const mark = this.#layouts[0]!;
    const id = mark.spec.id ?? 0;
    const parts = mark.legends?.(theme, this.#config.locale) ?? [];
    const header = this.#header(mark.legend(id, this.#palette, this.#theme), parts, measure);
    const bounds: Rect = {
      x: EDGE,
      y: header.top,
      width: Math.max(0, width - 2 * EDGE),
      height: Math.max(0, height - header.top - EDGE),
    };
    const result = mark.draw({
      id,
      bounds,
      theme,
      locale: this.#config.locale,
      measure,
      // A copy, which items found before the next scene still read.
      hidden: new Set(this.hidden),
      color: this.#palette,
      camera: this.#camera,
      clouds,
      keyed: keyedBy(this.#config),
    });
    this.#layout = { result, measure: mark.measure, marks: this.#config.marks };
    // Nothing is drawn along axes: let go of what the last such scene kept.
    this.#views = [];
    this.#drawn = [];
    this.#base = undefined;
    this.#splitter = undefined;
    this.#bands = {};
    this.#polylines.clear();
    this.#floats.clear();
    this.#doubles.clear();
    this.#bytes.clear();
    let vertices = 0;
    for (const item of result.geometry) vertices += item.draw.size(item);
    return {
      width,
      height,
      pixelRatio: this.pixelRatio,
      theme,
      title: header.title,
      headers: [],
      panels: [{ key: "", plot: bounds, grid: { x: [], y: [] }, axes: [], marks: result.geometry }],
      legend: header.legend,
      colorLegends: header.colorLegends,
      glyphLegends: header.glyphLegends,
      vertices,
    };
  }

  /** x scale of the last scene's first panel (the only one without facets). */
  xScale(): PositionScale | undefined {
    return this.#views[0]?.inspector.frame.x;
  }

  /** y scale of the last scene's first panel. */
  yScale(): PositionScale | undefined {
    return this.#views[0]?.inspector.frame.y;
  }

  /** The y scale a mark's values are placed with: in the first panel drawing it. */
  yScaleOf(mark: Mark): PositionScale | undefined {
    const inspector = this.#viewOf(mark)?.inspector;
    return sideOf(mark) === "right" ? inspector?.rightFrame?.y : inspector?.frame.y;
  }

  /** The panel named `panel`, or else the first drawing `mark` (in subplots, not every panel does). */
  #viewOf(mark?: Mark, panel?: string): PanelView | undefined {
    return (
      this.#views.find(({ key }) => key === panel) ??
      (mark && this.#views.find(({ inspector }) => inspector.marks.some((m) => m.mark === mark))) ??
      this.#views[0]
    );
  }

  /** Scale of the right y axis in the last scene, when marks use it. */
  yRightScale(): PositionScale | undefined {
    return this.#views[0]?.inspector.rightFrame?.y;
  }

  /** The last scene's panels: each one's key, plot, and scales. */
  panels(): readonly DrawnPanel[] {
    const views = this.#views;
    if (this.#panelList?.views !== views) {
      const panels = views.map(({ key, label, plot, xGroup, yGroup, inspector, plans }) => ({
        key,
        label,
        plot,
        x: inspector.frame.x,
        xGroup,
        y: inspector.frame.y,
        yGroup,
        yRight: inspector.rightFrame?.y,
        plans,
      }));
      this.#panelList = { views, panels };
    }
    return this.#panelList.panels;
  }

  /** What the last scene's legend lists, whether or not the chart shows it: series, or a layout mark's items. */
  legendEntries(): readonly LegendEntry[] {
    return this.#entries;
  }

  /** The series a panel of the last scene draws; with facets, the parts of series in it. */
  panelSeries(panel: string): Series[] {
    const view = this.#views.find(({ key }) => key === panel);
    return view ? view.inspector.marks.flatMap(({ series }) => series) : [];
  }

  /**
   * The series of a panel the keyboard stops at, in order. An inspection
   * along x (or y) reports every series with a point at exactly that
   * place, so series inspected along an axis share a stop when they share
   * their positions along it (several fields of one table); every other
   * shown series, and each inspected point by point or cell by cell, is a
   * stop of its own.
   */
  keyboardStops(panel: string): Series[] {
    const view = this.#views.find(({ key }) => key === panel);
    if (!view) return [];
    const shared: { axis: "x" | "y"; series: Series }[] = [];
    return view.inspector.marks.flatMap(({ mark, series }) =>
      series.filter((s) => {
        if (this.#drawnHidden.has(s.key) || s.length === 0) return false;
        const axis = mark.tooltip;
        if (axis !== "x" && axis !== "y") return true;
        if (shared.some((p) => p.axis === axis && samePositions(p.series, s, axis))) return false;
        shared.push({ axis, series: s });
        return true;
      }),
    );
  }

  /**
   * For series the keyboard reads cell by cell (heatmaps): the position of
   * the cell `columns` to the right and `rows` up from the one at
   * `position`, as the panel draws them, or undefined when there is none.
   */
  stepCell(
    panel: string,
    seriesKey: string,
    position: number,
    columns: number,
    rows: number,
  ): number | undefined {
    const view = this.#views.find(({ key }) => key === panel);
    const found = view?.inspector.marks.find(({ series }) =>
      series.some((s) => s.key === seriesKey),
    );
    const s = found?.series.find((part) => part.key === seriesKey);
    return s && found!.mark.stepCell?.(s, position, columns, rows, view!.inspector.frame);
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
    return this.#marks.flatMap(
      (mark) => mark.describe?.(this.formatsOf(mark), this.#config.locale) ?? [],
    );
  }

  /**
   * How the last scene formats x values and a mark's y values (without a
   * mark, the left axis'), as tooltips do.
   */
  formatsOf(mark?: Mark, panel?: string): AxisFormat {
    const view = this.#viewOf(mark, panel);
    const last = view?.inspector;
    const fallback = (value: number) => formatNumber(value, this.#config.locale);
    return {
      x: last?.formatX ?? fallback,
      y: last?.axisOf(mark).formatY ?? fallback,
      value: last?.formatValue ?? fallback,
    };
  }

  /** How the last scene formats values of the right y axis in a panel, when marks are on it. */
  yRightFormat(panel?: string): Formatter | undefined {
    return this.#viewOf(undefined, panel)?.inspector.formatRight;
  }

  /** Whether a series of the last scene is on the right y axis. */
  onRight(series: Series): boolean {
    const mark = this.markOf(series);
    return mark !== undefined && sideOf(mark) === "right";
  }

  /** The chart's bands as of the last scene, which band indices in series name. */
  get bands(): Bands {
    return this.#bands;
  }

  /** The mark a series of the last scene belongs to. */
  markOf(series: Series): Mark | undefined {
    return this.#base?.find((entry) => entry.series.some((s) => s.key === series.key))?.mark;
  }

  /** The parts of a series drawn in the last scene: one per panel with facets, else itself. */
  parts(series: Series): Series[] {
    if (!this.#base) return [series];
    return this.#drawn.flatMap((entry) => entry.series.filter((s) => s.key === series.key));
  }

  /**
   * Series of the last scene, for legends, tooltips, and summaries; with
   * facets, each series whole, before panels split it. Marks that summarize
   * rows (histograms, box plots) and that facets split list their series
   * without data: `parts` and `panelSeries` hold what each panel draws.
   */
  series(): Series[] {
    const marks = this.#base ?? this.#resolveSeries(this.#bands, this.#context());
    return marks.flatMap(({ series }) => series);
  }

  /**
   * Finds the data under a pointer position for tooltips, in the panel under
   * it or in `panel`; see `Inspector.inspect`.
   */
  inspect(px: number, py: number, mode?: TooltipMode, panel?: string): Inspection | undefined {
    if (this.#layout) return this.#item(this.#layout.result.itemAt(px, py));
    const view =
      panel === undefined ? this.#viewAt(px, py) : this.#views.find(({ key }) => key === panel);
    return view && this.#inPanel(view, view.inspector.inspect(px, py, mode));
  }

  /**
   * Inspects one point of a series by its position in a panel (the first by
   * default); see `Inspector.inspectPosition`.
   */
  inspectPosition(seriesKey: string, position: number, panel?: string): AxisInspection | undefined {
    const view =
      panel === undefined ? this.#views[0] : this.#views.find(({ key }) => key === panel);
    return view && this.#inPanel(view, view.inspector.inspectPosition(seriesKey, position));
  }

  /**
   * Whether the last scene was one layout mark's, whose items the pointer
   * and keyboard visit.
   */
  get layout(): boolean {
    return this.#layout !== undefined;
  }

  /** An item of the last scene's layout mark, by key. */
  inspectItem(key: string): Inspection | undefined {
    const layout = this.#layout?.result;
    const at = layout?.indexOf(key) ?? -1;
    return at < 0 ? undefined : this.#item(layout!.item(at));
  }

  /**
   * The key of the item `step` items after the one keyed `key` (before, for
   * negative steps), stopping at the ends. Without a current item, steps
   * count from before the first item, or after the last for negative ones.
   */
  stepItem(key: string | undefined, step: number): string | undefined {
    const layout = this.#layout?.result;
    if (!layout || layout.count === 0) return undefined;
    const at = key === undefined ? -1 : layout.indexOf(key);
    const from = at >= 0 ? at : step > 0 ? -1 : layout.count;
    return layout.item(Math.min(layout.count - 1, Math.max(0, from + step))).key;
  }

  /**
   * Sentences for what the last scene's legends of color scales and of
   * sizes and shapes show, which are drawn and so hidden from assistive
   * technology.
   */
  legendSummaries(): string[] {
    return this.#legendParts.map((part) => part.describe(this.#config.locale));
  }

  /** A sentence describing the layout mark's last scene. */
  layoutSummary(): string | undefined {
    return this.#layout?.result.summary();
  }

  #item(item: LayoutItem | undefined): Inspection | undefined {
    if (!item) return undefined;
    const { key, label, color, text, value, px, py, outline, values } = item;
    // The chart's marks are the layout mark, or the layers of a map or a 3D box.
    const mark = item.layer ?? 0;
    return {
      axis: "item",
      key,
      value,
      label: item.measure ?? this.#layout!.measure,
      points: [
        {
          mark,
          markId: this.#layout!.marks[mark]?.spec.id,
          key,
          label,
          row: item.row,
          color,
          text,
          value,
          px,
          py,
        },
      ],
      outline,
      ...(values && { values }),
    };
  }

  /** With facets, the inspection names its panel. */
  #inPanel(view: PanelView, inspection: AxisInspection | undefined): AxisInspection | undefined {
    return inspection && this.#namesPanels ? { ...inspection, panel: view.key } : inspection;
  }

  /** Releases geometry buffers. */
  dispose(): void {
    this.#polylines.clear();
    this.#floats.clear();
    this.#doubles.clear();
    this.#bytes.clear();
    this.#views = [];
    this.#panelList = undefined;
    this.#drawn = [];
    this.#base = undefined;
    this.#entries = [];
    this.#splitter = undefined;
    this.#layout = undefined;
    // Joined layout marks (a 3D chart's box) keep their geometry buffers.
    this.#layouts = [];
  }
}

/** Refuses a grid of panels the chart has no room for. */
/** Where a chart without facets draws: one panel, without headers. */
const ONE_PANEL: PanelGrid = { columns: 1, rows: 1, header: 0, columnHeader: 0, rowHeader: 0 };

function tooSmall(
  panels: number,
  columns: number,
  width: number,
  height: number,
  remedy: string,
): RangeError {
  const rows = Math.ceil(panels / columns);
  return new RangeError(
    `${panels} panels in ${rows} rows of ${columns} do not fit a ${width}×${height} chart; make it larger or ${remedy}`,
  );
}

function numberFormatter(locale: string | undefined): Formatter {
  return (value) => formatNumber(value, locale);
}

/** The category at a band index. */
function categoryOf(scale: PositionScale): Formatter {
  return (value) => scale.categories?.[Math.round(value)] ?? "";
}

/**
 * Precision for x values in tooltips: finer when each pixel covers less
 * time (on axes with breaks, less time shown).
 */
/**
 * `free` pixels shared by `count` rows or columns, equally or by `weights`.
 * Weights are scaled to the largest first, so huge ones cannot overflow.
 */
function trackSizes(free: number, count: number, weights?: readonly number[]): number[] {
  const largest = weights ? Math.max(...weights) : 1;
  const share = (k: number) => (weights ? weights[k]! / largest : 1);
  let total = 0;
  for (let k = 0; k < count; k++) total += share(k);
  return Array.from({ length: count }, (_, k) => (free * share(k)) / total);
}

function timeUnitFor(scale: PositionScale): TimeUnit {
  const perPixel = Math.abs(1 / scale.mapping().factor);
  if (perPixel < TIME_UNIT_MS.second) return "millisecond";
  if (perPixel < TIME_UNIT_MS.minute) return "second";
  if (perPixel < TIME_UNIT_MS.day) return "minute";
  return "day";
}

/** The y axis a mark's values are on. */
/** Whether scenes describe bars and slices for value transitions (`animation.values`). */
function keyedBy(config: ChartConfig): boolean {
  return (config.animation as AnimationSpec | undefined)?.values === true;
}

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

/**
 * Rejects configurations whose mark identities would collide or cannot be
 * laid out; returns the marks along axes and the layout marks.
 */
function validate(config: ChartConfig): [Mark[], LayoutMark[]] {
  const marks: Mark[] = [];
  let layouts: LayoutMark[] = [];
  for (const mark of config.marks) {
    if (isLayoutMark(mark)) layouts.push(mark);
    else marks.push(mark as Mark);
  }
  const [layout] = layouts;
  if (layout) {
    const type = layout.spec.type;
    // Layers of a map share its chart; they are drawn as one mark.
    if (layout.join) layouts = [layout.join(layouts, config)];
    if (layouts.length > 1 || marks.length > 0)
      throw new Error(`A ${type} mark has its chart to itself; draw other marks in another chart`);
    if (config.facet || config.panels)
      throw new Error(`Charts of a ${type} mark cannot have facets or panels yet`);
    const interaction = config.interaction;
    // 3D charts zoom their camera.
    const zooms = interaction?.zoom && !layouts[0]!.camera;
    if (zooms || interaction?.brush || interaction?.sync || config.x?.seams)
      throw new Error(
        `Charts of a ${type} mark have no x axis to zoom, brush, sync, or mark seams on`,
      );
  }
  const ids = new Set<string>();
  for (const mark of marks) {
    // The right axis measures values; marks placed along y belong on the left.
    if (sideOf(mark) === "right" && (mark.tooltip === "y" || mark.tooltip === "cell"))
      throw new Error(`A ${mark.spec.type} mark placed along y cannot use the right axis`);
    // Facet panels come from whole tables; a view's rows would split by them wrongly.
    if (config.facet && mark.view && mark.spec.facet !== "repeat")
      throw new Error(
        `A ${mark.spec.type} mark over a row view cannot be split by facets yet; give it facet: "repeat"`,
      );
    const id = mark.spec.id;
    if (id === undefined) continue;
    if (ids.has(id)) throw new Error(`Duplicate mark id "${id}"`);
    ids.add(id);
  }
  if (config.facet && config.panels) throw new Error("A chart has facets or panels, not both");
  const duration = typeof config.animation === "object" ? config.animation.duration : undefined;
  if (duration !== undefined && !(Number.isFinite(duration) && duration >= 0))
    throw new RangeError(`animation.duration must be milliseconds of at least 0, not ${duration}`);
  if (!config.panels) {
    const named = marks.find((mark) => mark.spec.panel !== undefined);
    if (named)
      throw new Error(`A ${named.spec.type} mark names a panel, but the chart has no panels`);
  }
  // Facets and panels refuse navigators, so one of the three checks the marks.
  (config.facet ?? config.panels ?? config.navigator)?.check(marks, config);
  return [marks, layouts];
}

/** An ascending range, or null for none or an empty one. */
function range(domain: readonly [number, number] | null): [number, number] | null {
  return domain && domain[0] !== domain[1] ? [Math.min(...domain), Math.max(...domain)] : null;
}

/** An ascending viewport the way the axis' configured domain runs, so reversed axes stay reversed. */
function oriented(
  viewport: readonly [number, number],
  domain: readonly [number, number] | undefined,
): [number, number] {
  const [lo, hi] = viewport;
  return domain && domain[0] > domain[1] ? [hi, lo] : [lo, hi];
}
