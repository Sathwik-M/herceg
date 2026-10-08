import { childrenByValue, type Hierarchy } from "../data/hierarchy.ts";

export interface TreemapPadding {
  /** Gap between siblings, in px. */
  inner: number;
  /** Space inside a parent around its children. */
  outer: number;
  /** Extra space at the top of parents below the root, for their labels. */
  top: number;
}

/** The aspect ratio squarified rows aim for: the golden ratio, as in D3. */
const RATIO = (1 + Math.sqrt(5)) / 2;

/**
 * Squarified treemap (Bruls, Huizing, and van Wijk): each node's children
 * fill its rectangle in rows of rectangles kept as close to the target
 * aspect ratio as the values allow, largest first. Writes x, y, width, and
 * height per node into `out` (four per node); the root fills `bounds`, and
 * nodes without a value get empty rectangles.
 */
export function layoutTreemap(
  tree: Hierarchy,
  values: Float64Array,
  bounds: { x: number; y: number; width: number; height: number },
  padding: TreemapPadding,
  out: Float64Array,
): void {
  out.fill(0, 0, tree.size * 4);
  out[0] = bounds.x;
  out[1] = bounds.y;
  out[2] = Math.max(0, bounds.width);
  out[3] = Math.max(0, bounds.height);
  const half = padding.inner / 2;
  let scratch: Uint32Array = new Uint32Array(16);
  for (let at = 0; at < tree.size; at++) {
    const node = tree.order[at]!;
    if (tree.childStart[node + 1] === tree.childStart[node] || !(values[node]! > 0)) continue;
    const top = node === 0 ? 0 : padding.top;
    // Children are placed in the content box widened by half the gap, then
    // each shrinks by half the gap: siblings end up a gap apart, and the
    // outer ones flush with the content box.
    const x0 = out[node * 4]! + padding.outer - half;
    const y0 = out[node * 4 + 1]! + padding.outer + top - half;
    const x1 = out[node * 4]! + out[node * 4 + 2]! - padding.outer + half;
    const y1 = out[node * 4 + 1]! + out[node * 4 + 3]! - padding.outer + half;
    if (!(x1 > x0 && y1 > y0)) continue;
    const children = childrenByValue(tree, values, node, scratch);
    if (children.length > scratch.length) scratch = children;
    squarify(children, values, values[node]!, x0, y0, x1, y1, out);
    for (const child of children) {
      const i = child * 4;
      const width = out[i + 2]! - 2 * half;
      const height = out[i + 3]! - 2 * half;
      if (width > 0 && height > 0) {
        out[i] = out[i]! + half;
        out[i + 1] = out[i + 1]! + half;
        out[i + 2] = width;
        out[i + 3] = height;
      } else {
        out.fill(0, i, i + 4);
      }
    }
  }
}

function squarify(
  nodes: Uint32Array,
  values: Float64Array,
  total: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  out: Float64Array,
): void {
  let remaining = total;
  let i0 = 0;
  const n = nodes.length;
  while (i0 < n) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    // A row starts at the next node with a value; those without take no room.
    let i1 = i0;
    let sum = 0;
    do sum = values[nodes[i1++]!]!;
    while (!sum && i1 < n);
    let min = sum;
    let max = sum;
    const alpha = Math.max(dy / dx, dx / dy) / (remaining * RATIO);
    let worst = Math.max(max / (sum * sum * alpha), (sum * sum * alpha) / min);
    // Grow the row while its worst aspect ratio does not get worse.
    for (; i1 < n; i1++) {
      const value = values[nodes[i1]!]!;
      const grown = sum + value;
      const beta = grown * grown * alpha;
      const ratio = Math.max(Math.max(max, value) / beta, beta / Math.min(min, value));
      if (ratio > worst) break;
      sum = grown;
      min = Math.min(min, value);
      max = Math.max(max, value);
      worst = ratio;
    }
    // Rows run along the longer side of what is left.
    if (dx < dy) {
      const y = remaining ? y0 + (dy * sum) / remaining : y1;
      place(nodes, i0, i1, values, sum, x0, y0, x1, y, true, out);
      y0 = y;
    } else {
      const x = remaining ? x0 + (dx * sum) / remaining : x1;
      place(nodes, i0, i1, values, sum, x0, y0, x, y1, false, out);
      x0 = x;
    }
    remaining -= sum;
    i0 = i1;
  }
}

/** Splits a row's rectangle among its nodes by value, left to right or top to bottom. */
function place(
  nodes: Uint32Array,
  from: number,
  to: number,
  values: Float64Array,
  sum: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  across: boolean,
  out: Float64Array,
): void {
  let at = across ? x0 : y0;
  const span = across ? x1 - x0 : y1 - y0;
  for (let k = from; k < to; k++) {
    const node = nodes[k]!;
    const size = sum ? (span * values[node]!) / sum : 0;
    const i = node * 4;
    out[i] = across ? at : x0;
    out[i + 1] = across ? y0 : at;
    out[i + 2] = across ? size : x1 - x0;
    out[i + 3] = across ? y1 - y0 : size;
    at += size;
  }
}
