// Cutting polygons at the walls of a 3D chart's box.

/** Cuts a polygon (x, y, z per corner, normalized) to the box from -1 to 1 on each axis. */
export function clipToBox(points: number[]): number[] {
  let polygon = points;
  for (let axis = 0; axis < 3; axis++) {
    for (const sign of [-1, 1]) {
      const next: number[] = [];
      const n = polygon.length / 3;
      for (let k = 0; k < n; k++) {
        const a = k * 3;
        const b = ((k + 1) % n) * 3;
        const da = 1 - sign * polygon[a + axis]!;
        const db = 1 - sign * polygon[b + axis]!;
        if (da >= 0) next.push(polygon[a]!, polygon[a + 1]!, polygon[a + 2]!);
        if (da >= 0 !== db >= 0) {
          const t = da / (da - db);
          for (let c = 0; c < 3; c++)
            next.push(polygon[a + c]! + t * (polygon[b + c]! - polygon[a + c]!));
        }
      }
      polygon = next;
      if (polygon.length === 0) return polygon;
    }
  }
  return polygon;
}
