// Panning and zooming maps, and lassoing their rows. The map's view is the
// chart's viewport, in the plane's units (see geo.ts), so every change goes
// through `setViewport` and is reported as a `viewport` event: the wheel
// zooms at the pointer, a drag pans, double-click and 0 show the whole map,
// Shift with the arrow keys pans, plus and minus zoom, and the toolbar's
// buttons do all of it for people who cannot drag. With a "lasso" brush, a
// drag lassos instead (Shift-drag, or the toolbar's lasso button turned
// off, pans), and the lasso is the chart's selection, kept on the plane.

import type { LayoutResult, PlaneView } from "../marks/layout-mark.ts";
import type { ChartConfig } from "../model/model.ts";
import type { Scene } from "../scene/scene.ts";
import type { Theme } from "../theme.ts";
import { Brush, type BrushPanel } from "./brush.ts";
import { DRAG_THRESHOLD } from "./brushed.ts";
import type { Controls as ChartControls, ControlsHost } from "./controls.ts";
import { RESET_GLYPH, Toolbar } from "./toolbar.ts";

/** Magnification per key press or button click. */
const ZOOM = 1.25;
/** The share of the map's room a key press or button click pans. */
const PAN = 1 / 8;
/**
 * The wheel, keys, and buttons zoom between the whole map and this many
 * times its scale; a view set beyond either is left there.
 */
const MAX_ZOOM = 256;

let lassos = 0;

/** The map as last drawn: its plane's scales across the room, and what a viewport would show. */
type Plane = NonNullable<LayoutResult["plane"]>;

/** A view to change: the plane's ranges across the room and its zoom, and the plane drawn (its room). */
interface View extends PlaneView {
  plane: Plane;
}

export class Controls implements ChartControls {
  readonly #host: ControlsHost;
  readonly #root: HTMLElement;
  readonly #toolbar: Toolbar;
  readonly #stop: (() => void)[] = [];
  /** Draws a lasso being dragged, and the chart's lasso selection; made for charts that lasso. */
  #brush: Brush | undefined;
  #zooms = false;
  #lassos = false;
  /** With both a lasso and zoom, whether a plain drag lassos (the toolbar's toggle). */
  #lassoing = true;
  #theme: Theme | undefined;
  /**
   * A press that may become a drag: where it started, what it does, the
   * plane drawn then (which a lasso is drawn on), and the view a pan moves.
   */
  #press: {
    pointer: number;
    x: number;
    y: number;
    mode: "pan" | "lasso";
    plane: Plane;
    view: View;
    moved: boolean;
  } | null = null;

  constructor(host: ControlsHost) {
    this.#host = host;
    const root = host.chart.root;
    this.#root = root;
    const pan = (dx: number, dy: number, said: string) => () => this.#pan(dx, dy, said);
    this.#toolbar = new Toolbar(root, "Map", [
      {
        label: "Lasso",
        glyph: "M8 3c3 0 5 1.4 5 3.2S11 9.5 8 9.5 3 8 3 6.2 5 3 8 3zM5.5 9 4.5 13",
        act: () => {
          this.#lassoing = !this.#lassoing;
        },
        pressed: () => this.#lassoing,
        hidden: () => !this.#lassos,
      },
      { label: "Zoom in", glyph: "M8 4v8M4 8h8", act: () => this.#zoomBy(ZOOM) },
      { label: "Zoom out", glyph: "M4 8h8", act: () => this.#zoomBy(1 / ZOOM) },
      { label: "Pan left", glyph: "M10 4 6 8l4 4", act: pan(-1, 0, "left") },
      { label: "Pan right", glyph: "M6 4l4 4-4 4", act: pan(1, 0, "right") },
      { label: "Pan up", glyph: "M4 10l4-4 4 4", act: pan(0, -1, "up") },
      { label: "Pan down", glyph: "M4 6l4 4 4-4", act: pan(0, 1, "down") },
      { label: "Show the whole map", glyph: RESET_GLYPH, act: () => this.#reset(true) },
    ]);
    this.#listen();
    // A change of selection alone draws no new scene, but changes the lasso drawn.
    this.#stop.push(
      host.chart.on("select", () => {
        if (this.#press?.mode !== "lasso") this.#drawLasso();
      }),
    );
  }

  get busy(): boolean {
    return this.#press?.mode === "pan" && this.#press.moved;
  }

  update(config: ChartConfig): void {
    const { zoom, brush } = config.interaction ?? {};
    this.#zooms = !!zoom;
    this.#lassos = brush === "lasso";
    if (this.#lassos && !this.#brush) {
      const group = this.#root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
      this.#host.overlay.append(group);
      this.#brush = new Brush(group, `herceg-map-lasso-${++lassos}`);
      this.#brush.mode = "lasso";
    } else if (!this.#lassos && this.#brush) {
      this.#brush.element.remove();
      this.#brush = undefined;
    }
    // The toolbar pans and zooms; its lasso toggle is there when a drag could do either.
    this.#toolbar.shown = this.#zooms;
    this.#toolbar.refresh();
    this.#root.style.touchAction = this.#zooms || this.#lassos ? "none" : "";
  }

  draw(scene: Scene): void {
    this.#theme = scene.theme;
    this.#toolbar.style(scene.theme);
    // The lasso selected stays on the plane as it pans and zooms.
    if (this.#press?.mode !== "lasso") this.#drawLasso();
  }

  dispose(): void {
    for (const stop of this.#stop.splice(0)) stop();
    this.#toolbar.dispose();
    this.#brush?.element.remove();
    this.#press = null;
  }

  /** The map as last drawn. */
  #plane(): Plane | undefined {
    return this.#host.model.items?.result()?.plane;
  }

  /** The room the map is drawn in, and its plane's scales, as the brush draws in it. */
  #panel(plane: Plane): BrushPanel {
    const [left, right] = plane.x.range;
    const [bottom, top] = plane.y.range;
    return { plot: { x: left, y: top, width: right - left, height: bottom - top }, ...plane };
  }

  #drawLasso(): void {
    const plane = this.#plane();
    if (this.#brush && plane && this.#theme)
      this.#brush.draw([this.#panel(plane)], this.#theme, this.#host.chart.selection);
  }

  /**
   * The view a command changes: the chart's viewport as set, though not
   * drawn yet, fitted to the room as the map fits it; so commands before a
   * frame add up.
   */
  #view(): View | undefined {
    const plane = this.#plane();
    const { model } = this.#host;
    return plane && { ...plane.view({ x: model.viewport, y: model.yViewport.y }), plane };
  }

  /** Shows the plane's x and y ranges, as the chart's viewport. */
  #show(x: readonly [number, number], y: readonly [number, number]): void {
    this.#host.chart.setViewport({ x, y });
  }

  /** Zooms by `by` around a pixel (the room's middle by default), within the zoom's range. */
  #zoomBy(by: number, at?: { x: number; y: number }, announce = true): void {
    const view = this.#view();
    if (!view) return;
    const { zoom, plane } = view;
    const next = Math.min(Math.max(zoom, MAX_ZOOM), Math.max(Math.min(zoom, 1), zoom * by));
    if (next === zoom) return;
    const factor = zoom / next;
    const [left, right] = plane.x.range;
    const [bottom, top] = plane.y.range;
    const [x0, x1] = view.x;
    const [y0, y1] = view.y;
    // The point under the pixel stays there.
    const cx = x0 + (((at?.x ?? (left + right) / 2) - left) / (right - left)) * (x1 - x0);
    const cy = y1 - (((at?.y ?? (top + bottom) / 2) - top) / (bottom - top)) * (y1 - y0);
    this.#show(
      [cx - (cx - x0) * factor, cx + (x1 - cx) * factor],
      [cy - (cy - y0) * factor, cy + (y1 - cy) * factor],
    );
    if (announce) this.#say(`Zoom ${Math.round(next * 10) / 10} times the whole map.`);
  }

  /** Pans the view a step along x and y (in steps of the room's size), and says which way. */
  #pan(dx: number, dy: number, way: string): void {
    const view = this.#view();
    if (!view) return;
    const { x, y } = view;
    const shift = (domain: readonly [number, number], by: number) =>
      [domain[0] + by, domain[1] + by] as const;
    const [x0, x1] = x;
    const [y0, y1] = y;
    // The view moves the way named: right shows more to the east, up more to the north.
    this.#show(shift(x, dx * PAN * (x1 - x0)), shift(y, -dy * PAN * (y1 - y0)));
    this.#say(`Moved ${way}.`);
  }

  #reset(announce: boolean): void {
    this.#host.chart.setViewport(null);
    if (announce) this.#say("Showing the whole map.");
  }

  #say(text: string): void {
    this.#host.announce(text);
  }

  /** Whether an event is on the map's drawing: not the legend or the toolbar. */
  #onMap(event: Event): boolean {
    return !this.#toolbar.contains(event.target) && this.#host.onPlot(event.target);
  }

  /** A pointer event's pixel, from the chart's top left corner, if it is in the map's room. */
  #point(event: MouseEvent, plane: Plane): { x: number; y: number } | undefined {
    const rect = this.#root.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const [left, right] = plane.x.range;
    const [bottom, top] = plane.y.range;
    return x >= left && x <= right && y >= top && y <= bottom ? { x, y } : undefined;
  }

  #listen(): void {
    const root = this.#root;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      root.addEventListener(type, handler, options);
      this.#stop.push(() => root.removeEventListener(type, handler, options));
    };
    on(
      "wheel",
      (event) => {
        const plane = this.#plane();
        const at = plane && this.#onMap(event) && this.#point(event, plane);
        if (!this.#zooms || !at) return;
        event.preventDefault();
        this.#zoomBy(Math.exp(-event.deltaY * 0.002), at, false);
      },
      { passive: false },
    );
    on("pointerdown", (event) => {
      const view = this.#view();
      // A second finger neither pans nor takes over the first one's drag.
      if (this.#press || event.button !== 0 || !view || !this.#onMap(event)) return;
      const { plane } = view;
      const at = this.#point(event, plane);
      if (!at) return;
      const lasso = this.#lassos && (this.#zooms ? this.#lassoing && !event.shiftKey : true);
      if (!lasso && !this.#zooms) return;
      const mode = lasso ? "lasso" : "pan";
      this.#press = { pointer: event.pointerId, ...at, mode, plane, view, moved: false };
      root.setPointerCapture?.(event.pointerId);
    });
    on("pointermove", (event) => {
      const press = this.#press;
      if (!press || event.pointerId !== press.pointer) return;
      const rect = root.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      press.moved ||= Math.hypot(x - press.x, y - press.y) >= DRAG_THRESHOLD;
      if (!press.moved) return;
      if (press.mode === "pan") {
        // From the view when the drag started, so the point pressed stays under the pointer.
        const { view } = press;
        const [left, right] = view.plane.x.range;
        const perPixel = (view.x[1] - view.x[0]) / (right - left);
        const dx = (press.x - x) * perPixel;
        const dy = (y - press.y) * perPixel;
        this.#show([view.x[0] + dx, view.x[1] + dx], [view.y[0] + dy, view.y[1] + dy]);
        return;
      }
      const brush = this.#brush;
      if (!brush || !this.#theme) return;
      if (!brush.dragging) brush.start(press.x, press.y, this.#panel(press.plane));
      brush.move(x, y);
      brush.draw([this.#panel(press.plane)], this.#theme, null);
    });
    on("pointerup", (event) => {
      const press = this.#press;
      if (!press || event.pointerId !== press.pointer) return;
      this.#press = null;
      if (press.mode !== "lasso" || !this.#brush?.dragging) return;
      const rect = root.getBoundingClientRect();
      this.#brush.move(event.clientX - rect.left, event.clientY - rect.top);
      const selection = this.#brush.end();
      if (selection) {
        this.#host.chart.select(selection);
        this.#say("Selected a freehand region.");
      }
      this.#drawLasso();
    });
    const cancel = (event: PointerEvent) => {
      if (event.pointerId !== this.#press?.pointer) return;
      this.#press = null;
      this.#brush?.cancel();
      this.#drawLasso();
    };
    on("pointercancel", cancel);
    on("lostpointercapture", cancel);
    on("dblclick", (event) => {
      const plane = this.#plane();
      if (this.#zooms && plane && this.#onMap(event) && this.#point(event, plane))
        this.#reset(false);
    });
    // Ahead of the chart's keys, which read the map's items with the arrows.
    on("keydown", (event) => this.#key(event), { capture: true });
  }

  /** Shift with an arrow key pans, plus and minus zoom, and 0 shows the whole map. */
  #key(event: KeyboardEvent): void {
    if (event.target !== this.#root) return;
    // Escape clears a lasso, as it clears brushes, and goes on to the chart's keys.
    if (event.key === "Escape" && this.#host.chart.selection) this.#host.chart.select(null);
    if (!this.#zooms) return;
    const steps: Record<string, [number, number, string]> = {
      ArrowLeft: [-1, 0, "left"],
      ArrowRight: [1, 0, "right"],
      ArrowUp: [0, -1, "up"],
      ArrowDown: [0, 1, "down"],
    };
    const step = event.shiftKey ? steps[event.key] : undefined;
    if (step) this.#pan(...step);
    else if (event.key === "+" || event.key === "=") this.#zoomBy(ZOOM);
    else if (event.key === "-") this.#zoomBy(1 / ZOOM);
    else if (event.key === "0") this.#reset(true);
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
