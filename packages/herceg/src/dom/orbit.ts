// Turning 3D charts: dragging orbits the camera, the wheel magnifies it,
// Shift with the arrow keys turns it and plus and minus zoom, double-click
// goes back to the configured camera, and buttons do all of it for people
// who cannot drag. A chart loads this module the first time it draws a 3D
// mark, so other charts never download it; it listens on the chart's root
// itself, its keys ahead of the chart's own.

import type { CameraSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { type Camera, MAX_ZOOM, MIN_ZOOM } from "../three/camera.ts";

/**
 * Pixels a press moves before it turns the chart, as before it brushes or
 * pans (brush.ts); not imported, which would split brush.ts out of the
 * chart's bundle into a chunk of its own.
 */
const DRAG_THRESHOLD = 3;
/** Degrees the camera turns per pixel dragged. */
const DRAGGED = 0.4;
/** Degrees per key press or button click. */
const STEP = 15;
/** Magnification per key press or button click. */
const ZOOM = 1.25;

/** The chart an orbit turns. */
export interface OrbitHost {
  /** The chart's camera now; undefined once it is no 3D chart. */
  camera(): Camera | undefined;
  /** Moves the camera (null: back to the configured one); `announce` reads the new view aloud. */
  turn(camera: CameraSpec | null, announce: boolean): void;
  /** Whether an event's target is the chart's drawing, not its legend. */
  onPlot(target: EventTarget | null): boolean;
}

const BUTTONS: readonly {
  label: string;
  glyph: string;
  act: (camera: Camera) => CameraSpec | null;
}[] = [
  { label: "Turn left", glyph: "M10 4 5 8l5 4", act: (c) => ({ azimuth: c.azimuth - STEP }) },
  { label: "Turn right", glyph: "M6 4l5 4-5 4", act: (c) => ({ azimuth: c.azimuth + STEP }) },
  { label: "Tilt up", glyph: "M4 10l4-5 4 5", act: (c) => ({ elevation: tilt(c, STEP) }) },
  { label: "Tilt down", glyph: "M4 6l4 5 4-5", act: (c) => ({ elevation: tilt(c, -STEP) }) },
  { label: "Zoom in", glyph: "M8 4v8M4 8h8", act: (c) => ({ zoom: magnify(c, ZOOM) }) },
  { label: "Zoom out", glyph: "M4 8h8", act: (c) => ({ zoom: magnify(c, 1 / ZOOM) }) },
  { label: "Reset view", glyph: "M4.5 9A3.5 3.5 0 1 0 6 5.2M4 3v3h3", act: () => null },
];

/** An elevation `by` degrees higher, within its range. */
function tilt(camera: Camera, by: number): number {
  return Math.min(90, Math.max(-90, camera.elevation + by));
}

/** A zoom `by` times the camera's, within its range. */
function magnify(camera: Camera, by: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * by));
}

export class Orbit {
  /** The buttons, shown while the pointer is over the chart or focus is in it. */
  readonly controls: HTMLDivElement;
  readonly #root: HTMLElement;
  readonly #host: OrbitHost;
  readonly #buttons: HTMLButtonElement[];
  readonly #stop: (() => void)[] = [];
  /** A press that may become a drag: its pointer, where it started, and the camera then. */
  #press: { pointer: number; x: number; y: number; from: Camera; moved: boolean } | null = null;
  #rotates = true;
  #zooms = false;
  #theme = "";

  constructor(root: HTMLElement, host: OrbitHost) {
    this.#root = root;
    this.#host = host;
    const document = root.ownerDocument;
    this.controls = document.createElement("div");
    this.controls.setAttribute("role", "toolbar");
    this.controls.setAttribute("aria-label", "View");
    this.#buttons = BUTTONS.map(({ label, glyph, act }) => {
      const button = document.createElement("button");
      button.type = "button";
      button.title = label;
      button.setAttribute("aria-label", label);
      button.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style="display:block"><path d="${glyph}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      button.addEventListener("click", () => {
        const camera = host.camera();
        if (camera) host.turn(act(camera), true);
      });
      return button;
    });
    this.controls.append(...this.#buttons);
    this.#show(false);
    root.append(this.controls);
    this.#listen();
  }

  /** Whether a drag is turning the chart, which shows no tooltip meanwhile. */
  get turning(): boolean {
    return this.#press?.moved ?? false;
  }

  /** Follows the chart's options: whether dragging turns it and the wheel zooms it. */
  update(rotate: boolean, zoom: boolean): void {
    this.#rotates = rotate;
    this.#zooms = zoom;
    // Touches turn the chart sideways and leave vertical drags to scroll the page.
    this.#root.style.touchAction = rotate ? "pan-y" : "";
  }

  /** Styles the buttons for a theme, when it changed. */
  style(theme: Theme): void {
    const key = `${theme.text}|${theme.tooltipBackground}|${theme.tooltipBorder}`;
    if (key === this.#theme) return;
    this.#theme = key;
    for (const button of this.#buttons)
      button.style.cssText = `display:block;width:24px;height:24px;padding:3px;border:1px solid ${theme.tooltipBorder};border-radius:4px;background:${theme.tooltipBackground};color:${theme.text};cursor:pointer`;
  }

  /** A sentence saying where `camera` looks from, for the live region. */
  describe(camera: Camera): string {
    const zoom = camera.zoom === 1 ? "" : `, zoom ${Math.round(camera.zoom * 100) / 100}`;
    return `Seen from azimuth ${Math.round(camera.azimuth)}°, elevation ${Math.round(camera.elevation)}°${zoom}.`;
  }

  /** Stops listening and removes the buttons, for a chart no longer 3D or destroyed. */
  dispose(): void {
    for (const stop of this.#stop.splice(0)) stop();
    this.controls.remove();
    this.#press = null;
  }

  /** Whether an event's target is the chart's drawing, not its legend or these buttons. */
  #onPlot(target: EventTarget | null): boolean {
    return !this.controls.contains(target as Node) && this.#host.onPlot(target);
  }

  /** Shows or hides the buttons; hidden ones stay focusable and show when focused. */
  #show(visible: boolean): void {
    this.controls.style.cssText = `position:absolute;right:6px;bottom:6px;display:flex;gap:2px;transition:opacity 120ms;opacity:${visible ? 1 : 0}`;
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
    on("pointerenter", () => this.#show(true));
    on("focusin", () => this.#show(true));
    const hide = () => {
      if (!root.matches(":hover") && !root.contains(root.ownerDocument.activeElement))
        this.#show(false);
    };
    on("pointerleave", () => setTimeout(hide));
    on("focusout", () => setTimeout(hide));
    on("pointerdown", (event) => {
      const from = this.#host.camera();
      // A second finger neither turns nor takes over the first one's drag.
      if (this.#press || event.button !== 0 || !from || !this.#rotates) return;
      if (!this.#onPlot(event.target)) return;
      this.#press = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        from,
        moved: false,
      };
      root.setPointerCapture?.(event.pointerId);
    });
    on("pointermove", (event) => {
      const press = this.#press;
      if (!press || event.pointerId !== press.pointer) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      press.moved ||= Math.hypot(dx, dy) >= DRAG_THRESHOLD;
      if (!press.moved) return;
      this.#host.turn(
        { azimuth: press.from.azimuth - dx * DRAGGED, elevation: tilt(press.from, dy * DRAGGED) },
        false,
      );
    });
    const end = (event: PointerEvent) => {
      if (event.pointerId === this.#press?.pointer) this.#press = null;
    };
    on("pointerup", end);
    on("pointercancel", end);
    on("lostpointercapture", end);
    on(
      "wheel",
      (event) => {
        const camera = this.#host.camera();
        if (!camera || !this.#zooms) return;
        event.preventDefault();
        this.#host.turn({ zoom: magnify(camera, Math.exp(-event.deltaY * 0.002)) }, false);
      },
      { passive: false },
    );
    on("dblclick", (event) => {
      if (this.#onPlot(event.target)) this.#host.turn(null, false);
    });
    // Ahead of the chart's keys, which step through points with the arrows.
    on("keydown", (event) => this.#key(event), { capture: true });
  }

  /** Shift with an arrow key turns the camera, plus and minus zoom. */
  #key(event: KeyboardEvent): void {
    const camera = this.#host.camera();
    if (!camera || event.target !== this.#root) return;
    const shift = event.shiftKey;
    let next: CameraSpec | undefined;
    if (shift && event.key === "ArrowLeft") next = { azimuth: camera.azimuth - STEP };
    else if (shift && event.key === "ArrowRight") next = { azimuth: camera.azimuth + STEP };
    else if (shift && event.key === "ArrowUp") next = { elevation: tilt(camera, STEP) };
    else if (shift && event.key === "ArrowDown") next = { elevation: tilt(camera, -STEP) };
    else if (event.key === "+" || event.key === "=") next = { zoom: magnify(camera, ZOOM) };
    else if (event.key === "-") next = { zoom: magnify(camera, 1 / ZOOM) };
    if (!next) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.#host.turn(next, true);
  }
}
