// The chart model turns marks and data into a scene. It is independent of the
// DOM: the browser runtime, server rendering, and tests all drive it the same
// way. It keeps per-chart state that must survive between frames: geometry
// buffers, the zoomed x range, hidden series, and layout hysteresis.

import type { Table } from "../data/table.ts";
import type { Fonts } from "../fonts/registry.ts";
import { type Formatter, formatNumber, timeValueFormatter } from "../format/format.ts";
import { aligned, alignedAt, insideAt } from "../layout/place.ts";
import {
  fitText,
  type MeasureText,
  textHeight,
  textItem,
  textItems,
  textWidth,
} from "../layout/text.ts";
import { stackTracks, type TrackRequest } from "../layout/tracks.ts";
import { Polyline } from "../lod/polyline.ts";
import { isLayoutMark, type LayoutMark } from "../marks/layout-mark.ts";
import {
  type AxisFormat,
  type BandContext,
  type BandList,
  type Bands,
  type ChartMark,
  type Frame,
  legendKey,
  type Mark,
  type MarkKey,
  numericBands,
  type Palette,
  type RowParts,
  usesY,
} from "../marks/mark.ts";
import { type Series, samePositions } from "../marks/series.ts";
import type { FieldReaders } from "../marks/tooltip-fields.ts";
import { unionExtent } from "../marks/trace.ts";
import type { TimeBreaks } from "../scale/breaks.ts";
import type { PositionScale } from "../scale/scale.ts";
import { TIME_UNIT_MS, type TimeUnit } from "../scale/time.ts";
import {
  type AxisGuide,
  type AxisPlacement,
  type Geometry,
  type Guide,
  type HeaderGuide,
  type Panel,
  type Rect,
  type Scene,
  tickLabelGap,
} from "../scene/scene.ts";
import type { InsidePlace, Place } from "../spec/place.ts";
import type {
  AnimationSpec,
  AxisSpec,
  CameraSpec,
  ChartSpec,
  ScaleScope,
  XAxisSpec,
} from "../spec/spec.ts";
import { insets, type TextPaint } from "../style/style.ts";
import { readNow, resolveTheme, type Theme, type ThemeEnvironment } from "../theme.ts";
import type { Camera } from "../three/camera.ts";
import {
  type AxisBreaks,
  type AxisContext,
  type AxisPlan,
  type AxisType,
  niceAxisDomain,
  planAxis,
  planBandAxis,
  shiftPlan,
  usableDomain,
  valueFormatter,
} from "./axis.ts";
import { axisGuide, TICK } from "./axis-guide.ts";
import type { Facet } from "./facet.ts";
import type { ItemPanel, ItemViews } from "./item-views.ts";
import { EDGE, HiddenKeys, type LegendEntry, type LegendPart, measureLegends } from "./legend.ts";
import type { Navigator } from "./navigator.ts";
import type { PanelGrid, PanelLayout, PanelSplit } from "./panel-layout.ts";
import type { Panels } from "./panels.ts";
import type { RowSelection } from "./row-selection.ts";
import { instanceType, type ScaleName } from "./scales.ts";
import { type ChartStyles, chartStyles, styleSources } from "./styles.ts";
import { titleText } from "./titles.ts";

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
  | "rowSelection"
> & {
  /**
   * Marks along axes, or one layout mark (a pie) that has the chart to
   * itself; with facets or panels, layout marks that have a panel each.
   */
  marks: readonly ChartMark[];
  x?: XAxisConfig | undefined;
  /** Small multiples: a panel per value of a category field (see `facet`). */
  facet?: Facet | undefined;
  /** Subplots: panels drawing the marks that name them (see `panels`). */
  panels?: Panels | undefined;
  /** A strip under the plots to see and move the x range by (see `rangeNavigator`). */
  navigator?: Navigator | undefined;
  /** Channels of selection stores the chart writes rows to and highlights (see `rowSelection`). */
  rowSelection?: RowSelection | undefined;
  /**
   * Fonts from `prepareFonts` (herceg/fonts) to measure text with: in a browser,
   * where they cover it, registered with the document to draw it; in SVG
   * and PNG exports, named by their families; in PDF, embedded.
   */
  fonts?: Fonts | undefined;
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
  yRightGroup: string;
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
  /** The right y axis' scale, in panels drawing marks on it. */
  yRight?: PositionScale | undefined;
  /** Names the right y scale the panel shares with others: "" when every panel does, or without one. */
  yRightGroup: string;
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

const GAP = 6;
/** Left inset of the title and legend. */

export class ChartModel {
  #config: ChartConfig;
  /** The chart's marks along axes, and its layout marks. */
  #marks: readonly Mark[] = [];
  #layouts: readonly LayoutMark[] = [];
  /** Each mark along axes' index among the chart's marks, which identifies it. */
  #positions: readonly number[] = [];
  /** What layout marks drew in the last scene, for charts with any. */
  #items: ItemViews | undefined;
  /** Every panel of the last scene, in order: with marks along axes, or a layout mark. */
  #all: readonly (ItemPanel & { items: boolean })[] = [];
  #theme!: Theme;
  /** Its guides' and panels' styles over the theme. */
  #styles!: ChartStyles;
  /** The page's colors and fonts in those styles when they were resolved (see `readNow`). */
  #pageStyles: string | undefined;
  width = 640;
  height = 400;
  pixelRatio = 1;
  /** Pixels per CSS pixel of the images marks draw (heatmaps); see `setSize`. */
  rasterRatio = 1;
  /** Keys of series hidden through the legend, with the legend groups of series (see HiddenKeys). */
  readonly hidden = new HiddenKeys();
  /**
   * Draws marks with the rows of a selection highlighted: set by a chart
   * bound to selection stores (see row-selection.ts).
   */
  declare highlight: typeof geometryOf | undefined;
  /**
   * Which of a table's rows the selection a chart highlights holds, for
   * layout marks drawing them (maps, trees, networks): set as `highlight` is.
   */
  declare layoutHighlight: ((table: Table) => Uint8Array | undefined) | undefined;
  /**
   * Reads the fields marks' tooltips show of rows (`tooltip.fields`) for
   * inspections: set by a chart once it has loaded what reads them.
   */
  declare fields: FieldReaders | undefined;
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
    { measure: MeasureText; widths: Map<string, number> }
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
  /** Every mark's series in the last scene: those of all panels. */
  #drawn: MarkSeries[] = [];
  /** Every mark's series before facets split them, for legends and summaries. */
  #base: MarkSeries[] | undefined;
  /** The color scales and size and shape keys the last scene's legends show. */
  /** The last scene's legends of color scales, sizes, and shapes. */
  #legendParts: readonly LegendPart[] = [];
  /** Palette slot per series key, assigned on first appearance and kept. */
  #slots = new Map<string, number>();

  /** `page` resolves themes that follow the page: "auto" and CSS variables. */
  constructor(config: ChartConfig, page?: ThemeEnvironment) {
    [this.#marks, this.#layouts, this.#positions] = validate(config);
    this.#config = config;
    this.#style(page);
  }

  /**
   * Resolves the theme and the guides' and panels' styles in `page`: what
   * they read of it is read now, as styles resolve when scenes ask for them.
   */
  #style(
    page: ThemeEnvironment | undefined,
    theme = resolveTheme(this.#config.theme, page),
    styles = readNow(styleSources(this.#config), page ?? {}),
  ): void {
    this.#theme = theme;
    this.#styles = chartStyles(theme, this.#config, styles.environment);
    this.#pageStyles = styles.reading;
    this.#layoutKey = "";
  }

  get config(): ChartConfig {
    return this.#config;
  }

  /** The layout marks the chart draws: a map's layers joined into one. */
  get layouts(): readonly LayoutMark[] {
    return this.#layouts;
  }

  get theme(): Theme {
    return this.#theme;
  }

  /** Resolves a theme and styles that follow the page again; whether they changed. */
  refreshTheme(page: ThemeEnvironment): boolean {
    const theme = resolveTheme(this.#config.theme, page);
    const styles = readNow(styleSources(this.#config), page);
    if (
      JSON.stringify(theme) === JSON.stringify(this.#theme) &&
      styles.reading === this.#pageStyles
    )
      return false;
    this.#style(page, theme, styles);
    return true;
  }

  /** Lets the next scene lay its margins out afresh, as when text measures differently. */
  relayout(): void {
    this.#layoutKey = "";
  }

  update(config: ChartConfig, page?: ThemeEnvironment): void {
    [this.#marks, this.#layouts, this.#positions] = validate(config);
    this.#config = config;
    // Series join their legend groups again as they are resolved.
    this.hidden.groups.clear();
    // Sides whose panels have scales of their own let go of their y viewport.
    const { y, yRight } = this.#yViewport;
    const kept = {
      y: this.#shares("y") ? y : null,
      yRight: this.#shares("yRight") ? yRight : null,
    };
    if (kept.y !== y || kept.yRight !== yRight) this.#yViewport = kept;
    this.#style(page);
  }

  /** A copy of the camera of the targeted 3D state; multiple cameras require a panel. */
  getCamera(panel?: string): Camera | undefined {
    return this.items?.camera(panel);
  }

  setCamera(camera: CameraSpec | null, panel?: string): boolean {
    const items = this.items;
    if (!items) throw new Error("setCamera: no 3D camera; add a 3D mark");
    return items.setCamera(camera, panel);
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

  /** Whether every panel shares one x scale: unless the chart's `x.scope` says otherwise. */
  get sharesX(): boolean {
    return this.#scope("x") === "chart";
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
      throw new Error("panel: required when panels have x scales of their own");
    }
    const view = this.#views.find(({ key }) => key === panel);
    if (!view) throw new RangeError(`panel: no panel "${panel}"`);
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

  /**
   * Throws for a y range in a chart whose panels have scales of their own
   * on that side: they have no one viewport there.
   */
  checkYViewport(viewport: Partial<YViewport>): void {
    if ((viewport.y && !this.#shares("y")) || (viewport.yRight && !this.#shares("yRight")))
      throw new Error("setViewport y: panels with y scales of their own have no one y range");
  }

  /**
   * Draws these ranges in place of the viewports and fitted domains while a
   * change of view plays: as they are, not rounded, and not reported as the
   * viewport. Null ends it.
   */
  setTransitionDomains(domains: ViewDomains | null): void {
    this.#transition = domains;
  }

  /**
   * Whether every panel shares a y axis' scale, so the chart has one
   * viewport of it: without facets or with that axis' `scope` "chart";
   * subplots never do.
   */
  #shares(axis: "y" | "yRight"): boolean {
    return !this.#config.panels && this.#scope(axis) === "chart";
  }

  /** Which of the chart's panels share a scale (see `PanelLayout.scopes`): all of them without panels. */
  #scope(axis: ScaleName): ScaleScope {
    return this.#panels?.scopes(this.#config)[axis] ?? "chart";
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

  #palette: Palette = (seriesKey, _label, color): string => {
    if (color !== undefined) return color;
    let slot = this.#slots.get(seriesKey);
    if (slot === undefined) {
      slot = this.#slots.size;
      this.#slots.set(seriesKey, slot);
    }
    return this.#theme.palette[slot % this.#theme.palette.length]!;
  };

  /**
   * The type of a scale every panel shares, from its declared type
   * (`declared`, the chart's by default) and the marks of `among` on its
   * side: a categorical channel gives a band scale, a time field a time scale.
   */
  #sharedType(
    axis: ScaleName,
    among: readonly Mark[] = this.#marks,
    declared = this.#config[axis]?.type,
  ): AxisType {
    // The y axes take the marks on their side.
    const marks = among.filter(
      (mark) => axis === "x" || (sideOf(mark) === "right") === (axis === "yRight"),
    );
    // In subplots, marks drawn in one panel name it in errors.
    const layout = this.#panels;
    return instanceType(marks, declared, {
      scale: axis,
      mixed: layout?.mixed && ((numbers, categories) => layout.mixed!(numbers, categories, axis)),
    });
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
    const { hidden } = this;
    return this.#marks.map((mark, index) => {
      const group = mark.spec.legendGroup;
      // A legend group's series take their colors by name.
      const palette: Palette =
        group === undefined
          ? this.#palette
          : (key, label, color) => {
              const entry = legendKey(group, label ?? key);
              hidden.groups.set(key, entry);
              return this.#palette(entry, label, color);
            };
      const series = mark.series(
        mark.spec.id ?? this.#positions[index]!,
        palette,
        hidden,
        bands,
        context,
        layout?.splits(mark),
      );
      return { mark, series };
    });
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
    return this.#splitter.splitter.split(base, this, this.#bands, context);
  }

  /** x extent of all data drawn, ignoring the viewport. */
  dataXExtent(): [number, number] | undefined {
    const type = this.#sharedType("x");
    if (type === "band") return undefined;
    const context = this.#context();
    const marks = this.#split(this.#resolveSeries(this.#bands, context), context).all;
    const breaks = this.#xBreaks(type, context.zone);
    return unionExtent(
      marks.map(({ mark, series, rows }) =>
        mark.xExtent(this.#xSeries(mark, series), type === "log", breaks, rows),
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
        marks.map(({ mark, series, rows }) => {
          const visible = series.filter((s) => !this.hidden.has(s.key));
          if (mark.zero === "y" && (visible.length > 0 || mark.seriesless)) stands = true;
          return mark.yExtent(visible, x0, x1, log, breaks, rows);
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
    let cached = this.#labelWidths.get(labels);
    if (cached?.measure !== measure) {
      cached = { measure, widths: new Map() };
      this.#labelWidths.set(labels, cached);
    }
    let width = cached.widths.get(font);
    if (width === undefined) {
      width = 0;
      for (const label of labels) width = Math.max(width, measure(label, font));
      cached.widths.set(font, width);
    }
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
    const config = this.#config;
    const layout = this.#panels;
    if (!layout && this.#layouts.length > 0) return this.#layoutScene(measure, clouds);
    this.#items?.clear();
    const theme = this.#theme;
    const { width, height } = this;
    const context = this.#context();
    const { zone, locale } = context;
    // The categories of every mark placing them along an axis. Scale types
    // are found once marks are in their panels: a category scale in one
    // subplot leaves another's alone.
    const bands: Bands = {};
    for (const axis of ["x", "y"] as const)
      if (this.#marks.some((mark) => mark.channelKind(axis) === "category"))
        bands[axis] = this.#bandList(axis, context);
    this.#bands = bands;
    const base = this.#resolveSeries(bands, context);
    const split = this.#split(base, context);
    // Each panel's bands on a band axis: the chart's, or its group's own (see PanelBands).
    const bandsOf = (axis: "x" | "y", panel: number) =>
      (split.bands?.[axis]?.[panel] ?? bands[axis])!;
    // Domains and layout consider what every panel draws.
    const marks = split.all;
    // Panels drawing a layout mark have no axes; the others place, label, and share scales.
    const items = split.items;
    const axesIn = (i: number) => !items?.[i];
    // Subplots take their first panel's x settings when every panel shares x.
    const xSpec = layout
      ? layout.panelAxis("x", Math.max(0, items?.indexOf(undefined) ?? 0), config.x)
      : config.x;
    const styles = this.#styles;
    const lineHeight = theme.style.text.lineHeight;
    const padding = (axis: "x" | "y") =>
      Math.min(
        0.2,
        ...marks
          .filter(({ mark }) => mark.channelKind(axis) === "category")
          .map(({ mark }) => mark.bandPadding ?? 0.2),
      );

    const drawn = marks.filter(({ series }) => series.length > 0);
    // Marks carry the formulas for glyph insets and room past bar labels.
    const padDomain = (
      axis: "x" | "y",
      domain: [number, number],
      pixels: number,
      type: AxisType,
      among = drawn,
    ): [number, number] => {
      let inset = 0;
      let room = 0;
      let insetDomain: Mark["insetDomain"];
      let headroomDomain: Mark["headroomDomain"];
      for (const { mark, series } of among) {
        if (mark.inset) {
          inset = Math.max(inset, mark.inset[axis]);
          insetDomain = mark.insetDomain;
        }
        if (mark.zero === axis && mark.headroom) {
          room = Math.max(
            room,
            mark.headroom(
              series.filter((s) => !this.hidden.has(s.key)),
              context,
            ),
          );
          headroomDomain = mark.headroomDomain;
        }
      }
      const widened = headroomDomain?.(domain, room, pixels, type) ?? domain;
      return insetDomain?.(widened, inset, pixels, type) ?? widened;
    };

    // Panels fill a grid of `columns`; without facets, one cell.
    const panelCount = split.keys.length;
    // Rows of text take their style's line height (and box), at least the base text's.
    const panelIndexes = split.keys.map((_, i) => i);
    const tallest = (paints: readonly TextPaint[]) =>
      Math.max(lineHeight, ...paints.map(textHeight));
    const grid = layout
      ? layout.grid(split, tallest(panelIndexes.map((i) => styles.panelTitle(i))))
      : ONE_PANEL;
    const { columns, rows, header, columnHeader, rowHeader } = grid;
    const rowOf = (panel: number) => Math.floor(panel / columns);

    // x scales: one for every panel, or with `x.scope` one per group of
    // panels (each alone, a row, or a column), from what the group draws.
    const xScope = this.#scope("x");
    const xGroups =
      xScope === "chart" ? undefined : layout!.groups(xScope, split, columns, "x", config.x);
    const xGroupAt = xGroups?.groupOf ?? new Array<number>(panelCount).fill(0);
    // Each group's marks, with every mark's series in the group's panels.
    const xMarks = xGroups?.drawn ?? [marks];
    const xShared = () => ({
      type: this.#sharedType(
        "x",
        marks.map(({ mark }) => mark),
        xSpec?.type,
      ),
      spec: xSpec,
    });
    const xContexts = (xGroups?.axes ?? [xShared()]).map((scale) => ({
      ...scale,
      zone,
      locale,
      breaks: this.#xBreaks(scale.type, zone),
    }));
    const seams = config.x?.seams;
    if (config.x?.breaks && !xContexts.some(({ breaks }) => breaks))
      throw new Error(`chart x.breaks: need a time x axis; x is ${xContexts[0]!.type}`);
    if (seams && !config.x?.breaks) throw new Error("chart x.seams: need x.breaks to mark");
    // Viewports are kept by group, named by its panels: a group whose panels
    // change (a facet value appears and the panels wrap anew) starts over.
    const xKeys = xGroups?.keys ?? [""];
    const xDrawn = xMarks.map((among) => among.filter(({ series }) => series.length > 0));
    // An x axis measuring bar lengths gets the y axis' defaults: zero, round
    // ends, and grid lines.
    const xMeasures = xMarks.map((among) =>
      among.some(({ mark, series }) => mark.zero === "x" && (series.length > 0 || mark.seriesless)),
    );

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
        xMarks[h]!.map(({ mark, series, rows }) =>
          mark.xExtent(this.#xSeries(mark, series), log, breaks, rows),
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

    // With x scales of their own, what panels draw counts within their own x
    // domain, so zooming one group can change a y scale it shares; category
    // x scales show all of theirs.
    const byX = xGroups && xContexts.some(({ type }) => type !== "band") && xGroups;
    // Each y axis is for the marks on its side: the left one's, or with
    // `axis: "right"` the right one's. A panel has a y axis when one of its
    // marks places values along it, and the left one also without a right
    // one (as `yAxesOf` says to the panels' groups and their agreement).
    const onSide = (among: readonly MarkSeries[], right: boolean) =>
      among.filter(({ mark }) => (sideOf(mark) === "right") === right);
    const placesY = (i: number, right: boolean) =>
      split.panels[i]!.some(
        ({ mark }, m) =>
          (sideOf(mark) === "right") === right && usesY(mark) && split.members?.[i]?.[m] !== false,
      );
    const rightIn = split.keys.map((_, i) => axesIn(i) && placesY(i, true));
    const leftIn = split.keys.map((_, i) => axesIn(i) && (!rightIn[i] || placesY(i, false)));
    const rightUsed = rightIn.includes(true);

    // Vertical layout depends only on fonts, titles, and the legends.
    // One legend per distinct scale or key: marks sharing a scale share one.
    const legends = config.legend ?? true;
    const format = (value: number) => formatNumber(value, locale);
    // Layout marks' color scales (a choropleth's) first, as a chart of one draws them.
    const parts = new Map<string, LegendPart>(this.items?.legends());
    for (const { mark, series } of legends ? base : []) {
      for (const part of mark.legends?.(series, theme, format) ?? [])
        if (!parts.has(part.key)) parts.set(part.key, part);
    }

    // Entries in the order of the chart's marks: series, and layout marks'
    // items; a legend group's series of one name share the first one's entry.
    const listed = new Set<string>();
    let along = 0;
    const entries = config.marks.flatMap((chartMark, index) => {
      if (isLayoutMark(chartMark))
        return chartMark.legend(chartMark.spec.id ?? index, this.#palette, theme);
      const { mark, series } = base[along++]!;
      return series.flatMap((s) => {
        const entry = mark.legendEntry ? mark.legendEntry(s, theme) : { color: s.color };
        const key = this.hidden.groups.get(s.key) ?? s.key;
        if (!entry || listed.has(key)) return [];
        listed.add(key);
        const item: LegendEntry = { key, label: s.label, color: entry.color };
        if (entry.glyph) item.glyph = entry.glyph;
        if (entry.stroke) item.stroke = entry.stroke;
        return [item];
      });
    });
    const showY = config.y?.show ?? true;
    // Whether panel `i` may show y labels on a side: marks drawn there, and
    // its settings showing the axis. Only styles drawn are read.
    const showsY = (axis: "y" | "yRight", i: number) =>
      (axis === "y" ? showY && leftIn[i]! : rightIn[i]!) &&
      (layout ? layout.panelAxis(axis, i, config[axis]) : config[axis])?.show !== false;
    // How far y labels reach past their end ticks: half their box, or half
    // their text. Boxes reaching further than the half of the base text the
    // spacing has always kept get room for it (`yOver`).
    const textReach = Math.ceil(theme.fontSize / 2);
    let yReachAll = 0;
    let yOver = 0;
    let yBoxed = false;
    for (const i of panelIndexes)
      for (const axis of ["y", "yRight"] as const) {
        if (!showsY(axis, i)) continue;
        const paint = styles.axisText("tickLabel", axis, i);
        const reach = Math.ceil((paint.background ? textHeight(paint) : paint.size) / 2);
        yReachAll = Math.max(yReachAll, reach);
        if (paint.background) {
          yBoxed = true;
          yOver = Math.max(yOver, reach - textReach);
        }
      }
    const head = this.#furniture(entries, [...parts.values()], measure, showY || rightUsed, yOver);
    const top = head.top;
    // x labels go under the lowest panel with axes of each column, and under
    // every panel when the panels of a column have x scales of their own, as
    // each panel's `show` setting (a subplot's own over the chart's) says.
    const xBetween = xScope === "panel" || xScope === "row";
    const panelX = (i: number) => (layout ? layout.panelAxis("x", i, config.x) : config.x);
    const labelsX = (i: number) =>
      axesIn(i) &&
      (panelX(i)?.show ?? true) &&
      (xBetween || (grid.lowest?.[i] ?? i + columns >= panelCount));
    const showX = split.keys.some((_, i) => labelsX(i));
    // Room under the plot before the x labels' line of text: more for large
    // text, whose labels sit further below the axis, and below the reach of
    // y labels' boxes, which would cover the first and last.
    const xLabeled = panelIndexes.filter(labelsX);
    const xLabelPaints = xLabeled.length
      ? xLabeled.map((i) => styles.axisText("tickLabel", "x", i))
      : [theme.style.tickLabel];
    const yReach = yOver && textReach + yOver;
    // Where either has boxes, x labels go below the y labels' reach, their
    // line (and box) starting half its leading above the hanging point.
    const xGap = (paint: TextPaint) =>
      Math.max(
        tickLabelGap(paint.size),
        yBoxed || paint.background ? yReachAll + 2 + (paint.lineHeight - paint.size) / 2 : 0,
      );
    const xLabels = TICK + GAP + Math.max(...xLabelPaints.map(xGap)) - tickLabelGap(0);
    const xLabelHeight = tallest(xLabelPaints);
    // Each x scale's title goes once, under the last panel labeled with it
    // (see xTitleOf), and only those panels' title styles are read.
    const titleAt = xContexts.map(() => -1);
    for (const i of xLabeled) titleAt[xGroupAt[i]!] = i;
    const xTitled = titleAt.filter((i, h) => i >= 0 && xContexts[h]!.spec?.title);
    const xTitleHeight = tallest(xTitled.map((i) => styles.axisText("axisTitle", "x", i)));
    const xTitle = xTitled.length ? xTitleHeight + GAP : 0; // y labels' boxes reach below the bottom tick as far as above the top one.
    const below =
      Math.max(
        showX ? xLabels + xLabelHeight + xTitle + (head.auto ? 2 : 0) : head.auto ? 4 : 0,
        yReach,
      ) + head.lift;
    // Rows of panels leave room between them for what goes there (see `PanelLayout.rowGap`).
    const space = {
      xBetween,
      ownX: xGroups !== undefined,
      showX,
      xLabels,
      lineHeight: xLabelHeight,
      xTitle,
    };
    // Rows leave room for both rows' y label boxes reaching into it, past
    // what goes between them (x labels too, then the next row's boxes).
    const rowGap = Math.max(
      (layout ? layout.rowGap(grid, panelCount, space) : 0) + yOver,
      2 * yReach - header,
    );
    // Rows share the height left for plots equally, or by the grid's
    // weights, and a navigator's strip goes under the x axis when they
    // leave room for it.
    let free = height - top - below - columnHeader - (rows - 1) * rowGap - rows * header;
    const navigator = config.navigator;
    const strip = navigator ? navigator.room(free, grid.least) : 0;
    free -= strip;
    const heights = layout
      ? layout.tracks(free, rows, grid.rowWeights, panelCount, columns, this)
      : [free];
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
    /** How panel `i`'s axis of scale `axis` writes its tick labels. */
    const tickPaint = (axis: ScaleName, i: number) => styles.axisText("tickLabel", axis, i);
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
      const nice = spec?.nice ?? !sideDrawn.some(({ mark }) => mark.tight);
      const rounded = niceAxisDomain(base, axisContext, count, nice);
      const domain = padDomain("y", rounded, size, axisContext.type, sideDrawn);
      return planAxis(
        axisContext,
        domain,
        [plotTop + size, plotTop],
        count,
        nice ? rounded : domain,
      );
    };

    /** The category y axis of panel `i` over the plot from `y`, `size` tall. */
    const planCategories = (y: number, size: number, i: number): AxisPlan => {
      // Categories read top to bottom; bands of numbers rise like a numeric axis.
      const upward = bands.y !== undefined && numericBands(bands.y);
      const paint = showsY("y", i) ? tickPaint("y", i) : theme.style.tickLabel;
      const plan = planBandAxis(
        bandsOf("y", i).labels,
        upward ? [y + size, y] : [y, y + size],
        padding("y"),
        paint.lineHeight,
      );
      // Long category names are shortened rather than squeezing the plot.
      const room = Math.max(48, Math.round(width * 0.3));
      plan.labels = plan.labels.map((label) => fitText(label, room, measure, paint.css));
      return plan;
    };
    /**
     * The plans of one side's y axis (`right`, or the left), whose ticks
     * decide that side's margin. Panels share one plan unless the side's
     * scope gives each panel, row, or column its own, from what those
     * panels draw on that side. Each group's axis is the chart's with its
     * first panel's settings, of the type its own panels' marks give.
     */
    const planY = (right: boolean) => {
      const axis = right ? "yRight" : "y";
      const view = right ? yRightView : yView;
      const scope = this.#scope(axis);
      const drawsAxis = right ? rightIn : leftIn;
      // A scale every panel shares has one type, from all their marks.
      const shared =
        scope === "chart"
          ? this.#sharedType(
              axis,
              marks.map(({ mark }) => mark),
            )
          : undefined;
      // Subplots always plan by group, to read each panel's own settings; a
      // shared category axis is the one plan.
      const groups =
        (config.panels && shared !== "band") || scope !== "chart"
          ? layout!.groups(scope, split, columns, axis, config[axis])
          : undefined;
      const groupOf = groups?.groupOf ?? new Array<number>(panelCount).fill(0);
      // What each group draws on this side, and its axis.
      const drawnOn = groups?.drawn ?? [onSide(marks, right)];
      const contexts = (groups?.axes ?? [{ type: shared!, spec: config[axis] }]).map(
        (scale): AxisContext => ({ ...scale, zone, locale }),
      );
      // Each group is planned over its shortest row with the axis, so what
      // marks draw past their values (points, bar labels) fits in every row;
      // a group of panels drawing layout marks only has nothing to fit.
      const heights = contexts.map(() => Number.POSITIVE_INFINITY);
      groupOf.forEach((g, i) => {
        if (drawsAxis[i]) heights[g] = Math.min(heights[g]!, rowHeights[rowOf(i)]!);
      });
      const heightOf = (g: number) => (heights[g]! < Infinity ? heights[g]! : plotHeight);
      const plans: AxisPlan[] = [];
      // Groups of panels with nothing to show along y have no y labels.
      const empty = new Set<number>();
      // With x scales of their own, a y group's panels are read by x group:
      // what the panels of both draw, within that x group's domain.
      const crossed =
        byX &&
        (groups
          ? layout!.across(split, groupOf, xGroupAt)
          : [xMarks.map((among, h) => [h, among] as const)]);
      drawnOn.forEach((among, g) => {
        if (contexts[g]!.type === "band") {
          plans[g] = planCategories(plotTop, heightOf(g), groupOf.indexOf(g));
          return;
        }
        const parts = crossed
          ? crossed[g]!.map(([h, those]) => part(onSide(those, right), h))
          : [part(among, 0)];
        // A group's own type: a subplot's log or time axis.
        const { type: own, spec } = contexts[g]!;
        const zoomed = !groups && view !== undefined;
        const fixed = zoomed ? oriented(view, spec?.domain) : spec?.domain;
        // A group shows something when its marks place a value along y,
        // annotations included; the extent of a fixed shared domain is not read.
        const extent = groups || !fixed ? this.#yData(parts, own, spec) : undefined;
        if (groups && !extent) empty.add(g);
        const base = usableDomain(fixed ?? extent, own);
        plans[g] = planValueAxis(contexts[g]!, base, among, zoomed, heightOf(g));
      });
      // Every panel's plan: its group's moved to its row. A row of another
      // height than the group's keeps the group's domain with ticks for its height.
      const byPanel = split.keys.map((_, i) => {
        const row = rowOf(i);
        const g = groupOf[i]!;
        const plan = plans[g]!;
        const context = contexts[g]!;
        const size = rowHeights[row]!;
        if (size === heightOf(g)) return shiftPlan(plan, context, rowOffset(row));
        const y = plotTop + rowOffset(row);
        if (context.type === "band") return planCategories(y, size, i);
        const [d0, d1] = plan.scale.domain;
        const count = tickCount(context.spec, size);
        return planAxis(context, [d0!, d1!], [y + size, y], count, plan.within);
      });
      // Panels show their own labels unless their scale is their row's:
      // beside the row's first panel on the left, its last on the right.
      const own = config.panels !== undefined || scope === "panel" || scope === "column";
      // Whether a group shows categories, which may be none.
      const banded = (i: number) => contexts[groupOf[i]!]!.type === "band";
      return { axis, groups, groupOf, contexts, plans: byPanel, empty, own, banded };
    };
    const leftY = planY(false);
    const rightY = rightUsed ? planY(true) : undefined;
    // Whether the left axis has anything to label: a band axis may have no bands.
    const leftData =
      !leftY.contexts.every(({ type }) => type === "band") || (bands.y?.keys.length ?? 0) > 0;
    if (!(leftData || rightUsed)) xHas.fill(false);
    const hasData = xHas.includes(true);
    /** Names the scale panel `i` shares on a side: "" when every panel does. */
    const groupKey = (side: typeof leftY, i: number) => side.groups?.keys[side.groupOf[i]!] ?? "";
    // Subplots show, title, and grid each panel's y axes as its own settings
    // say; other charts title the chart's once.
    const panelAxis = (i: number, axis: "y" | "yRight" = "y") =>
      layout ? layout.panelAxis(axis, i, config[axis]) : config[axis];
    /**
     * Where a side's y labels go: beside each row's first panel on the left
     * and its last on the right, or beside every panel when panels have
     * scales of their own there (and in subplots), of the panels `drawn`
     * that show the axis. Its widest labels and its title decide its
     * margin, and with labels beside every panel, the gaps between columns.
     */
    const yLabels = (side: typeof leftY | undefined, drawn: readonly boolean[]) => {
      const right = side !== leftY;
      const axis = right ? "yRight" : "y";
      const labeled = drawn.map(
        (shows, i) =>
          shows &&
          (panelAxis(i, axis)?.show ?? true) &&
          (side!.own ||
            (right ? i % columns === columns - 1 || i === panelCount - 1 : i % columns === 0)),
      );
      const labelsOf = (i: number) =>
        hasData && (right || leftData) && !side!.empty.has(side!.groupOf[i]!)
          ? side!.plans[i]!.labels
          : [];
      const widest = Math.max(
        0,
        ...labeled.flatMap((l, i) => {
          if (!l) return [];
          const paint = tickPaint(axis, i);
          // Labels in boxes take their boxes' padding too.
          const boxed = paint.background ? paint.padding[1] + paint.padding[3] : 0;
          return labelsOf(i).map((label) => measure(label, paint.css) + boxed);
        }),
      );
      const room = labeled.includes(true) ? Math.ceil(widest) + GAP + 2 : 0;
      // Subplots title each panel's axis, other charts it once, beside the
      // first labeled panel (see the y axes below): only those read styles.
      const first = labeled.indexOf(true);
      const titled = panelIndexes.filter(
        (i) => labeled[i] && (config.panels || i === first) && panelAxis(i, axis)?.title,
      );
      const titleHeight = tallest(titled.map((i) => styles.axisText("axisTitle", axis, i)));
      const title = titled.length ? titleHeight + GAP : 0;
      const between = side?.own
        ? layout!.columnGap(labeled, right, columns, room, config.panels ? title : 0)
        : 0;
      return { labeled, labelsOf, room, title, titleHeight, between, first };
    };
    // Panels that all draw layout marks, or marks on the right only, label no left axis.
    const leftLabels = yLabels(leftY, showY ? leftIn : []);
    const rightLabels = yLabels(rightY, rightY ? rightIn : []);
    // The widest label starts at the chart's edge inset, in line with the title.
    let left =
      head.left + leftLabels.room + (leftLabels.room && leftLabels.title) + (head.auto ? EDGE : 0);
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

    // The right labels decide the right margin, with a grid's row headers
    // and the right title beyond them.
    const { room: rightRoom } = rightLabels;
    let right =
      head.right +
      (rightRoom || rowHeader
        ? rightRoom + (rowHeader && rowHeader + GAP) + rightLabels.title + (head.auto ? EDGE : 0)
        : head.auto
          ? 12
          : 0);
    if (frozen) right = this.#right;
    else if (sameLayout) right = Math.max(right, this.#right);

    // x ticks; widen the margins if the first or last label would be clipped,
    // and the gap between columns of panels if labels at the edges of
    // neighboring panels would meet, by up to a quarter of the width each:
    // labels that cannot fit must not squeeze the plots away.
    const edgeRoom = Math.floor(width / 4);
    // Between columns: the right labels and titles of the panels before,
    // and the left ones of those after, when panels label their own.
    const labelRoom = leftLabels.between + rightLabels.between;
    let columnGap = columns > 1 ? Math.max(16, labelRoom, sameLayout ? this.#columnGap : 0) : 0;
    if (frozen) columnGap = this.#columnGap;
    // Columns share the width left for plots as rows share the height.
    const weighted = grid.columnWeights !== undefined;
    const widthsOf = () => {
      const free = width - left - right - (columns - 1) * columnGap;
      return layout
        ? layout.tracks(free, columns, grid.columnWeights, panelCount, columns, this)
        : [free];
    };
    let widths: number[] = [];
    // Where each column starts, from `left`; equal columns a whole step apart.
    let offsets: number[] = [];
    // Each x group is planned over its narrowest column with axes, so what
    // marks draw past their values fits in every column.
    let groupWidths: number[] = [];
    const xTicks = ({ type, spec }: AxisContext, size: number) =>
      spec?.ticks ?? Math.max(2, Math.round(size / (type === "time" ? 100 : 80)));
    // Each x group's plan for panels `plotWidth` wide, the first starting at `left`.
    const planCategoriesX = (h: number, range: readonly [number, number]): AxisPlan => {
      const first = xGroupAt.indexOf(h);
      const categories = bandsOf("x", first).labels;
      // Spaced for the widest of the group's labels drawn, in their styles
      // and boxes.
      const widest = Math.max(
        0,
        ...xLabeled
          .filter((i) => xGroupAt[i] === h)
          .map((i) => {
            const paint = tickPaint("x", i);
            const [, right, , left] = paint.background ? paint.padding : [0, 0, 0, 0];
            return this.#widest(categories, measure, paint.css) + left + right;
          }),
      );
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
        padDomain("x", d, plotWidth, as, xDrawn[h]);
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
        if (axesIn(i)) groupWidths[h] = Math.min(groupWidths[h]!, widths[i % columns]!);
      }
      groupWidths = groupWidths.map((w) => (w < Infinity ? w : widths[0]!));
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
    const labelEnds = (h: number, size: number, i: number) => {
      // Panels' labels differ only by their paints' font and box.
      const paint = tickPaint("x", i);
      const key = `${h} ${size} ${paint.css} ${paint.background && paint.padding}`;
      if (!ends.has(key)) {
        const { scale, ticks, labels } = sizedPlan(h, size);
        const last = ticks.length - 1;
        // Labels are centered on their ticks, with their boxes.
        const half = (index: number) => textWidth(labels[index]!, paint, measure) / 2;
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
        const end = labelEnds(h, widths[column]!, i);
        if (!end) continue;
        labeled = true;
        const [firstStart, lastEnd] = end;
        if (column > 0) spillLeft = Math.max(spillLeft, left - firstStart);
        else overflowLeft = Math.max(overflowLeft, head.left + (head.auto ? 2 : 0) - firstStart);
        if (column < columns - 1)
          spillRight = Math.max(spillRight, lastEnd - (left + widths[column]!));
        else
          overflowRight = Math.max(
            overflowRight,
            lastEnd + offsets[column]! - (width - head.right - (head.auto ? 2 : 0)),
          );
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
    /**
     * How panel `i`'s axis of scale `axis` is drawn: its line and ticks (x
     * axes'; y axes draw neither), labels, and title (when it has one), as
     * styles say; what is not drawn takes the theme's.
     */
    const axisPaints = (axis: ScaleName, i: number, titled: boolean): AxisPlacement["paints"] => {
      const own = axis === "x";
      return {
        line: own ? styles.axisStroke("axisLine", axis, i) : theme.style.axisLine,
        tick: own ? styles.axisStroke("tick", axis, i) : theme.style.tick,
        label: tickPaint(axis, i),
        title: titled ? styles.axisText("axisTitle", axis, i) : theme.style.axisTitle,
      };
    };
    // A y axis along one side of a plot, its title outside the labels,
    // centered on the grid, or on the plot for a subplot's own title.
    const yAxis = (
      side: "left" | "right",
      i: number,
      plot: Rect,
      plan: AxisPlan,
      labels: string[],
      title: string | undefined,
      titleX: number,
    ): AxisGuide => {
      const scale = side === "left" ? "y" : "yRight";
      const placement: AxisPlacement = {
        side,
        edge: side === "left" ? plot.x : plot.x + plot.width,
        start: plot.y + plot.height,
        end: plot.y,
        tickLength: 0,
        gap: 8,
        surface: theme.background,
        paints: axisPaints(scale, i, !!title),
      };
      const ticks = labels.map((label, k) => ({ position: plan.scale.map(plan.ticks[k]!), label }));
      // Along the grid, or a subplot's plot, from its bottom on the left (the
      // title reads upward) and its top on the right.
      const [low, high] = config.panels ? [plot.y + plot.height, plot.y] : [top + gridHeight, top];
      const [from, to] = side === "left" ? [low, high] : [high, low];
      const along = aligned(placement.paints.title.align ?? "center", from, to - from);
      const titled = title
        ? { text: title, x: titleX, y: along.at, anchor: along.anchor }
        : undefined;
      return axisGuide(`${scale}|${i}`, scale, placement, ticks, titled, measure);
    };

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
    const formatOf = (i: number, side = leftY): Formatter => {
      const g = side.groupOf[i]!;
      const key = `${side.axis} ${g} ${rowHeights[rowOf(i)]}`;
      let format = formats.get(key);
      if (!format) {
        const { scale } = side.plans[i]!;
        const context = side.contexts[g]!;
        format = context.type === "band" ? categoryOf(scale) : valueFormat(context, scale);
        formats.set(key, format);
      }
      return format;
    };
    const rightSet = new Set(onSide(marks, true).map(({ mark }) => mark));

    // Each x scale's title goes once, under the last panel labeled with it:
    // centered under the grid when every panel shares x, else under its
    // panel's column, or for a row's scale under all the row's panels.
    const xTitleOf = (h: number, i: number, plot: Rect): AxisGuide["title"] => {
      const text = xContexts[h]!.spec?.title;
      if (!text || titleAt[h] !== i) return undefined;
      const rowEnd = Math.min(panelCount, (rowOf(i) + 1) * columns) - 1;
      const end = left + offsets[rowEnd % columns]! + widths[rowEnd % columns]!;
      const [from, to] = xGroups
        ? xScope === "row"
          ? [left, end]
          : [plot.x, plot.x + plot.width]
        : [left, left + gridWidth];
      const along = aligned(
        styles.axisText("axisTitle", "x", i).align ?? "center",
        from,
        to - from,
      );
      return {
        text,
        x: along.at,
        anchor: along.anchor,
        y:
          rowOf(i) === rows - 1
            ? height - head.lift - strip - xTitleHeight / 2 - (head.auto ? 2 : 0)
            : plot.y + plot.height + xLabels + xLabelHeight + xTitleHeight / 2 + GAP,
      };
    };

    this.#used.clear();
    const scene = ++this.#scenes;
    const keyed = keyedBy(config);
    // A copy for the frames and inspectors this scene keeps: what they find
    // before the next scene is what was drawn, whatever has been hidden since.
    const hidden = this.hidden.snapshot();
    // Highlight frames change their hidden keys; group placement keeps this scene's original ones.
    const groupSeries: NonNullable<Frame["groupSeries"]> = [base, hidden];
    const views: PanelView[] = [];
    const headers: HeaderGuide[] = [];
    const all: (ItemPanel & { items: boolean })[] = [];
    const draw = this.highlight ?? geometryOf;
    const panels = split.keys.map((key, i): Panel => {
      const row = Math.floor(i / columns);
      const column = i % columns;
      const h = xGroupAt[i]!;
      const xAt = xPlanOf(h, column);
      const yAt = leftY.plans[i]!;
      const x = xAt.scale;
      const plot: Rect = {
        x: left + offsets[column]!,
        y: plotTop + rowOffset(row),
        width: widths[column]!,
        height: rowHeights[row]!,
      };
      const values = split.values[i]!;
      const label = values.join(", ");
      if (layout) {
        const paint = styles.panelTitle(i);
        // Headers in boxes fit their text in the room inside the box.
        const [, right, , left] = paint.background ? paint.padding : [0, 0, 0, 0];
        const fit = (text: string, room: number) =>
          fitText(text, room - left - right, measure, paint.css);
        // A grid's row headers go beyond the right axis' labels.
        const placed = layout.headers(
          i,
          values,
          row,
          column,
          plot,
          grid,
          fit,
          rightRoom,
          paint.align,
        );
        for (const { text, x, y, anchor, angle } of placed)
          headers.push({
            kind: "header",
            key: `header|${key}|${headers.length}`,
            text,
            x,
            y,
            anchor,
            angle,
            items: [
              textItem(
                text,
                { x, y, anchor, baseline: "middle", angle },
                paint,
                theme.background,
                measure,
              ),
            ],
          });
      }
      const item = items?.[i];
      all.push({ key, label, plot, items: !!item });
      // A layout mark draws its rows in the panel, which has no axes.
      if (item) {
        this.#items ??= new item.mark.views(this);
        this.#items.fields = this.fields?.(locale, zone, numberFormatter(locale));
        // Its room is its plot: drawn on the plot's paint, its halos on the plot's fill.
        const paint = styles.plot(i);
        const frame = {
          theme,
          locale,
          measure,
          hidden,
          color: this.#palette,
          surface: paint?.fill,
        };
        const drawn = this.#items.panel({ key, label, plot }, item, frame);
        return paint ? { ...drawn, frame: paint } : drawn;
      }
      const axes: AxisGuide[] = [];
      if (labelsX(i)) {
        const title = xTitleOf(h, i, plot);
        const paints = axisPaints("x", i, !!title);
        const placement: AxisPlacement = {
          side: "bottom",
          edge: plot.y + plot.height,
          start: plot.x,
          end: plot.x + plot.width,
          tickLength: TICK,
          gap: xGap(paints.label),
          surface: theme.background,
          paints,
        };
        const ticks = xHas[h]
          ? xAt.ticks.map((t, k) => ({ position: x.map(t), label: xAt.labels[k]! }))
          : [];
        axes.push(axisGuide(`x|${i}`, "x", placement, ticks, title, measure));
      }
      const rightAt = rightIn[i] ? rightY!.plans[i] : undefined;
      // The y axes: a subplot's title as far out from its plot as the first
      // column's (on the right, the last one's), other charts' once.
      for (const right of [false, true]) {
        const labels = right ? rightLabels : leftLabels;
        if (!labels.labeled[i]) continue;
        const title =
          config.panels || i === labels.first
            ? panelAxis(i, right ? "yRight" : "y")?.title
            : undefined;
        const out = config.panels
          ? right
            ? left + gridWidth - plot.x - plot.width
            : plot.x - left
          : 0;
        const edge = labels.titleHeight / 2 + (head.auto ? 2 : 0);
        const titleX = right ? width - head.right - edge - out : head.left + edge + out;
        const plan = right ? rightAt! : yAt;
        axes.push(
          yAxis(right ? "right" : "left", i, plot, plan, labels.labelsOf(i), title, titleX),
        );
      }
      // Horizontal grid lines follow the left axis, or the right one where
      // the left is unused, as a subplot's own settings say.
      const gridAt = leftIn[i]
        ? !leftY.banded(i) && (panelAxis(i)?.grid ?? true) && yAt
        : rightAt && (panelAxis(i, "yRight")?.grid ?? true) && rightAt;

      const plotPaint = styles.plot(i);
      const frame: Frame = {
        x,
        y: yAt.scale,
        plot,
        pixelRatio: this.pixelRatio,
        rasterRatio: this.rasterRatio,
        theme,
        surface: plotPaint?.fill,
        locale,
        hidden,
        groupSeries,
        owner: this,
        scene,
        clouds,
        measure,
        keyed,
        ...this.#pools(i),
      };
      // Marks on the right axis draw with its scale.
      const rightFrame: Frame | undefined = rightAt && { ...frame, y: rightAt.scale };
      const frameOf = (mark: Mark) => {
        const own = (sideOf(mark) === "right" && rightFrame) || frame;
        // GPU clouds are drawn over the plot only: marks it does not cut place points on the CPU.
        const { clip } = mark.spec;
        return clip !== undefined && clip !== "plot" && own.clouds
          ? { ...own, clouds: false }
          : own;
      };
      // Marks keep their index in the chart as their identity in every panel.
      const members = split.members?.[i];
      const panelMarks = split.panels[i]!;
      const geometry = panelMarks.flatMap(({ mark, series, rows }, index) =>
        members && !members[index]
          ? []
          : clipped(
              mark,
              draw(mark, series, frameOf(mark), mark.spec.id ?? this.#positions[index]!, rows),
            ),
      );
      if (seams) {
        const segments = xContexts[h]!.breaks?.seams?.(x, plot, seams, theme.grid);
        if (segments) geometry.unshift(segments);
      }
      const inspected = panelMarks.flatMap((entry, index) =>
        members && !members[index] ? [] : [{ ...entry, index: this.#positions[index]! }],
      );
      const inspector = new Inspector({
        marks: inspected,
        frame,
        right: rightFrame && { marks: rightSet, frame: rightFrame, formatY: formatOf(i, rightY) },
        mode: members ? modeOf(inspected.filter(({ series }) => series.length > 0)) : mode,
        hidden,
        formatX: formatXOf(h, column),
        formatY: formatOf(i),
        formatValue: formatNumbers,
        fields: this.fields?.(
          locale,
          zone,
          formatNumbers,
          xContexts[h]!.type === "time" ? formatXOf(h, column) : undefined,
        ),
      });
      views.push({
        key,
        label,
        plot,
        xGroup: xKeys[h]!,
        yGroup: groupKey(leftY, i),
        yRightGroup: rightAt ? groupKey(rightY!, i) : "",
        inspector,
        plans: { x: xAt, y: yAt, yRight: rightAt, grid: gridAt },
      });
      return {
        key,
        plot,
        frame: plotPaint,
        grid: {
          x: xGrid(i) ? xAt.ticks.map((t) => x.map(t)) : [],
          y: hasData && gridAt ? gridAt.ticks.map((t) => gridAt.scale.map(t)) : [],
          // Only lines drawn read their styles.
          xPaint: xGrid(i) ? styles.axisStroke("grid", "x", i) : undefined,
          yPaint:
            hasData && gridAt
              ? styles.axisStroke("grid", leftIn[i] ? "y" : "yRight", i)
              : undefined,
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
    this.#all = all;
    this.#namesPanels = layout !== undefined;
    this.#drawn = marks;
    this.#base = base;
    // Legends inside plots go over the content panels, not the navigator's strip.
    const inside = this.#inside(head, panels);
    if (strip) panels.push(navigator!.panel(this, views, planX, xContexts[0]!, strip, head.lift));

    let vertices = 0;
    for (const panel of panels) for (const item of panel.marks) vertices += item.draw.size(item);

    return {
      width,
      height,
      pixelRatio: this.pixelRatio,
      theme,
      panels,
      guides: [...headers, ...head.guides, ...inside],
      vertices,
    };
  }

  /**
   * The chart's furniture: its title and legends on their sides (inside a
   * plot, the legend to place once panels are), and the room they and the
   * padding keep from the panels. `yLabels` says whether y labels may reach
   * above the plots, which explicit padding leaves room for, and `yOver`
   * how much further than text alone their boxes reach.
   */
  #furniture(
    entries: readonly LegendEntry[],
    parts: readonly LegendPart[],
    measure: MeasureText,
    yLabels: boolean,
    yOver = 0,
  ): Furniture {
    const config = this.#config;
    const { width, height } = this;
    this.#entries = entries;
    // Parts that start rows of their own (keys) follow the others (ramps),
    // in the legend and in the chart's description alike.
    this.#legendParts = [
      ...parts.filter((part) => !part.breaks),
      ...parts.filter((part) => part.breaks),
    ];
    const theme = this.#theme;
    const styles = this.#styles;
    const lineHeight = theme.style.text.lineHeight;
    // Explicit padding is whitespace outside everything; left out, the
    // spacing is automatic.
    const padding = config.padding === undefined ? undefined : insets(config.padding);
    const auto = padding === undefined;
    const [pt, pr, pb, pl] = padding ?? [0, 0, 0, 0];
    const guides: Guide[] = [];

    const title = titleText(config.title);
    const paint = styles.title();
    const titleSide = (typeof config.title === "object" && config.title.place?.side) || "top";
    // A title larger than two pixels over the text size takes the extra room,
    // and lines set further apart than usual theirs; lines after the first
    // ("\n" breaks them), a line height each; and a background, its box.
    const breaks = title ? title.split("\n").length - 1 : 0;
    const [boxTop, , boxBottom] = paint.background ? paint.padding : [0, 0, 0];
    const firstLine =
      lineHeight + Math.max(0, Math.round((paint.size - theme.fontSize - 2) * 1.25));
    const spread = paint.lineHeight - Math.round(paint.size * 1.25);
    const titleHeight =
      (paint.background ? Math.max(firstLine, paint.lineHeight) : firstLine + Math.max(0, spread)) +
      breaks * paint.lineHeight +
      boxTop +
      boxBottom;
    const legend = config.legend;
    const place: Place = (typeof legend === "object" && legend.place) || { side: "top" };
    const side = "side" in place ? place.side : undefined;
    if (side && place.scope === "panel")
      throw new Error(
        'chart legend.place.scope: a legend on a side goes beside the whole chart; drop scope, or place it inside a panel with "inside"',
      );
    const across = side === "top" || side === "bottom";
    // What the title and legend align in: the chart's width inside its edges.
    const [contentLeft, contentRight] = auto ? [EDGE, width - EDGE] : [pl, width - pr];
    const align = "align" in place ? place.align : undefined;
    const measured = measureLegends(
      {
        // Without an explicit setting, one series needs no legend.
        entries: (legend ?? entries.length > 1) ? entries : [],
        parts: this.#legendParts,
        hidden: this.hidden,
      },
      {
        measure,
        label: styles.legend("legendLabel"),
        title: styles.legend("legendTitle"),
        value: styles.legend("tickLabel"),
        lineHeight,
        locale: config.locale,
        surface: theme.background,
      },
      // Rows across the chart above or below the plots; a column beside or in them.
      { wrap: across ? contentRight - contentLeft : undefined, align: align ?? "start" },
    );
    const offset = ("offset" in place && place.offset) || 0;

    // The title and the legend stack along their sides, outermost first: on
    // top the title, then the legend; below, the title under the legend.
    const requests: TrackRequest[] = [];
    if (title) requests.push({ key: "title", side: titleSide, size: titleHeight, gap: 8 });
    if (measured && side)
      requests.push({
        key: "legend",
        side,
        size: across ? measured.height : measured.width,
        gap: (across || auto ? 8 : 16) + offset,
      });
    const bottomEdge = height - (auto ? 4 : pb);
    const stacked = stackTracks(requests, {
      top: auto ? (title && titleSide === "top" ? 6 : Math.ceil(theme.fontSize / 2) + 2) : pt,
      bottom: bottomEdge,
      left: contentLeft,
      right: contentRight,
    });
    const { tracks, edges } = stacked;
    const sides = new Set(requests.map((r) => r.side));
    let { top } = edges;
    // With explicit padding, y labels reaching above the plots get room of
    // their own; labels in boxes get the room their boxes reach further.
    if (!auto && !sides.has("top") && yLabels) top += Math.ceil(theme.fontSize / 2);
    if (yLabels) top += yOver;
    const floor = edges.bottom;
    const lift = floor < bottomEdge ? height - floor : auto ? 0 : pb;
    const left = sides.has("left") ? edges.left : auto ? 0 : pl;
    const right = sides.has("right") ? width - edges.right : auto ? 0 : pr;
    if (title) {
      // In the chart's width, at its start (the default), center, or end;
      // `y` is the middle of the title's room.
      const y = tracks.get("title")! + titleHeight / 2;
      const { at: x, anchor } = aligned(
        paint.align ?? "start",
        contentLeft,
        contentRight - contentLeft,
      );
      guides.push({
        kind: "title",
        key: "title",
        text: title,
        x,
        y,
        items: textItems(
          title,
          { x, y: y - (breaks * paint.lineHeight) / 2, anchor, baseline: "middle", angle: 0 },
          paint,
          theme.background,
          measure,
        ),
      });
    }
    if (measured && side) {
      const at = tracks.get("legend")!;
      // Automatic spacing centers a top legend's first row on its track's
      // edge, as it always has; side legends stand at the top of the plots' room.
      guides.push(
        ...(across
          ? measured.place(
              alignedAt(align, contentLeft, contentRight - contentLeft, measured.width),
              side === "top" && auto ? at - lineHeight / 2 : at,
            )
          : measured.place(at, alignedAt(align, top, floor - top, measured.height))),
      );
    }
    const inside =
      measured && !side
        ? (box: Rect, surface?: string) => {
            const { x, y } = insideAt(
              (place as InsidePlace).inside,
              box,
              measured.width,
              measured.height,
              (place as InsidePlace).inset ?? 8,
            );
            return measured.place(x, y, surface);
          }
        : undefined;
    return {
      guides,
      inside,
      insidePlace: inside && (place as InsidePlace),
      auto,
      top,
      lift,
      left,
      right,
      box: {
        x: auto ? EDGE + left : left,
        y: top,
        width: Math.max(0, width - (auto ? 2 * EDGE : 0) - left - right),
        height: Math.max(0, height - top - (auto ? EDGE : 0) - lift),
      },
    };
  }

  /**
   * The legend placed inside a plot, once the panels are: the plot of the
   * panel its place names (the first by default), or with `scope: "chart"`,
   * the area every panel's plot spans.
   */
  #inside(head: Furniture, panels: readonly Panel[]): Guide[] {
    const { inside, insidePlace } = head;
    if (!inside || !insidePlace || panels.length === 0) return [];
    const plots = panels.map(({ plot }) => plot);
    if (insidePlace.scope === "chart") {
      const x = Math.min(...plots.map((p) => p.x));
      const y = Math.min(...plots.map((p) => p.y));
      const right = Math.max(...plots.map((p) => p.x + p.width));
      const bottom = Math.max(...plots.map((p) => p.y + p.height));
      return inside({ x, y, width: right - x, height: bottom - y });
    }
    const name = insidePlace.panel;
    const panel = name === undefined ? panels[0] : panels.find(({ key }) => key === name);
    if (!panel)
      throw new RangeError(
        `chart legend.place.panel: no panel "${name}"; name one of ${panels.map(({ key }) => `"${key}"`).join(", ")}`,
      );
    return inside(panel.plot, panel.frame?.fill);
  }

  /** A chart of one layout mark: the header, and the mark in the room below it. */
  #layoutScene(measure: MeasureText, clouds: boolean): Scene {
    const theme = this.#theme;
    const { locale, marks } = this.#config;
    const mark = this.#layouts[0]!;
    const parts = mark.legends?.(theme, locale) ?? [];
    const header = this.#furniture(
      mark.legend(mark.spec.id ?? 0, this.#palette, theme),
      parts,
      measure,
      false,
    );
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
    const items = this.items!;
    items.fields = this.fields?.(locale, this.#config.timeZone ?? "local", numberFormatter(locale));
    const paint = this.#styles.plot(0);
    const scene = items.scene(header, mark, marks, {
      theme,
      surface: paint?.fill,
      locale,
      measure,
      // A copy, which items found before the next scene still read.
      hidden: new Set(this.hidden),
      color: this.#palette,
      clouds,
      keyed: keyedBy(this.#config),
    });
    this.#all = this.#items!.panels;
    // The mark's room is its plot, drawn on the plot's paint.
    if (paint) scene.panels = scene.panels.map((panel) => ({ ...panel, frame: paint }));
    return scene;
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
      const panels = views.map(
        ({ key, label, plot, xGroup, yGroup, yRightGroup, inspector, plans }) => ({
          key,
          label,
          plot,
          x: inspector.frame.x,
          xGroup,
          y: inspector.frame.y,
          yGroup,
          yRight: inspector.rightFrame?.y,
          yRightGroup,
          plans,
        }),
      );
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
    return view.inspector.marks.flatMap(({ mark, visible: series }) =>
      series.filter((s) => {
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

  /**
   * Sentences describing marks without series (annotations), as of the last
   * scene: with facets or panels, as `PanelLayout.annotations` says (of what
   * `panel` alone draws, when given); in a chart of one panel, every one's.
   */
  annotationSummaries(panel?: string): string[] {
    const describe = (mark: Mark, view?: string, rows?: RowParts) =>
      mark.describe?.(this.formatsOf(mark, view), this.#config.locale, rows) ?? [];
    return (
      this.#panels?.annotations(this.#views, this.#marks, describe, panel) ??
      this.#marks.flatMap((mark) => describe(mark))
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
    const view =
      panel === undefined ? this.#viewAt(px, py) : this.#views.find(({ key }) => key === panel);
    return (
      this.#items?.inspect(px, py, panel) ??
      (view && this.#inPanel(view, view.inspector.inspect(px, py, mode)))
    );
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

  /** Layout items and their state, available before the first scene so controls can start loading. */
  get items(): ItemViews | undefined {
    this.#items ??= this.#layouts[0] && new this.#layouts[0].views(this);
    return this.#items;
  }

  /**
   * Whether the last scene was one layout mark's, without facets or panels,
   * whose items the pointer and every arrow key visit.
   */
  get layout(): boolean {
    return this.#items?.alone === true;
  }

  /**
   * Every panel of the last scene, in order: those with marks along axes,
   * which `panels` describes, and those a layout mark drew in (`items`).
   */
  allPanels(): readonly (ItemPanel & { items: boolean })[] {
    return this.#all;
  }

  /** An item a layout mark drew in the last scene, by key, in `panel` (the first by default). */
  inspectItem(key: string, panel?: string): Inspection | undefined {
    return this.#items?.inspectItem(key, panel);
  }

  /**
   * In `panel` (the first drawn by a layout mark by default), the key of the
   * item `step` items after the one keyed `key` (before, for negative
   * steps), stopping at the ends. Without a current item, steps count from
   * before the first item, or after the last for negative ones.
   */
  stepItem(key: string | undefined, step: number, panel?: string): string | undefined {
    return this.#items?.stepItem(key, step, panel);
  }

  /**
   * Sentences for what the last scene's legends of color scales and of
   * sizes and shapes show, which are drawn and so hidden from assistive
   * technology.
   */
  legendSummaries(): string[] {
    return this.#legendParts.map((part) => part.describe(this.#config.locale));
  }

  /**
   * Sentences describing what layout marks drew in the last scene: in
   * `panel`, or in the chart's one panel, or each panel's after its name,
   * up to `max` panels.
   */
  layoutSummary(panel?: string, max?: number): string | undefined {
    return this.#items?.summary(panel, max);
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
    this.#items = undefined;
    this.#all = [];
    // Joined layout marks (a 3D chart's box) keep their geometry buffers.
    this.#layouts = [];
  }
}

/** The chart's furniture as `#furniture` places it, and the room it keeps from the panels. */
interface Furniture {
  /** The title and legends placed on the chart's sides. */
  guides: Guide[];
  /** The legend inside a plot, placed in a box (drawn on `surface`) once the panels are, and where. */
  inside: ((box: Rect, surface?: string) => Guide[]) | undefined;
  insidePlace: InsidePlace | undefined;
  /** Whether the spacing is automatic, the chart having no padding of its own. */
  auto: boolean;
  /** Where the panels start below what is above them. */
  top: number;
  /** The room under the plots' axes: the bottom's padding, legend, and title. */
  lift: number;
  /** The room beside the plots' axes on each side: padding and a legend. */
  left: number;
  right: number;
  /** The room left for a chart of one layout mark, which has no axes. */
  box: Rect;
}

/** Where a chart without facets draws: one panel, without headers. */
const ONE_PANEL: PanelGrid = { columns: 1, rows: 1, header: 0, columnHeader: 0, rowHeader: 0 };

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
 * Rejects configurations whose mark identities would collide or cannot be
 * laid out; returns the marks along axes, the layout marks, and each mark
 * along axes' index among the chart's marks.
 */
function validate(config: ChartConfig): [Mark[], LayoutMark[], number[]] {
  const marks: Mark[] = [];
  const positions: number[] = [];
  let layouts: LayoutMark[] = [];
  const ids = new Set<string>();
  config.marks.forEach((mark, index) => {
    const id = mark.spec.id;
    if (id !== undefined && ids.has(id)) throw new Error(`id: "${id}" names two marks`);
    if (id !== undefined) ids.add(id);
    if (isLayoutMark(mark)) layouts.push(mark);
    else {
      marks.push(mark as Mark);
      positions.push(index);
    }
  });
  for (const mark of marks) {
    // The right axis measures values; marks placed along y belong on the left.
    if (sideOf(mark) === "right" && (mark.tooltip === "y" || mark.tooltip === "cell"))
      throw new Error(`${mark.spec.type} axis: marks along y cannot use the right axis`);
    // Facet panels come from whole tables; a view's rows would split by them wrongly.
    if (config.facet && mark.view && mark.spec.facet !== "repeat")
      throw new Error(
        `${mark.spec.type} facet: a row view cannot split into facets yet; give it facet: "repeat"`,
      );
    const group = mark.spec.legendGroup;
    if (group !== undefined && !(typeof group === "string" && group !== ""))
      throw new TypeError(
        `${mark.spec.type} legendGroup: expected a name; received ${JSON.stringify(group)}`,
      );
  }
  if (config.facet && config.panels) throw new Error("chart: facet or panels, not both");
  const duration = typeof config.animation === "object" ? config.animation.duration : undefined;
  if (duration !== undefined && !(Number.isFinite(duration) && duration >= 0))
    throw new RangeError(`chart animation.duration: expected 0 or more ms; received ${duration}`);
  if (!config.panels) {
    const named = config.marks.find((mark) => mark.spec.panel !== undefined);
    if (named) throw new Error(`${named.spec.type} panel: the chart has no panels; drop it`);
  }
  // Facets and panels check their marks, layout marks too; without them,
  // layout marks have the chart to themselves.
  const panelled = config.facet ?? config.panels;
  if (panelled) layouts = panelled.check(marks, config, layouts);
  else if (layouts[0]) layouts = layouts[0].views.alone(layouts, marks, config);
  config.navigator?.check(marks, config);
  config.rowSelection?.check(config, marks, layouts);
  return [marks, layouts, positions];
}

/** A mark's part of a panel's scene, as it draws it. */
function geometryOf(
  mark: Mark,
  series: readonly Series[],
  frame: Frame,
  key: MarkKey,
  rows?: RowParts,
): Geometry[] {
  return mark.geometry(series, frame, key, rows);
}

/** A mark's geometry, cut as its `clip` says when it sets one. */
function clipped(mark: Mark, geometry: Geometry[]): Geometry[] {
  const clip = mark.spec.clip;
  return clip === undefined ? geometry : geometry.map((g) => ({ ...g, clip }));
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
