// The range navigator's sliders: HTML controls over the strip the scene
// draws (model/navigator.ts), which a chart loads the first time it has a
// navigator. The window between the two edges pans when dragged, its edges
// zoom, a drag elsewhere in the strip shows the range dragged over, and a
// double click shows everything; for the keyboard, the edges and the window
// are sliders. They change the view through the chart's handle, so changes
// are reported and synced as any `setViewport` is, and drawn at once.
//
// This module imports no code: what it shared with the chart's own modules
// would move out of the chart's bundle into a chunk of its own.
import type { DrawnStrip } from "../model/navigator.ts";
import type { Chart } from "./handle.ts";

/** Below this many pixels, a press is a click rather than a drag (as `DRAG_THRESHOLD`). */
const DRAG_THRESHOLD = 3;
/** The least width of the window, in pixels of the strip. */
const MIN_WIDTH = 3;
/** How far each edge's hit area reaches outside the window, and inside it. */
const OUTSIDE = 10;
const INSIDE = 4;
/** The least width of the window's own hit area, between the edges'. */
const MIDDLE = 6;
/** Steps of the keys, as shares of the strip's width. */
const STEP = 0.01;
const PAGE = 0.1;
/** How long keys wait before announcing where they left the window, in milliseconds. */
const SETTLE = 400;

const HIDDEN_TEXT =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";

type Part = "left" | "window" | "right";

/** A drag over the strip, from where it started. */
interface Drag {
  pointer: number;
  part: Part | "select";
  x: number;
  strip: DrawnStrip;
  /** The viewport when it started, which Escape goes back to, and the last one it set. */
  from: readonly [number, number] | null;
  set: readonly [number, number] | null;
  moved: boolean;
}

/** Makes the sliders of `chart`, over the strip that `strip` reads. */
export function controls(chart: Chart, strip: () => DrawnStrip | undefined): Sliders {
  return new Sliders(chart, strip);
}

export class Sliders {
  readonly #chart: Chart;
  readonly #read: () => DrawnStrip | undefined;
  readonly #group: HTMLDivElement;
  readonly #parts: Record<Part, HTMLDivElement>;
  readonly #live: HTMLDivElement;
  readonly #stop: () => void;
  #drag: Drag | null = null;
  #disposed = false;
  /** An announcement waiting for keys to settle. */
  #pending: ReturnType<typeof setTimeout> | undefined;
  /** What the parts' styles and attributes were last set to, by element and name. */
  readonly #set = new WeakMap<Element, Map<string, string>>();

  constructor(chart: Chart, strip: () => DrawnStrip | undefined) {
    this.#chart = chart;
    this.#read = strip;
    const document = chart.root.ownerDocument;
    const div = () => document.createElement("div");
    this.#group = div();
    this.#group.setAttribute("role", "group");
    this.#group.setAttribute("aria-label", "Range navigator");
    this.#group.style.cssText =
      "position:absolute;touch-action:none;user-select:none;-webkit-user-select:none;cursor:crosshair";
    const slider = (label: string, cursor: string, z: number) => {
      const part = div();
      part.setAttribute("role", "slider");
      part.setAttribute("aria-orientation", "horizontal");
      part.setAttribute("aria-label", label);
      part.tabIndex = 0;
      part.style.cssText = `position:absolute;top:0;height:100%;cursor:${cursor};z-index:${z}`;
      return part;
    };
    this.#parts = {
      left: slider("Start of the shown range", "ew-resize", 2),
      window: slider("Shown range", "grab", 1),
      right: slider("End of the shown range", "ew-resize", 2),
    };
    this.#live = div();
    this.#live.setAttribute("aria-live", "polite");
    this.#live.setAttribute("aria-atomic", "true");
    this.#live.style.cssText = HIDDEN_TEXT;
    const { left, window: middle, right } = this.#parts;
    this.#group.append(left, middle, right, this.#live);
    chart.root.append(this.#group);
    this.#listen();
    this.#stop = chart.on("render", () => this.#update());
    this.#update();
  }

  dispose(): void {
    this.#end();
    this.#disposed = true;
    this.#stop();
    clearTimeout(this.#pending);
    this.#group.remove();
  }

  /**
   * Draws what is pending and returns the strip drawn, which then shows the
   * view: undefined if a `render` listener changed the view meanwhile (a
   * gesture would start from a strip already stale) or took the strip away.
   */
  #drawn(): DrawnStrip | undefined {
    if (!this.#strip()) return undefined;
    const view = this.#chart.getViewport().x;
    this.#chart.render();
    const strip = this.#strip();
    return strip && sameRange(this.#chart.getViewport().x, view) ? strip : undefined;
  }

  /** The strip as last drawn, while the chart still has a navigator. */
  #strip(): DrawnStrip | undefined {
    return this.#disposed ? undefined : this.#read();
  }

  /** Places the parts over the strip drawn, and says what they show. */
  #update(): void {
    const strip = this.#strip();
    this.#attribute(this.#group, "hidden", strip ? null : "");
    if (!strip) {
      // A drag cannot go on over a strip that is not drawn.
      this.#end();
      return;
    }
    const { plot, shown } = strip;
    // A strip that moved, resized, turned around, or changed its scale's
    // type or breaks (the chart did) ends a drag over it: its pixels no
    // longer mean what they did when it started. Data that only widens the
    // domain does not.
    const held = this.#drag?.strip;
    if (held && !sameRail(held, strip)) this.#end();
    this.#style(this.#group, "left", `${plot.x}px`);
    this.#style(this.#group, "top", `${plot.y}px`);
    this.#style(this.#group, "width", `${plot.width}px`);
    this.#style(this.#group, "height", `${plot.height}px`);
    // Hit areas side by side: the edges' reach into the window leaves its
    // middle, at least a few pixels wide, to the window, so a narrow one
    // still pans.
    const [from, to] = pixels(strip, shown);
    const inside = Math.max(0, Math.min(INSIDE, (to - from - MIDDLE) / 2));
    const half = Math.max(MIDDLE, to - from - 2 * inside) / 2;
    const middleX = (from + to) / 2;
    const { left, window: middle, right } = this.#parts;
    const place = (part: HTMLDivElement, x0: number, x1: number) => {
      this.#style(part, "left", `${x0 - plot.x}px`);
      this.#style(part, "width", `${x1 - x0}px`);
    };
    place(left, from - OUTSIDE, middleX - half);
    place(middle, middleX - half, middleX + half);
    place(right, middleX + half, to + OUTSIDE);
    // Each edge names the value at it: on a reversed axis, the left one
    // holds the end. Bounds are where Home and End take each slider.
    const span = spanOf(strip, shown);
    const [startEdge, endEdge] = span.up > 0 ? [left, right] : [right, left];
    const [start, end] = shown;
    const at = (part: HTMLDivElement, value: number, min: number, max: number, text: string) => {
      this.#attribute(part, "aria-valuenow", String(value));
      this.#attribute(part, "aria-valuemin", String(min));
      this.#attribute(part, "aria-valuemax", String(max));
      this.#attribute(part, "aria-valuetext", text);
    };
    const bound = (move: Move, side: 0 | 1) =>
      rangeOf(strip, span, move(span))?.[side] ?? shown[side];
    const format = (value: number) => this.#format(value);
    at(startEdge, start, bound(startTo(-Infinity), 0), bound(startTo(Infinity), 0), format(start));
    at(endEdge, end, bound(endTo(-Infinity), 1), bound(endTo(Infinity), 1), format(end));
    // The window's value is its start.
    at(
      middle,
      start,
      bound(pan(-Infinity), 0),
      bound(pan(Infinity), 0),
      `${format(start)} to ${format(end)}`,
    );
    this.#attribute(startEdge, "aria-label", "Start of the shown range");
    this.#attribute(endEdge, "aria-label", "End of the shown range");
  }

  #format(value: number): string {
    return this.#chart.formatValue(value, { axis: "x" }) ?? String(value);
  }

  #announce(): void {
    const strip = this.#strip();
    if (!strip) return;
    const [start, end] = strip.shown;
    this.#live.textContent = `Showing ${this.#format(start)} to ${this.#format(end)}.`;
  }

  /** Announces where the window is once keys stop moving it. */
  #announceLater(): void {
    clearTimeout(this.#pending);
    this.#pending = setTimeout(() => this.#announce(), SETTLE);
  }

  #style(element: HTMLElement, name: "left" | "top" | "width" | "height", value: string): void {
    if (this.#remember(element, name, value)) element.style[name] = value;
  }

  #attribute(element: HTMLElement, name: string, value: string | null): void {
    if (!this.#remember(element, name, value ?? "\u0000")) return;
    if (value === null) element.removeAttribute(name);
    else element.setAttribute(name, value);
  }

  /** Whether `value` is new for the element's `name`, remembering it. */
  #remember(element: Element, name: string, value: string): boolean {
    let set = this.#set.get(element);
    if (!set) {
      set = new Map();
      this.#set.set(element, set);
    }
    if (set.get(name) === value) return false;
    set.set(name, value);
    return true;
  }

  #listen(): void {
    const group = this.#group;
    const local = (event: MouseEvent) =>
      event.clientX - this.#chart.root.getBoundingClientRect().left;
    group.addEventListener("pointerdown", (event) => {
      // Presses on the strip are its own: the plot's handlers never take
      // them, even if the strip goes as it draws.
      event.stopPropagation();
      // One pointer drags at a time: a second finger does nothing.
      if (event.button !== 0 || !event.isPrimary || this.#drag) return;
      // The slider pressed takes the focus, the window's for a press
      // elsewhere in the strip, so that Escape reaches the drag; the chart
      // would otherwise take it, and text selection would start.
      event.preventDefault();
      const pressed = event.target as HTMLElement;
      (pressed.getAttribute("role") === "slider" ? pressed : this.#parts.window).focus({
        preventScroll: true,
      });
      // A drag starts from the view it lands in, not one an animation passes
      // through, nor one not drawn yet.
      const strip = this.#drawn();
      if (!strip) return;
      const target = event.target as Element;
      const part = (Object.keys(this.#parts) as Part[]).find(
        (name) => this.#parts[name] === target,
      );
      const from = this.#chart.getViewport().x;
      this.#drag = {
        pointer: event.pointerId,
        part: part ?? "select",
        x: local(event),
        strip,
        from,
        set: from,
        moved: false,
      };
      group.setPointerCapture?.(event.pointerId);
      if (part === "window") this.#parts.window.style.cursor = "grabbing";
    });
    group.addEventListener("pointermove", (event) => {
      const drag = this.#drag;
      if (drag?.pointer === event.pointerId) this.#dragTo(drag, local(event));
    });
    // A drag ends where the pointer is released, wherever the last move was.
    group.addEventListener("pointerup", (event) => {
      const drag = this.#drag;
      if (drag?.pointer !== event.pointerId) return;
      this.#dragTo(drag, local(event));
      if (drag.moved && this.#drag === drag) this.#announce();
      this.#end();
    });
    // The browser took the pointer: the drag keeps what it showed.
    const cancel = (event: PointerEvent) => {
      if (this.#drag?.pointer === event.pointerId) this.#end();
    };
    group.addEventListener("pointercancel", cancel);
    group.addEventListener("lostpointercapture", cancel);
    // The strip's double click shows all of x and leaves y alone; the
    // chart's own (which resets y too) and its wheel zoom stay out of it.
    group.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      this.#show(null);
      this.#announce();
    });
    group.addEventListener("wheel", (event) => event.stopPropagation());
    group.addEventListener("keydown", (event) => this.#key(event));
  }

  /**
   * Shows an ascending x range, or with null the data, at once: drawn now,
   * so an animated chart does not move there gradually, as it would to a
   * view an application asks for.
   */
  #show(x: readonly [number, number] | null): void {
    this.#chart.setViewport({ x });
    this.#chart.render();
  }

  /**
   * Moves a drag to `x` pixels along the chart, once it has gone a few
   * pixels. Another change of view (a wheel, a synced chart, a viewport
   * listener) since the drag's last one ends the drag rather than undo it.
   */
  #dragTo(drag: Drag, x: number): void {
    drag.moved ||= Math.abs(x - drag.x) >= DRAG_THRESHOLD;
    if (!drag.moved) return;
    if (!sameRange(this.#chart.getViewport().x, drag.set)) {
      this.#end();
      return;
    }
    const range = dragged(drag, x);
    if (!range) return;
    this.#show(range);
    // Listeners may have ended the drag, removed the navigator, or more.
    if (this.#disposed || this.#drag !== drag) return;
    const now = this.#chart.getViewport().x;
    if (!sameRange(now, range)) this.#end();
    else drag.set = now;
  }

  /** Ends the drag, however it ends, letting go of its pointer. */
  #end(): void {
    const drag = this.#drag;
    if (drag && this.#group.hasPointerCapture?.(drag.pointer))
      this.#group.releasePointerCapture(drag.pointer);
    this.#drag = null;
    this.#parts.window.style.cursor = "grab";
  }

  /**
   * Keys move the slider focused: an edge moves itself, the window pans
   * (with Shift, it widens or narrows about its middle). Escape takes a
   * drag back to where it started, or else shows all of x.
   */
  #key(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      const drag = this.#drag;
      if (drag) {
        this.#end();
        // Back to where it started, unless something else changed the view since.
        if (drag.moved && sameRange(this.#chart.getViewport().x, drag.set)) this.#show(drag.from);
      } else if (this.#chart.getViewport().x !== null) {
        this.#show(null);
        this.#announce();
      } else return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const part = (Object.keys(this.#parts) as Part[]).find(
      (name) => this.#parts[name] === event.target,
    );
    const sign = KEYS[event.key];
    if (!part || sign === undefined) return;
    // Keys move from the view asked for, drawn: not one an animation passes
    // through, nor a strip that view would widen.
    const strip = this.#drawn();
    if (!strip) return;
    event.preventDefault();
    event.stopPropagation();
    const span = spanOf(strip, strip.shown);
    const step = Math.max(1, strip.plot.width * (event.key.startsWith("Page") ? PAGE : STEP));
    // Keys move values: up is toward larger ones, and Home and End go to a
    // slider's least and greatest value.
    const by = Math.abs(sign) === Infinity ? sign : sign * step;
    const role = roleOf(part, span);
    const move: Move =
      role === "start"
        ? startTo(span.start + by)
        : role === "end"
          ? endTo(span.end + by)
          : event.shiftKey && Number.isFinite(by)
            ? resize(by)
            : pan(by);
    const range = rangeOf(strip, span, move(span));
    if (!range) return;
    this.#show(range);
    this.#announceLater();
  }
}

/** Which way each key moves a slider; Home and End go all the way. */
const KEYS: Record<string, number> = {
  ArrowLeft: -1,
  ArrowDown: -1,
  ArrowRight: 1,
  ArrowUp: 1,
  PageDown: -1,
  PageUp: 1,
  Home: -Infinity,
  End: Infinity,
};

/** A range's ends in the strip's pixels, left first. */
function pixels(strip: DrawnStrip, range: readonly [number, number]): [number, number] {
  const a = strip.rail.map(range[0]);
  const b = strip.rail.map(range[1]);
  return a <= b ? [a, b] : [b, a];
}

/**
 * The window and the strip in pixels measured toward larger values (so
 * leftward on a reversed axis, where `up` is -1): `start` and `end` are the
 * places of its edges' values, `low` and `high` the strip's ends, and
 * `least` how narrow the window may get, a few pixels or as narrow as it is.
 */
interface Span {
  /** The window's values, which edges that do not move keep exactly. */
  values: readonly [number, number];
  up: 1 | -1;
  start: number;
  end: number;
  low: number;
  high: number;
  least: number;
}

/** A window's edges moved within its span: the places of its start and end. */
type Move = (span: Span) => readonly [number, number];

function spanOf(strip: DrawnStrip, view: readonly [number, number]): Span {
  const { plot, rail } = strip;
  const a = rail.map(view[0]);
  const b = rail.map(view[1]);
  const up = b >= a ? 1 : -1;
  const [low, high] = [up * plot.x, up * (plot.x + plot.width)].sort((x, y) => x - y) as [
    number,
    number,
  ];
  const [start, end] = [up * a, up * b];
  const least = Math.min(MIN_WIDTH, end - start, high - low);
  return { values: view, up, start, end, low, high, least };
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

/** The start edge moved to `to`, stopping short of the end. */
const startTo =
  (to: number): Move =>
  ({ end, low, least }) => [clamp(to, low, Math.max(low, end - least)), end];

/** The end edge moved to `to`, stopping short of the start. */
const endTo =
  (to: number): Move =>
  ({ start, high, least }) => [start, clamp(to, Math.min(high, start + least), high)];

/** The window moved `by`, keeping its width, inside the strip. */
const pan =
  (by: number): Move =>
  ({ start, end, low, high }) => {
    const shift = clamp(by, low - start, high - end);
    return [start + shift, end + shift];
  };

/** The window widened `by` (narrowed, for less than 0) about its middle, inside the strip. */
const resize =
  (by: number): Move =>
  ({ start, end, low, high, least }) => {
    const width = Math.min(high - low, Math.max(least, end - start + by));
    const from = clamp((start + end) / 2 - width / 2, low, high - width);
    return [from, from + width];
  };

/** The range between two places, inside the strip and a few pixels wide at least. */
const between =
  (a: number, b: number): Move =>
  ({ low, high }) => {
    const least = Math.min(MIN_WIDTH, high - low);
    let from = clamp(Math.min(a, b), low, high);
    const to = clamp(Math.max(a, b), low, high);
    if (to - from >= least) return [from, to];
    from = Math.min(from, high - least);
    return [from, from + least];
  };

/** Which edge a part of the sliders is: the left one holds the start, unless the axis is reversed. */
function roleOf(part: Part, span: Span): "start" | "end" | "window" {
  if (part === "window") return part;
  return (part === "left") === span.up > 0 ? "start" : "end";
}

/**
 * The ascending x range between two places of `span`. An edge that stays
 * keeps its value, which pixels would not give back where a time axis'
 * break collapses many values into one place; the strip's ends are its
 * domain's ends exactly.
 */
function rangeOf(
  strip: DrawnStrip,
  span: Span,
  [start, end]: readonly [number, number],
): [number, number] | undefined {
  const { plot, rail } = strip;
  const [d0, d1] = rail.domain;
  const [left, right] = rail.map(d0) <= rail.map(d1) ? [d0, d1] : [d1, d0];
  const value = (place: number) => {
    const px = span.up * place;
    return px <= plot.x ? left : px >= plot.x + plot.width ? right : rail.invert(px);
  };
  const x0 = start === span.start ? span.values[0] : value(start);
  const x1 = end === span.end ? span.values[1] : value(end);
  if (!(Number.isFinite(x0) && Number.isFinite(x1)) || x0 === x1) return undefined;
  return x0 < x1 ? [x0, x1] : [x1, x0];
}

/** The x range a drag shows `x` pixels along the chart, from the strip it started on. */
function dragged(drag: Drag, x: number): [number, number] | undefined {
  const { strip } = drag;
  const span = spanOf(strip, strip.shown);
  const by = span.up * (x - drag.x);
  const move: Move =
    drag.part === "select"
      ? between(span.up * drag.x, span.up * x)
      : drag.part === "window"
        ? pan(by)
        : roleOf(drag.part, span) === "start"
          ? startTo(span.start + by)
          : endTo(span.end + by);
  return rangeOf(strip, span, move(span));
}

/** Whether a drag over `held` can go on over `strip`, drawn since. */
function sameRail(held: DrawnStrip, strip: DrawnStrip): boolean {
  const [a, b] = [held.rail, strip.rail];
  return (
    sameRect(held.plot, strip.plot) &&
    a.type === b.type &&
    a.breaks === b.breaks &&
    rising(a) === rising(b)
  );
}

/** Whether a rail's larger values are to the right, as on unreversed axes. */
function rising(rail: DrawnStrip["rail"]): boolean {
  const [a, b] = rail.domain;
  return rail.map(Math.max(a, b)) >= rail.map(Math.min(a, b));
}

function sameRect(a: DrawnStrip["plot"], b: DrawnStrip["plot"]): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function sameRange(
  a: readonly [number, number] | null,
  b: readonly [number, number] | null,
): boolean {
  return a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1]);
}
