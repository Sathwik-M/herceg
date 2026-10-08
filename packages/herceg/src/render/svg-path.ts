// SVG path data reduced to absolute moves, lines, cubic curves, and closes,
// for output formats without SVG's other commands (PDF). Custom marks write
// their shapes as SVG path data.

import type { PathSink } from "../draw/markup.ts";

/** Path data needs no rectangles. */
type Sink = Omit<PathSink, "rect">;

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/iy;
const SEPARATOR = /[\s,]*/y;
const PARAMETERS: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7 };

/**
 * Sends `d` to `sink`. Quadratic curves and arcs become cubic curves. As in
 * browsers, drawing stops at the first error in the data.
 */
export function tracePath(d: string, sink: Sink): void {
  let at = 0;
  const skip = () => {
    SEPARATOR.lastIndex = at;
    SEPARATOR.exec(d);
    at = SEPARATOR.lastIndex;
  };
  const number = (): number | undefined => {
    skip();
    NUMBER.lastIndex = at;
    const match = NUMBER.exec(d);
    if (!match) return undefined;
    at = NUMBER.lastIndex;
    return Number(match[0]);
  };
  // Arc flags are single digits, which may be written without separators.
  const flag = (): number | undefined => {
    skip();
    const c = d[at];
    if (c !== "0" && c !== "1") return undefined;
    at++;
    return c === "1" ? 1 : 0;
  };

  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  // Last control point, for the reflections of S and T.
  let controlX = 0;
  let controlY = 0;
  let previous = "";
  let open = false;
  // After a close, drawing continues from the subpath's start, as a new subpath.
  let closed = false;
  const args: number[] = [];

  for (;;) {
    skip();
    if (at >= d.length) return;
    const letter = d[at]!;
    const command = letter.toLowerCase();
    if (command === "z") {
      if (!open) return;
      at++;
      if (!closed) sink.closePath();
      closed = true;
      x = startX;
      y = startY;
      previous = "z";
      continue;
    }
    const count = PARAMETERS[command];
    if (count === undefined || (!open && command !== "m")) return;
    at++;
    const relative = letter !== letter.toUpperCase();
    let first = true;
    // Parameters repeat until the next command; extra pairs after a move are lines.
    for (;;) {
      args.length = 0;
      for (let i = 0; i < count; i++) {
        const value = command === "a" && (i === 3 || i === 4) ? flag() : number();
        if (value === undefined) {
          if (i === 0 && !first) break;
          return;
        }
        args.push(value);
      }
      if (args.length < count) break;
      const ox = relative ? x : 0;
      const oy = relative ? y : 0;
      const kind = command === "m" && !first ? "l" : command;
      if (closed && kind !== "m") sink.moveTo(x, y);
      closed = false;
      const smooth =
        (kind === "s" && (previous === "c" || previous === "s")) ||
        (kind === "t" && (previous === "q" || previous === "t"));
      const reflectX = smooth ? 2 * x - controlX : x;
      const reflectY = smooth ? 2 * y - controlY : y;
      switch (kind) {
        case "m":
          x = startX = ox + args[0]!;
          y = startY = oy + args[1]!;
          sink.moveTo(x, y);
          open = true;
          break;
        case "l":
          x = ox + args[0]!;
          y = oy + args[1]!;
          sink.lineTo(x, y);
          break;
        case "h":
          x = ox + args[0]!;
          sink.lineTo(x, y);
          break;
        case "v":
          y = oy + args[0]!;
          sink.lineTo(x, y);
          break;
        case "c":
        case "s": {
          const [x1, y1] = kind === "c" ? [ox + args[0]!, oy + args[1]!] : [reflectX, reflectY];
          const rest = kind === "c" ? 2 : 0;
          controlX = ox + args[rest]!;
          controlY = oy + args[rest + 1]!;
          const ex = ox + args[rest + 2]!;
          const ey = oy + args[rest + 3]!;
          sink.bezierCurveTo(x1, y1, controlX, controlY, ex, ey);
          x = ex;
          y = ey;
          break;
        }
        case "q":
        case "t": {
          const [qx, qy] = kind === "q" ? [ox + args[0]!, oy + args[1]!] : [reflectX, reflectY];
          const rest = kind === "q" ? 2 : 0;
          const ex = ox + args[rest]!;
          const ey = oy + args[rest + 1]!;
          // The cubic with the same shape as a quadratic curve.
          sink.bezierCurveTo(
            x + ((qx - x) * 2) / 3,
            y + ((qy - y) * 2) / 3,
            ex + ((qx - ex) * 2) / 3,
            ey + ((qy - ey) * 2) / 3,
            ex,
            ey,
          );
          controlX = qx;
          controlY = qy;
          x = ex;
          y = ey;
          break;
        }
        case "a": {
          const ex = ox + args[5]!;
          const ey = oy + args[6]!;
          arc(sink, x, y, args[0]!, args[1]!, args[2]!, args[3]!, args[4]!, ex, ey);
          x = ex;
          y = ey;
          break;
        }
      }
      previous = kind;
      first = false;
    }
  }
}

/**
 * An elliptical arc as cubic curves of at most a quarter turn each, after
 * the SVG specification's endpoint-to-center conversion (implementation
 * notes, F.6.5 and F.6.6).
 */
function arc(
  sink: Sink,
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  rotation: number,
  large: number,
  sweep: number,
  x2: number,
  y2: number,
): void {
  if (x1 === x2 && y1 === y2) return;
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  if (rx === 0 || ry === 0) {
    sink.lineTo(x2, y2);
    return;
  }
  const phi = (rotation * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const px = cos * dx + sin * dy;
  const py = -sin * dx + cos * dy;
  // Radii too small to reach the end point are scaled up until they do.
  const lambda = (px * px) / (rx * rx) + (py * py) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const numerator = rx * rx * ry * ry - rx * rx * py * py - ry * ry * px * px;
  const denominator = rx * rx * py * py + ry * ry * px * px;
  let factor = Math.sqrt(Math.max(0, numerator / denominator));
  if (large === sweep) factor = -factor;
  const cxp = (factor * rx * py) / ry;
  const cyp = (-factor * ry * px) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const start = angle(1, 0, (px - cxp) / rx, (py - cyp) / ry);
  let delta = angle((px - cxp) / rx, (py - cyp) / ry, (-px - cxp) / rx, (-py - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  else if (sweep && delta < 0) delta += 2 * Math.PI;

  const segments = Math.max(1, Math.ceil(Math.abs(delta) / (Math.PI / 2) - 1e-9));
  const step = delta / segments;
  const k = (4 / 3) * Math.tan(step / 4);
  // A point of the ellipse at parameter t, and its derivative, in user space.
  const point = (t: number): [number, number] => {
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    return [cx + cos * ex - sin * ey, cy + sin * ex + cos * ey];
  };
  const tangent = (t: number): [number, number] => {
    const ex = -rx * Math.sin(t);
    const ey = ry * Math.cos(t);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  let t = start;
  for (let i = 0; i < segments; i++) {
    const next = t + step;
    const [ax, ay] = point(t);
    const [ad, ae] = tangent(t);
    // The last segment ends exactly at the requested point.
    const [bx, by] = i === segments - 1 ? [x2, y2] : point(next);
    const [bd, be] = tangent(next);
    sink.bezierCurveTo(ax + k * ad, ay + k * ae, bx - k * bd, by - k * be, bx, by);
    t = next;
  }
}
