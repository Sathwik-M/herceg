// The box of a 3D chart: grid lines on the three walls behind the data, the
// walls' edges, tick labels along one edge per axis, and axis titles. All
// of it is ordinary scene geometry (lines and text), drawn by every
// renderer. The walls are the far ones for the camera; labels go on the
// box's silhouette, x and y along the lowest edges and z along the
// leftmost, each pushed outward along the edge's normal on screen, and
// labels that would overlap are thinned.

import { lineDrawing } from "../draw/line.ts";
import { textDrawing } from "../draw/text.ts";
import type { MeasureText } from "../layout/text.ts";
import { Polyline } from "../lod/polyline.ts";
import type { LineGeometry, Rect, TextGeometry } from "../scene/scene.ts";
import type { Theme } from "../theme.ts";
import type { View } from "./camera.ts";

/** One axis of a 3D chart, as the box draws it. */
export interface Axis3D {
  /** Where a value lies along the axis, from -1 to 1. */
  place(value: number): number;
  /** Values with grid lines and labels. */
  ticks: readonly number[];
  labels: readonly string[];
  /** The axis title; empty for none. */
  title: string;
  /** Grid lines across the walls at the ticks. */
  grid: boolean;
  /** Labels and title; false hides them. */
  shown: boolean;
}

export type Axes3D = readonly [Axis3D, Axis3D, Axis3D];

/** Pixels between an edge and its labels, and between labels and the title. */
const GAP = 6;
/** Edges shorter than this on screen, seen nearly end on, have no tick labels. */
const SHORT_EDGE = 24;

type Point3 = [number, number, number];

/** What the box draws, below the data (lines) and above it (labels). */
export interface BoxGeometry {
  lines: LineGeometry[];
  labels: TextGeometry[];
}

/**
 * The far side of each axis: the wall at -1 when the eye is on the + side,
 * else the wall at 1.
 */
export function farSides(view: View): Point3 {
  return view.eye.map((e) => (e > 0 ? -1 : 1)) as Point3;
}

/** The pixels a label of the box needs beyond the box: room the fit leaves around it. */
export function boxMargin(theme: Theme): number {
  return GAP * 2 + Math.round(theme.fontSize * 1.25) * 2;
}

export function boxGeometry(
  view: View,
  axes: Axes3D,
  theme: Theme,
  measure: MeasureText,
  bounds: Rect,
): BoxGeometry {
  const far = farSides(view);
  const out = new Float64Array(2);
  const screen = (p: Point3): [number, number] => {
    view.project(p[0], p[1], p[2], out, 0);
    return [out[0]!, out[1]!];
  };
  const grid = new Polyline();
  const edges = new Polyline();
  const segment = (path: Polyline, a: Point3, b: Point3) => {
    path.break();
    path.push(...screen(a));
    path.push(...screen(b));
  };
  // Each far wall is perpendicular to axis w, at far[w]; its grid lines
  // cross it at the ticks of the other two axes.
  for (let w = 0; w < 3; w++) {
    for (const k of others(w)) {
      const axis = axes[k]!;
      if (!axis.grid) continue;
      const j = 3 - w - k;
      for (const tick of axis.ticks) {
        const t = axis.place(tick);
        if (!(Math.abs(t) < 1 - 1e-9)) continue;
        const a: Point3 = [0, 0, 0];
        a[w] = far[w]!;
        a[k] = t;
        a[j] = -1;
        const b: Point3 = [...a];
        b[j] = 1;
        segment(grid, a, b);
      }
    }
  }
  // The walls' edges, each once: an edge along axis d at fixed values of the other two.
  const seen = new Set<string>();
  for (let w = 0; w < 3; w++) {
    for (const d of others(w)) {
      const j = 3 - w - d;
      for (const side of [-1, 1]) {
        const a: Point3 = [0, 0, 0];
        a[w] = far[w]!;
        a[j] = side;
        a[d] = -1;
        const key = `${d}:${a.join()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const b: Point3 = [...a];
        b[d] = 1;
        segment(edges, a, b);
      }
    }
  }
  const lines: LineGeometry[] = [
    {
      kind: "line",
      draw: lineDrawing,
      key: "box-grid",
      stroke: theme.grid,
      strokeWidth: 1,
      dash: theme.gridDash.length > 0 ? theme.gridDash : undefined,
      path: grid,
    },
    {
      kind: "line",
      draw: lineDrawing,
      key: "box-edges",
      stroke: theme.axis,
      strokeWidth: 1,
      dash: undefined,
      path: edges,
    },
  ];
  return { lines, labels: labelGeometry(view, axes, theme, measure, bounds, screen) };
}

/** The two axes other than `w`, in order. */
function others(w: number): [number, number] {
  return w === 0 ? [1, 2] : w === 1 ? [0, 2] : [0, 1];
}

/** -1 or 1 by the sign of `value`, or `tie` at 0. */
function side(value: number, tie: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : tie;
}

/**
 * The fixed coordinates of the edge axis `k` is labeled along: for x and y
 * the lowest edge on screen, for z the leftmost; where two edges are level,
 * the nearer.
 */
export function labelEdge(view: View, k: number): Point3 {
  const near = view.eye.map((e) => side(e, -1));
  const edge: Point3 = [0, 0, 0];
  // Screen up and right of each normalized coordinate, as the view maps them.
  const up = view.up.map((u, i) => u * view.half[i]!);
  const right = view.right.map((r, i) => r * view.half[i]!);
  for (const i of others(k)) {
    const toward = k === 2 ? right[i]! : up[i]!;
    edge[i] = side(-toward, near[i]!);
  }
  return edge;
}

interface Placed {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

function overlaps(a: Placed, b: Placed): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.width + b.width + 2 && Math.abs(a.y - b.y) * 2 < a.height + b.height
  );
}

function labelGeometry(
  view: View,
  axes: Axes3D,
  theme: Theme,
  measure: MeasureText,
  bounds: Rect,
  screen: (p: Point3) => [number, number],
): TextGeometry[] {
  const font = `${theme.fontSize}px ${theme.font}`;
  const height = Math.round(theme.fontSize * 1.25);
  const center: [number, number] = [view.cx, view.cy];
  const titles: Placed[] = [];
  const ticks: Placed[][] = [];
  for (let k = 0; k < 3; k++) {
    const axis = axes[k]!;
    ticks.push([]);
    if (!axis.shown) continue;
    const fixed = labelEdge(view, k);
    const along = (t: number): [number, number] => {
      const p: Point3 = [...fixed];
      p[k] = t;
      return screen(p);
    };
    const [x0, y0] = along(-1);
    const [x1, y1] = along(1);
    const [mx, my] = along(0);
    const length = Math.hypot(x1 - x0, y1 - y0);
    // Outward: the edge's normal on screen, on the side away from the box's
    // center; for an edge seen nearly end on, from the center through it.
    let [nx, ny] = length > SHORT_EDGE / 3 ? [(y0 - y1) / length, (x1 - x0) / length] : [0, 0];
    if (nx === 0 && ny === 0) {
      const d = Math.hypot(mx - center[0], my - center[1]);
      [nx, ny] = d > 0 ? [(mx - center[0]) / d, (my - center[1]) / d] : [0, 1];
    } else if (nx * (mx - center[0]) + ny * (my - center[1]) < 0) {
      [nx, ny] = [-nx, -ny];
    }
    /** The center of a box `width` wide pushed `distance` past (x, y) along the normal. */
    const pushed = (x: number, y: number, width: number, h: number, distance: number) => {
      const reach = distance + (Math.abs(nx) * width) / 2 + (Math.abs(ny) * h) / 2;
      return [x + nx * reach, y + ny * reach] as const;
    };
    let extent = 0;
    if (length >= SHORT_EDGE) {
      axis.ticks.forEach((tick, i) => {
        const t = axis.place(tick);
        if (!(Math.abs(t) <= 1 + 1e-9)) return;
        const text = axis.labels[i]!;
        const width = measure(text, font);
        const [px, py] = along(t);
        const [x, y] = pushed(px, py, width, height, GAP);
        ticks[k]!.push({ text, x, y, width, height });
        extent = Math.max(extent, Math.abs(nx) * width + Math.abs(ny) * height);
      });
    }
    if (axis.title) {
      const width = measure(axis.title, font);
      const [x, y] = pushed(mx, my, width, height, GAP + (extent > 0 ? extent + GAP : 0));
      titles.push({ text: axis.title, x, y, width, height });
    }
  }
  // Titles first, then each axis' labels thinned to every n-th until none
  // overlap each other or anything placed before.
  const placed: Placed[] = [...titles];
  const shown: Placed[] = [];
  for (const labels of ticks) {
    // Labels on what is placed already (at a corner the axes share) go; the
    // rest keep every n-th tick, the fewest needed to clear each other.
    const free = labels.map((label) => !placed.some((p) => overlaps(label, p)));
    let kept: Placed[] = [];
    for (let every = 1; every <= labels.length; every++) {
      kept = labels.filter((_, i) => i % every === 0 && free[i]);
      if (kept.every((label, i) => i === 0 || !overlaps(label, kept[i - 1]!))) break;
    }
    placed.push(...kept);
    shown.push(...kept);
  }
  const inside = (label: Placed) =>
    label.x >= bounds.x &&
    label.x <= bounds.x + bounds.width &&
    label.y >= bounds.y &&
    label.y <= bounds.y + bounds.height;
  const text = (key: string, fill: string, items: Placed[]): TextGeometry => {
    const kept = items.filter(inside);
    return {
      kind: "text",
      draw: textDrawing,
      key,
      fill,
      anchor: "middle",
      halo: false,
      coords: Float32Array.from(kept.flatMap(({ x, y }) => [x, y])),
      labels: kept.map(({ text }) => text),
      count: kept.length,
    };
  };
  return [text("box-ticks", theme.muted, shown), text("box-titles", theme.text, titles)];
}
