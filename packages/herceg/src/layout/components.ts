// Connected components of a graph, and their arrangement side by side.

/** Nodes' neighbors in compressed rows: those of node i are `neighbors[starts[i]]` up to `starts[i + 1]`. */
export interface Adjacency {
  starts: Int32Array;
  neighbors: Int32Array;
}

/**
 * Connected components, largest first (ties in the order of their first
 * nodes), each listing its nodes in breadth-first order from its
 * lowest-numbered node.
 */
export function componentsOf(nodes: number, { starts, neighbors }: Adjacency): Int32Array[] {
  const seen = new Uint8Array(nodes);
  const queue = new Int32Array(nodes);
  const components: Int32Array[] = [];
  let end = 0;
  for (let root = 0; root < nodes; root++) {
    if (seen[root]) continue;
    const start = end;
    seen[root] = 1;
    queue[end++] = root;
    for (let at = start; at < end; at++) {
      const node = queue[at]!;
      for (let k = starts[node]!; k < starts[node + 1]!; k++) {
        const next = neighbors[k]!;
        if (!seen[next]) {
          seen[next] = 1;
          queue[end++] = next;
        }
      }
    }
    components.push(queue.slice(start, end));
  }
  return components.sort((a, b) => b.length - a.length || a[0]! - b[0]!);
}

/**
 * Moves each component, whole, into rows of their bounding boxes, `gap`
 * apart: tallest first, each row as wide as a box of about `aspect` times
 * its height would be to hold them all (or the widest component), and
 * centered across and down their row. Boxes never overlap, so neither do components:
 * left inside one another, they would stay there in a force layout, since a
 * ring's repulsion, falling off as 1/r, cancels inside it.
 */
export function packComponents(
  positions: Float64Array,
  components: readonly Int32Array[],
  gap: number,
  aspect = 1.5,
): void {
  const boxes = components.map((members, index) => {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (const node of members) {
      x0 = Math.min(x0, positions[node * 2]!);
      x1 = Math.max(x1, positions[node * 2]!);
      y0 = Math.min(y0, positions[node * 2 + 1]!);
      y1 = Math.max(y1, positions[node * 2 + 1]!);
    }
    return { index, x0, y0, width: x1 - x0, height: y1 - y0, x: 0, y: 0 };
  });
  let area = 0;
  let widest = 0;
  for (const box of boxes) {
    area += (box.width + gap) * (box.height + gap);
    widest = Math.max(widest, box.width);
  }
  const rowWidth = Math.max(widest, Math.sqrt(area * aspect));
  // Tallest first; ties keep the components' order (largest first).
  const order = [...boxes].sort((a, b) => b.height - a.height || a.index - b.index);
  let row: typeof boxes = [];
  let x = 0;
  let y = 0;
  let height = 0;
  const finish = () => {
    // Each row centered across, and each box within its row's height.
    const shift = (rowWidth - (x - gap)) / 2;
    for (const box of row) {
      box.x += shift;
      box.y += (height - box.height) / 2;
    }
    y += height + gap;
    row = [];
    x = 0;
    height = 0;
  };
  for (const box of order) {
    if (row.length > 0 && x + box.width > rowWidth) finish();
    box.x = x;
    box.y = y;
    row.push(box);
    x += box.width + gap;
    height = Math.max(height, box.height);
  }
  if (row.length > 0) finish();
  for (const box of boxes) {
    const dx = box.x - box.x0;
    const dy = box.y - box.y0;
    for (const node of components[box.index]!) {
      positions[node * 2]! += dx;
      positions[node * 2 + 1]! += dy;
    }
  }
}
