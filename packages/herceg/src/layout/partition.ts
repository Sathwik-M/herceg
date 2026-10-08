import { childrenByValue, type Hierarchy } from "../data/hierarchy.ts";

/**
 * Adjacency partition, as sunbursts draw it: each node takes a share of its
 * parent's span in proportion to its value, largest first when `byValue`
 * (else in table order). Writes each node's start and end (two per node)
 * as fractions of the root's span [0, 1]. A parent with weight of its own
 * leaves the end of its span to it.
 */
export function layoutPartition(
  tree: Hierarchy,
  values: Float64Array,
  byValue: boolean,
  out: Float64Array,
): void {
  out.fill(0, 0, tree.size * 2);
  out[1] = values[0]! > 0 ? 1 : 0;
  let scratch: Uint32Array = new Uint32Array(16);
  for (let at = 0; at < tree.size; at++) {
    const node = tree.order[at]!;
    const total = values[node]!;
    if (!(total > 0)) continue;
    const children = byValue
      ? childrenByValue(tree, values, node, scratch)
      : tree.children.subarray(tree.childStart[node]!, tree.childStart[node + 1]!);
    if (byValue && children.length > scratch.length) scratch = children;
    const start = out[node * 2]!;
    const span = out[node * 2 + 1]! - start;
    let sum = 0;
    for (const child of children) {
      out[child * 2] = start + (span * sum) / total;
      sum += values[child]!;
      out[child * 2 + 1] = start + (span * sum) / total;
    }
  }
}
