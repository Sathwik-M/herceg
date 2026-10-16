// Turning 3D charts: dragging orbits the camera, the wheel magnifies it,
// Shift with the arrow keys turns it and plus and minus zoom, double-click
// goes back to the configured camera, and buttons do all of it for people
// who cannot drag. A chart loads this module the first time it draws a 3D
// mark (see controls.ts), so other charts never download it; it listens on
// the chart's root itself, its keys ahead of the chart's own.

import type { ChartConfig } from "../model/model.ts";
import type { Scene } from "../scene/scene.ts";
import type { CameraSpec } from "../spec/spec.ts";
import { type Camera, MAX_ZOOM, MIN_ZOOM } from "../three/camera.ts";
import type { Controls as ChartControls, ControlsHost } from "./controls.ts";
import { RESET_GLYPH, Toolbar } from "./toolbar.ts";

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

/** The buttons, each a change of the camera from the current one; null resets it. */
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
  { label: "Reset view", glyph: RESET_GLYPH, act: () => null },
];

/** An elevation `by` degrees higher, within its range. */
function tilt(camera: Camera, by: number): number {
  return Math.min(90, Math.max(-90, camera.elevation + by));
}

/** A zoom `by` times the camera's, within its range. */
function magnify(camera: Camera, by: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, camera.zoom * by));
}

export class Controls implements ChartControls {
  readonly #root: HTMLElement;
  readonly #host: ControlsHost;
  readonly #toolbars = new Map<string, Toolbar>();
  readonly #stop: (() => void)[] = [];
  /** A press that may become a drag: its pointer, where it started, and the camera then. */
  #press: {
    pointer: number;
    x: number;
    y: number;
    from: Camera;
    panel: string;
    moved: boolean;
  } | null = null;

  constructor(host: ControlsHost) {
    const root = host.chart.root;
    this.#root = root;
    this.#host = host;
    this.#listen();
  }

  /** Whether a drag is turning the chart, which shows no tooltip meanwhile. */
  get busy(): boolean {
    return this.#press?.moved ?? false;
  }

  /** Follows the chart's options: whether dragging turns it and the wheel zooms it. */
  update(config: ChartConfig): void {
    const rotate = config.interaction?.rotate !== false;
    if (this.#press && (!rotate || !this.#panels().some(({ key }) => key === this.#press!.panel)))
      this.#press = null;
  }

  #panels() {
    return this.#host.model.items?.panels.filter((panel) => panel.camera) ?? [];
  }

  #at(event: MouseEvent): string | undefined {
    if (!this.#onPlot(event.target)) return undefined;
    const rect = this.#root.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * this.#host.model.width) / rect.width;
    const y = ((event.clientY - rect.top) * this.#host.model.height) / rect.height;
    const { model } = this.#host;
    return this.#panels().find(
      ({ key, plot }) =>
        model.items?.alone ||
        (x >= plot.x &&
          x <= plot.x + plot.width &&
          y >= plot.y &&
          y <= plot.y + plot.height &&
          !model.coveredAt(key, x, y)),
    )?.key;
  }

  draw(scene: Scene): void {
    const panels = this.#panels();
    if (this.#press && !panels.some(({ key }) => key === this.#press!.panel)) this.#press = null;
    for (const [state, toolbar] of this.#toolbars)
      if (!panels.some((panel) => panel.state === state)) {
        toolbar.dispose();
        this.#toolbars.delete(state);
      }
    for (const { key, state, label, plot } of panels) {
      const name = state === "" ? "View" : `View, ${label || key}`;
      let toolbar = this.#toolbars.get(state);
      if (!toolbar) {
        toolbar = new Toolbar(
          this.#root,
          name,
          BUTTONS.map(({ label, glyph, act }) => ({
            label,
            glyph,
            act: () => {
              if (!this.#panels().some((panel) => panel.key === key)) return;
              const camera = this.#host.chart.getCamera({ panel: key });
              if (camera) this.#turn(act(camera), true, key);
            },
          })),
        );
        this.#toolbars.set(state, toolbar);
      }
      toolbar.element.setAttribute("aria-label", name);
      if (state !== "") toolbar.place(plot, scene.width, scene.height);
      toolbar.style(scene.theme);
    }
  }

  /** Stops listening and removes the buttons, for a chart no longer 3D or destroyed. */
  dispose(): void {
    for (const stop of this.#stop.splice(0)) stop();
    for (const toolbar of this.#toolbars.values()) toolbar.dispose();
    this.#toolbars.clear();
    this.#press = null;
  }

  /** Whether an event's target is the chart's drawing, not its legend or these buttons. */
  #onPlot(target: EventTarget | null): boolean {
    return (
      ![...this.#toolbars.values()].some((toolbar) => toolbar.contains(target)) &&
      this.#host.onPlot(target) &&
      !(target as Element | null)?.closest?.("[role=toolbar]")
    );
  }

  /** Moves the camera (null: back to the configured one); `announce` reads the new view aloud. */
  #turn(camera: CameraSpec | null, announce: boolean, panel: string): void {
    const chart = this.#host.chart;
    const before = chart.getCamera({ panel });
    chart.setCamera(camera, { panel });
    const after = chart.getCamera({ panel });
    if (announce && after && JSON.stringify(after) !== JSON.stringify(before))
      this.#host.announce(
        `${panel ? `${this.#panels().find((p) => p.key === panel)?.label || panel}. ` : ""}${this.#describe(after)}`,
      );
  }

  /** A sentence saying where `camera` looks from, for the live region. */
  #describe(camera: Camera): string {
    const zoom = camera.zoom === 1 ? "" : `, zoom ${Math.round(camera.zoom * 100) / 100}`;
    return `Seen from azimuth ${Math.round(camera.azimuth)}°, elevation ${Math.round(camera.elevation)}°${zoom}.`;
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
    on("pointerdown", (event) => {
      const panel = this.#at(event);
      const from = panel === undefined ? undefined : this.#host.chart.getCamera({ panel });
      // A second finger neither turns nor takes over the first one's drag.
      if (this.#press || !from || !this.#onPlot(event.target)) return;
      const action = this.#host
        .bindings()
        .match("drag", event, ({ type }) => type === "orbit" || type === "pageScroll")?.action;
      if (action?.type !== "orbit") return;
      this.#press = {
        pointer: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        from,
        panel: panel!,
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
      this.#turn(
        { azimuth: press.from.azimuth - dx * DRAGGED, elevation: tilt(press.from, dy * DRAGGED) },
        false,
        press.panel,
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
        const panel = this.#at(event);
        const camera = panel === undefined ? undefined : this.#host.chart.getCamera({ panel });
        const action =
          camera &&
          this.#host
            .bindings()
            .match(
              "wheel",
              event,
              ({ type }) => type === "zoom" || type === "pageScroll",
              this.#host.focused(),
            )?.action;
        if (action?.type !== "zoom") return;
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
        const delta =
          (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * unit;
        this.#turn({ zoom: magnify(camera!, Math.exp(-delta * 0.002)) }, false, panel!);
      },
      { passive: false },
    );
    // Double click goes back to the configured camera, unless a binding zooms with it.
    on("dblclick", (event) => {
      const panel = this.#at(event);
      const camera = panel === undefined ? undefined : this.#host.chart.getCamera({ panel });
      if (!camera) return;
      const action = this.#host.bindings().match("doubleClick", event)?.action;
      if (action?.type === "zoom")
        this.#turn({ zoom: magnify(camera, action.factor ?? 2) }, false, panel!);
      else this.#turn(null, false, panel!);
    });
    // Ahead of the chart's keys, which step through points with the arrows.
    on("keydown", (event) => this.#key(event), { capture: true });
  }

  /** Shift with an arrow key turns the camera, plus and minus zoom. */
  #key(event: KeyboardEvent): void {
    const panel = this.#host.cursor()?.panel ?? (this.#host.model.items?.alone ? "" : undefined);
    const camera =
      panel === undefined || !this.#panels().some((p) => p.key === panel)
        ? undefined
        : this.#host.chart.getCamera({ panel });
    if (!camera || event.target !== this.#root) return;
    const shift = event.shiftKey;
    const action = this.#host.bindings().match("key", event)?.action;
    let next: CameraSpec | null | undefined;
    if (action?.type === "zoom") next = { zoom: magnify(camera, action.factor ?? ZOOM) };
    else if (action?.type === "reset") next = null;
    // The keys of its own go without Ctrl, ⌘, or Alt, which are the page's (Ctrl and minus zoom it).
    else if (event.ctrlKey || event.metaKey || event.altKey) next = undefined;
    else if (shift && event.key === "ArrowLeft") next = { azimuth: camera.azimuth - STEP };
    else if (shift && event.key === "ArrowRight") next = { azimuth: camera.azimuth + STEP };
    else if (shift && event.key === "ArrowUp") next = { elevation: tilt(camera, STEP) };
    else if (shift && event.key === "ArrowDown") next = { elevation: tilt(camera, -STEP) };
    else if (event.key === "+" || event.key === "=") next = { zoom: magnify(camera, ZOOM) };
    else if (event.key === "-") next = { zoom: magnify(camera, 1 / ZOOM) };
    if (next === undefined) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.#turn(next, true, panel!);
  }
}
