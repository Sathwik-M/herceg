// Labels outside a pie, joined to their slices by leader lines: each side's
// labels keep their slices' vertical order and are pushed apart until none
// overlap, dropping the smallest slices' labels when a side has no room.

/** A slice to label: its middle angle, in radians clockwise from +x. */
export interface PieLabelInput {
  angle: number;
  /** Labels with lower priority are dropped first when they do not fit. */
  priority: number;
}

export interface PlacedPieLabel {
  /** Index into the inputs. */
  index: number;
  /** Where the text starts (right side) or ends (left side), at its middle. */
  x: number;
  y: number;
  anchor: "start" | "end";
  /**
   * The leader line's points (x, y each): the slice's edge, out along its
   * middle, across to a column beside the pie, along the column to the
   * label's height, and to the text. Past the slice's edge it stays outside
   * the pie however far the label moved.
   */
  line: number[];
}

/** Distance from the pie to the elbow of a leader line. */
export const ELBOW = 10;
/** Horizontal run from the elbow to the text. */
export const RUN = 14;

/**
 * Places labels around a pie at (cx, cy) of radius `r`, each `lineHeight`
 * tall, within the vertical span [top, bottom]. Returns the labels that fit.
 */
export function placePieLabels(
  inputs: readonly PieLabelInput[],
  cx: number,
  cy: number,
  r: number,
  lineHeight: number,
  top: number,
  bottom: number,
): PlacedPieLabel[] {
  const placed: PlacedPieLabel[] = [];
  for (const right of [true, false]) {
    let side = inputs
      .map((input, index) => ({ input, index }))
      .filter(({ input }) => Math.cos(input.angle) >= 0 === right);
    // A side holds at most as many labels as lines fit; the smallest go first.
    const room = Math.max(0, Math.floor((bottom - top) / lineHeight));
    if (side.length > room) {
      side = side
        .sort((a, b) => b.input.priority - a.input.priority || a.index - b.index)
        .slice(0, room);
    }
    const wanted = side
      .map(({ input, index }) => ({
        index,
        input,
        y: cy + (r + ELBOW) * Math.sin(input.angle),
      }))
      .sort((a, b) => a.y - b.y || a.index - b.index);
    const ys = spread(
      wanted.map(({ y }) => y),
      lineHeight,
      top + lineHeight / 2,
      bottom - lineHeight / 2,
    );
    wanted.forEach(({ input, index }, i) => {
      const y = ys[i]!;
      const cos = Math.cos(input.angle);
      const sin = Math.sin(input.angle);
      const elbowX = cx + (r + ELBOW) * cos;
      const elbowY = cy + (r + ELBOW) * sin;
      const column = right ? cx + r + ELBOW : cx - r - ELBOW;
      const endX = right ? column + RUN : column - RUN;
      placed.push({
        index,
        x: right ? endX + 3 : endX - 3,
        y,
        anchor: right ? "start" : "end",
        line: [cx + r * cos, cy + r * sin, elbowX, elbowY, column, elbowY, column, y, endX, y],
      });
    });
  }
  return placed.sort((a, b) => a.index - b.index);
}

/**
 * Positions as close to `wanted` (ascending) as possible, at least `gap`
 * apart and within [low, high]; `wanted` must fit, (n - 1) * gap <= high - low.
 */
export function spread(
  wanted: readonly number[],
  gap: number,
  low: number,
  high: number,
): number[] {
  const n = wanted.length;
  const ys = wanted.map((y) => Math.min(high, Math.max(low, y)));
  // Down from the top, then up from the bottom: each pass only moves labels
  // away from the bound it starts at, so the result keeps the order and
  // stays within both bounds.
  for (let i = 1; i < n; i++) ys[i] = Math.max(ys[i]!, ys[i - 1]! + gap);
  if (n > 0) ys[n - 1] = Math.min(ys[n - 1]!, high);
  for (let i = n - 2; i >= 0; i--) ys[i] = Math.min(ys[i]!, ys[i + 1]! - gap);
  return ys;
}
