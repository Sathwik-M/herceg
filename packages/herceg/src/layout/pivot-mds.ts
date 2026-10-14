// Starting positions for a force layout, by pivot MDS (Brandes and Pich,
// "Eigensolver methods for progressive multidimensional scaling of large
// data", 2006). Classical multidimensional scaling places nodes so that
// straight-line distances follow distances in the graph; pivot MDS
// approximates it from breadth-first distances to a few pivot nodes, in
// time linear in the graph's size. Rings start as circles and chains and
// trees unfolded, where a force layout started from a spiral, as d3's is,
// can stay folded.

import type { Adjacency } from "./components.ts";

/** Distances to this many pivots, at most, place each component's nodes. */
const PIVOTS = 50;
/** Power iterations per eigenvector; the k-by-k matrix makes them cheap. */
const ITERATIONS = 100;

/** Steps between which a placement may pause: about this many operations each. */
const STEP = 1 << 18;

/**
 * x, y per node: each component centered on (0, 0), scaled so its links
 * average `linkLength`. Components overlap until they are packed.
 */
export function pivotMds(
  nodes: number,
  adjacency: Adjacency,
  components: readonly Int32Array[],
  linkLength: number,
): Float64Array {
  const positions = new Float64Array(nodes * 2);
  for (const _ of pivotMdsSteps(adjacency, components, linkLength, positions));
  return positions;
}

/**
 * `pivotMds` in steps, writing x, y per node of `components` into
 * `positions`: it yields between steps of about the same work, so a large
 * network's placement can spread over animation frames.
 */
export function* pivotMdsSteps(
  adjacency: Adjacency,
  components: readonly Int32Array[],
  linkLength: number,
  positions: Float64Array,
): Generator<void, void> {
  const local = new Int32Array(positions.length / 2).fill(-1);
  for (const members of components) {
    members.forEach((node, i) => {
      local[node] = i;
    });
    const placed = yield* placeComponent(members, local, adjacency, linkLength);
    members.forEach((node, i) => {
      positions[node * 2] = placed[i * 2]!;
      positions[node * 2 + 1] = placed[i * 2 + 1]!;
    });
  }
}

/** Breadth-first hop counts from `from` to each member, by local index. */
function hops(
  from: number,
  local: Int32Array,
  { starts, neighbors }: Adjacency,
  out: Float64Array,
  queue: Int32Array,
): void {
  out.fill(-1);
  out[local[from]!] = 0;
  queue[0] = from;
  let end = 1;
  for (let at = 0; at < end; at++) {
    const node = queue[at]!;
    const d = out[local[node]!]! + 1;
    for (let k = starts[node]!; k < starts[node + 1]!; k++) {
      const next = neighbors[k]!;
      if (out[local[next]!]! < 0) {
        out[local[next]!] = d;
        queue[end++] = next;
      }
    }
  }
}

/** One component's x, y per member (by local index), centered on (0, 0). */
function* placeComponent(
  members: Int32Array,
  local: Int32Array,
  adjacency: Adjacency,
  linkLength: number,
): Generator<void, Float64Array> {
  const size = members.length;
  const placed = new Float64Array(size * 2);
  if (size < 3) {
    // A lone node at the middle, or a pair a link apart.
    if (size === 2) {
      placed[0] = -linkLength / 2;
      placed[2] = linkLength / 2;
    }
    return placed;
  }
  // Pivots spread out: each the member farthest from those chosen so far.
  const k = Math.min(PIVOTS, size);
  const squared = new Float64Array(size * k);
  const nearest = new Float64Array(size).fill(Number.POSITIVE_INFINITY);
  const distances = new Float64Array(size);
  const queue = new Int32Array(size);
  let pivot = members[0]!;
  // Work done since the last pause, in operations.
  let work = 0;
  const pause = (done: number) => {
    work += done;
    if (work < STEP) return false;
    work = 0;
    return true;
  };
  // A breadth-first search visits each member and each of its links once.
  let search = size;
  for (const node of members) search += adjacency.starts[node + 1]! - adjacency.starts[node]!;
  for (let j = 0; j < k; j++) {
    hops(pivot, local, adjacency, distances, queue);
    if (pause(search)) yield;
    let farthest = 0;
    for (let i = 0; i < size; i++) {
      const d = distances[i]!;
      squared[i * k + j] = d * d;
      nearest[i] = Math.min(nearest[i]!, d);
      if (nearest[i]! > nearest[farthest]!) farthest = i;
    }
    pivot = members[farthest]!;
  }
  // Double centering: subtract row and column means, add back the grand mean.
  const rows = new Float64Array(size);
  const columns = new Float64Array(k);
  let grand = 0;
  for (let i = 0; i < size; i++) {
    for (let j = 0; j < k; j++) {
      const v = squared[i * k + j]!;
      rows[i]! += v / k;
      columns[j]! += v / size;
      grand += v / (size * k);
    }
  }
  for (let i = 0; i < size; i++)
    for (let j = 0; j < k; j++)
      squared[i * k + j] = -0.5 * (squared[i * k + j]! - rows[i]! - columns[j]! + grand);
  if (pause(2 * size * k)) yield;
  const c = squared;
  // The k-by-k matrix C^T C, whose top eigenvectors give the coordinates.
  const product = new Float64Array(k * k);
  for (let a = 0; a < k; a++) {
    for (let b = a; b < k; b++) {
      let sum = 0;
      for (let i = 0; i < size; i++) sum += c[i * k + a]! * c[i * k + b]!;
      product[a * k + b] = sum;
      product[b * k + a] = sum;
    }
    if (pause(size * (k - a))) yield;
  }
  const first = topEigenvector(product, k, undefined);
  const second = topEigenvector(product, k, first);
  // Coordinates C v / λ^(1/4): as classical MDS scales its axes, by the root of each eigenvalue of C C^T.
  for (const [axis, { vector, value }] of [first, second].entries()) {
    const scale = value > 0 ? value ** -0.25 : 0;
    for (let i = 0; i < size; i++) {
      let sum = 0;
      for (let j = 0; j < k; j++) sum += c[i * k + j]! * vector[j]!;
      placed[i * 2 + axis] = sum * scale;
    }
  }
  // Scaled so links average `linkLength`, and centered.
  let total = 0;
  let links = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < size; i++) {
    const node = members[i]!;
    cx += placed[i * 2]! / size;
    cy += placed[i * 2 + 1]! / size;
    for (let at = adjacency.starts[node]!; at < adjacency.starts[node + 1]!; at++) {
      const j = local[adjacency.neighbors[at]!]!;
      total += Math.hypot(placed[i * 2]! - placed[j * 2]!, placed[i * 2 + 1]! - placed[j * 2 + 1]!);
      links++;
    }
  }
  const factor = total > 0 ? linkLength / (total / links) : 1;
  for (let i = 0; i < size; i++) {
    placed[i * 2] = (placed[i * 2]! - cx) * factor;
    placed[i * 2 + 1] = (placed[i * 2 + 1]! - cy) * factor;
  }
  return placed;
}

/**
 * The eigenvector of the largest eigenvalue of a symmetric k-by-k matrix,
 * by power iteration, and that eigenvalue; with `skip`, of the matrix less
 * that eigenvector's part, which gives the second.
 */
function topEigenvector(
  matrix: Float64Array,
  k: number,
  skip: { vector: Float64Array; value: number } | undefined,
): { vector: Float64Array; value: number } {
  // A fixed start with a part along every axis, as random starts have.
  let vector = Float64Array.from({ length: k }, (_, j) => 1 + ((j * 7919) % 101) / 101);
  let next = new Float64Array(k);
  let value = 0;
  for (let iteration = 0; iteration < ITERATIONS; iteration++) {
    for (let a = 0; a < k; a++) {
      let sum = 0;
      for (let b = 0; b < k; b++) sum += matrix[a * k + b]! * vector[b]!;
      next[a] = sum;
    }
    if (skip) {
      let along = 0;
      for (let a = 0; a < k; a++) along += skip.vector[a]! * vector[a]!;
      for (let a = 0; a < k; a++) next[a]! -= skip.value * along * skip.vector[a]!;
    }
    let norm = 0;
    for (let a = 0; a < k; a++) norm += next[a]! * next[a]!;
    norm = Math.sqrt(norm);
    if (!(norm > 0)) return { vector: new Float64Array(k), value: 0 };
    value = norm;
    for (let a = 0; a < k; a++) next[a]! /= norm;
    [vector, next] = [next, vector];
  }
  return { vector, value };
}
