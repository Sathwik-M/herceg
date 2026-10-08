// Browser runtime: mounts a chart into an element, renders through the
// shared scheduler, handles pointer, keyboard, legend, zoom, brushing, and
// sync, and emits events to the application.
//
// Layers, bottom to top: a canvas for dense marks (only when used), the SVG
// layer (grid and marks when not on canvas, rules, axes, title, pointer
// overlay), the HTML legend, the tooltip, and a visually hidden description.

import type { Table } from "../data/table.ts";
import { canvasMeasurer, estimateText, type MeasureText } from "../layout/text.ts";
import type { AxisFormat } from "../marks/mark.ts";
import { rowOf, type Series } from "../marks/series.ts";
import { describeChart } from "../model/describe.ts";
import {
  type ChartConfig,
  ChartModel,
  type Inspection,
  type PanelInfo,
  type YViewport,
} from "../model/model.ts";
import { canvasRasterUrl, paintCanvas } from "../render/canvas.ts";
import { renderSvg } from "../render/svg.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { CloudPainter, PointGeometry, Scene } from "../scene/scene.ts";
import { themeReadsPage } from "../theme.ts";
import { ascending, Brush, DRAG_THRESHOLD, normalize, type Selection } from "./brush.ts";
import { type ChartEvents, type ChartListener, Emitter } from "./events.ts";
import { Legend } from "./legend.ts";
import { readPage, watchPage } from "./page-theme.ts";
import { observeVisibility, type Scheduled, schedule, unschedule } from "./scheduler.ts";
import { SvgLayer, svgElement } from "./svg-layer.ts";
import {
  broadcastCursor,
  broadcastSelection,
  broadcastViewport,
  join,
  type SyncMember,
} from "./sync.ts";
import { describeInspection, Tooltip } from "./tooltip.ts";

export interface ChartOptions extends ChartConfig {
  /** Fixed size in CSS pixels; omitted dimensions follow the container. */
  width?: number;
  height?: number;
}

/** Above this many drawn points, "auto" moves marks from SVG to Canvas. */
const CANVAS_ABOVE = 4000;
/** Below this many, "auto" moves them back (hysteresis avoids flapping). */
const SVG_BELOW = 2000;
const DEFAULT_HEIGHT = 320;

let nextId = 0;
let sharedMeasure: MeasureText | undefined;

function measurer(document: Document): MeasureText {
  if (!sharedMeasure) {
    const context = document.createElement("canvas").getContext("2d");
    sharedMeasure = context ? canvasMeasurer(context) : estimateText;
  }
  return sharedMeasure;
}

const HIDDEN_TEXT =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";

export class Chart implements Scheduled, SyncMember {
  readonly model: ChartModel;
  readonly root: HTMLDivElement;
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
  #canvas: HTMLCanvasElement | null = null;
  #onCanvas = false;
  /** GPU painter for large point series once loaded; null when unavailable. */
  #clouds: CloudPainter | null | undefined;
  #cloudsLoading: Promise<void> | undefined;
  #scene: Scene | undefined;
  #visible = true;
  #dirty = true;
  #destroyed = false;
  #pointer: { x: number; y: number } | null = null;
  #syncedX: number | null = null;
  /** Keyboard cursor: a panel, a series, and a position in the series' part in the panel. */
  #keyboard: { panel: string; key: string; position: number } | null = null;
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
    panel: PanelInfo;
    mode: "pan" | "brush" | "click";
    moved: boolean;
  } | null = null;
  /** A press in a chart of a layout mark, which has nothing to drag: a click if released in place. */
  #tap: { x: number; y: number; moved: boolean } | null = null;
  readonly #brush: Brush;
  /** Where a keyboard selection (Shift + arrows) started: a value along the cursor's axis and its label. */
  #brushAnchor: { value: number; label: string } | null = null;
  readonly #events = new Emitter();
  /** What the last hover event reported, to emit only changes. */
  #hovered = "";
  readonly #cleanup: (() => void)[] = [];
  readonly #tables = new Map<Table, () => void>();
  #leaveSync: (() => void) | undefined;
  #unwatchPage: (() => void) | undefined;
  /** The page changed since its theme was last read; read again on the next frame. */
  #pageChanged = false;

  constructor(container: HTMLElement, options: ChartOptions) {
    const document = container.ownerDocument;
    this.#container = container;
    this.#options = options;
    this.model = readPage(container, (page) => new ChartModel(options, page));

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
    this.#brush = new Brush(svgElement(document, "g"), `${this.#id}-brush`);
    this.#svg.overlay.append(this.#brush.element, ...this.#crosshairs, this.#dots, this.#outline);
    this.#legend = new Legend(document, (key) => {
      if (this.model.hidden.has(key)) this.model.hidden.delete(key);
      else this.model.hidden.add(key);
      this.#invalidate();
    });
    this.#tooltip = new Tooltip(document);
    this.#description = document.createElement("div");
    this.#description.id = `${this.#id}-description`;
    this.#description.style.cssText = HIDDEN_TEXT;
    this.#live = document.createElement("div");
    this.#live.setAttribute("aria-live", "polite");
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
          if (width !== this.model.width || height !== this.model.height) this.#invalidate();
        });
        observer.observe(container, { box: "border-box" });
        this.#cleanup.push(() => observer.disconnect());
      }
      // The first frame renders synchronously so the chart is never blank.
      this.flush();
    } catch (error) {
      // Nothing returns a handle to the caller, so undo everything here.
      this.destroy();
      throw error;
    }
  }

  get visible(): boolean {
    return this.#visible;
  }

  /** Replaces options. Unspecified keys keep their current values. */
  update(options: Partial<ChartOptions>): void {
    this.#options = { ...this.#options, ...options };
    readPage(this.#container, (page) => this.model.update(this.#options, page));
    // The page was just read; a change it had is in the theme now.
    this.#pageChanged = false;
    this.#applyOptions();
    this.#invalidate();
  }

  /** Shows an x range (epoch ms for time axes), or null to fit the data. */
  setViewport(domain: readonly [number, number] | null): void {
    this.syncViewport(domain);
    // A viewport listener may have changed the viewport again; share where
    // it ended up, not the request.
    const sync = this.#options.interaction?.sync;
    if (sync) broadcastViewport(sync, this, this.model.viewport);
  }

  /**
   * Shows a y range of the left axis, or null to fit the data. In charts with
   * a right axis, `right` is its range; by default it shows what the same
   * pixels show there.
   */
  setYViewport(domain: readonly [number, number] | null, right?: readonly [number, number]): void {
    const panel = this.model.panels()[0];
    const scale = panel?.yRight;
    const across = (value: number) => scale!.invert(panel!.y.map(value));
    const mapped = domain && scale ? ([across(domain[0]), across(domain[1])] as const) : undefined;
    this.#setYViewport(domain && { y: domain, yRight: right ?? mapped });
  }

  /**
   * Calls `listener` on every `type` event until the returned function is
   * called.
   *
   * ```ts
   * chart.on("select", ({ x }) => x && other.setViewport(x));
   * ```
   */
  on<K extends keyof ChartEvents>(type: K, listener: ChartListener<K>): () => void {
    return this.#events.on(type, listener);
  }

  /** What is brushed (x and y ranges, epoch ms for time axes, and a lasso's outline), or null. */
  get selection(): Selection | null {
    return this.#brush.selection;
  }

  /**
   * Sets or clears (null) the selection, as if the user had brushed it; an
   * x range alone may be given as a pair.
   */
  select(selection: Selection | readonly [number, number] | null): void {
    this.syncSelection(selection);
    const sync = this.#options.interaction?.sync;
    if (sync) broadcastSelection(sync, this, this.#brush.selection);
  }

  syncSelection(selection: Selection | readonly [number, number] | null): void {
    const given = Array.isArray(selection)
      ? { x: selection as readonly [number, number], y: null, lasso: null }
      : (selection as Selection | null);
    const panel = this.model.panels()[0];
    const fit = (range: readonly [number, number] | null, scale: PositionScale | undefined) =>
      range && (scale ? normalize(scale, range[0], range[1]) : ascending(...range));
    const next =
      given && (given.x || given.y || given.lasso)
        ? { x: fit(given.x, panel?.x), y: fit(given.y, panel?.y), lasso: given.lasso }
        : null;
    if (!next) this.#brushAnchor = null;
    if (sameSelection(next, this.#brush.selection)) return;
    this.#brush.selection = next;
    schedule(this);
    this.#events.emit("select", next ?? { x: null, y: null, lasso: null });
  }

  /**
   * Pending while the chart loads its GPU painter for large point series,
   * which it draws once loaded; undefined when nothing is pending.
   */
  get loading(): Promise<void> | undefined {
    return this.#cloudsLoading;
  }

  /** Renders now instead of on the next frame. */
  render(): void {
    // The container may have changed since the observer last reported.
    this.#remember();
    this.#dirty = true;
    this.flush();
  }

  /** Standalone SVG of the current state, for export. */
  toSVG(): string {
    // Apply pending changes and the current container size first, so the
    // export reflects the latest state.
    this.render();
    const document = this.root.ownerDocument;
    return renderSvg(this.model.scene(measurer(document)), {
      idPrefix: `${this.#id}-export`,
      encodeRaster: (mark) => canvasRasterUrl(mark, document),
      ...(this.#options.description ? { description: this.#options.description } : {}),
    });
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    unschedule(this);
    if (this.#describeTimer !== 0) clearTimeout(this.#describeTimer);
    for (const stop of this.#cleanup) stop();
    this.#unwatchPage?.();
    for (const stop of this.#tables.values()) stop();
    this.#tables.clear();
    this.#clouds?.release(this);
    this.#events.clear();
    this.model.dispose();
    this.root.remove();
  }

  /** Called by the scheduler. */
  flush(): void {
    if (this.#destroyed) return;
    if (this.#pageChanged) {
      this.#pageChanged = false;
      if (readPage(this.#container, (page) => this.model.refreshTheme(page))) this.#dirty = true;
    }
    if (this.#dirty) {
      this.#dirty = false;
      this.#draw();
    }
    this.#drawOverlay();
  }

  syncCursor(x: number | null): void {
    this.#syncedX = x;
    schedule(this);
  }

  syncViewport(domain: readonly [number, number] | null): void {
    const before = this.model.viewport;
    this.model.setViewport(domain);
    this.#invalidate();
    const after = this.model.viewport;
    if (!sameRange(before, after))
      this.#events.emit("viewport", { domain: after, y: this.model.yViewport?.y ?? null });
  }

  #invalidate() {
    this.#dirty = true;
    schedule(this);
  }

  #setVisible(visible: boolean) {
    this.#visible = visible;
    if (visible && (this.#dirty || this.#pageChanged)) schedule(this);
  }

  #applyOptions() {
    const options = this.#options;
    this.root.setAttribute("aria-label", options.title ?? "Chart");
    // Re-subscribe to the tables the marks read.
    const tables = new Set(
      options.marks.map((mark) => mark.table).filter((table) => table !== undefined),
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
          table.subscribe(() => this.#invalidate()),
        );
    }
    const sync = options.interaction?.sync;
    this.#leaveSync?.();
    this.#leaveSync = sync ? join(sync, this) : undefined;
    this.#brush.mode = options.interaction?.brush ?? "x";
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
    // Themes that follow the page re-read it when it may have switched themes.
    const follows = themeReadsPage(options.theme);
    if (follows && !this.#unwatchPage) {
      this.#unwatchPage = watchPage(this.#container.ownerDocument, () => {
        this.#pageChanged = true;
        schedule(this);
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
    if (this.#clouds && !this.#clouds.usable) this.#clouds = undefined;
    return true;
  }

  #loadClouds(): void {
    if (this.#cloudsLoading) return;
    this.#cloudsLoading = import("../render/webgl.ts")
      .then((module) => module.cloudPainter() ?? null)
      .catch(() => null)
      .then((painter) => {
        this.#clouds = painter;
        this.#cloudsLoading = undefined;
        // Draw at once, so `loading` settles with the points on screen.
        this.#dirty = true;
        this.flush();
      });
  }

  #draw() {
    const { width, height } = this.#size();
    const window = this.root.ownerDocument.defaultView;
    this.model.setSize(width, height, window?.devicePixelRatio ?? 1);
    this.root.style.width = `${width}px`;
    this.root.style.height = `${height}px`;
    const scene = this.model.scene(measurer(this.root.ownerDocument), this.#cloudsAllowed());
    this.#scene = scene;
    const clouds = scene.panels.some((panel) =>
      panel.marks.some(
        (mark) => mark.kind === "point" && (mark as unknown as PointGeometry).cloud !== undefined,
      ),
    );
    // A null painter means WebGL is unavailable; it is not loaded again.
    if (clouds && this.#clouds === undefined) this.#loadClouds();

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
        defer: clouds && !this.#clouds,
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
    this.#describe();
  }

  #describe() {
    const { config } = this.model;
    const key = `${config.marks.map((mark) => mark.table?.version ?? 0).join(",")}|${[...this.model.hidden].join(",")}`;
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
    this.#description.textContent = `${describeChart(this.model)} Focus the chart and use the arrow keys to read values.`;
  }

  /** The point the pointer or the keyboard is on. */
  #inspection(): Inspection | undefined {
    if (!this.#scene) return undefined;
    // The model applies the configured tooltip mode.
    if (this.#pointer) return this.model.inspect(this.#pointer.x, this.#pointer.y);
    const keyboard = this.#keyboard;
    if (keyboard && this.model.layout) return this.model.inspectItem(keyboard.key);
    if (keyboard)
      return this.model.inspectPosition(keyboard.key, keyboard.position, keyboard.panel);
    return undefined;
  }

  /** Each panel's points at the x another chart's cursor shares. */
  #synced(): Inspection[] {
    const x = this.#syncedX;
    if (x === null || !this.#sharesCursor() || this.model.series().length === 0) return [];
    return this.model.panels().flatMap(({ plot, x: scale }) => {
      // Outside a panel's x range, the pixel would land in a neighboring panel.
      const px = scale.map(x);
      if (!(px >= plot.x && px <= plot.x + plot.width)) return [];
      const inspection = this.model.inspect(px, plot.y + plot.height / 2, "nearest-x");
      return inspection ? [inspection] : [];
    });
  }

  /**
   * Synced cursors are x positions. Charts whose data is placed along y
   * (horizontal bars) measure values on x, so they neither share nor follow them.
   */
  #sharesCursor(): boolean {
    return this.model.cursorAxis() === "x";
  }

  #drawOverlay() {
    const scene = this.#scene;
    if (!scene) return;
    const { theme } = scene;
    const panels = this.model.panels();
    this.#brush.draw(panels, theme);
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
      this.#pointer = local(event);
      this.#keyboard = null;
      this.#brushAnchor = null;
      const press = this.#press;
      const { x, y } = this.#pointer;
      const tap = this.#tap;
      // A press that strays is not a click, even if it comes back.
      if (tap) tap.moved ||= Math.hypot(x - tap.x, y - tap.y) >= DRAG_THRESHOLD;
      if (press) {
        press.moved ||= Math.hypot(x - press.x, y - press.y) >= DRAG_THRESHOLD;
        if (press.moved && press.mode === "pan") {
          this.#pan(press, x, y);
          return;
        }
        if (press.moved && press.mode === "brush") {
          if (!this.#brush.dragging) this.#brush.start(press.x, press.y, press.panel);
          this.#brush.move(x, y);
        }
      }
      schedule(this);
      const sync = this.#options.interaction?.sync;
      // Share the data x under the pointer; over no panel, none.
      if (sync && this.#sharesCursor()) {
        const panel = this.#panelAt(x, y);
        broadcastCursor(sync, this, panel ? panel.x.invert(x) : null);
      }
    });
    on("pointerleave", () => {
      this.#pointer = null;
      // A captured drag leaves only when released; any other press ends here.
      this.#press = null;
      this.#tap = null;
      this.#brush.cancel();
      schedule(this);
      const sync = this.#options.interaction?.sync;
      if (sync) broadcastCursor(sync, this, null);
    });

    on(
      "wheel",
      (event) => {
        if (!this.#options.interaction?.zoom || !this.#scene) return;
        event.preventDefault();
        const point = local(event);
        const panel = this.#panelAt(point.x, point.y) ?? this.model.panels()[0];
        if (!panel) return;
        // Zoom in pixel space and invert, so the value under the pointer stays
        // put on any scale type, including log.
        const { plot, x: scale } = panel;
        const zoom = this.#zoomAxes(panel);
        const factor = Math.exp(event.deltaY * 0.002);
        if (zoom.x) {
          const px = Math.min(plot.x + plot.width, Math.max(plot.x, point.x));
          this.setViewport([
            scale.invert(px - (px - plot.x) * factor),
            scale.invert(px + (plot.x + plot.width - px) * factor),
          ]);
        }
        if (zoom.y) {
          const py = Math.min(plot.y + plot.height, Math.max(plot.y, point.y));
          this.#zoomY(
            panel,
            py + (plot.y + plot.height - py) * factor,
            py - (py - plot.y) * factor,
          );
        }
      },
      { passive: false },
    );
    on("pointerdown", (event) => {
      if (event.button !== 0 || !this.#scene) return;
      const { x, y } = local(event);
      if (this.model.layout) {
        this.#tap = { x, y, moved: false };
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
      this.#tap = null;
      if (tap) {
        if (!tap.moved) this.#click(local(event));
        return;
      }
      const press = this.#press;
      this.#press = null;
      if (!press) return;
      if (!press.moved) {
        this.#click(local(event));
        return;
      }
      if (press.mode !== "brush") return;
      // The release point ends the brush, wherever the last move was.
      const end = local(event);
      this.#brush.move(end.x, end.y);
      const selection = this.#brush.end();
      // The drag outline goes, whether or not the brush selects anything.
      schedule(this);
      if (!selection) return;
      if (this.#zooms(selection, press.panel)) {
        this.#zoomTo(selection, press.panel);
        return;
      }
      this.select(selection);
      const selected = this.#brush.selection;
      if (selected) this.#live.textContent = describeSelection(selected, this.model.formatsOf());
    });
    // The browser took the pointer (a touch turned into scrolling, say).
    const cancel = () => {
      this.#press = null;
      this.#tap = null;
      this.#brush.cancel();
      schedule(this);
    };
    on("pointercancel", cancel);
    on("lostpointercapture", () => {
      if (this.#press) cancel();
    });
    // Double click resets both axes, also one zoomed before `interaction.zoom` stopped naming it.
    on("dblclick", () => {
      if (!this.#options.interaction?.zoom) return;
      this.setViewport(null);
      this.setYViewport(null);
    });

    on("keydown", (event) => this.#key(event));
    on("blur", () => {
      this.#keyboard = null;
      this.#brushAnchor = null;
      schedule(this);
    });
  }

  /** Moves the zoomable axes by a drag's shift, through the scales of the panel it started in. */
  #pan(press: { x: number; y: number; panel: PanelInfo }, x: number, y: number) {
    const { panel } = press;
    const { plot } = panel;
    const zoom = this.#zoomAxes(panel);
    if (zoom.x) {
      const shift = press.x - x;
      this.setViewport([
        panel.x.invert(plot.x + shift),
        panel.x.invert(plot.x + plot.width + shift),
      ]);
    }
    if (zoom.y) {
      const shift = press.y - y;
      this.#zoomY(panel, plot.y + plot.height + shift, plot.y + shift);
    }
  }

  /**
   * The axes the wheel, drags, and brushes zoom: those `interaction.zoom`
   * names, less category axes, which do not zoom.
   */
  #zoomAxes(panel: PanelInfo): { x: boolean; y: boolean } {
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
  #zooms(selection: Selection, panel: PanelInfo): boolean {
    if (selection.lasso || !(selection.x || selection.y)) return false;
    const zoom = this.#zoomAxes(panel);
    return (!selection.x || zoom.x) && (!selection.y || zoom.y);
  }

  /** Zooms to a brushed selection. */
  #zoomTo(selection: Selection, panel: PanelInfo) {
    if (selection.x) this.setViewport(selection.x);
    if (selection.y) this.#zoomY(panel, panel.y.map(selection.y[0]), panel.y.map(selection.y[1]));
  }

  /**
   * Shows the y values between two pixels of a panel: on the left axis, and
   * on the right axis what the same pixels show there.
   */
  #zoomY(panel: PanelInfo, bottom: number, top: number) {
    const range = (scale: PositionScale) => [scale.invert(bottom), scale.invert(top)] as const;
    this.#setYViewport({ y: range(panel.y), yRight: panel.yRight && range(panel.yRight) });
  }

  #setYViewport(viewport: YViewport | null) {
    const before = this.model.yViewport;
    this.model.setYViewport(viewport);
    this.#invalidate();
    const after = this.model.yViewport;
    if (!sameRange(before?.y ?? null, after?.y ?? null))
      this.#events.emit("viewport", { domain: this.model.viewport, y: after?.y ?? null });
  }

  /** The panel whose plot holds a point of the chart. */
  #panelAt(x: number, y: number): PanelInfo | undefined {
    return this.model
      .panels()
      .find(
        ({ plot }) =>
          x >= plot.x && x <= plot.x + plot.width && y >= plot.y && y <= plot.y + plot.height,
      );
  }

  /** A press released without dragging: clears the selection and reports the data there. */
  #click(point: { x: number; y: number }) {
    if (this.#options.interaction?.brush) this.select(null);
    if (this.#events.has("click"))
      this.#events.emit("click", { inspection: this.model.inspect(point.x, point.y) });
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
    if (event.target !== this.root) return;
    if (this.model.layout) {
      this.#itemKey(event);
      return;
    }
    const keys = [
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Escape",
      "Enter",
    ];
    const panels = this.model.panels();
    const across = panels.length > 1 && (event.key === "ArrowUp" || event.key === "ArrowDown");
    if (!keys.includes(event.key) && !across) return;
    // The first visible series with points in a panel.
    const firstIn = (panel: string) =>
      this.model.panelSeries(panel).find((s) => !this.model.hidden.has(s.key) && s.length > 0);
    let index = Math.max(
      0,
      panels.findIndex(({ key }) => key === this.#keyboard?.panel),
    );
    if (across) {
      const step = event.key === "ArrowUp" ? -1 : 1;
      let next = index + step;
      while (next >= 0 && next < panels.length && !firstIn(panels[next]!.key)) next += step;
      if (next < 0 || next >= panels.length) return;
      index = next;
    }
    const panel = panels[index]?.key ?? "";
    const series = firstIn(panel);
    if (!series) return;
    const brush = this.#options.interaction?.brush;
    if (event.key === "Enter") {
      const selection = this.#brush.selection;
      const first = panels[0];
      if (!selection || !first || !this.#zooms(selection, first)) return;
      event.preventDefault();
      this.#brushAnchor = null;
      this.select(null);
      this.#zoomTo(selection, first);
      return;
    }
    event.preventDefault();
    if (event.key === "Escape") {
      this.#keyboard = null;
      this.#brushAnchor = null;
      this.#live.textContent = "";
      if (this.#brush.selection) this.select(null);
      schedule(this);
      return;
    }
    const before = this.#keyboard ? this.#inspection() : undefined;
    const keyboard = this.#keyboard;
    const current =
      keyboard?.key === series.key && keyboard.panel === panel ? keyboard.position : -1;
    const page = Math.max(1, Math.round(series.length / 10));
    let position = Math.max(0, current);
    if (across) position = nearestTo(series, before?.axis === "x" ? before.value : undefined);
    else if (event.key === "ArrowLeft") position -= 1;
    else if (event.key === "ArrowRight") position = current < 0 ? 0 : current + 1;
    else if (event.key === "PageUp") position -= page;
    else if (event.key === "PageDown") position += page;
    else if (event.key === "Home") position = 0;
    else if (event.key === "End") position = series.length - 1;
    position = Math.min(series.length - 1, Math.max(0, position));
    this.#keyboard = { panel, key: series.key, position };
    this.#pointer = null;
    this.flush();
    const inspection = this.#inspection();
    if (!inspection) return;
    let text = describeInspection(inspection);
    if (across || (inspection.panel !== undefined && before?.panel !== inspection.panel))
      text = `${inspection.panel}: ${text}`;
    // Shift selects a range along the axis the cursor steps along: for
    // brushes along that axis, and for rectangles and lassos, which the
    // keyboard cannot draw.
    const axis = inspection.axis;
    if (
      event.shiftKey &&
      axis !== "item" &&
      (brush === axis || brush === "xy" || brush === "lasso")
    ) {
      const start = before?.axis === axis ? before : inspection;
      this.#brushAnchor ??= { value: start.value, label: start.label };
      const range = [this.#brushAnchor.value, inspection.value] as const;
      this.select({ x: axis === "x" ? range : null, y: axis === "y" ? range : null, lasso: null });
      const selection = this.#brush.selection;
      const zooms = selection && this.#zooms(selection, panels[index]!);
      const hint = zooms ? " Press Enter to zoom to it." : "";
      text = `Selected ${this.#brushAnchor.label} to ${inspection.label}.${hint} ${text}`;
    } else {
      this.#brushAnchor = null;
    }
    this.#live.textContent = text;
  }
  /** Arrow keys step through a layout mark's items, in reading order; Escape leaves them. */
  #itemKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      this.#keyboard = null;
      this.#live.textContent = "";
      schedule(this);
      return;
    }
    const step = ITEM_STEPS[event.key];
    if (step === undefined) return;
    event.preventDefault();
    const key = this.model.stepItem(this.#keyboard?.key, step);
    if (key === undefined) return;
    this.#keyboard = { panel: "", key, position: 0 };
    this.#pointer = null;
    this.flush();
    const inspection = this.#inspection();
    if (inspection) this.#live.textContent = describeInspection(inspection);
  }
}

/** Steps for the keys that move through the items of a layout mark. */
const ITEM_STEPS: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  PageDown: 5,
  PageUp: -5,
  Home: -Infinity,
  End: Infinity,
};

/** Position of the point of `series` whose x is nearest `x`; the first without one. */
function nearestTo(series: Series, x: number | undefined): number {
  if (x === undefined) return 0;
  let best = 0;
  let distance = Infinity;
  for (let k = 0; k < series.length; k++) {
    const d = Math.abs(series.x[rowOf(series, k)]! - x);
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

/** Two ranges hold the same values, or are both null. */
function sameRange(
  a: readonly [number, number] | null,
  b: readonly [number, number] | null,
): boolean {
  return a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1]);
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
 *   y: { label: "Latency (ms)" },
 * });
 * ```
 */
export function createChart(container: HTMLElement, options: ChartOptions): Chart {
  return new Chart(container, options);
}
