import type { Polyline } from "../lod/polyline.ts";
import type { Curve } from "../spec/spec.ts";

/**
 * Rewrites `source` as a step line into `out`. "step-after" holds each value
 * until the next x, "step-before" jumps at the previous x, and "step" changes
 * value halfway between points.
 */
export function stepPolyline(
  source: Polyline,
  curve: Exclude<Curve, "linear">,
  out: Polyline,
): void {
  out.reset();
  const c = source.coords;
  for (let run = 0; run < source.starts.length; run++) {
    out.break();
    const start = source.starts[run]!;
    const end = source.runEnd(run);
    for (let i = start; i < end; i++) {
      const x = c[i * 2]!;
      const y = c[i * 2 + 1]!;
      if (i > start) {
        const px = c[i * 2 - 2]!;
        const py = c[i * 2 - 1]!;
        if (curve === "step-after") out.push(x, py);
        else if (curve === "step-before") out.push(px, y);
        else {
          const mid = (px + x) / 2;
          out.push(mid, py);
          out.push(mid, y);
        }
      }
      out.push(x, y);
    }
  }
}
