// Circular layout: nodes evenly spaced on one circle, in a given order,
// with a gap between consecutive groups. Neighbors on the circle are about a
// link length apart, so circles of any size share the force layout's units.

import { LINK_DISTANCE } from "./force.ts";

/**
 * x, y per node on a circle centered at (0, 0), in layout units: `order`
 * lists the nodes clockwise from the top, and `group` (per node, -1 for
 * none) puts an empty slot between runs of different groups, less where
 * groups are many, so gaps never take more than a fifth of the circle.
 * `turn` rotates the circle clockwise, in radians.
 */
export function layoutCircular(order: Int32Array, group?: Int32Array, turn = 0): Float64Array {
  const n = order.length;
  const positions = new Float64Array(n * 2);
  if (n < 2) return positions;
  // Where runs of groups change, around the circle and back to the start.
  let changes = 0;
  if (group)
    for (let i = 0; i < n; i++) if (group[order[i]!] !== group[order[(i + 1) % n]!]) changes++;
  const gap = changes > 0 ? Math.min(1, (n * 0.25) / changes) : 0;
  const slots = n + changes * gap;
  const radius = (slots * LINK_DISTANCE) / (2 * Math.PI);
  let slot = 0;
  for (let i = 0; i < n; i++) {
    const node = order[i]!;
    const angle = -Math.PI / 2 + turn + (2 * Math.PI * slot) / slots;
    positions[node * 2] = radius * Math.cos(angle);
    positions[node * 2 + 1] = radius * Math.sin(angle);
    slot += 1;
    if (group && group[node] !== group[order[(i + 1) % n]!]) slot += gap;
  }
  return positions;
}

/**
 * The rotation that moves nodes laid out at `next` least from where they
 * were at `previous` (both around (0, 0), NaN where a node has no place):
 * the circular mean of the change of each node's angle.
 */
export function bestTurn(previous: Float64Array, next: Float64Array): number {
  let sin = 0;
  let cos = 0;
  for (let i = 0; i < next.length; i += 2) {
    const [px, py, nx, ny] = [previous[i]!, previous[i + 1]!, next[i]!, next[i + 1]!];
    if (!(Number.isFinite(px) && Number.isFinite(py)) || (px === 0 && py === 0)) continue;
    if (nx === 0 && ny === 0) continue;
    const change = Math.atan2(py, px) - Math.atan2(ny, nx);
    sin += Math.sin(change);
    cos += Math.cos(change);
  }
  return sin === 0 && cos === 0 ? 0 : Math.atan2(sin, cos);
}
