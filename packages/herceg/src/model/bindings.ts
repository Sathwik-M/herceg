// Gestures bound to actions: `interaction.bindings`, then the bindings the
// presets (`pan`, `zoom`, `brush`, `rotate`, `drag`) stand for, compiled
// once per configuration. The chart's input gate, its controller, and the
// controls of layout marks match input against the same list, so the same
// input means the same in every chart.

import type {
  BindingSpec,
  BrushSpec,
  DragGesture,
  InteractionSpec,
  KeyGesture,
  Modifier,
  WheelGesture,
  ZoomSpec,
} from "../spec/spec.ts";

/** A binding as input is matched against it: its gesture's modifiers as a mask (see `modifiersOf`). */
export type Binding = BindingSpec & { mods: number };

/** What bindings read of an input event: the keys held, and what tells gestures apart. */
export interface GestureEvent {
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  /** Pointer events: the button pressed and the kind of pointer. */
  button?: number;
  pointerType?: string;
  /** Keyboard events. */
  key?: string;
  /** Wheel events. */
  deltaX?: number;
  deltaY?: number;
}

/** Input as bindings match it: the gesture made and what tells it apart. */
interface Input {
  type: BindingSpec["gesture"]["type"];
  /** The keys held, as a mask (see `modifiersOf`). */
  mods: number;
  axis: "x" | "y";
  button: number | undefined;
  pointer: string | undefined;
  key: string | undefined;
  focused: boolean;
}

/** Keys the keyboard cursor and selections answer to. */
export const NAVIGATION_KEYS = [
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

const MODIFIERS: readonly Modifier[] = ["shift", "ctrl", "alt", "meta"];
const SHIFT = 1;

/** The keys an event says are held, as a mask: Shift 1, Ctrl 2, Alt 4, Meta 8. */
function modifiersOf(event: GestureEvent): number {
  return +event.shiftKey | (+event.ctrlKey << 1) | (+event.altKey << 2) | (+event.metaKey << 3);
}

/** A gesture's modifiers as a mask (pinches have none). */
function mask(gesture: BindingSpec["gesture"]): number {
  const modifiers = ("modifiers" in gesture && gesture.modifiers) || [];
  return modifiers.reduce((sum, modifier) => sum | (1 << MODIFIERS.indexOf(modifier)), 0);
}

/** Zoom presets' steps for keys: + and − zoom by this, double-click resets. */
const KEY_ZOOM = 1.25;

/** A chart's bindings, which input is matched against. */
export class Bindings {
  readonly list: readonly Binding[];

  /**
   * The bindings of a chart's `interaction`: its own, in order, then the
   * presets'. Throws for a gesture bound twice, for keys the keyboard
   * cursor answers to, for a brush that zooms in a chart whose brushes
   * select rows (`brushesRows`), and for limits that run backwards.
   */
  constructor(interaction: InteractionSpec = {}, brushesRows = false) {
    this.list = compile(interaction, brushesRows);
  }

  /**
   * The first binding that `event`, a gesture of `type`, matches and whose
   * action `applies` where it happened, if any; `focused` says whether the
   * chart has the keyboard focus. A `pageScroll` binding leaves the input
   * to the page: its caller takes nothing.
   */
  match(
    type: Input["type"],
    event: GestureEvent,
    applies: (action: Binding["action"]) => boolean = () => true,
    focused = false,
  ): Binding | undefined {
    const { deltaX = 0, deltaY = 0 } = event;
    const input: Input = {
      type,
      mods: modifiersOf(event),
      // Ties go to y, the way wheels turn.
      axis: Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y",
      button: event.button,
      pointer: event.pointerType,
      key: event.key,
      focused,
    };
    return this.list.find((binding) => fits(binding, input) && applies(binding.action));
  }
}

/**
 * Refuses limits that bound nothing sensible: ends that are not finite
 * numbers (or null), or that run backwards; edges' fractions below zero.
 * Specs are checked as they load; charts made in code, here.
 */
function checkLimits({ limits }: InteractionSpec): void {
  for (const name of ["x", "y", "yRight"] as const) {
    const { extent, edge } = limits?.[name] ?? {};
    const at = `interaction.limits.${name}`;
    const end = (value: unknown) =>
      value === null || (typeof value === "number" && Number.isFinite(value));
    if (
      extent &&
      !(
        extent.length === 2 &&
        extent.every(end) &&
        (extent[0] === null || extent[1] === null || extent[0] < extent[1])
      )
    )
      throw new Error(
        `${at}.extent: expected two finite numbers, ascending, either of them null for no end; received ${JSON.stringify(extent)}`,
      );
    for (const [key, value] of Object.entries(typeof edge === "object" ? edge : {}))
      if (!(typeof value === "number" && value >= 0 && Number.isFinite(value)))
        throw new Error(
          `${at}.edge.${key}: expected a fraction of the view, at least 0; received ${String(value)}`,
        );
  }
}

function compile(interaction: InteractionSpec, brushesRows: boolean): Binding[] {
  checkLimits(interaction);
  const { pan, zoom, brush, rotate = true, drag } = interaction;
  const list: Binding[] = [];
  const add = (binding: BindingSpec) =>
    list.push({ ...binding, mods: mask(binding.gesture) } as Binding);
  for (const [i, binding] of (interaction.bindings ?? []).entries()) {
    const at = `interaction.bindings[${i}]`;
    const { gesture, action } = binding;
    const mods = mask(gesture);
    const twin = list.findIndex(
      (other) => other.mods === mods && sameGesture(other.gesture, gesture),
    );
    if (twin >= 0)
      throw new Error(`${at}: duplicates binding ${twin}; remove one or change its gesture`);
    if (gesture.type === "key" && NAVIGATION_KEYS.includes(gesture.key) && !(mods & ~SHIFT))
      throw new Error(
        `${at}.gesture.key: "${gesture.key}" moves the keyboard cursor; bind another key, or hold Ctrl, Alt, or Meta`,
      );
    if (action.type === "brush" && action.zoom && brushesRows)
      throw new Error(
        `${at}.action.zoom: brushes select rows for rowSelection, which never zoom; drop zoom, or "brush" from rowSelection's events`,
      );
    add(binding);
  }
  // `zoom` pans too, unless `pan` is false; `true` is each panel's default axes.
  const panning = pan === false ? undefined : (pan ?? zoom);
  const panAxes = axesOf(panning);
  const zoomAxes = axesOf(zoom);
  const panX = panning && panAxes !== "y";
  if (brush) {
    const action = { type: "brush", shape: brush, zoom: covers(zoom, brush) } as const;
    add({ gesture: { type: "drag" }, action });
    // Shift-drag pans a chart that pans, and brushes the others.
    if (!panning) add({ gesture: { type: "drag", modifiers: ["shift"] }, action });
  }
  if (drag) add({ gesture: { type: "drag" }, action: { type: "moveItem" } });
  if (panning) {
    const action = { type: "pan", ...(panAxes && { axes: panAxes }) } as const;
    // With a brush, Shift-drag pans; a map's lasso brushes only when its
    // toolbar says so, and dragging pans otherwise.
    if (!brush || brush === "lasso") add({ gesture: { type: "drag" }, action });
    add({ gesture: { type: "drag", modifiers: ["shift"] }, action });
  }
  if (rotate) add({ gesture: { type: "drag" }, action: { type: "orbit" } });
  if (panX) {
    const action = { type: "pan", axes: "x" } as const;
    add({ gesture: { type: "wheel", axis: "x" }, action });
    // Shift scrolls sideways: browsers report it along x or along y.
    add({ gesture: { type: "wheel", axis: "x", modifiers: ["shift"] }, action });
    add({ gesture: { type: "wheel", axis: "y", modifiers: ["shift"] }, action });
  }
  if (zoom) {
    const action = { type: "zoom", ...(zoomAxes && { axes: zoomAxes }) } as const;
    for (const modifiers of [["ctrl"], ["meta"]] as const)
      add({ gesture: { type: "wheel", axis: "y", modifiers }, action });
    add({ gesture: { type: "pinch" }, action });
    for (const key of ["+", "="])
      add({ gesture: { type: "key", key }, action: { ...action, factor: KEY_ZOOM } });
    add({ gesture: { type: "key", key: "-" }, action: { ...action, factor: 1 / KEY_ZOOM } });
    add({ gesture: { type: "key", key: "0" }, action: { type: "reset" } });
  }
  if (panning || zoom) add({ gesture: { type: "doubleClick" }, action: { type: "reset" } });
  return list;
}

/** A preset's axes: `true` is each panel's default (x along axes, both ways on a plane). */
function axesOf(value: boolean | ZoomSpec | undefined): ZoomSpec | undefined {
  return value === true || !value ? undefined : value;
}

/** Whether a zoom preset zooms along every axis a brush selects along: then the brush zooms. */
function covers(zoom: boolean | ZoomSpec | undefined, brush: BrushSpec): boolean {
  const axes = zoom === true ? "x" : zoom || "";
  return brush !== "lasso" && [...brush].every((axis) => axes.includes(axis));
}

/** Whether two gestures are the same but for their modifiers. */
function sameGesture(a: BindingSpec["gesture"], b: BindingSpec["gesture"]): boolean {
  const key = (gesture: BindingSpec["gesture"]) => {
    const {
      type,
      axis,
      focused,
      button = 0,
      pointer,
      key,
    } = gesture as Partial<WheelGesture & DragGesture & KeyGesture>;
    return JSON.stringify([type, axis, !!focused, button, pointer, key]);
  };
  return key(a) === key(b);
}

function fits({ gesture, mods }: Binding, input: Input): boolean {
  if (gesture.type !== input.type) return false;
  // Shift may be needed to type a symbol ("+"), so it does not count there.
  const loose = gesture.type === "key" && gesture.key.length === 1 && !/\p{L}/u.test(gesture.key);
  if ((loose ? input.mods & ~SHIFT : input.mods) !== (loose ? mods & ~SHIFT : mods)) return false;
  switch (gesture.type) {
    case "wheel":
      return (
        (!gesture.axis || gesture.axis === input.axis) && (!gesture.focused || !!input.focused)
      );
    case "drag":
      return (
        (gesture.button ?? 0) === input.button &&
        (!gesture.pointer || gesture.pointer === input.pointer)
      );
    case "key":
      return gesture.key === input.key;
    default:
      return true;
  }
}
