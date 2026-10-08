// Labels of a radar: spoke names around it (how large the radar can be with
// them outside the rim, and where each goes), and ring values beside the
// first spoke. Labels that do not fit are shortened or left out, so the radar
// keeps most of its room.

import type { Rect } from "../scene/scene.ts";
import { fitText, type MeasureText } from "./text.ts";

/** The smallest radius labels may shrink the radar to, as a fraction of the radius it has without them. */
const SMALLEST = 0.6;
/** Space kept between labels side by side. */
const SPACING = 6;

/** Left, top, right, bottom. */
type Box = [number, number, number, number];

export interface SpokeLabel {
  /** The spoke's index. */
  spoke: number;
  text: string;
  /** Where the text starts, ends, or is centered (by `anchor`), and its vertical middle. */
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  box: Box;
}

/** A ring's value: text starting at x, vertically centered on y. */
export interface TickLabel {
  text: string;
  x: number;
  y: number;
}

/**
 * Labels on the right start at their spoke, labels on the left end at it,
 * and labels near the top and bottom are centered on it.
 */
function anchorAt(cos: number): SpokeLabel["anchor"] {
  return cos > 0.15 ? "start" : cos < -0.15 ? "end" : "middle";
}

/**
 * The radius of a radar centered in `bounds` that leaves room outside its
 * rim for the spoke labels `names` (at `angles`, radians clockwise from +x),
 * and the labels placed there.
 */
export function placeSpokeLabels(
  names: readonly string[],
  angles: Float64Array,
  bounds: Rect,
  measure: MeasureText,
  font: string,
  lineHeight: number,
): { radius: number; labels: SpokeLabel[] } {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const right = bounds.x + bounds.width;
  const bottom = bounds.y + bounds.height;
  const full = Math.max(0, Math.min(bounds.width, bounds.height) / 2 - 2);
  const directions = Array.from(angles, (angle) => [Math.cos(angle), Math.sin(angle)] as const);
  // Beyond the rim's value, which is centered on the rim beside the first spoke.
  const gap = lineHeight / 2 + 1;

  /** A label `width` wide on spoke `spoke` of a radar of radius `r`. */
  const place = (spoke: number, r: number, width: number) => {
    const [cos, sin] = directions[spoke]!;
    const x = cx + (r + gap) * cos;
    // Labels above and below the radar sit beyond the gap, not across it.
    const y = cy + (r + gap) * sin + (sin * lineHeight) / 2;
    const anchor = anchorAt(cos);
    const left = anchor === "start" ? x : anchor === "end" ? x - width : x - width / 2;
    const box: Box = [left, y - lineHeight / 2, left + width, y + lineHeight / 2];
    return { x, y, anchor, box };
  };

  // A label on a larger radar is the same box moved along its spoke, so each
  // edge facing outward limits the radius linearly. Centered labels grow
  // sideways; shortening them fits them, not a smaller radar.
  let radius = full;
  names.forEach((name, spoke) => {
    const [cos, sin] = directions[spoke]!;
    const { anchor, box } = place(spoke, 0, measure(name, font));
    if (anchor === "start") radius = Math.min(radius, (right - box[2]) / cos);
    if (anchor === "end") radius = Math.min(radius, (box[0] - bounds.x) / -cos);
    if (sin > 1e-9) radius = Math.min(radius, (bottom - box[3]) / sin);
    if (sin < -1e-9) radius = Math.min(radius, (box[1] - bounds.y) / -sin);
  });
  radius = Math.max(radius, full * SMALLEST);

  const labels: SpokeLabel[] = [];
  const taken: Box[] = [];
  names.forEach((name, spoke) => {
    const { x, y, anchor, box } = place(spoke, radius, 0);
    if (box[1] < bounds.y || box[3] > bottom) return;
    const room =
      anchor === "start"
        ? right - x
        : anchor === "end"
          ? x - bounds.x
          : 2 * Math.min(x - bounds.x, right - x);
    const text = fitText(name, room, measure, font);
    if (text === "…" || text === "") return;
    const fitted = place(spoke, radius, measure(text, font)).box;
    // Earlier spokes keep their labels; many spokes on a small radar crowd them.
    if (taken.some((other) => overlaps(fitted, other))) return;
    taken.push(fitted);
    labels.push({ spoke, text, x, y, anchor, box: fitted });
  });
  return { radius, labels };
}

/**
 * The ring labels that fit, from `ticks` in order of priority: each inside
 * `bounds`, and clear of the spoke labels and of the ring labels kept before it.
 */
export function fitTickLabels(
  ticks: readonly TickLabel[],
  spokes: readonly SpokeLabel[],
  bounds: Rect,
  measure: MeasureText,
  font: string,
  lineHeight: number,
): TickLabel[] {
  const taken = spokes.map(({ box }) => box);
  return ticks.filter(({ text, x, y }) => {
    const box: Box = [x, y - lineHeight / 2, x + measure(text, font), y + lineHeight / 2];
    const inside =
      box[0] >= bounds.x &&
      box[1] >= bounds.y &&
      box[2] <= bounds.x + bounds.width &&
      box[3] <= bounds.y + bounds.height;
    if (!inside || taken.some((other) => overlaps(box, other))) return false;
    taken.push(box);
    return true;
  });
}

/** Lines of text overlap when their boxes do, or when they are too close side by side. */
function overlaps(a: Box, b: Box): boolean {
  return a[0] < b[2] + SPACING && b[0] < a[2] + SPACING && a[1] < b[3] && b[1] < a[3];
}
