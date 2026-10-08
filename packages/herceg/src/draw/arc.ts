import type { ArcGeometry, Drawing, SvgElement } from "../scene/scene.ts";
import { markupOf, n, type PathSink, SvgPath } from "./markup.ts";

const TAU = 2 * Math.PI;

/** Paths that take circular arcs too, as a canvas does. */
export type ArcSink = PathSink & Pick<CanvasPath, "arc">;

/**
 * The sweep of an arc traced as on a canvas: positive and at most a full
 * turn, or 0 for arcs that draw nothing.
 */
export function arcSweep(a0: number, a1: number, counterclockwise = false): number {
  const sweep = counterclockwise ? a0 - a1 : a1 - a0;
  return sweep > 0 ? Math.min(sweep, TAU) : 0;
}

/**
 * SVG path data with arcs. As on a canvas, an arc continues the path with a
 * line to its start, so the builder keeps track of the current point.
 */
export class ArcPath extends SvgPath implements ArcSink {
  /** The current point; NaN before the first. */
  #x = Number.NaN;
  #y = Number.NaN;
  /** Where the current subpath started, which closing it returns to. */
  #startX = Number.NaN;
  #startY = Number.NaN;

  override moveTo(x: number, y: number): void {
    super.moveTo(x, y);
    this.#x = this.#startX = x;
    this.#y = this.#startY = y;
  }
  override lineTo(x: number, y: number): void {
    super.lineTo(x, y);
    this.#x = x;
    this.#y = y;
  }
  override bezierCurveTo(
    ax: number,
    ay: number,
    bx: number,
    by: number,
    x: number,
    y: number,
  ): void {
    super.bezierCurveTo(ax, ay, bx, by, x, y);
    this.#x = x;
    this.#y = y;
  }
  override rect(x: number, y: number, width: number, height: number): void {
    super.rect(x, y, width, height);
    this.#x = this.#startX = x;
    this.#y = this.#startY = y;
  }
  override closePath(): void {
    super.closePath();
    this.#x = this.#startX;
    this.#y = this.#startY;
  }
  arc(cx: number, cy: number, r: number, a0: number, a1: number, counterclockwise = false): void {
    const x = cx + r * Math.cos(a0);
    const y = cy + r * Math.sin(a0);
    if (Number.isNaN(this.#x)) this.moveTo(x, y);
    else if (Math.abs(x - this.#x) > 0.05 || Math.abs(y - this.#y) > 0.05) this.lineTo(x, y);
    const sweep = arcSweep(a0, a1, counterclockwise);
    // One A command cannot draw a whole circle; arcs over a half turn take two.
    const parts = sweep > Math.PI ? 2 : 1;
    const step = (counterclockwise ? -sweep : sweep) / parts;
    for (let i = 1; sweep > 0 && i <= parts; i++) {
      const ex = cx + r * Math.cos(a0 + step * i);
      const ey = cy + r * Math.sin(a0 + step * i);
      this.d += `A${n(r)} ${n(r)} 0 0 ${counterclockwise ? 0 : 1} ${n(ex)} ${n(ey)}`;
      this.#x = ex;
      this.#y = ey;
    }
  }
}

/**
 * The gap a sector of `sweep` radians out to radius `r1` keeps from its
 * neighbors: `gap`, or less for sectors narrower than three gaps at their
 * rim, so that thin sectors still show.
 */
export function sectorGap(gap: number, sweep: number, r1: number): number {
  return Math.min(gap, (sweep * r1) / 3);
}

/**
 * Adds a ring sector to `sink`: between radii r0 and r1 around (cx, cy),
 * from angle a0 to a1 (radians, clockwise from +x on screen). A gap moves
 * the sector's straight sides gap / 2 inward, parallel to themselves, so
 * neighboring sectors are evenly apart; a pie slice's point moves out to
 * where its sides meet. Thin sectors keep a smaller gap (see `sectorGap`).
 */
export function traceSector(
  sink: ArcSink,
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
  gap: number,
): void {
  const sweep = a1 - a0;
  if (!(sweep > 0 && r1 > r0)) return;
  if (sweep >= TAU - 1e-9) {
    // A whole ring: the outer circle one way round, the hole the other.
    sink.moveTo(cx + r1, cy);
    sink.arc(cx, cy, r1, 0, TAU, false);
    sink.closePath();
    if (r0 > 0) {
      sink.moveTo(cx + r0, cy);
      sink.arc(cx, cy, r0, TAU, 0, true);
      sink.closePath();
    }
    return;
  }
  const half = sectorGap(gap, sweep, r1) / 2;
  // Closer in than this, the moved sides have crossed.
  const inner = Math.max(r0, half > 0 ? half / Math.sin(Math.min(sweep, Math.PI) / 2) : 0);
  if (!(inner < r1)) return;
  const d1 = Math.asin(half / r1);
  sink.moveTo(cx + r1 * Math.cos(a0 + d1), cy + r1 * Math.sin(a0 + d1));
  sink.arc(cx, cy, r1, a0 + d1, a1 - d1, false);
  if (inner > 0) {
    const d0 = Math.min(sweep / 2, Math.asin(Math.min(1, half / inner)));
    sink.arc(cx, cy, inner, a1 - d0, a0 + d0, true);
  } else {
    sink.lineTo(cx, cy);
  }
  sink.closePath();
}

/** The sectors of `mark` by color: the indices of those filled with each of its colors. */
export function sectorsByColor(mark: ArcGeometry): number[][] {
  const groups = mark.colors.map((): number[] => []);
  for (let i = 0; i < mark.count; i++) groups[mark.colorIndex[i]!]?.push(i);
  return groups;
}

/** Adds the sectors `sectors` of `mark`. */
export function traceArcs(sink: ArcSink, mark: ArcGeometry, sectors: readonly number[]): void {
  const a = mark.arcs;
  for (const i of sectors) {
    const at = i * 6;
    traceSector(sink, a[at]!, a[at + 1]!, a[at + 2]!, a[at + 3]!, a[at + 4]!, a[at + 5]!, mark.gap);
  }
}

/** Sectors as one path per color, in the order the colors are listed. */
function arcElements(mark: ArcGeometry): SvgElement[] {
  const groups = sectorsByColor(mark);
  return mark.colors.flatMap((fill, color) => {
    const path = new ArcPath();
    traceArcs(path, mark, groups[color]!);
    if (!path.d) return [];
    return [
      {
        tag: "path",
        attributes: { d: path.d, fill, "fill-opacity": String(mark.fillOpacity) },
      },
    ];
  });
}

export const arcDrawing: Drawing<ArcGeometry> = {
  size: (mark) => mark.count,
  elements: arcElements,
  svg: (mark) => markupOf(arcElements(mark)),
  canvas(context, mark) {
    context.globalAlpha = mark.fillOpacity;
    const groups = sectorsByColor(mark);
    mark.colors.forEach((fill, color) => {
      context.beginPath();
      traceArcs(context, mark, groups[color]!);
      context.fillStyle = fill;
      context.fill();
    });
    context.globalAlpha = 1;
  },
};

/** Whether `traceSector` draws anything of a sector. */
export function sectorPaints(r0: number, r1: number, sweep: number, gap: number): boolean {
  if (!(sweep > 0 && r1 > r0)) return false;
  if (sweep >= TAU - 1e-9) return true;
  const half = sectorGap(gap, sweep, r1) / 2;
  return Math.max(r0, half > 0 ? half / Math.sin(Math.min(sweep, Math.PI) / 2) : 0) < r1;
}

/**
 * Whether (px, py) is in the sector as `traceSector` draws it: within its
 * radii and angles, between its sides moved in by half its gap, and not at
 * its point.
 */
export function inSector(
  px: number,
  py: number,
  cx: number,
  cy: number,
  r0: number,
  r1: number,
  a0: number,
  a1: number,
  gap: number,
): boolean {
  const dx = px - cx;
  const dy = py - cy;
  const distance = Math.hypot(dx, dy);
  const sweep = a1 - a0;
  if (sweep >= TAU - 1e-9) return distance >= r0 && distance <= r1;
  // The point's angle, measured from the sector's start.
  const turn = Math.atan2(dy, dx) - a0;
  if (turn - TAU * Math.floor(turn / TAU) > sweep) return false;
  const half = sectorGap(gap, sweep, r1) / 2;
  const inner = Math.max(r0, half > 0 ? half / Math.sin(Math.min(sweep, Math.PI) / 2) : 0);
  if (!(distance >= inner && distance <= r1)) return false;
  // Distances from the sides, rays from the center (sectors over a half
  // turn wrap around the lines' other halves).
  const side = (a: number) =>
    dx * Math.cos(a) + dy * Math.sin(a) < 0
      ? distance
      : Math.abs(dx * Math.sin(a) - dy * Math.cos(a));
  return side(a0) >= half && side(a1) >= half;
}
