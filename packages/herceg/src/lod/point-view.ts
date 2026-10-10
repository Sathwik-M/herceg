// Optional point views for independent panel bands and values hidden by
// time breaks. Placement objects carry this synchronous copying path.
import type { NumericArray } from "../data/column.ts";

export interface TraceSource {
  key: string;
  x: NumericArray;
  y: NumericArray;
  y0: NumericArray | undefined;
  rows: Uint32Array | undefined;
  length: number;
}

export type TraceColumns = Pick<TraceSource, "x" | "y" | "y0" | "length">;
export type TraceBuffers = (key: string, stage: string, length: number) => Float64Array;

export interface PositionLookup {
  at(position: number): number;
}

export function copyTrace(
  s: TraceSource,
  buffers: TraceBuffers,
  places?: PositionLookup,
  breaks?: { hides(value: number): boolean },
): TraceColumns {
  const n = s.length;
  const x = buffers(s.key, "placed", n);
  const y = buffers(s.key, "placed-values", n);
  const y0 = s.y0 && buffers(s.key, "placed-bases", n);
  let length = 0;
  for (let k = 0; k < n; k++) {
    const row = s.rows ? s.rows[k]! : k;
    if (breaks?.hides(s.y[row]!)) continue;
    x[length] = places ? places.at(s.x[row]!) : s.x[row]!;
    y[length] = s.y[row]!;
    if (y0) y0[length] = s.y0![row]!;
    length++;
  }
  return { x, y, y0, length };
}
