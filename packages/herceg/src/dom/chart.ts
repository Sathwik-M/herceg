// Browser runtime: mounts a chart into an element, renders through the
// shared scheduler, and handles pointer, keyboard, legend, zoom, and sync.
//
// Layers, bottom to top: a canvas for dense marks (only when used), the SVG
// layer (grid and marks when not on canvas, rules, axes, title, pointer
// overlay), the HTML legend, the tooltip, and a visually hidden description.

import type { Table } from "../data/table.ts";
import { canvasMeasurer, estimateText, type MeasureText } from "../layout/text.ts";
import { describeChart } from "../model/describe.ts";
import { type ChartConfig, ChartModel, type Inspection } from "../model/model.ts";
import { canvasRasterUrl, paintCanvas } from "../render/canvas.ts";
import { renderSvg } from "../render/svg.ts";
import type { CloudPainter } from "../render/webgl.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { Scene } from "../scene/scene.ts";
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
  readonly #crosshair: SVGLineElement;
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
  /** Keyboard cursor: a series and a position in it. */
  #keyboard: { key: string; position: number } | null = null;
  #describedAt = -Infinity;
  /** What the current summary was written from; zooming and hovering do not change it. */
  #described: { config: unknown; key: string } | undefined;
  #describeTimer: ReturnType<typeof setTimeout> | 0 = 0;
  #drag: { x: number; scale: PositionScale } | null = null;
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
    this.#crosshair = svgElement(document, "line", { "stroke-width": "1", visibility: "hidden" });
    this.#dots = svgElement(document, "g");
    this.#svg.overlay.append(this.#crosshair, this.#dots);
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
    const sync = this.#options.interaction?.sync;
    if (sync) broadcastViewport(sync, this, domain);
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
    this.model.setViewport(domain);
    this.#invalidate();
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
    const clouds = scene.marks.some((mark) => mark.kind === "point" && mark.cloud !== undefined);
    if (clouds && !this.#clouds) this.#loadClouds();

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

  #inspection(): Inspection | undefined {
    const scene = this.#scene;
    if (!scene) return undefined;
    // The model applies the configured tooltip mode.
    if (this.#pointer) return this.model.inspect(this.#pointer.x, this.#pointer.y);
    if (this.#keyboard)
      return this.model.inspectPosition(this.#keyboard.key, this.#keyboard.position);
    const x = this.#syncedX;
    if (x === null) return undefined;
    const px = this.model.series().length > 0 ? this.#xToPixel(x) : undefined;
    if (px === undefined) return undefined;
    return this.model.inspect(px, scene.plot.y + scene.plot.height / 2, "nearest-x");
  }

  #xToPixel(x: number): number | undefined {
    const px = this.model.xScale()?.map(x);
    return px !== undefined && Number.isFinite(px) ? px : undefined;
  }

  #drawOverlay() {
    const scene = this.#scene;
    if (!scene) return;
    const showTooltip = this.#options.tooltip ?? true;
    const inspection = showTooltip ? this.#inspection() : undefined;
    const { theme, plot } = scene;
    const document = this.root.ownerDocument;
    if (!inspection) {
      this.#crosshair.setAttribute("visibility", "hidden");
      this.#dots.replaceChildren();
      this.#tooltip.hide();
      return;
    }
    const x = String(Math.round(inspection.px) + 0.5);
    this.#crosshair.setAttribute("x1", x);
    this.#crosshair.setAttribute("x2", x);
    this.#crosshair.setAttribute("y1", String(plot.y));
    this.#crosshair.setAttribute("y2", String(plot.y + plot.height));
    this.#crosshair.setAttribute("stroke", theme.axis);
    this.#crosshair.setAttribute("visibility", "visible");
    this.#dots.replaceChildren(
      ...inspection.points.map((point) =>
        svgElement(document, "circle", {
          cx: String(point.px),
          cy: String(point.py),
          r: "3.5",
          fill: point.color,
          stroke: theme.background === "transparent" ? "#ffffff" : theme.background,
          "stroke-width": "1.5",
        }),
      ),
    );
    // Synced charts show the cursor; only the chart being used shows a tooltip.
    if (this.#pointer || this.#keyboard) {
      const anchor = this.#pointer ?? { x: inspection.px, y: plot.y + plot.height / 2 };
      this.#tooltip.show(inspection, theme, anchor, { width: scene.width, height: scene.height });
    } else {
      this.#tooltip.hide();
    }
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
      if (this.#drag) {
        this.#pan(this.#pointer.x);
        return;
      }
      schedule(this);
      const sync = this.#options.interaction?.sync;
      const scale = this.model.xScale();
      // Share the data x under the pointer.
      if (sync && scale) broadcastCursor(sync, this, scale.invert(this.#pointer.x));
    });
    on("pointerleave", () => {
      this.#pointer = null;
      this.#drag = null;
      schedule(this);
      const sync = this.#options.interaction?.sync;
      if (sync) broadcastCursor(sync, this, null);
    });

    on(
      "wheel",
      (event) => {
        if (!this.#options.interaction?.zoom || !this.#scene) return;
        event.preventDefault();
        const scale = this.model.xScale();
        if (!scale) return;
        // Zoom in pixel space and invert, so the value under the pointer stays
        // put on any scale type, including log.
        const { plot } = this.#scene;
        const px = Math.min(plot.x + plot.width, Math.max(plot.x, local(event).x));
        const factor = Math.exp(event.deltaY * 0.002);
        this.setViewport([
          scale.invert(px - (px - plot.x) * factor),
          scale.invert(px + (plot.x + plot.width - px) * factor),
        ]);
      },
      { passive: false },
    );
    on("pointerdown", (event) => {
      if (!this.#options.interaction?.zoom || event.button !== 0) return;
      const scale = this.model.xScale();
      if (!scale) return;
      this.#drag = { x: local(event).x, scale };
      root.setPointerCapture?.(event.pointerId);
    });
    on("pointerup", () => {
      this.#drag = null;
    });
    on("dblclick", () => {
      if (this.#options.interaction?.zoom) this.setViewport(null);
    });

    on("keydown", (event) => this.#key(event));
    on("blur", () => {
      this.#keyboard = null;
      schedule(this);
    });
  }

  #pan(x: number) {
    const drag = this.#drag;
    const scene = this.#scene;
    if (!drag || !scene) return;
    // Shift in pixels and invert through the scale the drag started with.
    const shift = drag.x - x;
    const { plot } = scene;
    this.setViewport([
      drag.scale.invert(plot.x + shift),
      drag.scale.invert(plot.x + plot.width + shift),
    ]);
  }

  /**
   * Arrow keys step through the points of the first visible series. The
   * cursor keeps its position in the series, so repeated x values are each
   * reachable.
   */
  #key(event: KeyboardEvent) {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown", "Escape"];
    if (!keys.includes(event.key)) return;
    const series = this.model.series().find((s) => !this.model.hidden.has(s.key) && s.length > 0);
    if (!series) return;
    event.preventDefault();
    if (event.key === "Escape") {
      this.#keyboard = null;
      this.#live.textContent = "";
      schedule(this);
      return;
    }
    const current = this.#keyboard?.key === series.key ? this.#keyboard.position : -1;
    const page = Math.max(1, Math.round(series.length / 10));
    let position = Math.max(0, current);
    if (event.key === "ArrowLeft") position -= 1;
    else if (event.key === "ArrowRight") position = current < 0 ? 0 : current + 1;
    else if (event.key === "PageUp") position -= page;
    else if (event.key === "PageDown") position += page;
    else if (event.key === "Home") position = 0;
    else if (event.key === "End") position = series.length - 1;
    position = Math.min(series.length - 1, Math.max(0, position));
    this.#keyboard = { key: series.key, position };
    this.#pointer = null;
    this.flush();
    const inspection = this.#inspection();
    if (inspection) this.#live.textContent = describeInspection(inspection);
  }
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
