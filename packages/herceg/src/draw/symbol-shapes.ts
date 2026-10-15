// Point symbols' shapes. Every shape covers the area of a circle of the
// same radius, so no symbol looks heavier than another. Shapes are polygons
// of unit area pi, scaled by the radius; circles are arcs. Every shape winds
// clockwise on screen, in SVG and on canvas, so overlapping shapes filled as
// one path never cancel each other out. This module imports nothing, so the
// feature compiler's markers draw them without moving chart code into a
// chunk of its own (see model/guides.ts, `GUIDE_KIT`).

import type { SymbolName } from "../spec/encoding.ts";

export type { SymbolName };

/**
 * Every symbol: the first `CYCLE` in the order category fields take them,
 * distinct silhouettes first; "x", a cross turned 45 degrees, only by name.
 */
export const SYMBOLS: readonly SymbolName[] = [
  "circle",
  "square",
  "triangle",
  "diamond",
  "cross",
  "star",
  "wye",
  "triangle-down",
  "x",
];

/** How many of SYMBOLS category fields take in turn. */
export const CYCLE = 8;

const PI = Math.PI;

/** Regular polygon vertices around the center, starting straight up. */
function radial(radii: readonly number[], count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const angle = -PI / 2 + (i * 2 * PI) / count;
    const r = radii[i % radii.length]!;
    out.push(r * Math.cos(angle), r * Math.sin(angle));
  }
  return out;
}

function polygons(): Record<Exclude<SymbolName, "circle">, number[]> {
  const half = Math.sqrt(PI) / 2;
  const diagonal = Math.sqrt(PI / 2);
  // An equilateral triangle's area is 3√3/4 of its circumradius squared.
  const triangle = radial([Math.sqrt((4 * PI) / (3 * Math.sqrt(3)))], 3);
  // A plus of five squares, each `w` wide.
  const w = Math.sqrt(PI / 5);
  const a = w / 2;
  const b = 1.5 * w;
  const cross = [
    -a,
    -b,
    a,
    -b,
    a,
    -a,
    b,
    -a,
    b,
    a,
    a,
    a,
    a,
    b,
    -a,
    b,
    -a,
    a,
    -b,
    a,
    -b,
    -a,
    -a,
    -a,
  ];
  // A pentagram of ten triangles, outer radius R, inner R·0.382.
  const inner = 0.381966;
  const outer = Math.sqrt(PI / (5 * inner * Math.sin(PI / 5)));
  // A wye: three arms of width `k` from a central triangle (after d3-shape).
  const k = 1 / Math.sqrt(12);
  const scale = Math.sqrt(PI / ((k / 2 + 1) * 3));
  const x0 = scale / 2;
  const y0 = scale * k;
  const x1 = x0;
  const y1 = scale * k + scale;
  const x2 = -x1;
  const y2 = y1;
  const c = -0.5;
  const s = Math.sqrt(3) / 2;
  const wye: number[][] = [
    [x0, y0],
    [x1, y1],
    [x2, y2],
    [c * x0 - s * y0, s * x0 + c * y0],
    [c * x1 - s * y1, s * x1 + c * y1],
    [c * x2 - s * y2, s * x2 + c * y2],
    [c * x0 + s * y0, c * y0 - s * x0],
    [c * x1 + s * y1, c * y1 - s * x1],
    [c * x2 + s * y2, c * y2 - s * x2],
  ];
  const shapes = {
    square: [-half, -half, half, -half, half, half, -half, half],
    diamond: [0, -diagonal, diagonal, 0, 0, diagonal, -diagonal, 0],
    triangle,
    "triangle-down": triangle.map((v, i) => (i % 2 ? -v : v)),
    cross,
    x: cross.map(
      (_, i) => (i % 2 ? cross[i - 1]! + cross[i]! : cross[i]! - cross[i + 1]!) / Math.SQRT2,
    ),
    star: radial([outer, outer * inner], 10),
    wye: wye.flat(),
  };
  for (const vertices of Object.values(shapes)) clockwise(vertices);
  return shapes;
}

/** Reverses a polygon's vertices in place unless they already turn clockwise on screen. */
function clockwise(v: number[]): void {
  let area = 0;
  for (let i = 0; i < v.length; i += 2) {
    const j = (i + 2) % v.length;
    area += v[i]! * v[j + 1]! - v[j]! * v[i + 1]!;
  }
  // With y pointing down, a positive shoelace sum turns clockwise.
  if (area > 0) return;
  for (let i = 0, j = v.length - 2; i < j; i += 2, j -= 2) {
    [v[i], v[j]] = [v[j]!, v[i]!];
    [v[i + 1], v[j + 1]] = [v[j + 1]!, v[i + 1]!];
  }
}

/**
 * How far a symbol reaches from its center along x or y, per unit of radius:
 * 1 for circles, more for pointed shapes (a star reaches about 1.6).
 */
export function symbolReach(symbol: SymbolName): number {
  if (symbol === "circle") return 1;
  return Math.max(...vertices(symbol).map(Math.abs));
}

let shapes: Record<Exclude<SymbolName, "circle">, number[]> | undefined;

/** Unit vertices (x, y pairs) of a polygon symbol. */
export function vertices(symbol: Exclude<SymbolName, "circle">): number[] {
  shapes ??= polygons();
  return shapes[symbol];
}
