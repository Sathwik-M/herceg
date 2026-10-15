// Shared navigation of maps and networks, and lassoing their rows. The view
// is the chart's viewport of the panel in the plane's units, so every change
// goes through `setViewport` and is reported as a `viewport` event: the wheel
// zooms at the pointer, a drag pans, double-click and 0 show the whole view,
// Shift with the arrow keys pans, plus and minus zoom, and the toolbar's
// buttons do all of it for people who cannot drag. With a "lasso" brush, a
// drag lassos instead (Shift-drag, or the toolbar's lasso button turned
// off, pans), and the lasso is the chart's selection, kept on the plane.
//
// Facet panels share one view and one lasso, drawn in each, and one toolbar
// in the chart's corner; a subplot's map or network has its own view and
// toolbar, in its corner. The pointer acts in the panel it presses (a drag
// stays there), the keys in the panel the keyboard reads.

import type { LayoutResult, PlaneView } from "../marks/layout-mark.ts";
import type { Binding } from "../model/bindings.ts";
import type { ItemPanel } from "../model/item-views.ts";
import type { ChartConfig } from "../model/model.ts";
import type { Scene } from "../scene/scene.ts";
import type { Theme } from "../theme.ts";
import { Brush, type BrushPanel } from "./brush.ts";
import { DRAG_THRESHOLD } from "./brushed.ts";
import { type Controls as ChartControls, type ControlsHost, PointerOwnership } from "./controls.ts";
import { RESET_GLYPH, type ToolButton, Toolbar } from "./toolbar.ts";

/** Magnification per key press or button click. */
const ZOOM = 1.25;
/** The share of the room a key press or button click pans. */
const PAN = 1 / 8;
/**
 * The wheel, keys, and buttons zoom between the whole view and this many
 * times its scale; a view set beyond either is left there.
 */
const MAX_ZOOM = 256;

let lassos = 0;

/** The layout as last drawn: its plane's scales across the room, and what a viewport would show. */
type Plane = NonNullable<LayoutResult["plane"]>;

/** A view to change: the plane's ranges across the room and its zoom, and the plane drawn (its room). */
interface View extends PlaneView {
  plane: Plane;
}

/** A panel drawing a plane of the family, with the key of its state. */
type PlanePanel = ItemPanel & { state: string; plane: Plane };

export class Controls implements ChartControls {
  readonly #host: ControlsHost;
  readonly #root: HTMLElement;
  readonly #family: "map" | "network";
  readonly #nodePress: ((event: PointerEvent, panel: string) => boolean) | undefined;
  readonly #tools: (panel: () => string) => readonly ToolButton[];
  readonly #extraShown: (panel: string) => boolean;
  readonly #pointer: PointerOwnership;
  /** A toolbar per state: "" for the chart's one (or every facet panel's), a subplot's id for its own. */
  readonly #toolbars = new Map<string, Toolbar>();
  readonly #stop: (() => void)[] = [];
  /** Draws a lasso being dragged, and the chart's lasso selection; made for charts that lasso. */
  #brush: Brush | undefined;
  #zooms = false;
  /** Whether Shift with the arrow keys pans (`pan`, or `zoom`, which pans too). */
  #pans = false;
  #lassos = false;
  /** With both a lasso and zoom, whether a plain drag lassos (the toolbars' toggle). */
  #lassoing = true;
  #theme: Theme | undefined;
  /**
   * A press that may become a drag: where it started, what it does, the
   * panel and plane drawn then (which a lasso is drawn on), and the view a pan moves.
   */
  #press: {
    pointer: number;
    x: number;
    y: number;
    mode: "pan" | "lasso";
    /** The axes a pan moves along: both ways unless its binding says. */
    axes: string;
    panel: string;
    plane: Plane;
    view: View;
    moved: boolean;
  } | null = null;

  constructor(
    host: ControlsHost,
    family: "map" | "network" = "map",
    nodePress?: (event: PointerEvent, panel: string) => boolean,
    tools: (panel: () => string) => readonly ToolButton[] = () => [],
    extraShown: (panel: string) => boolean = () => false,
    pointer: PointerOwnership = new PointerOwnership(),
  ) {
    this.#host = host;
    this.#family = family;
    this.#nodePress = nodePress;
    this.#tools = tools;
    this.#extraShown = extraShown;
    this.#pointer = pointer;
    this.#root = host.chart.root;
    this.#listen();
    // A change of selection alone draws no new scene, but changes the lasso drawn.
    this.#stop.push(
      host.chart.on("select", () => {
        if (this.#press?.mode !== "lasso") this.#drawLasso();
      }),
    );
  }

  /**
   * The family's toolbar for state `state`, made the first time. Its
   * buttons act in the first panel drawn with the state, whichever facet
   * panels are drawn now.
   */
  #toolbar(state: string, label: string): Toolbar {
    let toolbar = this.#toolbars.get(state);
    if (toolbar) return toolbar;
    const panel = () => this.#planes().find((plane) => plane.state === state)!.key;
    const pan = (dx: number, dy: number, way: string) => () => this.#pan(panel(), dx, dy, way);
    const name = this.#family === "map" ? "Map" : "Network";
    toolbar = new Toolbar(this.#root, state === "" ? name : `${name}, ${label}`, [
      {
        label: "Lasso",
        glyph: "M8 3c3 0 5 1.4 5 3.2S11 9.5 8 9.5 3 8 3 6.2 5 3 8 3zM5.5 9 4.5 13",
        act: () => {
          this.#lassoing = !this.#lassoing;
          for (const other of this.#toolbars.values()) other.refresh();
        },
        pressed: () => this.#lassoing,
        hidden: () => !this.#lassos || !this.#zooms,
      },
      ...[
        { label: "Zoom in", glyph: "M8 4v8M4 8h8", act: () => this.#zoomBy(panel(), ZOOM) },
        { label: "Zoom out", glyph: "M4 8h8", act: () => this.#zoomBy(panel(), 1 / ZOOM) },
        { label: "Pan left", glyph: "M10 4 6 8l4 4", act: pan(-1, 0, "left") },
        { label: "Pan right", glyph: "M6 4l4 4-4 4", act: pan(1, 0, "right") },
        { label: "Pan up", glyph: "M4 10l4-4 4 4", act: pan(0, -1, "up") },
        { label: "Pan down", glyph: "M4 6l4 4 4-4", act: pan(0, 1, "down") },
        {
          label: `Show the whole ${this.#family}`,
          glyph: RESET_GLYPH,
          act: () => this.#reset(panel(), true),
        },
      ].map((tool) => ({ ...tool, hidden: () => !this.#zooms })),
      ...this.#tools(panel),
    ]);
    this.#toolbars.set(state, toolbar);
    return toolbar;
  }

  /** Ends a press: a pan stays where it got to, a lasso being drawn goes. */
  #cancel(): void {
    const { pointer } = this.#press!;
    this.#press = null;
    this.#pointer.release(pointer);
    if (this.#root.hasPointerCapture?.(pointer)) this.#root.releasePointerCapture(pointer);
    this.#brush?.cancel();
    this.#drawLasso();
  }

  /** A plain drag currently lassos rather than moving a node or the view. */
  get lassoing(): boolean {
    return this.#lassos && (!this.#zooms || this.#lassoing);
  }

  contains(target: EventTarget | null): boolean {
    return [...this.#toolbars.values()].some((toolbar) => toolbar.contains(target));
  }

  get busy(): boolean {
    return this.#press?.mode === "pan" && this.#press.moved;
  }

  update(config: ChartConfig): void {
    const { zoom, pan, brush, bindings } = config.interaction ?? {};
    this.#zooms = !!zoom;
    this.#pans = pan === undefined ? !!zoom : pan !== false;
    // A binding of the chart's own may brush too, which on a plane lassos.
    this.#lassos = brush === "lasso" || !!bindings?.some(({ action }) => action.type === "brush");
    if (this.#press && (this.#press.mode === "pan" ? !this.#pans : !this.#lassos)) this.#cancel();
    if (this.#lassos && !this.#brush) {
      const group = this.#root.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g");
      this.#host.overlay.append(group);
      this.#brush = new Brush(group, `herceg-${this.#family}-lasso-${++lassos}`);
      this.#brush.mode = "lasso";
    } else if (!this.#lassos && this.#brush) {
      this.#brush.element.remove();
      this.#brush = undefined;
    }
    this.#showToolbars();
  }

  draw(scene: Scene): void {
    this.#theme = scene.theme;
    const planes = this.#planes();
    // A press on a panel that is gone ends.
    if (this.#press && !planes.some(({ key }) => key === this.#press!.panel)) this.#cancel();
    const states = new Map<string, PlanePanel>();
    for (const panel of planes) if (!states.has(panel.state)) states.set(panel.state, panel);
    for (const [state, toolbar] of this.#toolbars)
      if (!states.has(state)) {
        toolbar.dispose();
        this.#toolbars.delete(state);
      }
    for (const [state, { label, plot }] of states) {
      const toolbar = this.#toolbar(state, label);
      toolbar.style(scene.theme);
      if (state !== "") toolbar.place(plot, scene.width, scene.height);
    }
    this.#showToolbars();
    // The lasso selected stays on the plane as it pans and zooms.
    if (this.#press?.mode !== "lasso") this.#drawLasso();
  }

  dispose(): void {
    for (const stop of this.#stop.splice(0)) stop();
    for (const toolbar of this.#toolbars.values()) toolbar.dispose();
    this.#toolbars.clear();
    this.#brush?.element.remove();
    if (this.#press) this.#pointer.release(this.#press.pointer);
    this.#press = null;
  }

  /** The toolbars pan and zoom; a lasso toggle is there when a drag could do either. */
  #showToolbars(): void {
    for (const toolbar of this.#toolbars.values()) {
      const panel = this.#planes().find(({ state }) => this.#toolbars.get(state) === toolbar)?.key;
      toolbar.shown = this.#zooms || (panel !== undefined && this.#extraShown(panel));
      toolbar.refresh();
    }
  }

  /** The panels the family's layout was last drawn in, in order: a network's, or a map's. */
  #planes(): PlanePanel[] {
    return (this.#host.model.items?.panels ?? []).flatMap((panel) => {
      const { plane, moves } = panel.result;
      return plane && !!moves === (this.#family === "network") ? [{ ...panel, plane }] : [];
    });
  }

  /** The panel of the family keyed `panel`, as last drawn. */
  #planeOf(panel: string): PlanePanel | undefined {
    return this.#planes().find(({ key }) => key === panel);
  }

  /** The panel of the family holding a pixel of the chart. */
  #planeAt(x: number, y: number): PlanePanel | undefined {
    return this.#planes().find(({ plane }) => inRoom(plane, x, y));
  }

  /** The room a plane is drawn in, and its scales, as the brush draws in it. */
  #brushPanel(plane: Plane): BrushPanel {
    const [left, right] = plane.x.range;
    const top = Math.min(...plane.y.range);
    const bottom = Math.max(...plane.y.range);
    return { plot: { x: left, y: top, width: right - left, height: bottom - top }, ...plane };
  }

  /** Draws the chart's lasso in the panels of the family it belongs to. */
  #drawLasso(): void {
    const { chart } = this.#host;
    const selection = chart.selection;
    const owners = chart.selectionPanels ?? [];
    if (!this.#brush || !this.#theme) return;
    const panels = selection?.lasso ? this.#planes().filter(({ key }) => owners.includes(key)) : [];
    this.#brush.draw(
      panels.map(({ plane }) => this.#brushPanel(plane)),
      this.#theme,
      panels.length > 0 ? selection : null,
    );
  }

  /**
   * The view a command changes in panel `panel`: the chart's viewport there
   * as set, though not drawn yet, fitted to the room as the layout fits it;
   * so commands before a frame add up.
   */
  #view(panel: string): View | undefined {
    const plane = this.#planeOf(panel)?.plane;
    return plane && { ...plane.view(this.#host.model.items!.view(panel)), plane };
  }

  /**
   * Shows the plane's x and y ranges in panel `panel`, as the chart's
   * viewport there. Controls act on what was drawn: a panel an update took
   * away keeps it until the next frame, which ends the press.
   */
  #show(panel: string, x: readonly [number, number], y: readonly [number, number]): void {
    this.#host.model.items?.setView({ x, y }, panel);
  }

  /** Zooms panel `panel` by `by` around a pixel (the room's middle by default), within the zoom's range. */
  #zoomBy(panel: string, by: number, at?: { x: number; y: number }, announce = true): void {
    const view = this.#view(panel);
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
    const cy = y0 + (((at?.y ?? (top + bottom) / 2) - bottom) / (top - bottom)) * (y1 - y0);
    this.#show(
      panel,
      [cx - (cx - x0) * factor, cx + (x1 - cx) * factor],
      [cy - (cy - y0) * factor, cy + (y1 - cy) * factor],
    );
    if (announce) this.#say(`Zoom ${Math.round(next * 10) / 10} times the whole ${this.#family}.`);
  }

  /** Pans panel `panel`'s view a step along x and y (in steps of the room's size), and says which way. */
  #pan(panel: string, dx: number, dy: number, way: string): void {
    const view = this.#view(panel);
    if (!view) return;
    const { x, y } = view;
    const shift = (domain: readonly [number, number], by: number) =>
      [domain[0] + by, domain[1] + by] as const;
    const [x0, x1] = x;
    const [y0, y1] = y;
    // Follow screen directions whether the plane's y increases up (maps) or down (networks).
    this.#show(
      panel,
      shift(x, dx * PAN * (x1 - x0)),
      shift(y, dy * PAN * (y1 - y0) * Math.sign(view.plane.y.range[1] - view.plane.y.range[0])),
    );
    this.#say(`Moved ${way}.`);
  }

  /**
   * What a press on panel `panel`'s plane does by the chart's bindings:
   * lasso (when the toolbar's toggle says so, with zoom on), move the node
   * under it (`nodePress` says whether there is one), or pan.
   */
  dragAction(event: PointerEvent, panel: string): Binding["action"] | undefined {
    const action = this.#host
      .bindings()
      .match("drag", event, ({ type }) =>
        type === "brush"
          ? this.lassoing
          : type === "moveItem"
            ? !!this.#nodePress?.(event, panel)
            : type === "pan" || type === "pageScroll",
      )?.action;
    return action?.type === "pageScroll" ? undefined : action;
  }

  /** Shows what lies `dx` pixels right and `dy` down of what panel `panel` shows. */
  #panBy(panel: string, dx: number, dy: number): void {
    const view = this.#view(panel);
    if (!view) return;
    const [left, right] = view.plane.x.range;
    const [bottom, top] = view.plane.y.range;
    const across = (dx * (view.x[1] - view.x[0])) / (right - left);
    const up = (dy * (view.y[1] - view.y[0])) / (top - bottom);
    this.#show(panel, [view.x[0] + across, view.x[1] + across], [view.y[0] + up, view.y[1] + up]);
  }

  #reset(panel: string, announce: boolean): void {
    this.#host.model.items?.setView(null, panel);
    if (announce) this.#say(`Showing the whole ${this.#family}.`);
  }

  #say(text: string): void {
    this.#host.announce(text);
  }

  /** Whether an event is on the layout's drawing: not the legend or a toolbar. */
  #onPlot(event: Event): boolean {
    return !this.contains(event.target) && this.#host.onPlot(event.target);
  }

  /** A pointer event's pixel, from the chart's top left corner. */
  #point(event: MouseEvent): { x: number; y: number } {
    const rect = this.#root.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
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
        const at = this.#point(event);
        const panel = this.#onPlot(event) ? this.#planeAt(at.x, at.y) : undefined;
        const action =
          panel &&
          this.#host
            .bindings()
            .match("wheel", event, ({ type }) => type !== "orbit", this.#host.focused())?.action;
        if (action?.type !== "zoom" && action?.type !== "pan") return;
        event.preventDefault();
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
        const [dx, dy] = [event.deltaX * unit, event.deltaY * unit];
        const along = Math.abs(dx) > Math.abs(dy) ? dx : dy;
        if (action.type === "zoom") this.#zoomBy(panel!.key, Math.exp(-along * 0.002), at, false);
        else if (action.axes === "y") this.#panBy(panel!.key, 0, along);
        else if (action.axes === "x") this.#panBy(panel!.key, along, 0);
        else this.#panBy(panel!.key, dx, dy);
      },
      { passive: false },
    );
    on("pointerdown", (event) => {
      // A second finger neither pans nor takes over the first one's drag;
      // which buttons drag is the bindings'.
      if (this.#press || !this.#onPlot(event)) return;
      const at = this.#point(event);
      const panel = this.#planeAt(at.x, at.y)?.key;
      const view = panel === undefined ? undefined : this.#view(panel);
      if (!view) return;
      const action = this.dragAction(event, panel!);
      if (action?.type !== "brush" && action?.type !== "pan") return;
      if (!this.#pointer.acquire(event.pointerId)) return;
      const mode = action.type === "brush" ? "lasso" : "pan";
      const { plane } = view;
      this.#press = {
        pointer: event.pointerId,
        ...at,
        mode,
        axes: (action.type === "pan" && action.axes) || "xy",
        panel: panel!,
        plane,
        view,
        moved: false,
      };
      root.setPointerCapture?.(event.pointerId);
    });
    on("pointermove", (event) => {
      const press = this.#press;
      if (!press || event.pointerId !== press.pointer) return;
      const { x, y } = this.#point(event);
      press.moved ||= Math.hypot(x - press.x, y - press.y) >= DRAG_THRESHOLD;
      if (!press.moved) return;
      if (press.mode === "pan") {
        // From the view when the drag started, so the point pressed stays under the pointer.
        const { view, axes } = press;
        const [left, right] = view.plane.x.range;
        const perPixel = (view.x[1] - view.x[0]) / (right - left);
        const dx = axes.includes("x") ? (press.x - x) * perPixel : 0;
        const dy = axes.includes("y")
          ? ((press.y - y) * (view.y[1] - view.y[0])) /
            (view.plane.y.range[1] - view.plane.y.range[0])
          : 0;
        this.#show(press.panel, [view.x[0] + dx, view.x[1] + dx], [view.y[0] + dy, view.y[1] + dy]);
        return;
      }
      const brush = this.#brush;
      if (!brush || !this.#theme) return;
      if (!brush.dragging) brush.start(press.x, press.y, this.#brushPanel(press.plane));
      brush.move(x, y);
      // Facet panels share the plane: the lasso shows in each.
      const state = this.#planeOf(press.panel)?.state;
      const panels = this.#planes().filter((panel) => state === "" && panel.state === "");
      brush.draw(
        (panels.length > 0 ? panels.map(({ plane }) => plane) : [press.plane]).map((plane) =>
          this.#brushPanel(plane),
        ),
        this.#theme,
        null,
      );
    });
    on("pointerup", (event) => {
      const press = this.#press;
      if (!press || event.pointerId !== press.pointer) return;
      this.#pointer.release(press.pointer);
      this.#press = null;
      if (press.mode !== "lasso" || !this.#brush?.dragging) return;
      const { x, y } = this.#point(event);
      this.#brush.move(x, y);
      const selection = this.#brush.end();
      // A panel that went while dragging (drawn now, if an update took it) selects nothing.
      this.#host.chart.render();
      if (selection && this.#planeOf(press.panel)) {
        this.#host.chart.select(selection, { panel: press.panel });
        this.#say("Selected a freehand region.");
      }
      this.#drawLasso();
    });
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === this.#press?.pointer) this.#cancel();
    };
    on("pointercancel", cancel);
    on("lostpointercapture", cancel);
    on("dblclick", (event) => {
      const at = this.#point(event);
      const panel = this.#onPlot(event) ? this.#planeAt(at.x, at.y) : undefined;
      const action = panel && this.#host.bindings().match("doubleClick", event)?.action;
      if (action?.type === "reset") this.#reset(panel!.key, false);
      else if (action?.type === "zoom") this.#zoomBy(panel!.key, action.factor ?? 2, at, false);
    });
    // Ahead of the chart's keys, which read the map's items with the arrows.
    on("keydown", (event) => this.#key(event), { capture: true });
  }

  /**
   * Keys the bindings bind (plus and minus zoom, 0 shows the whole map, with
   * `zoom`), and Shift with an arrow key pans, in the panel the keyboard
   * reads (or the chart's one plane).
   */
  #key(event: KeyboardEvent): void {
    if (event.target !== this.#root) return;
    // Escape clears a lasso, as it clears brushes, and goes on to the chart's keys.
    if (event.key === "Escape" && this.#host.chart.selection) this.#host.chart.select(null);
    const action = this.#host.bindings().match("key", event)?.action;
    if (!(action || ((this.#zooms || this.#pans) && !event.altKey))) return;
    const cursor = this.#host.cursor();
    const [first] = this.#planes();
    const panel = cursor ? cursor.panel : first?.state === "" ? first.key : undefined;
    const plane = panel === undefined ? undefined : this.#planeOf(panel);
    if (!plane) return;
    const steps: Record<string, [number, number, string]> = {
      ArrowLeft: [-1, 0, "left"],
      ArrowRight: [1, 0, "right"],
      ArrowUp: [0, -1, "up"],
      ArrowDown: [0, 1, "down"],
    };
    // Shift alone: with Ctrl, ⌘, or Alt, the arrows are the page's (or a node's, with Alt).
    const plain = !(event.altKey || event.ctrlKey || event.metaKey);
    const step = event.shiftKey && plain && this.#pans ? steps[event.key] : undefined;
    if (action?.type === "zoom") this.#zoomBy(panel!, action.factor ?? ZOOM);
    else if (action?.type === "reset") this.#reset(panel!, true);
    else if (action?.type === "pan") {
      // Fractions of the room across and up, along the axes it names (both by default).
      const [across, up] = action.step ?? [0.1, 0];
      const axes = action.axes ?? "xy";
      const [left, right] = plane.plane.x.range;
      const [bottom, top] = plane.plane.y.range;
      this.#panBy(
        panel!,
        axes.includes("x") ? across * (right - left) : 0,
        axes.includes("y") ? up * (top - bottom) : 0,
      );
    } else if (step) this.#pan(panel!, ...step);
    // 0 alone, as the toolbar's button does.
    else if (event.key === "0" && plain) this.#reset(panel!, true);
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

/** Whether a pixel is in the room a plane is drawn across. */
function inRoom(plane: Plane, x: number, y: number): boolean {
  const [left, right] = plane.x.range;
  return (
    x >= left && x <= right && y >= Math.min(...plane.y.range) && y <= Math.max(...plane.y.range)
  );
}
