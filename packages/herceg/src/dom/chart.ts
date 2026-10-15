// Browser runtime: mounts a chart into an element, renders through the
// shared scheduler, keeps its state (views, selections, hidden series, sync),
// and emits events to the application. Pointer, wheel, and keyboard input,
// and what they draw over the chart, are the interaction controller's
// (interaction.ts), which loads after the first frame; until then the chart
// keeps the input that arrives (`#hold`).
//
// Layers, bottom to top: a canvas for dense marks (only when used), the SVG
// layer (grid and marks when not on canvas, rules, axes, title, pointer
// overlay), the HTML legend, a visually hidden description, and the tooltip.

import type { RowView } from "../data/row-view.ts";
import type { Table, TableChange } from "../data/table.ts";
import { checkFonts, type PageFonts, USE_FONTS } from "../fonts/prepared.ts";
import type { Fonts } from "../fonts/registry.ts";
import type { MeasureText } from "../layout/text.ts";
import { Polyline } from "../lod/polyline.ts";
import { monotonePolyline } from "../marks/curve.ts";
import { tablesOf, viewOf } from "../marks/layout-mark.ts";
import { keepsKey } from "../marks/mark.ts";
import { lowerPosition, placeAt, rowOf, samePositions, xAt } from "../marks/series.ts";
import type { DrillRoot } from "../marks/tree-data.ts";
import { planAxis } from "../model/axis.ts";
import { axisGuide } from "../model/axis-guide.ts";
import { chartDescription, describeChart } from "../model/describe.ts";
import type { FeatureCompiler } from "../model/features.ts";
import { GUIDE_KIT, type GuideCompiler } from "../model/guides.ts";
import {
  type ChartConfig,
  ChartModel,
  type DrawnPanel,
  type Inspection,
  type Viewport,
} from "../model/model.ts";
import type { NavigatorControls } from "../model/navigator.ts";
import type { RowLink, RowSelectionChange } from "../model/row-selection.ts";
import type { SelectionOwner } from "../model/selected-rows.ts";
import { styleSources } from "../model/styles.ts";
import { titleText } from "../model/titles.ts";
import { canvasRasterUrl, paintCanvas } from "../render/canvas.ts";
import { EXPORT_FONTS, EXPORT_SCENE, type ExportsScene } from "../render/export-scene.ts";
import { checkSizing, renderSvg, type SvgSizing } from "../render/svg.ts";
import type { PositionScale } from "../scale/scale.ts";
import {
  type CloudPainter,
  type FaceGeometry,
  guidesOf,
  type PointGeometry,
  type Scene,
  tickLabelGap,
} from "../scene/scene.ts";
import { type ChartError, type ChartErrorPhase, chartError } from "../spec/errors.ts";
import type { CameraSpec } from "../spec/spec.ts";
import { surface, themeReadsPage } from "../theme.ts";
import type { Camera } from "../three/camera.ts";
import type { AdoptedChart } from "./adopt.ts";
import type { Brush } from "./brush.ts";
import { ascending, DRAG_THRESHOLD, normalize, type Selection } from "./brushed.ts";
import { showFailure } from "./errors.ts";
import {
  type ChartEvents,
  type ChartListener,
  Emitter,
  type PanelTarget,
  type ViewCause,
} from "./events.ts";
import {
  type AxisTarget,
  type Chart,
  type CursorOptions,
  type CursorPosition,
  type InspectOptions,
  type ItemPositions,
  type LegendEntry,
  type PanelInfo,
  panelInfo,
} from "./handle.ts";
import type { Interaction, InteractionHost, InteractionKit, ShownCursor } from "./interaction.ts";
import { Legend } from "./legend.ts";
import { measurer, onFacesLoaded } from "./measurers.ts";
import { readPage, watchPage } from "./page-theme.ts";
import { observeVisibility, report, schedule, unschedule } from "./scheduler.ts";
import { SvgLayer, svgElement } from "./svg-layer.ts";
import {
  broadcast,
  type Channel,
  type ChannelOf,
  channelsOf,
  join,
  type SyncMember,
} from "./sync.ts";
import type { RenderTooltip } from "./tooltip.ts";
import type { ViewAnimation } from "./transition.ts";
import type { ValueAnimation } from "./value-transition.ts";

export type { Chart };

export interface ChartOptions extends ChartConfig {
  /** Fixed size in CSS pixels; omitted dimensions follow the container. */
  width?: number;
  height?: number;
  /**
   * The tooltip's content, of your own (JavaScript only): text, or a node
   * to show in the built-in box, which keeps its placement, the crosshair
   * and highlighted points, and the keyboard's announcements (which read
   * the inspection as the built-in content writes it, fields and all);
   * null or undefined for the built-in content. Called when what the
   * tooltip is at changes.
   */
  renderTooltip?: RenderTooltip | undefined;
  /**
   * How the chart shows what keeps it from drawing (a `ChartError`):
   * "inline" (the default) draws it in the chart's place, a box of the
   * chart's size, or over the last frame where that is still right (an
   * update it refused), a banner, and neither making the chart nor
   * `update` throws for its options; "throw" draws nothing for it, and
   * making the chart and `update` throw what they refuse. `onError` and
   * "error" listeners hear of what is not thrown (with "throw", what fails
   * later: a frame of new data, code that loads), and `ready` rejects with
   * a first frame's.
   */
  errorMode?: "inline" | "throw" | undefined;
  /** Called with what keeps the chart from drawing, as "error" listeners are. */
  onError?: ((error: ChartError) => void) | undefined;
}

/**
 * Changes for `update`. Each option given replaces the chart's (nested
 * ones, such as an axis or `interaction`, whole), one given as `undefined`
 * goes back to its default, and options left out keep their values.
 */
export type ChartUpdate = {
  [K in keyof ChartOptions]?: K extends "marks" ? ChartOptions[K] : ChartOptions[K] | undefined;
};

/** A range of values. */
type Range = readonly [number, number];

/**
 * A selection as sync channels carry it: its range along the channel's
 * scale, across it (for "xy"), and a lasso, with categories by name.
 */
type SharedSelection = [
  along: Range | readonly string[] | null,
  across: Range | readonly string[] | null,
  lasso: Selection["lasso"],
];

/** Above this many drawn points, "auto" moves marks from SVG to Canvas. */
const CANVAS_ABOVE = 4000;
/** Below this many, "auto" moves them back (hysteresis avoids flapping). */
const SVG_BELOW = 2000;
const DEFAULT_HEIGHT = 320;

let nextId = 0;

/**
 * The guide compiler and the feature compiler (model/guides.ts,
 * model/features.ts), once a chart on the page has loaded them, and their
 * imports: code a configuration may need before it draws.
 */
const compilers: [GuideCompiler?, FeatureCompiler?] = [];
const imports: (Promise<unknown> | undefined)[] = [];
const COMPILERS = [
  () => import("../guides/compile.ts").then((module) => module.guideCompiler(GUIDE_KIT)),
  () =>
    import("../marks/features/compile.ts").then((module) =>
      // The browser tells colors from fields' names (see FeatureKit).
      module.featureCompiler({ ...GUIDE_KIT, isColor: (value) => CSS.supports("color", value) }),
    ),
];

/**
 * The interaction controller's module, once a chart on the page has loaded
 * it, and its import: charts mounted after that attach theirs at once.
 */
let controllers: typeof import("./interaction.ts") | undefined;
let controllersLoading: Promise<typeof import("./interaction.ts")> | undefined;
let importControllers = () => import("./interaction.ts");

function loadControllers(): Promise<typeof import("./interaction.ts")> {
  controllersLoading ??= importControllers().then(
    (module) => (controllers = module),
    (error: unknown) => {
      // A later chart imports again (browsers that keep a failed module's
      // result reject it until the page reloads).
      controllersLoading = undefined;
      throw error;
    },
  );
  return controllersLoading;
}

/** Keys the keyboard cursor and selections answer to. */
const NAVIGATION_KEYS = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "Escape",
  "Enter",
];

/** What the controller shares with charts (see `InteractionKit`). */
const KIT: InteractionKit = {
  svgElement,
  placeAt,
  rowOf,
  lowerPosition,
  xAt,
  samePositions,
  surface,
  tickLabelGap,
  keys: NAVIGATION_KEYS,
  dragThreshold: DRAG_THRESHOLD,
};

/** Input the chart keeps for its controller until it is attached. */
const HELD = [
  "pointermove",
  "pointerleave",
  "pointerdown",
  "pointerup",
  "pointercancel",
  "lostpointercapture",
  "wheel",
  "dblclick",
  "keydown",
  "blur",
  "dragstart",
] as const;

/**
 * Loads the interaction controller, after which charts mounted take input
 * from the start: for this package's tests, whose charts take events as
 * soon as they are made.
 */
export function loadInteraction(): Promise<void> {
  return loadControllers().then(() => {});
}

/**
 * Forgets the loaded controller, so that the next chart loads it as the
 * first on a page does, with `load` (the module's import by default): for
 * this package's tests of input that arrives before it.
 */
export function forgetInteraction(
  load: () => Promise<typeof import("./interaction.ts")> = () => import("./interaction.ts"),
): void {
  controllers = undefined;
  controllersLoading = undefined;
  importControllers = load;
}

/** Most pointer moves kept of a press held for the controller: of a longer path, the last. */
const HELD_MOVES = 256;

/**
 * What a scene leaves to the GPU painter: large point series ("points"), a
 * large 3D chart ("3d", which needs the 3D painter), or nothing.
 */
function cloudsIn(scene: Scene): "points" | "3d" | undefined {
  let found: "points" | undefined;
  for (const panel of scene.panels)
    for (const mark of panel.marks) {
      if (mark.kind === "faces" && (mark as unknown as FaceGeometry).batches) return "3d";
      if (mark.kind === "point" && (mark as unknown as PointGeometry).cloud) found = "points";
    }
  return found;
}

const HIDDEN_TEXT =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";

/** The chart behind a `Chart` handle: what `createChart` mounts. */
export class MountedChart implements Chart, ExportsScene {
  readonly root: HTMLDivElement;
  readonly ready: Promise<void>;
  readonly #model: ChartModel;
  #options: ChartOptions;
  readonly #container: HTMLElement;
  /**
   * Container size, measured when the resize observer reports a change (when
   * layout is already current) and on explicit renders, so scheduled frames
   * need not read layout after the previous frame's DOM writes.
   */
  #containerSize: { width: number; height: number } | undefined;
  readonly #id: string;
  /**
   * How a hydrated chart's server markup measured its text, which the chart
   * measures with until its options or size change, so that it lays out as
   * the markup did.
   */
  #snapshotMeasure: MeasureText | undefined;
  /** A hydrated chart keeps its server markup on screen until it paints a frame in full. */
  #hydrating: boolean;
  readonly #svg: SvgLayer;
  readonly #legend: Legend;
  readonly #description: HTMLDivElement;
  readonly #live: HTMLDivElement;
  /** Pointer, wheel, and keyboard input, and the overlay they draw; once loaded. */
  #controller: Interaction | undefined;
  /** Its loading, pending from mount until it is attached; rejected if it cannot load. */
  #controllerLoading: Promise<void> | undefined;
  /** The import this chart attaches to, once started. */
  #attaching: Promise<void> | undefined;
  /** Input that arrived before the controller, in order (see `#hold`); null once it failed to load. */
  #held: Event[] | null = [];
  #canvas: HTMLCanvasElement | null = null;
  #onCanvas = false;
  /** GPU painter for large point series once loaded; null when unavailable. */
  #clouds: CloudPainter | null | undefined;
  /** Whether `#clouds` draws 3D charts' clouds too (render/webgl3d.ts loaded). */
  #clouds3d = false;
  #cloudsLoading: Promise<void> | undefined;
  /** The compilers' loading while the configuration waits for them. */
  #compiling: Promise<void> | undefined;
  /** Why the compilers did not load or take the configuration, until an update tries again. */
  #compileFailure: ChartError | undefined;
  /** The fonts measured with, as the page uses them, how, and their faces' loading while pending. */
  #fonts: Fonts | undefined;
  #page: PageFonts | undefined;
  #fontsMeasure: MeasureText | undefined;
  #fontsLoading: Promise<void> | undefined;
  #scene: Scene | undefined;
  /** Moves the axes to views asked for, once loaded for `animation`; null if it failed to load. */
  #animation: ViewAnimation | null | undefined;
  #animationLoading: Promise<void> | undefined;
  /** Moves marks and axes to changed values, once loaded for `animation.values`; null if it failed to load. */
  #values: ValueAnimation | null | undefined;
  #valuesLoading: Promise<void> | undefined;
  /** How long the last frame took to plan and paint, in milliseconds. */
  #drawTime = 0;
  /**
   * The chart in the shared frame loop: it draws pending changes once a
   * frame while the chart is on screen.
   */
  readonly #scheduled = { flush: () => this.#flush(), visible: true };
  /**
   * How synced charts reach this one: what they share is shown here without
   * being shared again. Broadcasts name it as their sender.
   */
  readonly #member: SyncMember = {
    receive: (channel, value) => {
      const { scale } = this.#channels[channel]!;
      const model = this.#model;
      if (channel === "cursor") {
        this.#cursor = value === null ? null : { at: { [scale]: value } as CursorPosition };
        schedule(this.#scheduled);
        return;
      }
      // Panels with scales of their own share cursors only: a view or a
      // selection belongs to some of them.
      if (!(scale === "y" ? model.sharesY : model.sharesX)) return;
      if (channel === "selection") {
        this.#select(this.#decode(value as SharedSelection | null, scale));
        return;
      }
      this.#settle();
      const range = value as readonly [number, number] | null;
      this.#changeView(
        () =>
          scale === "y"
            ? model.setYViewport({ ...model.yViewport, y: range })
            : model.setViewport(range),
        false,
        "sync",
      );
    },
  };
  /** The channels the chart syncs on, from `interaction.sync`. */
  #channels: Partial<Record<Channel, ChannelOf>> = {};
  /** The cursor another chart shares, or `showCursor` shows: a value on x or y, and how it shows; null for none. */
  #cursor: ShownCursor | null = null;
  #dirty = true;
  /**
   * Changes since the last frame that may change the panels or how they
   * share scales (options, data, size, hidden series), unlike changes of view.
   */
  #panelsChanged = false;
  #destroyed = false;
  #describedAt = -Infinity;
  /** What the current summary was written from; zooming and hovering do not change it. */
  #described: { config: unknown; key: string } | undefined;
  #describeTimer: ReturnType<typeof setTimeout> | 0 = 0;
  /** The navigator's sliders, which load when the chart first has a navigator. */
  #navigator: NavigatorControls | undefined;
  /** What is selected, in data values; the brush draws it once loaded. */
  #selection: Selection | null = null;
  /** Drags and draws selections; loaded the first time a chart brushes or selects. */
  #brush: Brush | undefined;
  #brushLoading: Promise<void> | undefined;
  /** Where the brush draws, in the pointer overlay. */
  readonly #brushLayer: SVGGElement;
  /**
   * The panels the selection belongs to: the x scale they share ("" for
   * one every panel shares) and their keys; null without a selection.
   */
  #owner: SelectionOwner | null = null;
  /** Writes the rows gestures select to the stores `rowSelection` binds, and highlights theirs. */
  #rows: RowLink | undefined;
  readonly #events = new Emitter();
  /** What last changed the view or what bounds it, for `edge` events. */
  #cause: ViewCause = "options";
  /** Inside `#changeView`, whose end reports the change. */
  #changingView = false;
  /**
   * What viewport events reported for each x scale while a change of view
   * is being reported (see `#reporting`): a listener's own change, reported
   * inside the report of another, is not reported again by the outer one.
   */
  readonly #reported = new Map<string, Viewport>();
  #reportDepth = 0;
  readonly #cleanup: (() => void)[] = [];
  /** Subscriptions to the tables the marks read and the row views some show. */
  readonly #tables = new Map<Table | RowView, () => void>();
  #leaveSync: (() => void) | undefined;
  #unwatchPage: (() => void) | undefined;
  /** The page changed since its theme was last read; read again on the next frame. */
  #pageChanged = false;
  /** Settles `ready`: with the first frame drawn, or the failure of the first. */
  #settleReady: [() => void, (error: ChartError) => void] | undefined;
  /** A frame of the chart's options and data is on screen. */
  #drawn = false;
  /**
   * Why the chart draws nothing until an update: the model does not hold
   * the options, refused when the chart was made, or the controller refused them.
   */
  #refusal: ChartError | undefined;
  /** What the chart shows in place of a frame, or over the last one, while it cannot draw. */
  #failure: HTMLElement | undefined;
  /** Counts changes of options and data; a failure is reported once per count. */
  #revision = 0;
  #reportedFailure = -1;

  /**
   * Mounts a chart in `container`, or with `adopted`, takes over the element
   * and nodes of its server markup (see dom/adopt.ts), drawing again only
   * what differs.
   */
  constructor(container: HTMLElement, options: ChartOptions, adopted?: AdoptedChart) {
    const document = container.ownerDocument;
    this.#container = container;
    this.#options = options;
    this.ready = new Promise((resolve, reject) => {
      this.#settleReady = [resolve, reject];
    });
    // Rejected for listeners that ask; unread, it is no unhandled rejection.
    this.ready.catch(() => {});
    let refused: unknown;
    const model = (config: ChartOptions) =>
      readPage(container, (page) => new ChartModel(config, page, ...compilers));
    try {
      this.#model = model(options);
    } catch (error) {
      // Options refused show where the chart goes, which an update may fix.
      if (options.errorMode === "throw") throw chartError(error, "validate");
      refused = error;
      this.#model = model({ marks: [] });
    }
    this.#id = adopted?.id ?? `herceg-${++nextId}`;
    this.#snapshotMeasure = adopted?.measure;
    this.#containerSize = adopted?.size;
    this.#hydrating = !!adopted;

    this.root = adopted?.root ?? document.createElement("div");
    // An adopted root keeps the size it was drawn at until a frame draws (a
    // compiler it waits for may come later).
    if (!adopted) this.root.style.cssText = "position:relative;overflow:hidden;outline-offset:2px";
    this.root.tabIndex = 0;
    this.root.setAttribute("role", "figure");
    this.#svg = new SvgLayer(document, this.#id, adopted?.layer);
    this.#brushLayer = svgElement(document, "g");
    this.#svg.overlay.append(this.#brushLayer);
    this.#legend = new Legend(
      document,
      (keys) =>
        this.setVisibility(
          keys,
          [keys].flat().every((key) => this.#model.hidden.has(key)),
        ),
      adopted?.legend,
    );
    this.#description = adopted?.description ?? document.createElement("div");
    this.#description.id = `${this.#id}-description`;
    // Read only as the figure's description: shown as text too, it would be read twice.
    this.#description.hidden = true;
    this.#live = adopted?.live ?? document.createElement("div");
    this.#live.setAttribute("aria-live", "polite");
    // A new value is announced whole, not as the words that changed.
    this.#live.setAttribute("aria-atomic", "true");
    this.#live.style.cssText = HIDDEN_TEXT;
    this.root.setAttribute("aria-describedby", this.#description.id);
    // Adopted nodes stay where they are: moving them would lose focus.
    if (!adopted) {
      this.root.append(this.#svg.svg, this.#legend.element, this.#description, this.#live);
      container.append(this.root);
    }

    try {
      // When faces load in the page, any chart's, what was measured before
      // is measured again (a new measurer, so caches by measurer let go),
      // and the margins kept for it laid out afresh.
      this.#cleanup.push(
        onFacesLoaded(document, () => {
          const measure = this.#page?.measure;
          if (measure) this.#fontsMeasure = (text, font) => measure(text, font);
          this.#model.relayout();
          this.#invalidate();
        }),
      );
      this.#gate();
      try {
        this.#useFonts(options.fonts);
        this.#applyOptions();
        this.#loadCompilers();
      } catch (error) {
        refused ??= error;
      }
      if (refused !== undefined) {
        if (options.errorMode === "throw") throw chartError(refused, "validate");
        this.#refusal = chartError(refused, "validate");
        this.#fail(this.#refusal, "validate");
      }
      this.#cleanup.push(observeVisibility(this.root, (visible) => this.#setVisible(visible)));
      this.#cleanup.push(() => this.#leaveSync?.());
      if (typeof ResizeObserver !== "undefined") {
        // Observers report once on attach; only real size changes re-render.
        const observer = new ResizeObserver(() => {
          this.#remember();
          const { width, height } = this.#size();
          if (width === this.#model.width && height === this.#model.height) return;
          this.#snapshotMeasure = undefined;
          this.#settle();
          this.#invalidate();
        });
        observer.observe(container, { box: "border-box" });
        this.#cleanup.push(() => observer.disconnect());
      }
      // The first frame renders synchronously so the chart is never blank.
      this.#flush(true);
      // Its interaction follows: at once where a chart on the page loaded
      // it, else once that frame is on screen, or at the first input.
      if (controllers) {
        try {
          this.#attach(controllers);
        } catch (error) {
          this.#controllerLoading = Promise.reject(error);
          this.#controllerLoading.catch(() => {});
        }
      } else {
        const loading = new Promise<void>((resolve) => {
          if (document.visibilityState === "hidden") resolve();
          else requestAnimationFrame(() => setTimeout(resolve));
        })
          .then(() => this.#loadController())
          .then(() => {
            if (this.#controllerLoading === loading) this.#controllerLoading = undefined;
          });
        // `loading` reports a failure; unread, it is no unhandled rejection.
        loading.catch(() => {});
        this.#controllerLoading = loading;
      }
    } catch (error) {
      // Nothing returns a handle to the caller, so undo everything here.
      this.destroy();
      throw error;
    }
  }

  /**
   * The model a chart draws from: for this package's own tests, which read
   * state no public method reports. Applications use the `Chart` methods.
   */
  static modelOf(chart: Chart): ChartModel {
    return (chart as MountedChart).#model;
  }

  update(options: ChartUpdate): void {
    const next: Record<string, unknown> = { ...this.#options, ...options };
    for (const [key, value] of Object.entries(options)) if (value === undefined) delete next[key];
    const previous = this.#options;
    // The fonts last taken: the options kept may hold fonts refused when the chart was made.
    const fonts = this.#fonts;
    const y = this.#model.yViewport;
    // The x views by scale (named by its first panel), which limits that changed may move.
    const x = this.#xScales().map((first) => ({
      group: first?.xGroup ?? "",
      view: this.#model.viewportOf(first?.key),
      first,
    }));
    this.#revision++;
    try {
      // Bindings the controller refuses, fonts the page refuses, and options
      // the model refuses leave the chart as it was.
      this.#controller?.check(next as unknown as ChartOptions);
      this.#useFonts(next.fonts);
      this.#options = next as unknown as ChartOptions;
      readPage(this.#container, (page) => this.#model.update(this.#options, page));
    } catch (error) {
      this.#options = previous;
      this.#useFonts(fonts);
      if (next.errorMode === "throw") throw chartError(error, "validate");
      // The last frame stays right: it is of the options kept.
      if (this.#refusal) this.#refusal = chartError(error, "validate");
      this.#fail(error, "validate", this.#drawn && !(this.#refusal ?? this.#compileFailure));
      return;
    }
    this.#refusal = undefined;
    // A controller that refused the options, or failed to load, tries again with these.
    if (!this.#controller && this.#held === null) {
      this.#held = [];
      this.#attaching = undefined;
      const loading: Promise<void> = this.#loadController().then(() => {
        if (this.#controllerLoading === loading) this.#controllerLoading = undefined;
      });
      loading.catch(() => {});
      this.#controllerLoading = loading;
    }
    this.#snapshotMeasure = undefined;
    // The page was just read; a change it had is in the theme now.
    this.#pageChanged = false;
    this.#cause = "options";
    this.#settle();
    this.#applyOptions();
    this.#loadCompilers();
    this.#invalidate();
    // Hidden keys go with their marks' identities: their ids, or their
    // indexes, which other marks may take; what series stand for, while
    // some mark's series stand for values of its kind (its scope).
    const marks = this.#options.marks;
    const owners = new Set(marks.map((mark, i) => mark.spec.id ?? i));
    const scopes = this.#model.scopes();
    const kept = [...this.#model.hidden].filter((key) => keepsKey(key, owners, scopes));
    this.#hide(kept);
    // Panels given y scales of their own let go of the y viewport, and
    // limits that changed move views inside them. Which x scales there are
    // now is known once drawn; listeners drawing calls (hover, select) may
    // change the view, which this report then includes.
    // Scales the update gave panels of their own changed anyway (reported below).
    const model = this.#model;
    const movedX = x.some(
      ({ first, view }) => (first || model.sharesX) && model.viewportOf(first?.key) !== view,
    );
    if (this.#model.yViewport !== y || movedX) {
      this.#reporting(() => {
        this.#flush();
        const scales = this.#xScales();
        this.#reportViews(
          scales,
          scales.map((first) => ({
            ...y,
            x:
              x.find(({ group }) => group === (first?.xGroup ?? ""))?.view ??
              this.#model.viewportOf(first?.key),
          })),
        );
      });
      this.#shareView(movedX);
    }
  }

  setViewport(
    view: Partial<Viewport> | readonly [number, number] | null,
    target: PanelTarget = {},
  ): void {
    const { panel } = target;
    // Maps' and networks' planes keep views of their own; null resets them too.
    if (this.#plane()?.setView(view, panel, true)) return;
    this.#current(panel);
    const change: Partial<Viewport> = Array.isArray(view)
      ? { x: view as readonly [number, number] }
      : ((view as Partial<Viewport> | null) ?? { x: null, y: null, yRight: null });
    // Checked whole, so a change the chart refuses changes nothing.
    if (change.x && panel === undefined) this.#model.xGroupOf();
    this.#model.checkYViewport(change);
    this.#animated(() =>
      this.#changeView(() => {
        if (change.x !== undefined) this.#model.setViewport(change.x, panel);
        if (change.y !== undefined || change.yRight !== undefined) {
          const kept = this.#model.yViewport;
          this.#model.setYViewport({
            y: change.y === undefined ? kept.y : change.y,
            yRight: change.yRight === undefined ? kept.yRight : change.yRight,
          });
        }
      }, change.x !== undefined),
    );
  }

  getViewport(target: PanelTarget = {}): Viewport {
    const plane = this.#plane()?.view(target.panel, true);
    if (plane) return plane;
    this.#current(target.panel);
    return this.#viewOf(target.panel);
  }

  #viewOf(panel?: string): Viewport {
    const { y, yRight } = this.#model.yViewport;
    return { x: this.#model.viewportOf(panel), y, yRight };
  }

  /**
   * The current panel named `panel`; throws when there is none. Pending
   * changes other than changes of view may change the panels and how they
   * share x, so they are drawn first, unless the panel is drawn on the one
   * x scale the chart's options still say every panel shares. Without a
   * name, nothing.
   */
  #current(panel: string | undefined): DrawnPanel | undefined {
    if (panel === undefined) return undefined;
    const find = () => this.#model.panels().find(({ key }) => key === panel);
    if (this.#panelsChanged && !(this.#model.sharesX && find()?.xGroup === "")) this.#flush();
    this.#model.xGroupOf(panel);
    return find();
  }

  on<K extends keyof ChartEvents>(type: K, listener: ChartListener<K>): () => void {
    return this.#events.on(type, listener);
  }

  showCursor(position: CursorPosition, options: CursorOptions = {}): void {
    const axis = "x" in position ? "x" : "y";
    const value = (position as Record<string, unknown>)[axis];
    if (typeof value !== "string" && !Number.isFinite(value))
      throw new TypeError(
        `showCursor ${axis}: expected a finite number or a category's name; received ${String(value)}`,
      );
    this.#cursor = { at: position, shown: options };
    // It is drawn by the controller, which loads now if it has not.
    this.#loadController().catch(() => {});
    schedule(this.#scheduled);
    const channel = this.#channels.cursor;
    if (options.broadcast !== false && channel?.scale === axis)
      broadcast("cursor", channel.group, this.#member, value);
  }

  hideCursor({ broadcast: share = true }: CursorOptions = {}): void {
    this.#cursor = null;
    schedule(this.#scheduled);
    const channel = this.#channels.cursor;
    if (share && channel) broadcast("cursor", channel.group, this.#member, null);
  }

  get selection(): Selection | null {
    return this.#selection;
  }

  get selectionPanels(): readonly string[] | null {
    const owner = this.#owner;
    return owner && (owner.plane ? owner.panels : this.#keysOf(owner.x));
  }

  select(
    selection: Selection | readonly [number, number] | null,
    target: PanelTarget & { rows?: boolean } = {},
  ): void {
    // A map's or network's lasso belongs to its plane; clearing names one only to check it.
    const plane =
      selection || target.panel !== undefined ? this.#plane()?.select(target.panel) : undefined;
    this.#selectIn(selection, plane ? undefined : this.#current(target.panel), target.rows, plane);
  }

  /**
   * Selects in a panel of the last scene, or on a map's or network's
   * `plane` (writing its rows), and shares a selection of the axes with synced charts.
   */
  #selectIn(
    selection: Selection | readonly [number, number] | null,
    panel?: DrawnPanel,
    rows = true,
    plane?: SelectionOwner | null,
  ) {
    this.#select(selection, panel, rows, plane);
    const channel = this.#channels.selection;
    const shares = channel?.scale === "y" ? this.#model.sharesY : this.#model.sharesX;
    if (channel && shares && !plane)
      broadcast("selection", channel.group, this.#member, this.#encode(channel.scale));
  }

  /**
   * Sets the selection, in panel `at` or on a `plane`; one of the chart's
   * own (`local`), not a synced chart's, writes its rows.
   */
  #select(
    selection: Selection | readonly [number, number] | null,
    at?: DrawnPanel,
    local = false,
    plane?: SelectionOwner | null,
  ) {
    const given = Array.isArray(selection)
      ? { x: selection as readonly [number, number], y: null, lasso: null }
      : (selection as Selection | null);
    const panel = plane ? undefined : (at ?? this.#model.panels()[0]);
    const fit = (range: readonly [number, number] | null, scale: PositionScale | undefined) =>
      range && (scale ? normalize(scale, range[0], range[1]) : ascending(...range));
    const next =
      given && (given.x || given.y || given.lasso)
        ? { x: fit(given.x, panel?.x), y: fit(given.y, panel?.y), lasso: given.lasso }
        : null;
    // A selection belongs to the panels sharing the x scale of the panel it is in.
    const x = next ? (plane?.x ?? at?.xGroup ?? this.#model.xGroupOf()) : undefined;
    // A selection is drawn by the brush.
    if (next) this.#loadBrush();
    const before = this.#owner;
    if (sameSelection(next, this.#selection) && x === before?.x) {
      // Shown without writing, even unchanged, it is no longer the brush's own.
      if (!local) this.#rows?.brushed(null, null, false);
      return;
    }
    this.#selection = next;
    this.#owner = next && (plane ?? { x: x!, panels: this.#keysOf(x!) });
    schedule(this.#scheduled);
    const written = this.#rows?.brushed(next, this.#owner, local);
    // A listener may have changed the selection as its rows were written: that change reported itself.
    if (this.#selection === next) this.#emitSelection(next, this.#owner ?? before, written);
  }

  /**
   * Reports a selection, naming its panels when they are only some (the
   * cleared one's, for none), with the rows it wrote (`written`).
   */
  #emitSelection(
    selection: Selection | null,
    owner: SelectionOwner | null,
    written?: { rows: readonly RowSelectionChange[] } | false,
  ) {
    this.#events.emit("select", {
      ...(selection ?? { x: null, y: null, lasso: null }),
      ...(owner?.x && { panels: owner.panels }),
      ...written,
    });
  }

  /**
   * The selection as synced charts read it, along the channel's `scale`
   * ("x" or "y" alone; with "xy" both, and lassos): categories by name.
   */
  #encode(scale: ChannelOf["scale"]): SharedSelection | null {
    const selection = this.#selection;
    const panel = this.#model.panels()[0];
    const named = (axis: "x" | "y") => {
      const range = selection![axis];
      const categories = panel?.[axis].categories;
      return range && categories ? categories.slice(range[0], range[1] + 1) : range;
    };
    // Lassos go between charts of numbers and times only.
    const lasso = panel?.x.categories || panel?.y.categories ? null : selection?.lasso;
    return (
      selection &&
      (scale === "xy" ? [named("x"), named("y"), lasso ?? null] : [named(scale), null, null])
    );
  }

  /** A selection a synced chart shared, on this chart's scales: names as categories' indices. */
  #decode(shared: SharedSelection | null, scale: ChannelOf["scale"]): Selection | null {
    const panel = this.#model.panels()[0];
    const ranged = (values: SharedSelection[0], axis: "x" | "y"): Range | null => {
      const categories = panel?.[axis].categories;
      if (!values || !categories !== (typeof values[0] === "number")) return null;
      if (!categories) return values as Range;
      const found = (values as readonly string[])
        .map((name) => categories.indexOf(name))
        .filter((i) => i >= 0);
      return found.length ? [Math.min(...found), Math.max(...found)] : null;
    };
    const xy = scale === "xy";
    const bands = panel?.x.categories || panel?.y.categories;
    return (
      shared && {
        x: scale === "y" ? null : ranged(shared[0], "x"),
        y: scale === "x" ? null : ranged(shared[xy ? 1 : 0], "y"),
        lasso: xy && !bands ? shared[2] : null,
      }
    );
  }

  get loading(): Promise<void> | undefined {
    const pending = [
      this.#compiling,
      this.#fontsLoading,
      this.#cloudsLoading,
      this.#animationLoading,
      this.#valuesLoading,
      this.#controllerLoading,
      ...(this.#controller?.loading ?? []),
      this.#model.items?.controlsLoading,
      this.#brushLoading,
      this.#navigator?.loading,
    ].filter((loading) => loading !== undefined);
    return pending.length > 1
      ? Promise.all(pending).then(() => {})
      : (pending[0] as Promise<void> | undefined);
  }

  getCamera(target?: PanelTarget): Camera | undefined {
    return this.#model.getCamera(target?.panel);
  }

  setCamera(camera: CameraSpec | null, target?: PanelTarget): void {
    if (this.#model.setCamera(camera, target?.panel)) this.#invalidate(false);
  }

  getDrillRoot(target?: PanelTarget): DrillRoot | undefined {
    return this.#model.items?.drillRoot(target?.panel);
  }

  setDrillRoot(node: string | readonly string[] | null, target?: PanelTarget): void {
    this.#items().setDrillRoot(node, target?.panel);
  }

  getItemPositions(target?: PanelTarget): ItemPositions {
    return this.#model.items?.positions(target?.panel) ?? {};
  }

  setItemPosition(
    key: string,
    position: { x: number; y: number } | null,
    target?: PanelTarget,
  ): void {
    this.#items().setItemPosition(key, position, target?.panel);
  }

  /**
   * What the chart's layout marks drew, and their items' state, with
   * pending changes of options or data drawn first; throws for charts without any.
   */
  #items() {
    const items = this.#plane();
    if (!items) throw new Error("chart: no items to drill or move");
    return items;
  }

  /** As `#items`, or undefined for charts without layout marks, whose views are all the axes'. */
  #plane() {
    if (this.#model.items && this.#panelsChanged) this.#flush();
    return this.#model.items;
  }

  getPanels(): readonly PanelInfo[] {
    const drawn = this.#model.panels();
    let at = 0;
    // Panels a layout mark drew in have no axes.
    return this.#model
      .allPanels()
      .map(({ key, label, plot, items }) =>
        items ? { key, label, plot: { ...plot } } : panelInfo(drawn[at++]!),
      );
  }

  toPixel(value: number, { panel, axis }: AxisTarget): number | undefined {
    const scale = this.#panelOf(panel)?.[axis];
    if (!scale || !Number.isFinite(value) || scale.breaks?.hides(value)) return undefined;
    return finite(scale.map(value));
  }

  fromPixel(pixel: number, { panel, axis }: AxisTarget): number | undefined {
    const scale = this.#panelOf(panel)?.[axis];
    return scale && Number.isFinite(pixel) ? finite(scale.invert(pixel)) : undefined;
  }

  formatValue(value: number, { panel, axis }: AxisTarget): string | undefined {
    const drawn = this.#panelOf(panel);
    if (!drawn?.[axis] || !Number.isFinite(value)) return undefined;
    const model = this.#model;
    // As the panel's tooltips write values: category axes give "" past their categories.
    const format =
      axis === "yRight"
        ? model.yRightFormat(drawn.key)
        : model.formatsOf(undefined, drawn.key)[axis];
    return format?.(value) || undefined;
  }

  inspect(x: number, y: number, { panel, mode }: InspectOptions = {}): Inspection | undefined {
    // Throws for a panel the chart does not have; without one, the panel under the pixel.
    if (panel !== undefined) this.#panelOf(panel);
    return this.#model.inspect(x, y, mode, panel);
  }

  /**
   * The panel of the last frame named `panel`, which charts of several
   * panels need; throws for one the chart does not have. Undefined for a
   * panel a layout mark drew in, which has no axes.
   */
  #panelOf(panel: string | undefined): DrawnPanel | undefined {
    const panels = this.#model.panels();
    const all = this.#model.allPanels();
    if (panel === undefined) {
      if (all.length > 1) throw new Error("panel: required with several panels");
      return panels[0];
    }
    // Throws for a panel the last frame did not have.
    if (!all.some(({ key }) => key === panel)) this.#model.xGroupOf(panel);
    return panels.find(({ key }) => key === panel);
  }

  getLegend(): readonly LegendEntry[] {
    return this.#model.legendEntries().map(({ key, label, color }) => ({ key, label, color }));
  }

  getHiddenKeys(): readonly string[] {
    return [...this.#model.hidden];
  }

  setHiddenKeys(keys: readonly string[]): void {
    this.#hide(keys);
  }

  setVisibility(keys: string | readonly string[], visible: boolean): void {
    const hidden = new Set(this.#model.hidden);
    const { groups } = this.#model.hidden;
    for (const key of typeof keys === "string" ? [keys] : keys) {
      // A series of a legend group shows and hides with its group's entry.
      const stored = groups.get(key) ?? key;
      if (visible) hidden.delete(stored);
      else hidden.add(stored);
    }
    this.#hide(hidden);
  }

  /**
   * Hides what `next` names and shows the rest: how the legend, the
   * visibility methods, and updates that remove marks all hide series and
   * items, reporting once when something changed.
   */
  #hide(next: Iterable<string>): void {
    const hidden = this.#model.hidden;
    // A series of a legend group goes with its group's entry.
    const keys = new Set<string>();
    for (const key of next) keys.add(hidden.groups.get(key) ?? key);
    if (keys.size === hidden.size && [...hidden].every((key) => keys.has(key))) return;
    // Scenes draw with copies of the model's set, made as they are built.
    hidden.clear();
    for (const key of keys) hidden.add(key);
    this.#settle();
    this.#invalidate();
    this.#events.emit("visibility", { hiddenKeys: [...hidden] });
  }

  render(): void {
    // The container may have changed since the observer last reported.
    this.#remember();
    this.#settle();
    this.#dirty = true;
    this.#flush();
  }

  toSVG(options: SvgSizing = {}): string {
    checkSizing(options, "toSVG");
    return this[EXPORT_SCENE]((scene, model) => this.#svgOf(scene, model, options));
  }

  toPNG(options?: { scale?: number }): Promise<Blob> {
    // The state now, whatever changes while the encoder loads.
    const [svg, width, height] = this[EXPORT_SCENE](
      (scene, model) => [this.#svgOf(scene, model), scene.width, scene.height] as const,
    );
    return import("./png-export.ts").then((png) =>
      png.svgToPng(svg, width, height, this.root.ownerDocument, options, this.#fonts?.faces),
    );
  }

  /** The SVG export of a scene of the chart. */
  #svgOf(scene: Scene, model: ChartModel, sizing: SvgSizing = {}): string {
    const document = this.root.ownerDocument;
    return renderSvg(scene, {
      ...sizing,
      unkerned: this.#fonts !== undefined,
      idPrefix: `${this.#id}-export`,
      encodeRaster: (mark) => canvasRasterUrl(mark, document),
      description: describeChart(model),
    });
  }

  get [EXPORT_FONTS](): Fonts | undefined {
    return this.#options.fonts;
  }

  [EXPORT_SCENE]<T>(use: (scene: Scene, model: ChartModel) => T): T {
    // An export shows the latest state at the container's current size: what
    // is pending is drawn first, and no frame is drawn when nothing is, so
    // render listeners may export.
    // A chart drawing nothing of its options exports nothing in their place.
    const refusal = this.#refusal ?? this.#compileFailure;
    if (refusal) throw refusal;
    if (this.#compiling) throw new Error("chart: its code has not loaded; await chart.loading");
    this.#remember();
    this.#settle();
    const { width, height } = this.#size();
    if (width !== this.#model.width || height !== this.#model.height) this.#dirty = true;
    let drawn: boolean;
    try {
      drawn = this.#drawPending();
    } catch (error) {
      // Shown and told as a frame failing is; the export fails with it.
      this.#fail(error, "render");
      throw error;
    }
    if (drawn) this.#succeed();
    try {
      return use(this.#model.scene(this.#measure()), this.#model);
    } finally {
      // Listeners hear of the frame once the export is made (or failed):
      // what they change then is drawn on the next frame, as after any other.
      if (drawn) this.#finishFrame(true);
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    unschedule(this.#scheduled);
    if (this.#describeTimer !== 0) clearTimeout(this.#describeTimer);
    for (const stop of this.#cleanup) stop();
    this.#unwatchPage?.();
    for (const stop of this.#tables.values()) stop();
    this.#tables.clear();
    this.#clouds?.release(this);
    this.#controller?.dispose();
    this.#held = null;
    this.#model.items?.disposeControls();
    this.#navigator?.dispose();
    this.#rows?.dispose();
    // A transition waiting for its first frame leaves the frame's batch;
    // values let go of what they moved.
    this.#animation?.settle();
    this.#values?.settle();
    this.#events.clear();
    this.#model.dispose();
    this.#scene = undefined;
    this.root.remove();
  }

  /**
   * Draws what changed: the scheduler calls this once a frame, the chart
   * itself when it must draw at once. A frame that fails shows why; the
   * first frame of a chart made to throw (`rethrow`) throws instead.
   */
  #flush(rethrow = false): void {
    if (this.#destroyed) return;
    let drawn: boolean;
    try {
      drawn = this.#drawPending();
    } catch (error) {
      if (rethrow && this.#options.errorMode === "throw") throw chartError(error, "render");
      this.#fail(error, "render");
      return;
    }
    if (drawn) this.#succeed();
    this.#finishFrame(drawn);
  }

  /**
   * Shows and reports what keeps the chart from drawing (see
   * `ChartOptions.errorMode`): over the last frame where it is still right
   * (`kept`), else in its place. Each change of options or data is
   * reported once, whatever frames fail again for it; the next change tries again.
   */
  #fail(error: unknown, phase: ChartErrorPhase, kept = false): void {
    if (this.#destroyed) return;
    const failure = chartError(error, phase);
    const reported = this.#reportedFailure === this.#revision;
    this.#reportedFailure = this.#revision;
    if (this.#options.errorMode !== "throw" && !(reported && this.#failure)) {
      this.#failure?.remove();
      // The chart keeps its size, its drawing hidden under a box saying why.
      if (!kept) {
        const { width, height } = this.#size();
        Object.assign(this.root.style, {
          width: `${width}px`,
          height: `${height}px`,
          visibility: "hidden",
        });
      }
      this.#failure = showFailure(this.root, failure, kept);
    }
    if (!reported) this.#report(failure);
  }

  /** Tells of `failure`: rejects `ready` if no frame drew, then `onError`, "error" listeners, or the console. */
  #report(failure: ChartError): void {
    // A chart destroyed (a component unmounted) tells no one of what it no longer draws.
    if (this.#destroyed) return;
    this.#settleReady?.[1](failure);
    this.#settleReady = undefined;
    const { onError } = this.#options;
    try {
      onError?.(failure);
    } catch (thrown) {
      report(thrown);
    }
    this.#events.emit("error", { error: failure });
    if (!onError && !this.#events.has("error")) console.error(failure);
  }

  /** A frame is on screen: what showed it could not draw goes. */
  #succeed(): void {
    this.#drawn = true;
    this.#settleReady?.[0]();
    this.#settleReady = undefined;
    if (!this.#failure) return;
    this.#failure.remove();
    this.#failure = undefined;
    this.root.style.visibility = "";
  }

  /** Draws pending changes, the page's theme among them; whether there were any. */
  #drawPending(): boolean {
    // A configuration waiting for a compiler keeps the last frame, or none;
    // a chart whose options were refused draws nothing until an update.
    if (this.#destroyed || this.#compiling || this.#refusal) return false;
    if (this.#pageChanged) {
      this.#pageChanged = false;
      if (readPage(this.#container, (page) => this.#model.refreshTheme(page))) {
        // New fonts or sizes need margins planned for them: show the new view at once.
        this.#animation?.settle();
        this.#dirty = true;
      }
    }
    const drawn = this.#dirty;
    if (drawn) {
      this.#dirty = false;
      this.#panelsChanged = false;
      this.#draw();
    }
    return drawn;
  }

  /**
   * Draws the cursor, tooltip, and brush, and reports what the frame
   * changed: what is hovered, the camera, and with `drawn`, the frame.
   */
  #finishFrame(drawn: boolean): void {
    // A tree whose data lost the node it was drilled into shows an ancestor:
    // reported before listeners of the frame (hover) may drill again.
    if (drawn) this.#model.items?.finishFrame();
    this.#drawSelection();
    this.#controller?.draw(drawn);
    if (drawn) this.#events.emit("render", {});
  }

  /**
   * Keeps the selection while its panels are drawn, and draws it, or the
   * drag in progress, with the brush.
   */
  #drawSelection(): void {
    const scene = this.#scene;
    if (!scene) return;
    const panels = this.#model.panels();
    // A selection whose panels are gone (their facet values, or a change of
    // how they share scales) goes too.
    const owner = this.#owner;
    // A map's lasso is on its plane's panels.
    if (
      owner &&
      !(owner.plane ? owner.panels.length : panels.some(({ xGroup }) => xGroup === owner.x))
    ) {
      this.#selection = null;
      this.#owner = null;
      // So do the rows it wrote, from the channels that still hold them.
      this.#emitSelection(null, owner, this.#rows?.brushed(null, null, true));
    }
    // A drag draws in the panels it would select in, a selection in its own.
    const brush = this.#brush;
    const x = brush?.dragging ? this.#controller?.dragged : this.#owner?.x;
    brush?.draw(
      x ? panels.filter(({ xGroup }) => xGroup === x) : panels,
      scene.theme,
      this.#selection,
    );
  }

  /**
   * Makes the view changes `change` makes, then reports each x scale whose
   * view changed (its x range, or the y ranges every scale shares) once,
   * and with `shareX`, shares the x range with synced charts. Listeners run
   * once the change is complete; changes made inside it report with it.
   */
  #changeView(change: () => void, shareX: boolean, cause: ViewCause = "api"): void {
    if (this.#changingView) {
      change();
      return;
    }
    this.#cause = cause;
    const scales = this.#xScales();
    const before = scales.map((first) => this.#viewOf(first?.key));
    this.#changingView = true;
    try {
      change();
    } finally {
      this.#changingView = false;
    }
    this.#invalidate(false);
    this.#reportViews(scales, before);
    // A listener may have changed the view again: share where it ended up.
    // What a synced chart shared is not shared again.
    if (cause !== "sync") this.#shareView(shareX);
  }

  /**
   * Shares the view with the charts of the viewport channel: along y, or
   * along x when it changed there (`shareX`). Charts whose panels have
   * scales of their own share cursors only: a viewport belongs to some panels.
   */
  #shareView(shareX: boolean): void {
    const channel = this.#channels.viewport;
    const model = this.#model;
    const y = channel?.scale === "y";
    if (channel && (y ? model.sharesY : shareX && model.sharesX))
      broadcast("viewport", channel.group, this.#member, y ? model.yViewport.y : model.viewport);
  }

  /**
   * Reports each x scale (named by its first panel) whose view is not what
   * it was `before`, once: a listener's own change of view, made while
   * these are reported, reports itself, and the views it reported are not
   * reported again.
   */
  #reportViews(scales: readonly (DrawnPanel | undefined)[], before: readonly Viewport[]): void {
    this.#reporting(() =>
      scales.forEach((first, i) => {
        // A listener may have changed the panels; those gone are left alone.
        if (first && !this.#still(first)) return;
        const view = this.#viewOf(first?.key);
        const group = first?.xGroup ?? "";
        if (sameView(view, before[i]!) || sameView(view, this.#reported.get(group))) return;
        this.#reported.set(group, view);
        this.#events.emit("viewport", { ...view, ...(group && { panels: this.#keysOf(group) }) });
      }),
    );
  }

  /**
   * Whether a panel of an earlier scene is still drawn, with the same
   * scales to share.
   */
  #still(panel: DrawnPanel): boolean {
    return this.#model
      .panels()
      .some(({ key, xGroup }) => key === panel.key && xGroup === panel.xGroup);
  }

  /** Runs `report` as part of the report of a change of view that `#reported` records. */
  #reporting(report: () => void): void {
    this.#reportDepth++;
    try {
      report();
    } finally {
      if (--this.#reportDepth === 0) this.#reported.clear();
    }
  }

  /** The first panel of each x scale; one undefined when every panel shares x. */
  #xScales(): (DrawnPanel | undefined)[] {
    const panels = this.#model.panels();
    return this.#model.sharesX
      ? [undefined]
      : panels.filter((p, i) => panels.findIndex(({ xGroup }) => xGroup === p.xGroup) === i);
  }

  /** The keys of the panels drawn with the x scale named `x`. */
  #keysOf(x: string): string[] {
    return this.#model
      .panels()
      .filter(({ xGroup }) => xGroup === x)
      .map(({ key }) => key);
  }

  /**
   * Draws on the next frame. Changes of view (`panels` false) keep the
   * panels and how they share scales, which `#current` then need not draw.
   */
  #invalidate(panels = true) {
    this.#dirty = true;
    if (panels) this.#panelsChanged = true;
    schedule(this.#scheduled);
  }

  #setVisible(visible: boolean) {
    this.#scheduled.visible = visible;
    // A chart scrolled away shows the view asked for when it returns.
    if (!visible) this.#settle();
    if (visible && (this.#dirty || this.#pageChanged)) schedule(this.#scheduled);
  }

  /**
   * Loads the compilers the configuration waits for, and draws once they
   * are here: `loading` settles with that frame on screen, or rejects when
   * one cannot load or refuses the configuration, and the chart draws
   * nothing more until an update loads them or needs them no more.
   */
  #loadCompilers(): void {
    const lacks = this.#model.lacks();
    if (!lacks.includes(true)) {
      this.#compiling = this.#compileFailure = undefined;
      return;
    }
    if (this.#compiling && !this.#compileFailure) return;
    this.#compileFailure = undefined;
    // A load an update made needless since (`#compiling` moved on) leaves the chart as it is.
    let compiling: Promise<void> | undefined;
    const fail = (phase: ChartErrorPhase) => (error: unknown) => {
      if (this.#compiling === compiling) {
        this.#compileFailure = chartError(error, phase);
        this.#fail(this.#compileFailure, phase);
      }
      throw error;
    };
    for (const [i, lack] of lacks.entries())
      if (lack)
        imports[i] ??= COMPILERS[i]!().then(
          (compiler) => {
            compilers[i] = compiler as never;
          },
          (error: unknown) => {
            // A later update imports again, though browsers that keep a failed
            // module's result (Chrome does) reject it until the page reloads.
            imports[i] = undefined;
            throw error;
          },
        );
    compiling = Promise.all(lacks.map((lack, i) => lack && imports[i])).then(() => {
      if (this.#compiling !== compiling) return;
      try {
        readPage(this.#container, (page) => this.#model.use(compilers[0], compilers[1], page));
      } catch (error) {
        // A compiler refuses the configuration: nothing is drawn until an update.
        fail("compile")(error);
      }
      this.#compiling = undefined;
      // An update while they loaded may need another.
      this.#loadCompilers();
      if (this.#compiling) return this.#compiling;
      this.#invalidate();
      this.#flush();
    }, fail("load"));
    // Reported as it fails; `loading` rejects for those who ask.
    compiling.catch(() => {});
    this.#compiling = compiling;
  }

  /**
   * Measures with `fonts` from now on, their faces claimed on the page and
   * registered with it; once faces load, the chart is laid out and drawn again.
   */
  #useFonts(fonts: unknown): void {
    checkFonts(fonts, "chart");
    if (fonts === this.#fonts) return;
    const document = this.root.ownerDocument;
    const page = fonts?.[USE_FONTS](document);
    this.#fonts = fonts;
    this.#page = page;
    this.#fontsMeasure = page?.measure;
    // Supplied fonts measure glyph by glyph: the chart's text is drawn so.
    const style = this.root.style;
    style.fontKerning = style.fontVariantLigatures = fonts ? "none" : "";
    const loaded = page?.loaded?.then(() => {
      if (this.#fontsLoading === loaded) this.#fontsLoading = undefined;
    });
    this.#fontsLoading = loaded;
  }

  /** What the chart measures text with: its fonts, or its document's canvas. */
  #measure(): MeasureText {
    return this.#fontsMeasure ?? this.#snapshotMeasure ?? measurer(this.root.ownerDocument);
  }

  #applyOptions() {
    const options = this.#options;
    this.root.setAttribute("aria-label", titleText(options.title) ?? "Chart");
    // Re-subscribe to the tables the marks read, and to the views of rows they show.
    const tables = new Set<Table | RowView>(
      options.marks.flatMap((mark) => {
        const view = viewOf(mark);
        return view ? [...tablesOf(mark), view] : tablesOf(mark);
      }),
    );
    for (const [table, stop] of this.#tables) {
      if (!tables.has(table)) {
        stop();
        this.#tables.delete(table);
      }
    }
    for (const table of tables) {
      if (!this.#tables.has(table))
        this.#tables.set(
          table,
          table.subscribe((change?: TableChange) => {
            // New data shows at once: a moving view would plan from stale
            // data. Changed values may move there from what is on screen,
            // unless something inspects or presses it or moves its view.
            const busy = this.#animation?.playing || this.#controller?.busy;
            this.#values?.changed(
              busy || !this.#scheduled.visible ? undefined : this.#scene,
              change,
              this.#drawTime,
            );
            this.#animation?.settle();
            this.#cause = "data";
            this.#revision++;
            this.#invalidate();
          }),
        );
    }
    this.#leaveSync?.();
    this.#channels = channelsOf(options.interaction?.sync);
    this.#leaveSync = join(this.#channels, this.#member);
    if (this.#brush) this.#brush.mode = options.interaction?.brush ?? "x";
    const { brush, bindings, pan, zoom } = options.interaction ?? {};
    // Until the controller sets the policy its bindings call for, touches
    // drag along x (where most charts pan and brush) and scroll the page up and down.
    if (!this.#controller) this.root.style.touchAction = pan || zoom || brush ? "pan-y" : "";
    if (brush || bindings?.some(({ action }) => action.type === "brush")) this.#loadBrush();
    if (options.animation) this.#loadAnimation();
    if (typeof options.animation === "object" && options.animation.values) this.#loadValues();
    this.#controller?.configure();
    // The navigator's sliders stay as options change, keeping their focus,
    // and go when it does.
    this.#navigator =
      options.navigator?.mount(
        this.#navigator,
        () => import("./navigator.ts"),
        this as Chart,
        this.#model,
      ) ?? this.#navigator?.dispose();
    this.#rows =
      options.rowSelection?.mount(
        this.#rows,
        this.#model,
        this,
        this.#events,
        () => this.#invalidate(false),
        () => this.#controller?.keyboard ?? null,
        this.#live,
      ) ?? this.#rows?.dispose();
    this.#loadControls();
    // Themes that follow the page re-read it when it may have switched themes.
    // So do charts whose guides' and subplots' styles read it.
    const follows = themeReadsPage(options.theme, styleSources(options));
    if (follows && !this.#unwatchPage) {
      this.#unwatchPage = watchPage(this.#container.ownerDocument, () => {
        this.#pageChanged = true;
        schedule(this.#scheduled);
      });
    } else if (!follows && this.#unwatchPage) {
      this.#unwatchPage();
      this.#unwatchPage = undefined;
    }
  }

  /** Measures the container and caches the size where the observer keeps it current. */
  #remember(): { width: number; height: number } {
    const container = this.#container;
    const { width, height } = container.getBoundingClientRect();
    // Inline hosts have no box of their own and get no resize notifications
    // when they reflow, so they are measured on every frame instead.
    const display = container.ownerDocument.defaultView?.getComputedStyle(container).display;
    const observed = display !== "inline" && display !== "contents";
    this.#containerSize = observed ? { width, height } : undefined;
    return { width, height };
  }

  #size(): { width: number; height: number } {
    const { width, height } = this.#options;
    const box = this.#containerSize ?? this.#remember();
    return {
      width: Math.round(width ?? (box.width || 640)),
      height: Math.round(height ?? (box.height || DEFAULT_HEIGHT)),
    };
  }

  /**
   * Whether scenes may leave large point series to the GPU painter: unless
   * WebGL2 is unavailable or SVG is forced. The painter is loaded the first
   * time a scene holds a cloud, so other charts never download it.
   */
  #cloudsAllowed(): boolean {
    if (this.#options.renderer === "svg" || this.#clouds === null) return false;
    // After a lost context, a fresh painter is loaded.
    if (this.#clouds && !this.#clouds.usable) {
      this.#clouds = undefined;
      this.#clouds3d = false;
    }
    return true;
  }

  /** Loads the GPU painter, with 3D clouds when `deep`; 2D charts never download that part. */
  #loadClouds(deep: boolean): void {
    if (this.#cloudsLoading) return;
    this.#cloudsLoading = import("../render/webgl.ts")
      .then((module) =>
        // A 3D painter that fails to load leaves 3D points to the CPU, and
        // 2D ones to the painter without it.
        deep ? module.deepPainter().catch(() => module.cloudPainter()) : module.cloudPainter(),
      )
      .catch(() => undefined)
      .then((painter): Promise<void> | undefined => {
        this.#clouds = painter ?? null;
        this.#clouds3d = deep;
        this.#cloudsLoading = undefined;
        // Draw at once, so `loading` settles with the points on screen; a
        // scene that turned 3D meanwhile loads that painter, which `loading`
        // waits for too.
        this.#dirty = true;
        this.#flush();
        return this.#cloudsLoading;
      });
  }

  #draw() {
    const { width, height } = this.#size();
    const window = this.root.ownerDocument.defaultView;
    // Hosts measured each frame change size without the resize observer.
    if (width !== this.#model.width || height !== this.#model.height) this.#animation?.settle();
    this.#model.setSize(width, height, window?.devicePixelRatio ?? 1);
    this.root.style.width = `${width}px`;
    this.root.style.height = `${height}px`;
    const measure = this.#measure();
    const cloudsAllowed = this.#cloudsAllowed();
    const animation = this.#animation;
    if (animation?.playing) {
      const plan = () => {
        this.#model.scene(measure, cloudsAllowed);
        return this.#model.panels()[0];
      };
      if (animation.step(plan, this.#drawTime)) this.#invalidate(false);
    }
    const started = performance.now();
    // Changed values on their way draw the scene they move to, which stays
    // the model's last, with its marks and axes between.
    const build = () => this.#model.scene(measure, cloudsAllowed);
    const scene = this.#values?.frame(build, this.#drawTime) ?? build();
    if (this.#values?.playing) this.#invalidate(false);
    this.#scene = scene;
    const clouds = cloudsIn(scene);
    // A null painter means WebGL is unavailable; it is not loaded again.
    const waiting =
      clouds !== undefined &&
      this.#clouds !== null &&
      !(this.#clouds && (clouds === "points" || this.#clouds3d));
    if (waiting) this.#loadClouds(clouds === "3d");
    // Until its GPU painter draws, a hydrated chart shows its server markup.
    if (waiting && this.#hydrating) return;
    this.#hydrating = false;

    const renderer = this.#options.renderer ?? "auto";
    this.#onCanvas =
      renderer === "canvas" ||
      (renderer === "auto" &&
        (this.#onCanvas ? scene.vertices >= SVG_BELOW : scene.vertices > CANVAS_ABOVE));
    if (this.#onCanvas) {
      if (!this.#canvas) {
        this.#canvas = this.root.ownerDocument.createElement("canvas");
        this.#canvas.setAttribute("aria-hidden", "true");
        this.#canvas.style.cssText = "position:absolute;left:0;top:0";
        this.root.prepend(this.#canvas);
      }
      this.#canvas.style.width = `${width}px`;
      this.#canvas.style.height = `${height}px`;
      // Until the painter has loaded, clouds are left out rather than drawn
      // slowly on the CPU; `loading` settles once they are on screen.
      paintCanvas(
        this.#canvas,
        scene,
        { painter: this.#clouds ?? undefined, owner: this, defer: waiting },
        !this.#fonts,
      );
    } else if (this.#canvas) {
      // Release the backing store when marks move back to SVG.
      this.#canvas.width = 0;
      this.#canvas.height = 0;
      this.#canvas.remove();
      this.#canvas = null;
    }
    // Uploads this chart no longer draws are released.
    this.#clouds?.endFrame(this);
    this.#svg.render(scene, { marks: !this.#onCanvas });
    this.#legend.update(guidesOf(scene, "legend"), scene.theme);
    this.#model.items?.drawControls(scene);
    this.#drawTime = performance.now() - started;
    this.#describe();
  }

  /**
   * Makes the view changes `change` makes, moving the axes there gradually
   * where `animation` allows: in a chart of one panel, on screen, and not
   * linked to others.
   */
  #animated(change: () => void): void {
    const animation = this.#animation;
    const panels = this.#model.panels();
    const { config } = this.#model;
    const movable =
      animation &&
      panels.length === 1 &&
      !config.facet &&
      !config.panels &&
      !config.interaction?.sync &&
      this.#scheduled.visible &&
      this.#scene &&
      cloudsIn(this.#scene) === undefined;
    // What is on screen: no scene is drawn until the next frame.
    const from = movable ? panels[0] : undefined;
    this.#settle();
    // The transition starts before the change reports itself, so viewport
    // listeners that draw, stream data, or change options end it as usual.
    if (from && animation!.start(from, this.#options.animation, this.#drawTime))
      this.#invalidate(false);
    change();
  }

  /**
   * Ends values on their way, or shown part way, and draws the new ones
   * now, before input reads them (a click may come before the next frame).
   */
  #showValues(): void {
    if (!this.#values?.settle()) return;
    this.#invalidate(false);
    this.#flush();
    // What render listeners changed meanwhile shows at once too: input reads it next.
    this.#values?.settle();
  }

  /** Ends a change of view or values playing and draws where it was going. */
  #settle(): void {
    const values = this.#values?.settle();
    if (!values && !this.#animation?.playing) return;
    this.#animation?.settle();
    this.#invalidate(false);
  }

  /**
   * Has the controls the chart's layout mark asks for (see controls.ts),
   * following the options, loading them the first time; controls of
   * another kind go.
   */
  #loadControls(): void {
    this.#model.items?.updateControls(
      (kind) =>
        import("./layout-controls.ts").then(({ mountControls }) =>
          mountControls(kind, {
            chart: this,
            model: this.#model,
            overlay: this.#svg.overlay,
            live: this.#live,
            legend: this.#legend.element,
            invalidate: () => this.#invalidate(false),
            cursor: () => this.#controller?.keyboard ?? undefined,
          }),
        ),
      // Drills, moves, and views of maps and networks report themselves.
      (type, change) => {
        if (type !== "camera") this.#invalidate(false);
        this.#events.emit(type, change);
      },
    );
  }

  /**
   * Listens for input until the controller is attached, keeping what
   * arrives for it (`#hold`).
   */
  #gate(): void {
    const hold = (event: Event) => this.#hold(event);
    for (const type of HELD) {
      this.root.addEventListener(type, hold, type === "wheel" ? { passive: false } : undefined);
      this.#cleanup.push(() => this.root.removeEventListener(type, hold));
    }
  }

  /**
   * Keeps input that arrives before the controller, which plays it once it
   * is attached: hover as its latest position, presses whole (their start,
   * their path, and their end), keys and wheel steps in order. What the
   * controller would take is taken in the event itself, since it cannot be
   * later (the browser's default prevented, the pointer captured), as the
   * presets bind it: the chart's own bindings take input once it is here.
   */
  #hold(event: Event): void {
    const held = this.#held;
    if (this.#controller || !held) return;
    this.#loadController().catch(() => {});
    const { pan, zoom, brush, bindings } = this.#options.interaction ?? {};
    const { type } = event;
    const pressed = held.some((e) => e.type === "pointerdown");
    if (type === "wheel") {
      // The wheel sideways pans; with Ctrl or ⌘ held, it zooms.
      const { deltaX, deltaY, shiftKey, ctrlKey, metaKey } = event as WheelEvent;
      const panning = pan === false ? undefined : (pan ?? zoom);
      const sideways = Math.abs(deltaX) > Math.abs(deltaY) || shiftKey;
      if (sideways ? panning && panning !== "y" : zoom && (ctrlKey || metaKey))
        event.preventDefault();
      // Others scroll the page, and only bindings of the chart's own may take them later.
      else if (!bindings) return;
    } else if (type === "keydown") {
      const { key, target } = event as KeyboardEvent;
      if (target !== this.root) return;
      // The keys the chart reads, and with zoom + and −, 0: not the page's.
      const zooms = zoom && ["+", "-", "=", "0"].includes(key);
      if ((NAVIGATION_KEYS.includes(key) && key !== "Enter") || zooms) event.preventDefault();
    } else if (type === "pointerdown") {
      // A press that may become a drag owns its pointer; touches are
      // captured where they land.
      const { pointerType, pointerId, target } = event as PointerEvent;
      const drags = pan || zoom || brush || bindings;
      if (drags && pointerType !== "touch" && !(target as Element).closest?.("button"))
        this.root.setPointerCapture?.(pointerId);
    } else if (type === "dragstart") {
      // A press held for the controller drags the chart, not the page's selection.
      if (pressed) event.preventDefault();
      return;
    } else if (
      type === "pointermove" &&
      held.at(-1)?.type === "pointermove" &&
      // Without a press, only where the pointer is now matters; a press keeps its path.
      (!pressed || held.length > HELD_MOVES)
    )
      held.pop();
    held.push(event);
  }

  /** Imports the controller, once, and attaches it when it arrives. */
  #loadController(): Promise<void> {
    this.#attaching ??= loadControllers().then(
      // A drag held for the controller needs the brush, should it brush.
      async (module) => {
        await this.#brushLoading;
        if (!this.#destroyed && !this.#controller) this.#attach(module);
        // What attaching started to load (crosshair labels, tooltip content) is part of it.
        await Promise.all(this.#controller?.loading ?? []).catch((error: unknown) => {
          this.#report(chartError(error, "load"));
          throw error;
        });
      },
      (error: unknown) => {
        // The chart still draws and answers, without input: said, not shown.
        this.#stopHolding();
        this.#report(chartError(error, "load"));
        throw error;
      },
    );
    return this.#attaching;
  }

  /**
   * Without a controller the chart draws, reports, and answers its methods,
   * but takes no input: what was held goes, and nothing more is.
   */
  #stopHolding(): void {
    for (const event of this.#held ?? [])
      if (event.type === "pointerdown")
        this.root.releasePointerCapture?.((event as PointerEvent).pointerId);
    this.#held = null;
  }

  /**
   * Attaches the controller, which plays what input arrived before it. One
   * that refuses the options (their bindings) is reported, and leaves the
   * chart without one.
   */
  #attach({ Interaction }: typeof import("./interaction.ts")): void {
    let controller: InstanceType<typeof Interaction>;
    try {
      controller = new Interaction(this.#host(), KIT);
    } catch (error) {
      // Options it refuses (their bindings) are the chart's: it draws none of them.
      this.#stopHolding();
      this.#refusal = chartError(error, "validate");
      this.#fail(this.#refusal, "validate");
      throw error;
    }
    this.#controller = controller;
    const held = this.#held ?? [];
    this.#held = [];
    controller.play(held);
    schedule(this.#scheduled);
  }

  /** What the chart lends its controller. */
  #host(): InteractionHost {
    return {
      root: this.root,
      model: this.#model,
      overlay: this.#svg.overlay,
      live: this.#live,
      legend: this.#legend.element,
      events: this.#events,
      id: this.#id,
      options: () => this.#options,
      scene: () => this.#scene,
      schedule: () => schedule(this.#scheduled),
      report: (error) => this.#report(chartError(error, "load")),
      invalidate: () => this.#invalidate(false),
      finishFrame: () => this.#finishFrame(false),
      stale: () => this.#panelsChanged,
      current: () => {
        this.#showValues();
        if (this.#dirty) this.#flush();
        this.#values?.settle();
      },
      showValues: () => this.#showValues(),
      settle: () => this.#settle(),
      animated: (change) => this.#animated(change),
      changeView: (change, shareX, cause) => this.#changeView(change, shareX, cause),
      select: (selection, at) => this.#selectIn(selection, at),
      selection: () => this.#selection,
      owner: () => this.#owner,
      rows: () => this.#rows,
      brush: () => this.#brush,
      cursorScale: () => this.#channels.cursor?.scale,
      shareCursor: (value) => {
        const channel = this.#channels.cursor;
        if (channel) broadcast("cursor", channel.group, this.#member, value);
      },
      cursor: () => this.#cursor,
      cause: () => this.#cause,
    };
  }

  /**
   * Loads the brush the first time a chart brushes or shows a selection.
   * The selection itself is kept without it; a press before it loads still
   * drags from where it started, once the pointer moves after it has.
   */
  #loadBrush(): void {
    if (this.#brush || this.#brushLoading) return;
    this.#brushLoading = import("./brush.ts")
      .then(({ Brush }) => {
        if (this.#destroyed) return;
        this.#brush = new Brush(this.#brushLayer, `${this.#id}-brush`);
        this.#brush.mode = this.#options.interaction?.brush ?? "x";
        // A selection made while it loaded shows now, or when the chart is
        // back on screen if it left while the brush loaded.
        if (this.#selection) this.#invalidate(false);
      })
      // Without it, selections are kept and reported but not drawn.
      .catch(() => {})
      .finally(() => {
        this.#brushLoading = undefined;
      });
  }

  /** Loads the animation module the first time a chart asks for `animation`. */
  #loadAnimation(): void {
    if (this.#animation !== undefined || this.#animationLoading) return;
    this.#animationLoading = import("./transition.ts")
      .then(
        ({ ViewAnimation }) => new ViewAnimation(this.#model, this.root.ownerDocument.defaultView),
      )
      // Without it, views change at once.
      .catch(() => null)
      .then((animation) => {
        this.#animation = animation;
        this.#animationLoading = undefined;
      });
  }

  /** Loads what moves changed values the first time a chart asks for `animation.values`. */
  #loadValues(): void {
    if (this.#values !== undefined || this.#valuesLoading) return;
    this.#valuesLoading = import("./value-transition.ts")
      .then(
        ({ ValueAnimation }) =>
          new ValueAnimation(
            this.#model,
            this.root.ownerDocument.defaultView,
            // The scene on screen shows the chart's options, unless a frame is pending.
            !this.#dirty,
            {
              planAxis,
              axisGuide,
              Polyline,
              monotonePolyline,
              measure: (text: string, font: string) => this.#measure()(text, font),
            },
          ),
      )
      // Without it, values change at once.
      .catch(() => null)
      .then((values) => {
        if (!this.#destroyed) this.#values = values;
        this.#valuesLoading = undefined;
      });
  }

  #describe() {
    const model = this.#model;
    const { config } = model;
    const key = JSON.stringify([
      config.marks.flatMap((mark) => tablesOf(mark).map((table) => table.version)),
      [...model.hidden],
      config.navigator?.describe(model),
      config.rowSelection?.description,
      model.items?.summaryKey,
    ]);
    if (this.#described?.config === config && this.#described.key === key) return;
    // Summaries scan the data, so streaming charts refresh them at most once
    // a second; a trailing refresh picks up the last change.
    const wait = this.#describedAt + 1000 - performance.now();
    if (wait > 0) {
      if (this.#describeTimer === 0) {
        this.#describeTimer = setTimeout(() => {
          this.#describeTimer = 0;
          // The summary reads the last drawn series; with a draw pending (an
          // offscreen chart, say), that draw writes the summary instead.
          if (!this.#dirty) this.#describe();
        }, wait);
      }
      return;
    }
    this.#describedAt = performance.now();
    this.#described = { config, key };
    this.#description.textContent = chartDescription(model);
  }
}

/** Two selections cover the same values, or are both null. */
function sameSelection(a: Selection | null, b: Selection | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  const sameLasso =
    a.lasso === b.lasso ||
    (a.lasso !== null &&
      b.lasso !== null &&
      a.lasso.length === b.lasso.length &&
      a.lasso.every(([x, y], i) => x === b.lasso![i]![0] && y === b.lasso![i]![1]));
  return sameRange(a.x, b.x) && sameRange(a.y, b.y) && sameLasso;
}

/** Two viewports show the same ranges. */
function sameView(a: Viewport, b: Viewport | undefined): boolean {
  return (
    b !== undefined && sameRange(a.x, b.x) && sameRange(a.y, b.y) && sameRange(a.yRight, b.yRight)
  );
}

/** Two ranges hold the same values, or are both null. */
function sameRange(
  a: readonly [number, number] | null,
  b: readonly [number, number] | null,
): boolean {
  return a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1]);
}

/** A number, or undefined for none: NaN and infinities are where nothing is. */
function finite(value: number): number | undefined {
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Mounts a chart into `container`.
 *
 * ```ts
 * const chart = createChart(element, {
 *   marks: [line(metrics, { x: "time", y: "latency", series: "service" })],
 *   y: { title: "Latency (ms)" },
 * });
 * ```
 */
export function createChart(container: HTMLElement, options: ChartOptions): Chart {
  return new MountedChart(container, options);
}
