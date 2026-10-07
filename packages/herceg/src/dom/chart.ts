// Browser runtime: mounts a chart into an element, renders through the
// shared scheduler, handles pointer, keyboard, legend, zoom, brushing, and
// sync, and emits events to the application.
//
// Layers, bottom to top: a canvas for dense marks (only when used), the SVG
// layer (grid and marks when not on canvas, rules, axes, title, pointer
// overlay), the HTML legend, the tooltip, and a visually hidden description.

import type { Table } from "../data/table.ts";
import { canvasMeasurer, estimateText, type MeasureText } from "../layout/text.ts";
import { rowOf, type Series } from "../marks/series.ts";
import { describeChart } from "../model/describe.ts";
import { type ChartConfig, ChartModel, type Inspection, type PanelInfo } from "../model/model.ts";
import { canvasRasterUrl, paintCanvas } from "../render/canvas.ts";
import { renderSvg } from "../render/svg.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { CloudPainter, PointGeometry, Rect, Scene } from "../scene/scene.ts";
import { ascending, Brush, DRAG_THRESHOLD, normalize } from "./brush.ts";
import { type ChartEvents, type ChartListener, Emitter } from "./events.ts";
import { Legend } from "./legend.ts";
import { observeVisibility, type Scheduled, schedule, unschedule } from "./scheduler.ts";
import { SvgLayer, svgElement } from "./svg-layer.ts";
import { broadcastCursor, broadcastViewport, join, type SyncMember } from "./sync.ts";
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
  #describedAt = -Infinity;
  /** What the current summary was written from; zooming and hovering do not change it. */
  #described: { config: unknown; key: string } | undefined;
  #describeTimer: ReturnType<typeof setTimeout> | 0 = 0;
  /**
   * A primary-button press on a plot until release: where it started, the
   * panel and x scale it started in, and what dragging does.
   */
  #press: {
    x: number;
    y: number;
    plot: Rect;
    scale: PositionScale;
    mode: "pan" | "brush" | "click";
    moved: boolean;
  } | null = null;
  readonly #brush: Brush;
  /** Where a keyboard selection (Shift + arrows) started: data x and its label. */
  #brushAnchor: { value: number; label: string } | null = null;
  readonly #events = new Emitter();
  /** What the last hover event reported, to emit only changes. */
  #hovered = "";
  readonly #cleanup: (() => void)[] = [];
  readonly #tables = new Map<Table, () => void>();
  #leaveSync: (() => void) | undefined;

  constructor(container: HTMLElement, options: ChartOptions) {
    const document = container.ownerDocument;
    this.#container = container;
    this.#options = options;
    this.model = new ChartModel(options);

    this.root = document.createElement("div");
    this.root.style.cssText = "position:relative;overflow:hidden;outline-offset:2px";
    this.root.tabIndex = 0;
    this.root.setAttribute("role", "figure");
    this.#svg = new SvgLayer(document, this.#id);
    this.#crosshairs = [
      svgElement(document, "line", { "stroke-width": "1", visibility: "hidden" }),
    ];
    this.#dots = svgElement(document, "g");
    this.#brush = new Brush(svgElement(document, "g"));
    this.#svg.overlay.append(this.#brush.element, ...this.#crosshairs, this.#dots);
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
    this.model.update(this.#options);
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

  /** The brushed x range (epoch ms for time axes), or null. */
  get selection(): readonly [number, number] | null {
    return this.#brush.selection;
  }

  /** Sets or clears (null) the brushed x range, as if the user had brushed it. */
  select(range: readonly [number, number] | null): void {
    const scale = this.model.xScale();
    const next = range && (scale ? normalize(scale, range[0], range[1]) : ascending(...range));
    if (!next) this.#brushAnchor = null;
    if (sameRange(next, this.#brush.selection)) return;
    this.#brush.selection = next;
    schedule(this);
    this.#events.emit("select", { x: next });
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
    if (!sameRange(before, after)) this.#events.emit("viewport", { domain: after });
  }

  #invalidate() {
    this.#dirty = true;
    schedule(this);
  }

  #setVisible(visible: boolean) {
    this.#visible = visible;
    if (visible && this.#dirty) schedule(this);
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
    // Horizontal drags pan or brush; the page still scrolls vertically.
    const drags = options.interaction?.zoom || options.interaction?.brush;
    this.root.style.touchAction = drags ? "pan-y" : "";
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
    for (const [i, line] of lines.entries()) {
      const inspection = drawn[i];
      if (!inspection) {
        line.setAttribute("visibility", "hidden");
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
      if (press) {
        press.moved ||= Math.hypot(x - press.x, y - press.y) >= DRAG_THRESHOLD;
        if (press.moved && press.mode === "pan") {
          this.#pan(press, x);
          return;
        }
        if (press.moved && press.mode === "brush") {
          if (!this.#brush.dragging)
            this.#brush.start(press.x, { plot: press.plot, x: press.scale });
          this.#brush.move(x);
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
        const px = Math.min(plot.x + plot.width, Math.max(plot.x, point.x));
        const factor = Math.exp(event.deltaY * 0.002);
        this.setViewport([
          scale.invert(px - (px - plot.x) * factor),
          scale.invert(px + (plot.x + plot.width - px) * factor),
        ]);
      },
      { passive: false },
    );
    on("pointerdown", (event) => {
      if (event.button !== 0 || !this.#scene) return;
      const { x, y } = local(event);
      // Presses on the axes, titles, gaps, or legend are not on the data.
      const panel = this.#panelAt(x, y);
      if (!panel) return;
      // Dragging brushes when brushing is on (Shift pans instead when zoom is
      // on too), pans when only zoom is on, and otherwise does nothing.
      const { brush, zoom } = this.#options.interaction ?? {};
      const mode = brush && !(zoom && event.shiftKey) ? "brush" : zoom ? "pan" : "click";
      this.#press = { x, y, plot: panel.plot, scale: panel.x, mode, moved: false };
      if (mode !== "click") root.setPointerCapture?.(event.pointerId);
    });
    on("pointerup", (event) => {
      const press = this.#press;
      this.#press = null;
      if (!press) return;
      if (!press.moved) {
        this.#click(local(event));
        return;
      }
      if (press.mode !== "brush") return;
      // The release point ends the brush, wherever the last move was.
      this.#brush.move(local(event).x);
      const range = this.#brush.end();
      // The drag band goes, whether or not the brush selects anything.
      schedule(this);
      if (!range) return;
      if (this.#zoomsToBrush(press.scale)) this.setViewport(range);
      else this.select(range);
    });
    // The browser took the pointer (a touch turned into scrolling, say).
    const cancel = () => {
      this.#press = null;
      this.#brush.cancel();
      schedule(this);
    };
    on("pointercancel", cancel);
    on("lostpointercapture", () => {
      if (this.#press) cancel();
    });
    on("dblclick", () => {
      if (this.#options.interaction?.zoom) this.setViewport(null);
    });

    on("keydown", (event) => this.#key(event));
    on("blur", () => {
      this.#keyboard = null;
      this.#brushAnchor = null;
      schedule(this);
    });
  }

  #pan(press: { x: number; plot: Rect; scale: PositionScale }, x: number) {
    // Shift in pixels and invert through the panel and scale the drag started with.
    const shift = press.x - x;
    const { plot } = press;
    this.setViewport([
      press.scale.invert(plot.x + shift),
      press.scale.invert(plot.x + plot.width + shift),
    ]);
  }

  /**
   * With zoom on, a brush zooms to its range rather than selecting it;
   * category axes cannot zoom, so their brushes select.
   */
  #zoomsToBrush(scale: PositionScale): boolean {
    return Boolean(this.#options.interaction?.zoom) && scale.type !== "band";
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
      const range = this.#brush.selection;
      const scale = this.model.xScale();
      if (!brush || !range || !scale || !this.#zoomsToBrush(scale)) return;
      event.preventDefault();
      this.#brushAnchor = null;
      this.select(null);
      this.setViewport(range);
      return;
    }
    event.preventDefault();
    if (event.key === "Escape") {
      this.#keyboard = null;
      this.#brushAnchor = null;
      this.#live.textContent = "";
      if (brush) this.select(null);
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
    if (brush && event.shiftKey && inspection.axis === "x") {
      const start = before?.axis === "x" ? before : inspection;
      this.#brushAnchor ??= { value: start.value, label: start.label };
      this.select([this.#brushAnchor.value, inspection.value]);
      const scale = this.model.xScale();
      const hint = scale && this.#zoomsToBrush(scale) ? " Press Enter to zoom to it." : "";
      text = `Selected ${this.#brushAnchor.label} to ${inspection.label}.${hint} ${text}`;
    } else {
      this.#brushAnchor = null;
    }
    this.#live.textContent = text;
  }
}

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
