// Where insets go: an inset's box on its parent's plot, along one axis at a
// time, as the solver places grids (layout/grid.ts); and the parts of a
// plot its insets leave visible, which the parent's drawings are cut to so
// they never cover an inset. Loaded with subplots only.

import { shapesDrawing } from "../draw/shapes.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { Rect, ShapesGeometry } from "../scene/scene.ts";
import type { Coordinate, InsetAnchor, InsetSpec } from "../spec/spec.ts";
import { dashPattern } from "../style/style.ts";
import type { Theme } from "../theme.ts";
import { layoutError } from "./compile.ts";

/** Pixels an inset placed at a corner or edge stands in from its parent's plot. */
const INSET = 8;
/** An inset's share of its parent's plot when its size is left out. */
const SHARE = 0.35;

/**
 * The start and end of an inset's box along `axis` ("x" across, "y" down),
 * on its parent's plot from `plot0` to `plot1`, in a chart from `chart0` to
 * `chart1`; `path` is where the inset is, for messages.
 */
export function insetSpan(
  spec: InsetSpec,
  axis: "x" | "y",
  plot0: number,
  plot1: number,
  chart0: number,
  chart1: number,
  path: string,
): [number, number] {
  const size = axis === "x" ? spec.width : spec.height;
  const room = plot1 - plot0;
  let length = SHARE * room;
  if (size !== undefined) {
    const at = `${path}.${axis === "x" ? "width" : "height"}`;
    if ("fraction" in size) {
      if (!(size.fraction > 0 && size.fraction <= 1))
        throw layoutError(
          `${at}.fraction`,
          `expected a fraction above 0 and at most 1; received ${size.fraction}`,
        );
      length = size.fraction * room;
    } else if ("px" in size) {
      if (!(size.px > 0 && Number.isFinite(size.px)))
        throw layoutError(`${at}.px`, `expected pixels greater than 0; received ${size.px}`);
      length = size.px;
    } else
      throw layoutError(at, `expected { fraction } or { px }; received ${JSON.stringify(size)}`);
  }
  const place = spec.place ?? { inside: "top-right" };
  if ("inside" in place) {
    const inset = place.inset ?? INSET;
    if (!(inset >= 0 && Number.isFinite(inset)))
      throw layoutError(`${path}.place.inset`, `expected pixels of at least 0; received ${inset}`);
    const [first, last] = axis === "x" ? ["left", "right"] : ["top", "bottom"];
    const start = place.inside.includes(first)
      ? plot0 + inset
      : place.inside.includes(last)
        ? plot1 - inset - length
        : plot0 + (room - length) / 2;
    return [start, start + length];
  }
  if (!("at" in place))
    throw layoutError(
      `${path}.place`,
      `expected { inside } or { at }; received ${JSON.stringify(place)}`,
    );
  const at = coordinate(
    place.at[axis],
    axis,
    plot0,
    plot1,
    chart0,
    chart1,
    `${path}.place.at.${axis}`,
  );
  const share = anchorShare(place.anchor ?? "top-left", axis);
  const start = at - share * length;
  return [start, start + length];
}

/** Where `c` is along `axis`: a fraction (up from the bottom for y) or pixels (down for y) of the plot or the chart. */
function coordinate(
  c: Coordinate,
  axis: "x" | "y",
  plot0: number,
  plot1: number,
  chart0: number,
  chart1: number,
  path: string,
): number {
  if (!("fraction" in c || "px" in c))
    throw layoutError(
      path,
      "insets are placed by fractions or pixels of the plot or the chart, not data; use { fraction } or { px }",
    );
  const [lo, hi] = c.frame === "chart" ? [chart0, chart1] : [plot0, plot1];
  const offset = c.offset ?? 0;
  const value = "px" in c ? c.px : c.fraction;
  for (const [name, n] of [
    ["px" in c ? "px" : "fraction", value],
    ["offset", offset],
  ] as const)
    if (!Number.isFinite(n))
      throw layoutError(`${path}.${name}`, `expected a finite number; received ${n}`);
  if ("px" in c) return lo + c.px + offset;
  return (axis === "x" ? lo + c.fraction * (hi - lo) : hi - c.fraction * (hi - lo)) + offset;
}

/** How far along an inset's box, from its start, its anchor is. */
function anchorShare(anchor: InsetAnchor, axis: "x" | "y"): number {
  if (anchor === "center") return 0.5;
  const [first, last] = axis === "x" ? ["left", "right"] : ["top", "bottom"];
  return anchor.includes(first) ? 0 : anchor.includes(last) ? 1 : 0.5;
}

/**
 * Where a line across `visible` (the rectangles `uncovered` leaves of
 * `plot`, in rows) is wholly in it: a line at `at` along y (or x), `half`
 * wide each way, as spans along it.
 */
export function clearSpans(
  visible: readonly Rect[],
  plot: Rect,
  along: "x" | "y",
  at: number,
  half: number,
): [number, number][] {
  // Horizontal lines (at a y) lie along rows; vertical ones cross them,
  // each where its stroke, within the plot, is in a rectangle.
  if (along === "x") {
    const from = Math.max(at - half, plot.x);
    const to = Math.min(at + half, plot.x + plot.width);
    const out: [number, number][] = [];
    for (const r of visible)
      if (r.x <= from && to <= r.x + r.width) {
        const last = out[out.length - 1];
        if (last && Math.abs(last[1] - r.y) < 1e-9) last[1] = r.y + r.height;
        else out.push([r.y, r.y + r.height]);
      }
    return out;
  }
  // Of each row the line's stroke crosses in the plot, the spans of its
  // rectangles; the line is where all have one, and nowhere where a row
  // has none (an inset across the plot).
  const lo = Math.max(at - half, plot.y);
  const hi = Math.min(at + half, plot.y + plot.height);
  const rows = new Map<number, { end: number; spans: [number, number][] }>();
  for (const r of visible)
    if (r.y < hi && r.y + r.height > lo) {
      const row = rows.get(r.y) ?? { end: r.y + r.height, spans: [] };
      row.spans.push([r.x, r.x + r.width]);
      rows.set(r.y, row);
    }
  let reach = lo;
  for (const [y, { end }] of [...rows].sort(([a], [b]) => a - b)) {
    if (y > reach + 1e-9) return [];
    reach = Math.max(reach, end);
  }
  if (reach < hi - 1e-9) return [];
  let out: [number, number][] | undefined;
  for (const { spans } of rows.values())
    out = out
      ? out.flatMap(([a, b]) =>
          spans.flatMap(([c, d]): [number, number][] =>
            Math.max(a, c) < Math.min(b, d) ? [[Math.max(a, c), Math.min(b, d)]] : [],
          ),
        )
      : spans;
  return out ?? [];
}

/**
 * The parts of `box` that `covers` leave visible, as rectangles that do not
 * overlap: cut along the covers' edges into a grid of strips, those no
 * cover holds joined along each row.
 */
export function uncovered(box: Rect, covers: readonly Rect[]): Rect[] {
  const right = box.x + box.width;
  const bottom = box.y + box.height;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  const xs = new Set([box.x, right]);
  const ys = new Set([box.y, bottom]);
  for (const c of covers) {
    xs.add(clamp(c.x, box.x, right));
    xs.add(clamp(c.x + c.width, box.x, right));
    ys.add(clamp(c.y, box.y, bottom));
    ys.add(clamp(c.y + c.height, box.y, bottom));
  }
  const across = [...xs].sort((a, b) => a - b);
  const down = [...ys].sort((a, b) => a - b);
  const out: Rect[] = [];
  for (let r = 0; r + 1 < down.length; r++) {
    const [y0, y1] = [down[r]!, down[r + 1]!];
    if (y1 <= y0) continue;
    let start: number | undefined;
    for (let k = 0; k + 1 < across.length; k++) {
      const [x0, x1] = [across[k]!, across[k + 1]!];
      const mx = (x0 + x1) / 2;
      const my = (y0 + y1) / 2;
      const covered = covers.some(
        (c) => mx > c.x && mx < c.x + c.width && my > c.y && my < c.y + c.height,
      );
      if (!covered && x1 > x0) start ??= x0;
      if ((covered || k + 2 === across.length) && start !== undefined) {
        const end = covered ? x0 : x1;
        if (end > start) out.push({ x: start, y: y0, width: end - start, height: y1 - y0 });
        start = undefined;
      }
    }
  }
  return out;
}

/** A panel's position scales, as an inset's indicator reads them. */
export interface PanelScales {
  x: PositionScale;
  y: PositionScale;
}

/**
 * The indicator of an inset (`spec`, at `path`, its panel `id`) over its
 * parent: a box on the parent's plot around the inset's x and y ranges,
 * with lines from two of its corners to the same corners of the inset's
 * `cover`, the pair that runs outside both boxes; none where the parent
 * shows none of those ranges. Throws where the scales cannot place one's
 * values on the other: categories, or times against numbers.
 */
export function indicator(
  spec: InsetSpec,
  path: string,
  id: string,
  parent: PanelScales | undefined,
  inset: PanelScales | undefined,
  cover: Rect,
  theme: Theme,
): ShapesGeometry | undefined {
  for (const axis of ["x", "y"] as const) {
    const [from, to] = [parent?.[axis].type ?? "none", inset?.[axis].type ?? "none"];
    if (from !== to || from === "band" || from === "none")
      throw layoutError(
        `${path}.indicator`,
        `parent and inset must use compatible continuous x and y coordinates, and their ${axis} axes are ${from} and ${to}; drop indicator`,
      );
  }
  // The inset's ranges on the parent's scales, within its plot.
  const along = (axis: "x" | "y") => {
    const [a, b] = inset![axis].domain.map((v) => parent![axis].map(v));
    const [r0, r1] = parent![axis].range;
    return [
      Math.max(Math.min(a!, b!), Math.min(r0, r1)),
      Math.min(Math.max(a!, b!), Math.max(r0, r1)),
    ] as const;
  };
  const [x0, x1] = along("x");
  const [y0, y1] = along("y");
  // Ranges the parent does not show have nothing to indicate.
  if (x0 > x1 || y0 > y1) return undefined;
  const settings = typeof spec.indicator === "object" ? spec.indicator : {};
  const style = settings.style ?? {};
  const strokeWidth = style.strokeWidth ?? 1;
  let d = `M${x0} ${y0}H${x1}V${y1}H${x0}Z`;
  if (settings.connectors !== false) {
    // The box's side facing the inset joins the inset's side facing it, corner
    // to corner; an inset over the box has no lines.
    const [cx0, cx1, cy0, cy1] = [cover.x, cover.x + cover.width, cover.y, cover.y + cover.height];
    const join = (ax: number, ay: number, bx: number, by: number) => `M${ax} ${ay}L${bx} ${by}`;
    if (cx0 >= x1) d += join(x1, y0, cx0, cy0) + join(x1, y1, cx0, cy1);
    else if (cx1 <= x0) d += join(x0, y0, cx1, cy0) + join(x0, y1, cx1, cy1);
    else if (cy1 <= y0) d += join(x0, y0, cx0, cy1) + join(x1, y0, cx1, cy1);
    else if (cy0 >= y1) d += join(x0, y1, cx0, cy0) + join(x1, y1, cx1, cy0);
  }
  return {
    kind: "shapes",
    key: `inset|${id}|indicator`,
    draw: shapesDrawing,
    shapes: [
      {
        d,
        fill: "none",
        stroke: style.stroke ?? theme.muted,
        strokeWidth,
        opacity: style.opacity ?? 1,
        dash: dashPattern(style.dash, strokeWidth),
      },
    ],
    font: theme.font,
    fontSize: theme.fontSize,
  };
}
