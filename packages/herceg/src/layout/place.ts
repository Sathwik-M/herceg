// Where chart furniture goes: items anchored inside a box (a legend at a
// plot's corner), and text and boxes aligned in a span. The model stacks
// titles and legends along the chart's sides and reserves their room from
// the panels; these are the small pieces that arithmetic shares.

import type { Rect } from "../scene/scene.ts";
import type { Inside } from "../spec/place.ts";

/**
 * The top left corner of an item `width` by `height` inside `box` at
 * `inside`, a corner or the middle of an edge, `inset` pixels in.
 */
export function insideAt(
  inside: Inside,
  box: Rect,
  width: number,
  height: number,
  inset: number,
): { x: number; y: number } {
  const across = inside.endsWith("left") ? 0 : inside.endsWith("right") ? 1 : 0.5;
  const down = inside.startsWith("top") ? 0 : inside.startsWith("bottom") ? 1 : 0.5;
  return {
    x: box.x + inset + (box.width - width - 2 * inset) * across,
    y: box.y + inset + (box.height - height - 2 * inset) * down,
  };
}

/** Where something goes in a span: at its start, center, or end. */
export type Align = "start" | "center" | "end";

const SHARE = { start: 0, center: 0.5, end: 1 } as const;
const ANCHOR = { start: "start", center: "middle", end: "end" } as const;

/** Where an item `length` long goes in a span from `start`, `room` long, aligned `align` (its start by default). */
export function alignedAt(
  align: Align | undefined,
  start: number,
  room: number,
  length: number,
): number {
  return start + (room - length) * SHARE[align ?? "start"];
}

/**
 * Where text aligned `align` goes in a span from `start`, `length` long
 * (negative for a span read backward): its anchor point and anchor.
 */
export function aligned(
  align: Align,
  start: number,
  length: number,
): { at: number; anchor: "start" | "middle" | "end" } {
  return { at: start + length * SHARE[align], anchor: ANCHOR[align] };
}
