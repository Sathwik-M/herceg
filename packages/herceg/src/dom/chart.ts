// Browser runtime: mounts a chart into an element, renders through the
// shared scheduler, handles pointer, keyboard, legend, zoom, brushing, and
// sync, and emits events to the application.
//
// Layers, bottom to top: a canvas for dense marks (only when used), the SVG
// layer (grid and marks when not on canvas, rules, axes, title, pointer
// overlay), the HTML legend, the tooltip, and a visually hidden description.

import type { RowView } from "../data/row-view.ts";
import type { Table, TableChange } from "../data/table.ts";
import { canvasMeasurer, type MeasureText } from "../layout/text.ts";
import { Polyline } from "../lod/polyline.ts";
import { monotonePolyline } from "../marks/curve.ts";
import { tablesOf, viewOf } from "../marks/layout-mark.ts";
import { type AxisFormat, keepsKey } from "../marks/mark.ts";
import { placeAt, rowOf, type Series } from "../marks/series.ts";
import type { DrillRoot } from "../marks/tree-data.ts";
import { planAxis } from "../model/axis.ts";
import { describeChart } from "../model/describe.ts";
import {
  type ChartConfig,
  ChartModel,
  type DrawnPanel,
  type Inspection,
  type Viewport,
  type YViewport,
} from "../model/model.ts";
import type { NavigatorControls } from "../model/navigator.ts";
import type { RowLink, RowSelectionChange } from "../model/row-selection.ts";
import type { SelectionOwner } from "../model/selected-rows.ts";
import { canvasRasterUrl, paintCanvas } from "../render/canvas.ts";
import { EXPORT_SCENE, type ExportsScene } from "../render/export-scene.ts";
import { renderSvg } from "../render/svg.ts";
import type { PositionScale } from "../scale/scale.ts";
import {
  type CloudPainter,
  type FaceGeometry,
  type PlotRect,
  type PointGeometry,
  type Scene,
  tickLabelGap,
} from "../scene/scene.ts";
import type { CameraSpec } from "../spec/spec.ts";
import { surface, themeReadsPage } from "../theme.ts";
import type { Camera } from "../three/camera.ts";
import type { CrosshairLabels } from "./axis-labels.ts";
import type { Brush } from "./brush.ts";
import { ascending, DRAG_THRESHOLD, normalize, type Selection } from "./brushed.ts";
import { type ChartEvents, type ChartListener, Emitter, type PanelTarget } from "./events.ts";
import {
  type AxisTarget,
  type Chart,
  type InspectOptions,
  type ItemPositions,
  type LegendEntry,
  type PanelInfo,
  panelInfo,
} from "./handle.ts";
import { Legend } from "./legend.ts";
import { readPage, watchPage } from "./page-theme.ts";
import { observeVisibility, schedule, unschedule } from "./scheduler.ts";
import { SvgLayer, svgElement } from "./svg-layer.ts";
import {
  broadcastCursor,
  broadcastSelection,
  broadcastViewport,
  join,
  type SyncMember,
} from "./sync.ts";
import { describeInspection, type RenderTooltip, Tooltip } from "./tooltip.ts";
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
}

/**
 * Changes for `update`. Each option given replaces the chart's (nested
 * ones, such as an axis or `interaction`, whole), one given as `undefined`
 * goes back to its default, and options left out keep their values.
 */
export type ChartUpdate = {
  [K in keyof ChartOptions]?: K extends "marks" ? ChartOptions[K] : ChartOptions[K] | undefined;
};

/** Above this many drawn points, "auto" moves marks from SVG to Canvas. */
const CANVAS_ABOVE = 4000;
/** Below this many, "auto" moves them back (hysteresis avoids flapping). */
const SVG_BELOW = 2000;
const DEFAULT_HEIGHT = 320;

let nextId = 0;
let sharedMeasure: MeasureText | undefined;

/**
 * Without a canvas to measure with (some test environments), glyphs are
 * taken to be 0.6 em wide; browsers always measure, so charts do not carry
 * the static estimator's font tables.
 */
const roughText: MeasureText = (text, font) =>
  text.length * 0.6 * (Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]) || 12);

function measurer(document: Document): MeasureText {
  if (!sharedMeasure) {
    const context = document.createElement("canvas").getContext("2d");
    sharedMeasure = context ? canvasMeasurer(context) : roughText;
  }
  return sharedMeasure;
}

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
  readonly #model: ChartModel;
  #options: ChartOptions;
  readonly #container: HTMLElement;
  /**
   * Container size, measured when the resize observer reports a change (when
   * layout is already current) and on explicit renders, so scheduled frames
   * need not read layout after the previous frame's DOM writes.
   */
  #containerSize: { width: number; height: number } | undefined;
  readonly #id = `herceg-${++nextId}`;
  readonly #svg: SvgLayer;
  readonly #legend: Legend;
  readonly #tooltip: Tooltip;
  readonly #description: HTMLDivElement;
  readonly #live: HTMLDivElement;
  /** A crosshair per panel shown; the first stays, hidden, when none is. */
  readonly #crosshairs: SVGLineElement[];
  readonly #dots: SVGGElement;
  /** Labels on the axes at the crosshair, once loaded for `tooltip.axisLabels`; null if it failed to load. */
  #crosshair: CrosshairLabels | null | undefined;
  #crosshairLoading: Promise<void> | undefined;
  /** What reads tooltip fields and draws `renderTooltip`'s content, while it loads. */
  #contentLoading: Promise<void> | undefined;
  #canvas: HTMLCanvasElement | null = null;
  #onCanvas = false;
  /** GPU painter for large point series once loaded; null when unavailable. */
  #clouds: CloudPainter | null | undefined;
  /** Whether `#clouds` draws 3D charts' clouds too (render/webgl3d.ts loaded). */
  #clouds3d = false;
  #cloudsLoading: Promise<void> | undefined;
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
    syncCursor: (x) => {
      this.#syncedX = x;
      schedule(this.#scheduled);
    },
    syncViewport: (domain) => {
      if (!this.#model.sharesX) return;
      this.#settle();
      this.#changeView(() => this.#model.setViewport(domain), false);
    },
    // Charts whose panels have x scales of their own share cursors only.
    syncSelection: (selection) => {
      if (this.#model.sharesX) this.#select(selection);
    },
  };
  #dirty = true;
  /**
   * Changes since the last frame that may change the panels or how they
   * share scales (options, data, size, hidden series), unlike changes of view.
   */
  #panelsChanged = false;
  #destroyed = false;
  #pointer: { x: number; y: number } | null = null;
  #syncedX: number | null = null;
  /** Keyboard cursor: a panel, a series, and a position in the series' part in the panel. */
  /**
   * The keyboard's cursor, and what it last announced: where the cursor
   * was, should its series go (hidden) before the next key.
   */
  #keyboard: { panel: string; key: string; position: number; last?: Inspection } | null = null;
  /** Outlines the item inspected in charts of a layout mark (a pie slice). */
  readonly #outline: SVGPathElement;
  #describedAt = -Infinity;
  /** What the current summary was written from; zooming and hovering do not change it. */
  #described: { config: unknown; key: string } | undefined;
  #describeTimer: ReturnType<typeof setTimeout> | 0 = 0;
  /**
   * A primary-button press on a plot until release: where it started, the
   * panel (and so the scales) it started in, and what dragging does.
   */
  #press: {
    x: number;
    y: number;
    panel: DrawnPanel;
    mode: "pan" | "brush" | "click";
    moved: boolean;
  } | null = null;
  /** A press in a chart of a layout mark, which has nothing to drag: a click if released in place. */
  #tap: { pointer: number; x: number; y: number; moved: boolean } | null = null;
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
  /** Where a keyboard selection (Shift + arrows) started: a value along the cursor's axis and its label. */
  #brushAnchor: { value: number; label: string; axis: "x" | "y" } | null = null;
  readonly #events = new Emitter();
  /** What the last hover event reported, to emit only changes. */
  #hovered = "";
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

  constructor(container: HTMLElement, options: ChartOptions) {
    const document = container.ownerDocument;
    this.#container = container;
    this.#options = options;
    this.#model = readPage(container, (page) => new ChartModel(options, page));

    this.root = document.createElement("div");
    this.root.style.cssText = "position:relative;overflow:hidden;outline-offset:2px";
    this.root.tabIndex = 0;
    this.root.setAttribute("role", "figure");
    this.#svg = new SvgLayer(document, this.#id);
    this.#crosshairs = [
      svgElement(document, "line", { "stroke-width": "1", visibility: "hidden" }),
    ];
    this.#dots = svgElement(document, "g");
    this.#outline = svgElement(document, "path", {
      fill: "none",
      "stroke-width": "2",
      "stroke-linejoin": "round",
      visibility: "hidden",
    });
    this.#brushLayer = svgElement(document, "g");
    this.#svg.overlay.append(this.#brushLayer, ...this.#crosshairs, this.#dots, this.#outline);
    this.#legend = new Legend(document, (key) =>
      this.setVisibility(key, this.#model.hidden.has(key)),
    );
    this.#tooltip = new Tooltip(document);
    this.#description = document.createElement("div");
    this.#description.id = `${this.#id}-description`;
    // Read only as the figure's description: shown as text too, it would be read twice.
    this.#description.hidden = true;
    this.#live = document.createElement("div");
    this.#live.setAttribute("aria-live", "polite");
    // A new value is announced whole, not as the words that changed.
    this.#live.setAttribute("aria-atomic", "true");
    this.#live.style.cssText = HIDDEN_TEXT;
    this.root.setAttribute("aria-describedby", this.#description.id);
    this.root.append(
      this.#svg.svg,
      this.#legend.element,
      this.#tooltip.element,
      this.#description,
      this.#live,
    );
    container.append(this.root);

    try {
      this.#listen();
      this.#applyOptions();
      this.#cleanup.push(observeVisibility(this.root, (visible) => this.#setVisible(visible)));
      this.#cleanup.push(() => this.#leaveSync?.());
      if (typeof ResizeObserver !== "undefined") {
        // Observers report once on attach; only real size changes re-render.
        const observer = new ResizeObserver(() => {
          this.#remember();
          const { width, height } = this.#size();
          if (width === this.#model.width && height === this.#model.height) return;
          this.#settle();
          this.#invalidate();
        });
        observer.observe(container, { box: "border-box" });
        this.#cleanup.push(() => observer.disconnect());
      }
      // The first frame renders synchronously so the chart is never blank.
      this.#flush();
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
    this.#options = next as unknown as ChartOptions;
    const y = this.#model.yViewport;
    readPage(this.#container, (page) => this.#model.update(this.#options, page));
    // The page was just read; a change it had is in the theme now.
    this.#pageChanged = false;
    this.#settle();
    this.#applyOptions();
    this.#invalidate();
    // Hidden keys go with their marks' identities: their ids, or their
    // indexes, which other marks may take; a legend group's entries, with
    // the group.
    const marks = this.#options.marks;
    const owners = new Set(marks.map((mark, i) => mark.spec.id ?? i));
    const groups = new Set(marks.map((mark) => mark.spec.legendGroup));
    const kept = [...this.#model.hidden].filter((key) => keepsKey(key, owners, groups));
    this.#hide(kept);
    // Panels given y scales of their own let go of the y viewport. Which x
    // scales there are now is known once drawn; listeners drawing calls
    // (hover, select) may change the view, which this report then includes.
    if (this.#model.yViewport !== y) {
      this.#reporting(() => {
        this.#flush();
        const scales = this.#xScales();
        this.#reportViews(
          scales,
          scales.map((first) => ({ ...y, x: this.#model.viewportOf(first?.key) })),
        );
      });
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
    const sync = this.#options.interaction?.sync;
    if (sync && this.#model.sharesX && !plane)
      broadcastSelection(sync, this.#member, this.#selection);
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
    if (!next) this.#brushAnchor = null;
    // A selection is drawn by the brush.
    else this.#loadBrush();
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

  get loading(): Promise<void> | undefined {
    const pending = [
      this.#cloudsLoading,
      this.#animationLoading,
      this.#valuesLoading,
      this.#crosshairLoading,
      this.#contentLoading,
      this.#model.items?.controlsLoading,
      this.#brushLoading,
      this.#navigator?.loading,
    ].filter((loading) => loading !== undefined);
    return pending.length > 1 ? Promise.all(pending).then(() => {}) : pending[0];
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

  toSVG(): string {
    return this[EXPORT_SCENE]((scene, model) => this.#svgOf(scene, model));
  }

  toPNG(options?: { scale?: number }): Promise<Blob> {
    // The state now, whatever changes while the encoder loads.
    const [svg, width, height] = this[EXPORT_SCENE](
      (scene, model) => [this.#svgOf(scene, model), scene.width, scene.height] as const,
    );
    return import("./png-export.ts").then((png) =>
      png.svgToPng(svg, width, height, this.root.ownerDocument, options),
    );
  }

  /** The SVG export of a scene of the chart. */
  #svgOf(scene: Scene, model: ChartModel): string {
    const document = this.root.ownerDocument;
    return renderSvg(scene, {
      idPrefix: `${this.#id}-export`,
      encodeRaster: (mark) => canvasRasterUrl(mark, document),
      description: describeChart(model),
    });
  }

  [EXPORT_SCENE]<T>(use: (scene: Scene, model: ChartModel) => T): T {
    // An export shows the latest state at the container's current size: what
    // is pending is drawn first, and no frame is drawn when nothing is, so
    // render listeners may export.
    this.#remember();
    this.#settle();
    const { width, height } = this.#size();
    if (width !== this.#model.width || height !== this.#model.height) this.#dirty = true;
    const drawn = this.#drawPending();
    const result = use(this.#model.scene(measurer(this.root.ownerDocument)), this.#model);
    // Listeners hear of the frame once the export is made: what they
    // change then is drawn on the next frame, as after any other.
    if (drawn) this.#finishFrame(true);
    return result;
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

  /** Draws what changed: the scheduler calls this once a frame, the chart itself when it must draw at once. */
  #flush(): void {
    if (this.#destroyed) return;
    this.#finishFrame(this.#drawPending());
  }

  /** Draws pending changes, the page's theme among them; whether there were any. */
  #drawPending(): boolean {
    if (this.#destroyed) return false;
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
    this.#drawOverlay();
    if (drawn) this.#events.emit("render", {});
  }

  /**
   * Makes the view changes `change` makes, then reports each x scale whose
   * view changed (its x range, or the y ranges every scale shares) once,
   * and with `shareX`, shares the x range with synced charts. Listeners run
   * once the change is complete; changes made inside it report with it.
   */
  #changeView(change: () => void, shareX: boolean): void {
    if (this.#changingView) {
      change();
      return;
    }
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
    // Charts whose panels have x scales of their own share cursors only: a
    // viewport belongs to some panels.
    const sync = this.#options.interaction?.sync;
    if (shareX && sync && this.#model.sharesX)
      broadcastViewport(sync, this.#member, this.#model.viewport);
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

  #applyOptions() {
    const options = this.#options;
    this.root.setAttribute("aria-label", options.title ?? "Chart");
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
            const busy =
              this.#animation?.playing ||
              this.#pointer ||
              this.#keyboard ||
              this.#press ||
              this.#tap;
            this.#values?.changed(
              busy || !this.#scheduled.visible ? undefined : this.#scene,
              change,
              this.#drawTime,
            );
            this.#animation?.settle();
            this.#invalidate();
          }),
        );
    }
    const sync = options.interaction?.sync;
    this.#leaveSync?.();
    this.#leaveSync = sync ? join(sync, this.#member) : undefined;
    if (this.#brush) this.#brush.mode = options.interaction?.brush ?? "x";
    if (options.interaction?.brush) this.#loadBrush();
    if (options.animation) this.#loadAnimation();
    if (typeof options.animation === "object" && options.animation.values) this.#loadValues();
    if (typeof options.tooltip === "object" && options.tooltip.axisLabels) this.#loadCrosshair();
    if (options.renderTooltip || options.marks.some((mark) => mark.spec.tooltip))
      this.#loadTooltipContent();
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
        () => this.#keyboard,
        this.#live,
      ) ?? this.#rows?.dispose();
    // Drags pan or brush; the page still scrolls along an axis they leave alone.
    const { zoom, brush } = options.interaction ?? {};
    const along = `${zoom === true ? "x" : zoom || ""}${brush === "lasso" ? "xy" : (brush ?? "")}`;
    this.root.style.touchAction = !along
      ? ""
      : along.includes("x") && along.includes("y")
        ? "none"
        : along.includes("x")
          ? "pan-y"
          : "pan-x";
    this.#loadControls();
    // Themes that follow the page re-read it when it may have switched themes.
    const follows = themeReadsPage(options.theme);
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
    const measure = measurer(this.root.ownerDocument);
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
      paintCanvas(this.#canvas, scene, {
        painter: this.#clouds ?? undefined,
        owner: this,
        defer: waiting,
      });
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
    this.#legend.update(scene.legend, scene.theme);
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
            cursor: () => this.#keyboard ?? undefined,
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
            { planAxis, Polyline, monotonePolyline },
          ),
      )
      // Without it, values change at once.
      .catch(() => null)
      .then((values) => {
        if (!this.#destroyed) this.#values = values;
        this.#valuesLoading = undefined;
      });
  }

  /** Loads what reads tooltip fields and draws content of the application's own. */
  #loadTooltipContent(): void {
    if (this.#model.fields || this.#contentLoading) return;
    this.#contentLoading = import("./tooltip-content.ts")
      .then(({ fieldReader, ownContent }) => {
        if (this.#destroyed) return;
        this.#model.fields = fieldReader;
        this.#cleanup.push(ownContent(this.#tooltip, () => this.#options.renderTooltip));
      })
      // Without it, tooltips show the built-in content.
      .catch(() => {})
      .then(() => {
        this.#contentLoading = undefined;
        // Inspections read the fields from the next frame on.
        if (!this.#destroyed) this.#invalidate(false);
      });
  }

  /** Loads the crosshair labels the first time a chart asks for `tooltip.axisLabels`. */
  #loadCrosshair(): void {
    if (this.#crosshair !== undefined || this.#crosshairLoading) return;
    this.#crosshairLoading = import("./axis-labels.ts")
      .then(({ CrosshairLabels }) => {
        const labels = new CrosshairLabels(this.root.ownerDocument);
        this.#dots.before(labels.line);
        this.#svg.overlay.append(labels.labels);
        return labels;
      })
      // Without it, the crosshair has no labels.
      .catch(() => null)
      .then((labels) => {
        this.#crosshair = labels;
        this.#crosshairLoading = undefined;
        if (!this.#destroyed) schedule(this.#scheduled);
      });
  }

  #describe() {
    const model = this.#model;
    const { config } = model;
    const key = JSON.stringify([
      config.marks.flatMap((mark) => tablesOf(mark).map((table) => table.version)),
      [...model.hidden],
      config.navigator?.describe(model),
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
    const hint = model.items?.hint;
    this.#description.textContent = `${describeChart(model)} Focus the chart and use the arrow keys to read values.${hint ? ` ${hint}` : ""}`;
  }

  /** The point the pointer or the keyboard is on. */
  #inspection(): Inspection | undefined {
    if (!this.#scene) return undefined;
    // A chart being turned, panned, or dragged shows no tooltip.
    if (this.#model.items?.busy) return undefined;
    // The model applies the configured tooltip mode.
    if (this.#pointer) return this.#model.inspect(this.#pointer.x, this.#pointer.y);
    const keyboard = this.#keyboard;
    if (keyboard)
      return (
        this.#model.inspectItem(keyboard.key, keyboard.panel) ??
        this.#model.inspectPosition(keyboard.key, keyboard.position, keyboard.panel)
      );
    return undefined;
  }

  /** Each panel's points at the x another chart's cursor shares. */
  #synced(): Inspection[] {
    const x = this.#syncedX;
    if (x === null || !this.#sharesCursor() || this.#model.series().length === 0) return [];
    return this.#model.panels().flatMap(({ plot, x: scale }) => {
      // Outside a panel's x range, the pixel would land in a neighboring panel;
      // a time an axis break leaves out has no place.
      const px = scale.map(x);
      if (!(px >= plot.x && px <= plot.x + plot.width) || scale.breaks?.hides(x)) return [];
      const inspection = this.#model.inspect(px, plot.y + plot.height / 2, "nearest-x");
      return inspection ? [inspection] : [];
    });
  }

  /**
   * Synced cursors are x positions. Charts whose data is placed along y
   * (horizontal bars) measure values on x, so they neither share nor follow them.
   */
  #sharesCursor(): boolean {
    return this.#model.cursorAxis() === "x";
  }

  #drawOverlay() {
    const scene = this.#scene;
    if (!scene) return;
    const { theme } = scene;
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
      this.#brushAnchor = null;
      // So do the rows it wrote, from the channels that still hold them.
      this.#emitSelection(null, owner, this.#rows?.brushed(null, null, true));
    }
    // A drag draws in the panels it would select in, a selection in its own.
    const press = this.#press;
    const x = this.#brush?.dragging && press ? press.panel.xGroup : this.#owner?.x;
    this.#brush?.draw(
      x ? panels.filter(({ xGroup }) => xGroup === x) : panels,
      theme,
      this.#selection,
    );
    const showTooltip = this.#options.tooltip ?? true;
    // Hover listeners get the inspection even without the built-in tooltip,
    // which is how applications draw their own.
    const hovering = this.#events.has("hover");
    const active = showTooltip || hovering ? this.#inspection() : undefined;
    // A cursor another chart shares shows in every panel, without a tooltip.
    const shown = active ? [active] : showTooltip || hovering ? this.#synced() : [];
    if (hovering) {
      const key = inspectionKey(shown[0]);
      if (key !== this.#hovered) {
        this.#hovered = key;
        this.#events.emit("hover", { inspection: shown[0] });
      }
    }
    const document = this.root.ownerDocument;
    const lines = this.#crosshairs;
    const drawn = showTooltip ? shown : [];
    while (lines.length < drawn.length) {
      const line = svgElement(document, "line", { "stroke-width": "1" });
      this.#dots.before(line);
      lines.push(line);
    }
    const dots: SVGCircleElement[] = [];
    this.#outline.setAttribute("visibility", "hidden");
    for (const [i, line] of lines.entries()) {
      const inspection = drawn[i];
      if (!inspection || inspection.axis === "item") line.setAttribute("visibility", "hidden");
      if (!inspection) continue;
      // Items are outlined instead of crossed, and their tooltip points at them.
      if (inspection.axis === "item") {
        this.#outline.setAttribute("d", inspection.outline);
        this.#outline.setAttribute("stroke", theme.text);
        this.#outline.setAttribute("visibility", "visible");
        const [item] = inspection.points;
        const anchor = this.#pointer ?? { x: item!.px, y: item!.py };
        if (inspection === active)
          this.#tooltip.show(inspection, theme, anchor, {
            width: scene.width,
            height: scene.height,
          });
        continue;
      }
      const { plot } = panels.find(({ key }) => key === (inspection.panel ?? "")) ?? panels[0]!;
      // The crosshair crosses the plot at the inspected position: a vertical
      // line for x, a horizontal one for y.
      const at = String(Math.round(inspection.position) + 0.5);
      const vertical = inspection.axis === "x";
      line.setAttribute("x1", vertical ? at : String(plot.x));
      line.setAttribute("x2", vertical ? at : String(plot.x + plot.width));
      line.setAttribute("y1", vertical ? String(plot.y) : at);
      line.setAttribute("y2", vertical ? String(plot.y + plot.height) : at);
      line.setAttribute("stroke", theme.axis);
      line.setAttribute("visibility", "visible");
      // A bar may end outside the plot; its marker would land on the axes.
      const inside = (point: { px: number; py: number }) =>
        point.px >= plot.x - 0.5 &&
        point.px <= plot.x + plot.width + 0.5 &&
        point.py >= plot.y - 0.5 &&
        point.py <= plot.y + plot.height + 0.5;
      for (const point of inspection.points.filter(inside)) {
        dots.push(
          svgElement(document, "circle", {
            cx: String(point.px),
            cy: String(point.py),
            r: "3.5",
            fill: point.color,
            stroke: theme.background === "transparent" ? "#ffffff" : theme.background,
            "stroke-width": "1.5",
          }),
        );
      }
      // Only the chart being used shows a tooltip.
      if (inspection === active) {
        const anchor =
          this.#pointer ??
          (vertical
            ? { x: inspection.position, y: plot.y + plot.height / 2 }
            : { x: plot.x + plot.width / 2, y: inspection.position });
        this.#tooltip.show(inspection, theme, anchor, { width: scene.width, height: scene.height });
      }
    }
    this.#dots.replaceChildren(...dots);
    const tooltip = this.#options.tooltip;
    const crosshair = this.#crosshair;
    if (crosshair && typeof tooltip === "object" && tooltip.axisLabels) {
      crosshair.draw(drawn, active, this.#pointer, {
        model: this.#model,
        scene,
        measure: measurer(this.root.ownerDocument),
        labelGap: tickLabelGap(theme.fontSize),
        surface: surface(theme),
      });
    } else {
      crosshair?.hide();
    }
    if (!active || !showTooltip) this.#tooltip.hide();
  }

  #listen() {
    const root = this.root;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      root.addEventListener(type, handler, options);
      this.#cleanup.push(() => root.removeEventListener(type, handler, options));
    };
    const local = (event: MouseEvent) => {
      const rect = root.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };

    on("pointermove", (event) => {
      // Inspection reads the new values: they show first.
      this.#showValues();
      this.#pointer = local(event);
      this.#keyboard = null;
      this.#brushAnchor = null;
      const press = this.#press;
      const { x, y } = this.#pointer;
      const tap = this.#tap;
      // A press that strays is not a click, even if it comes back.
      if (tap?.pointer === event.pointerId)
        tap.moved ||= Math.hypot(x - tap.x, y - tap.y) >= DRAG_THRESHOLD;
      if (press && !this.#still(press.panel)) this.#cancelPress();
      else if (press) {
        press.moved ||= Math.hypot(x - press.x, y - press.y) >= DRAG_THRESHOLD;
        if (press.moved && press.mode === "pan") {
          this.#pan(press, x, y);
          return;
        }
        if (press.moved && press.mode === "brush") {
          if (this.#brush && !this.#brush.dragging)
            this.#brush.start(press.x, press.y, press.panel);
          this.#brush?.move(x, y);
        }
      }
      schedule(this.#scheduled);
      const sync = this.#options.interaction?.sync;
      // Share the data x under the pointer; over no panel, none.
      if (sync && this.#sharesCursor()) {
        const panel = this.#panelAt(x, y);
        broadcastCursor(sync, this.#member, panel ? panel.x.invert(x) : null);
      }
    });
    on("pointerleave", (event) => {
      this.#pointer = null;
      // A captured drag leaves only when released; any other press ends here.
      this.#press = null;
      if (this.#tap?.pointer === event.pointerId) this.#tap = null;
      this.#brush?.cancel();
      schedule(this.#scheduled);
      const sync = this.#options.interaction?.sync;
      if (sync) broadcastCursor(sync, this.#member, null);
    });

    on(
      "wheel",
      (event) => {
        if (!this.#options.interaction?.zoom || !this.#scene) return;
        const point = local(event);
        if (this.#onItems(point.x, point.y)) return;
        // Outside the plots, the wheel zooms the one x scale every panel
        // shares; with several, none, and the page scrolls.
        const panel =
          this.#panelAt(point.x, point.y) ??
          (this.#model.sharesX ? this.#model.panels()[0] : undefined);
        if (!panel) return;
        event.preventDefault();
        // The wheel zooms from the view on screen, at once.
        this.#settle();
        // Zoom in pixel space and invert, so the value under the pointer stays
        // put on any scale type, including log.
        const { plot, x: scale } = panel;
        const zoom = this.#zoomAxes(panel);
        const factor = Math.exp(event.deltaY * 0.002);
        const px = Math.min(plot.x + plot.width, Math.max(plot.x, point.x));
        const py = Math.min(plot.y + plot.height, Math.max(plot.y, point.y));
        this.#changeView(() => {
          if (zoom.x) {
            this.#model.setViewport(
              [
                scale.invert(px - (px - plot.x) * factor),
                scale.invert(px + (plot.x + plot.width - px) * factor),
              ],
              panel.key,
            );
          }
          if (zoom.y)
            this.#zoomY(
              panel,
              py + (plot.y + plot.height - py) * factor,
              py - (py - plot.y) * factor,
            );
        }, zoom.x);
      },
      { passive: false },
    );
    on("pointerdown", (event) => {
      // Buttons (the legend's, controls') take their own presses.
      if (event.button !== 0 || !this.#scene || (event.target as Element).closest?.("button"))
        return;
      // A drag starts from the view it lands in, not one passing by, and
      // from values as they are.
      if (this.#animation?.playing) {
        this.#settle();
        this.#flush();
      }
      this.#showValues();
      const { x, y } = local(event);
      // Presses on what layout marks draw are clicks, not drags.
      if (this.#model.layout || this.#onItems(x, y)) {
        // A second pointer down makes neither a click (a pinch, say).
        if (this.#tap) this.#tap.moved = true;
        else this.#tap = { pointer: event.pointerId, x, y, moved: false };
        return;
      }
      // Presses on the axes, titles, gaps, or legend are not on the data.
      const panel = this.#panelAt(x, y);
      if (!panel) return;
      // Dragging brushes when brushing is on (Shift pans instead when zoom is
      // on too), pans when only zoom is on, and otherwise does nothing.
      const { brush, zoom } = this.#options.interaction ?? {};
      const mode = brush && !(zoom && event.shiftKey) ? "brush" : zoom ? "pan" : "click";
      this.#press = { x, y, panel, mode, moved: false };
      if (mode !== "click") root.setPointerCapture?.(event.pointerId);
    });
    on("pointerup", (event) => {
      const tap = this.#tap;
      if (tap) {
        if (tap.pointer !== event.pointerId) return;
        this.#tap = null;
        if (!tap.moved) this.#click(local(event), event);
        return;
      }
      const press = this.#press;
      this.#press = null;
      if (!press) return;
      if (!press.moved) {
        this.#click(local(event), event);
        return;
      }
      if (press.mode !== "brush") return;
      // The release point ends the brush, wherever the last move was.
      const end = local(event);
      this.#brush?.move(end.x, end.y);
      const selection = this.#brush?.end() ?? null;
      // The drag outline goes, whether or not the brush selects anything.
      schedule(this.#scheduled);
      // A panel that went while dragging (its facet value did) selects nothing.
      if (!selection || !this.#still(press.panel)) return;
      if (this.#zooms(selection, press.panel)) {
        this.#zoomTo(selection, press.panel);
        return;
      }
      this.#selectIn(selection, press.panel);
      const selected = this.#selection;
      if (selected) {
        const format = this.#model.formatsOf(undefined, press.panel.key);
        this.#live.textContent = describeSelection(selected, format);
      }
    });
    // A drag the chart makes of a press (a brush, pan, lasso, node move, or
    // turn) captures its pointer at the root. The browser must not drag the
    // page's selection instead, which would end the press: Chrome does when
    // the selection spans the drawing pressed.
    // -1 is no pointer's id: it marks events no pointing device made. A
    // second pointer (a touch beside the mouse) leaves the first one's.
    let pressed = -1;
    on(
      "pointerdown",
      (event) => {
        if (!root.hasPointerCapture?.(pressed)) pressed = event.pointerId;
      },
      { capture: true },
    );
    on("dragstart", (event) => {
      if (root.hasPointerCapture?.(pressed)) event.preventDefault();
    });
    // The browser took the pointer (a touch turned into scrolling, say).
    // A tap ends only with its own pointer.
    const cancel = (event: PointerEvent) => {
      this.#cancelPress();
      if (this.#tap?.pointer === event.pointerId) this.#tap = null;
    };
    on("pointercancel", cancel);
    on("lostpointercapture", (event) => {
      if (this.#press || this.#tap?.pointer === event.pointerId) cancel(event);
    });
    // Double click resets both axes, also one zoomed before `interaction.zoom`
    // stopped naming it: on a plot, its x scale; elsewhere, every one. The
    // legend's buttons keep their clicks.
    on("dblclick", (event) => {
      if (!this.#options.interaction?.zoom) return;
      if (this.#legend.element.contains(event.target as Node)) return;
      const { x, y } = local(event);
      if (this.#onItems(x, y)) return;
      const panel = this.#model.sharesX ? undefined : this.#panelAt(x, y)?.key;
      this.#animated(() =>
        this.#changeView(() => {
          this.#model.setViewport(null, panel);
          this.#model.setYViewport({ y: null, yRight: null });
        }, true),
      );
    });

    on("keydown", (event) => this.#key(event));
    on("blur", () => {
      this.#keyboard = null;
      this.#brushAnchor = null;
      schedule(this.#scheduled);
    });
  }

  /** Moves the zoomable axes by a drag's shift, through the scales of the panel it started in. */
  #pan(press: { x: number; y: number; panel: DrawnPanel }, x: number, y: number) {
    this.#settle();
    const { panel } = press;
    const { plot } = panel;
    const zoom = this.#zoomAxes(panel);
    const [dx, dy] = [press.x - x, press.y - y];
    this.#changeView(() => {
      if (zoom.x)
        this.#model.setViewport(
          [panel.x.invert(plot.x + dx), panel.x.invert(plot.x + plot.width + dx)],
          panel.key,
        );
      if (zoom.y) this.#zoomY(panel, plot.y + plot.height + dy, plot.y + dy);
    }, zoom.x);
  }

  /**
   * The axes the wheel, drags, and brushes zoom: those `interaction.zoom`
   * names, less category axes, which do not zoom.
   */
  #zoomAxes(panel: DrawnPanel): { x: boolean; y: boolean } {
    const zoom = this.#options.interaction?.zoom;
    const axes = zoom === true ? "x" : zoom || "";
    return {
      x: axes.includes("x") && panel.x.type !== "band",
      y: axes.includes("y") && panel.y.type !== "band",
    };
  }

  /**
   * Whether a selection is zoomed to rather than shown: when zoom is on along
   * every axis it has a range on. Lassos only select.
   */
  #zooms(selection: Selection, panel: DrawnPanel): boolean {
    if (selection.lasso || !(selection.x || selection.y) || this.#rows?.brushes) return false;
    const zoom = this.#zoomAxes(panel);
    return (!selection.x || zoom.x) && (!selection.y || zoom.y);
  }

  /** A press ends without doing anything: the browser took the pointer, or its panel went. */
  #cancelPress() {
    this.#press = null;
    this.#brush?.cancel();
    schedule(this.#scheduled);
  }

  /**
   * Whether a panel of an earlier scene is still drawn, with the same
   * scales to share: what a drag that started in it may go on acting on.
   */
  #still(panel: DrawnPanel): boolean {
    return this.#model
      .panels()
      .some(({ key, xGroup }) => key === panel.key && xGroup === panel.xGroup);
  }

  /** Zooms to a brushed selection. */
  #zoomTo(selection: Selection, panel: DrawnPanel) {
    const { x, y } = selection;
    this.#animated(() =>
      this.#changeView(() => {
        if (x) this.#model.setViewport(x, panel.key);
        if (y) this.#zoomY(panel, panel.y.map(y[0]), panel.y.map(y[1]));
      }, x !== null),
    );
  }

  /**
   * Shows the y values between two pixels of a panel: on the left axis, and
   * on the right axis what the same pixels show there.
   */
  #zoomY(panel: DrawnPanel, bottom: number, top: number) {
    const range = (scale: PositionScale) => [scale.invert(bottom), scale.invert(top)] as const;
    const view: YViewport = {
      y: range(panel.y),
      yRight: panel.yRight ? range(panel.yRight) : null,
    };
    this.#model.setYViewport(view);
  }

  /** The panel whose plot holds a point of the chart. */
  #panelAt(x: number, y: number): DrawnPanel | undefined {
    return this.#model.panels().find(({ plot }) => holds(plot, x, y));
  }

  /** Whether a point of the chart is in a panel a layout mark drew in. */
  #onItems(x: number, y: number): boolean {
    return this.#model.allPanels().some(({ items, plot }) => items && holds(plot, x, y));
  }

  /**
   * A press released without dragging: selects the rows there (with
   * `rowSelection`), clears the brushed selection, and reports the data there.
   */
  #click(point: { x: number; y: number }, event: MouseEvent) {
    const written = this.#rows?.clicked(point.x, point.y, event);
    // A click on an item standing for none of the bound rows keeps the brush too.
    if (this.#options.interaction?.brush && written !== null) this.select(null);
    if (this.#events.has("click"))
      this.#events.emit("click", { inspection: this.#model.inspect(point.x, point.y), ...written });
  }

  /**
   * Arrow keys step through the points of the first visible series. The
   * cursor keeps its position in the series, so repeated x values are each
   * reachable. In charts with facets, the cursor is in one panel; the Up and
   * Down arrows move it to the previous or next panel, near the same x. With
   * brushing on, Shift extends a selection from where the cursor started,
   * Enter zooms to it when zoom is on, and Escape clears it.
   */
  #key(event: KeyboardEvent) {
    // Controls inside the chart (legend buttons) keep their own keys.
    if (event.target !== this.root || !NAVIGATION_KEYS.includes(event.key)) return;
    // Keys move through what the chart shows once pending changes (a series
    // hidden, new options, values on their way) are drawn, and values that
    // render listeners changed meanwhile do not move.
    this.#showValues();
    if (this.#dirty) this.#flush();
    this.#values?.settle();
    const panels = this.#model.panels();
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    const brush = this.#options.interaction?.brush;
    // Enter and Escape act on the selection, whichever panel the cursor is in.
    if (event.key === "Enter") {
      const selection = this.#selection;
      const at = panels.find(({ xGroup }) => xGroup === this.#owner?.x);
      if (!selection || !at || !this.#zooms(selection, at)) return;
      event.preventDefault();
      this.#brushAnchor = null;
      this.select(null);
      // A select listener may have taken the panel away, or given it another
      // scale: zoom only where the selection still is.
      if (this.#dirty) this.#flush();
      const still = this.#model
        .panels()
        .find(({ key, xGroup }) => key === at.key && xGroup === at.xGroup);
      if (still) this.#zoomTo(selection, still);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.#keyboard = null;
      this.#brushAnchor = null;
      this.#live.textContent = "";
      if (this.#selection) this.select(null);
      schedule(this.#scheduled);
      return;
    }
    // Where the cursor stops, panel by panel: Left and Right move through a
    // stop's points, or a layout mark's items (a stop of their own), Up and
    // Down to the stop before or after.
    const stops = this.#model
      .allPanels()
      .flatMap(({ key, items }): { panel: string; series?: Series }[] =>
        items
          ? [{ panel: key }]
          : this.#model.keyboardStops(key).map((series) => ({ panel: key, series })),
      );
    const keyboard = this.#keyboard;
    let at = stops.findIndex(
      ({ panel, series }) => panel === keyboard?.panel && (!series || series.key === keyboard.key),
    );
    // The cursor's stop may be gone (its series hidden): then it starts afresh in its panel.
    const found = at >= 0;
    const current = found ? keyboard!.position : -1;
    if (!found)
      at = Math.max(
        0,
        stops.findIndex(({ panel }) => panel === keyboard?.panel),
      );
    const start = stops[at];
    if (!start) return;
    // A layout mark's items: every arrow key reads them in a chart of one.
    if (!start.series && (!vertical || stops.length < 2)) {
      this.#itemKey(event, start.panel);
      return;
    }
    // Heatmaps step cell by cell, in rows and columns as drawn; Up and Down
    // leave the grid at its edges. Contours' regions and lines are read as points are.
    const cells = ({ series }: { series?: Series }) =>
      series !== undefined && this.#model.markOf(series)?.stepCell !== undefined;
    let cell: number | undefined;
    if (cells(start) && current >= 0) {
      const [columns, rows] = CELL_STEPS[event.key] ?? [0, 0];
      cell =
        this.#model.stepCell(start.panel, start.series!.key, current, columns, rows) ??
        (vertical ? undefined : current);
    }
    let across = keyboard !== null && !found;
    if (vertical && cell === undefined) {
      const next = keyboard && found ? at + (event.key === "ArrowUp" ? -1 : 1) : at;
      if (next < 0 || next >= stops.length) return;
      across ||= next !== at;
      at = next;
    }
    const { panel, series } = stops[at]!;
    if (!series) {
      this.#itemKey(event, panel, true);
      return;
    }
    // Entering a grid, the cursor starts at its top left cell.
    if (cell === undefined && cells(stops[at]!) && (across || current < 0))
      cell = this.#model.stepCell(panel, series.key, -1, 0, 0);
    const from = panels.find(({ key }) => key === start.panel);
    const to = panels.find(({ key }) => key === panel);
    event.preventDefault();
    const before = keyboard ? (this.#inspection() ?? keyboard.last) : undefined;
    const page = Math.max(1, Math.round(series.length / 10));
    // Up and Down carry the cursor's place along the axis it follows (x, or
    // y for marks along y) to the next stop: its value on a shared scale,
    // else its place across the plot.
    const along = before?.axis === "y" ? "y" : "x";
    let position = Math.max(0, current);
    if (cell !== undefined) position = cell;
    else if (across)
      position = nearestTo(
        series,
        before?.axis !== along
          ? undefined
          : !from || !to || from[`${along}Group`] === to[`${along}Group`]
            ? before.value
            : to[along].invert(to.plot[along] + before.position - from.plot[along]),
        to![along],
        along,
      );
    else if (event.key === "ArrowLeft") position -= 1;
    else if (event.key === "ArrowRight") position = current < 0 ? 0 : current + 1;
    else if (event.key === "PageUp") position -= page;
    else if (event.key === "PageDown") position += page;
    else if (event.key === "Home") position = 0;
    else if (event.key === "End") position = series.length - 1;
    position = Math.min(series.length - 1, Math.max(0, position));
    // Reading series already exclude hidden points; other series step over
    // axis breaks in the direction of travel.
    const breaks = this.#model.markOf(series)?.readSeries ? undefined : to?.x.breaks;
    if (breaks && !across) {
      const back = event.key === "ArrowLeft" || event.key === "PageUp" || event.key === "End";
      const { x, rows, length, sorted } = series;
      const shown = breaks.nearestShown(x, position, length, back, sorted, rows);
      if (shown >= 0) position = shown;
    }
    this.#keyboard = { panel, key: series.key, position };
    this.#pointer = null;
    // The cursor moves on the frame drawn: what listeners changed while it
    // drew waits for the next.
    this.#finishFrame(false);
    const inspection = this.#inspection();
    if (!inspection) return;
    this.#keyboard.last = inspection;
    let text = describeInspection(inspection);
    // Arriving in a panel, the cursor names it and the annotations it alone draws.
    if (
      inspection.panel !== undefined &&
      (before?.panel !== inspection.panel || panel !== start.panel)
    )
      text = [
        `${panels.find(({ key }) => key === inspection.panel)?.label ?? inspection.panel}:`,
        ...this.#model.annotationSummaries(inspection.panel),
        text,
      ].join(" ");
    // Shift selects a range along the axis the cursor steps along: for
    // brushes along that axis, and for rectangles and lassos, which the
    // keyboard cannot draw. A range does not go on into a panel with
    // another scale along that axis.
    const axis = inspection.axis;
    // Nor does it go on along another axis.
    const crossed = from?.xGroup !== to?.xGroup;
    if (crossed || (this.#brushAnchor && this.#brushAnchor.axis !== axis)) this.#brushAnchor = null;
    if (
      event.shiftKey &&
      axis !== "item" &&
      (brush === axis || brush === "xy" || brush === "lasso")
    ) {
      const start = before?.axis === axis && !crossed ? before : inspection;
      this.#brushAnchor ??= { value: start.value, label: start.label, axis };
      const range = [this.#brushAnchor.value, inspection.value] as const;
      // In the panel as drawn: what listeners changed since waits for the next frame.
      this.#selectIn(
        { x: axis === "x" ? range : null, y: axis === "y" ? range : null, lasso: null },
        to,
      );
      const selection = this.#selection;
      const zooms = selection && this.#zooms(selection, to!);
      const hint = zooms ? " Press Enter to zoom to it." : "";
      text = `Selected ${this.#brushAnchor.label} to ${inspection.label}.${hint} ${text}`;
    } else {
      this.#brushAnchor = null;
    }
    this.#live.textContent = text;
  }
  /**
   * Arrow keys step through a layout mark's items in `panel`, in reading
   * order; Up and Down `enter` the panel at its first item. Arriving in a
   * facet panel or subplot, the cursor names it. Escape leaves a chart of
   * one layout mark's items.
   */
  #itemKey(event: KeyboardEvent, panel: string, enters = false) {
    const items = this.#model.items!;
    const from = this.#keyboard;
    const to = items.step(event.key, from, panel, enters);
    if (to === undefined) return;
    event.preventDefault();
    this.#keyboard = to;
    this.#pointer = null;
    this.#brushAnchor = null;
    this.#finishFrame(false);
    const inspection = this.#inspection();
    this.#live.textContent = to
      ? items.said(inspection && describeInspection(inspection), panel, from?.panel !== panel)
      : "";
  }
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

/** Columns right and rows up each key moves in a grid of cells. */
const CELL_STEPS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, 1],
  ArrowDown: [0, -1],
  Home: [Number.NEGATIVE_INFINITY, 0],
  End: [Number.POSITIVE_INFINITY, 0],
  PageUp: [0, Number.POSITIVE_INFINITY],
  PageDown: [0, Number.NEGATIVE_INFINITY],
};

/**
 * Position of the point of `series` placed nearest `value` along `axis` on
 * screen (on `scale`), never one an axis break hides; the first without a
 * `value`.
 */
function nearestTo(
  series: Series,
  value: number | undefined,
  scale: PositionScale,
  axis: "x" | "y",
): number {
  if (value === undefined) return 0;
  let best = 0;
  let distance = Infinity;
  const at = scale.map(value);
  for (let k = 0; k < series.length; k++) {
    const place = placeAt(series, axis, rowOf(series, k));
    if (scale.breaks?.hides(place)) continue;
    const d = Math.abs(scale.map(place) - at);
    if (d < distance) {
      best = k;
      distance = d;
    }
  }
  return best;
}

/** A sentence announcing a selection, with values as the axes label them. */
function describeSelection(selection: Selection, format: AxisFormat): string {
  if (selection.lasso) return "Selected a freehand region.";
  const { x, y } = selection;
  const ranges: string[] = [];
  if (x) ranges.push(`x from ${format.x(x[0])} to ${format.x(x[1])}`);
  if (y) ranges.push(`y from ${format.y(y[0])} to ${format.y(y[1])}`);
  return `Selected ${ranges.join(" and ")}.`;
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

/** Whether a plot holds a point of the chart. */
function holds(plot: PlotRect, x: number, y: number): boolean {
  return x >= plot.x && x <= plot.x + plot.width && y >= plot.y && y <= plot.y + plot.height;
}

/** What a hover event reports, as a key that changes when any of it does. */
function inspectionKey(inspection: Inspection | undefined): string {
  return inspection ? JSON.stringify(inspection) : "";
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
