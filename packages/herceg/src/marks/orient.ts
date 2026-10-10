// Lines and areas along either axis and over category axes: which axis a
// mark runs along (its positions' axis, `orient`), its rows in band order on
// a category axis, and tracing it with the code that traces lines along x,
// through views of its series and frame with positions as x.

import type { NumericArray } from "../data/column.ts";
import type { Schema, Table } from "../data/table.ts";
import type { Mapping } from "../lod/m4.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { PositionScale } from "../scale/scale.ts";
import type { Orient } from "../spec/spec.ts";
import { CATEGORY, type Frame, NUMERIC, requireField } from "./mark.ts";
import { rowOf, type Series, xExtent } from "./series.ts";

/** Fields a line or area takes as positions: numbers, times, and categories. */
export const POSITION = [...NUMERIC, ...CATEGORY];

/** A line's or area's fields by role: its positions and the values along the other axis. */
export interface Roles {
  orient: Orient;
  /** The field of positions, which the mark runs along. */
  position: string;
  /** Fields of values, one series each without a series field. */
  values: readonly string[];
  /** Whether the positions are categories, at their bands' centers. */
  banded: boolean;
}

/**
 * Which axis a line or area runs along and its fields' roles: `orient`, or
 * y for a category y with values on x, as bars lie along a category y;
 * otherwise x. Positions are number, time, or category fields; values
 * number or time fields.
 */
export function rolesOf(
  table: Table<Schema>,
  type: "line" | "area",
  x: string | readonly string[],
  y: string | readonly string[],
  orient: unknown,
  series: string | undefined,
): Roles {
  if (orient !== undefined && orient !== "x" && orient !== "y")
    throw new RangeError(`${type} orient: expected "x" or "y"; received ${JSON.stringify(orient)}`);
  const kind = (field: string | readonly string[]) =>
    typeof field === "string" && table.has(field) ? table.kind(field) : undefined;
  const along: Orient = orient ?? (kind(y) === "category" && kind(x) !== "category" ? "y" : "x");
  const [position, values] = along === "x" ? [x, y] : [y, x];
  const across = along === "x" ? "y" : "x";
  if (typeof position !== "string") {
    throw new Error(
      along === "x"
        ? `${type} x: several fields are values along x of a mark along y; give orient: "y", or one x field`
        : `${type} y: a mark along y has one y field of positions; give one y field, or orient: "x"`,
    );
  }
  if (orient === "x" && kind(values) === "category")
    throw new Error(
      `${type} orient: "x" makes y the values, and "${values}" holds categories; give orient: "y", or a number field as y`,
    );
  requireField(table, position, POSITION, `${type} ${along}`);
  const fields = typeof values === "string" ? [values] : values;
  for (const field of fields) requireField(table, field, NUMERIC, `${type} ${across}`);
  if (series !== undefined && fields.length > 1)
    throw new Error(`${type} ${across}: several fields or a series field, not both; drop one`);
  const repeated = fields.find((field, i) => fields.indexOf(field) !== i);
  if (repeated !== undefined)
    throw new Error(`${type} ${across}: field "${repeated}" is listed twice; list it once`);
  return {
    orient: along,
    position,
    values: fields,
    banded: table.kind(position) === "category",
  };
}

/** What some rows came to. */
interface Kept {
  rows: Uint32Array | undefined;
}

/**
 * Rows of series (see `bandOrder` and `withBands`), held weakly by the
 * band indices and by the rows: a whole table's rows, or a row subset's.
 */
type RowsBy = WeakMap<NumericArray, { whole?: Kept; parts: WeakMap<Uint32Array, Kept> }>;
const orders: RowsBy = new WeakMap();
const banded: RowsBy = new WeakMap();

/** What `rows` came to, worked out once per band indices and rows. */
function kept(
  cache: RowsBy,
  bands: NumericArray,
  rows: Uint32Array | undefined,
  compute: () => Uint32Array | undefined,
): Uint32Array | undefined {
  let byBands = cache.get(bands);
  if (!byBands) {
    byBands = { parts: new WeakMap() };
    cache.set(bands, byBands);
  }
  if (!rows) {
    byBands.whole ??= { rows: compute() };
    return byBands.whole.rows;
  }
  let found = byBands.parts.get(rows);
  if (!found) {
    found = { rows: compute() };
    byBands.parts.set(rows, found);
  }
  return found.rows;
}

/**
 * A series' rows (all `length` rows when `rows` is undefined) that have a
 * band (`bands`, each row's band index, -1 for none), in their order:
 * `rows` itself when they all do.
 */
export function withBands(
  bands: NumericArray,
  rows: Uint32Array | undefined,
  length: number,
): Uint32Array | undefined {
  return kept(banded, bands, rows, () => {
    const out: number[] = [];
    for (let k = 0; k < length; k++) {
      const row = rows ? rows[k]! : k;
      if (bands[row]! >= 0) out.push(row);
    }
    return out.length === length ? rows : Uint32Array.from(out);
  });
}

/**
 * A series' rows (all `length` rows when `rows` is undefined) in the order
 * of their bands (`bands`, each row's band index, -1 for none), rows of one
 * band in their own order, without rows that have none: undefined when
 * the rows already ascend through bands and all have one. Kept while the
 * band indices and the rows stay the same, so redraws sort nothing.
 */
export function bandOrder(
  bands: NumericArray,
  rows: Uint32Array | undefined,
  length: number,
): Uint32Array | undefined {
  return kept(orders, bands, rows, () => {
    let previous = 0;
    for (let k = 0; k < length; k++) {
      const band = bands[rows ? rows[k]! : k]!;
      if (band < previous) {
        // Rows of one band keep their order: rows ascend within a series.
        const out = withBands(bands, rows, length) ?? Uint32Array.from({ length }, (_, i) => i);
        return Uint32Array.from(out).sort((a, b) => bands[a]! - bands[b]! || a - b);
      }
      previous = band;
    }
    return rows;
  });
}

/** A scale moved `by` pixels: a dodged series' place in each band. */
function shifted(scale: PositionScale, by: number): PositionScale {
  const mapping: Mapping = scale.mapping();
  return {
    type: scale.type,
    domain: scale.domain,
    range: scale.range,
    ...(scale.bandwidth !== undefined && { bandwidth: scale.bandwidth }),
    map: (value) => scale.map(value) + by,
    invert: (pixel) => scale.invert(pixel - by),
    ticks: (count) => scale.ticks(count),
    mapping: () => ({ ...mapping, offset: mapping.offset + by }),
  };
}

/**
 * A frame on which a mark running along `orient` is traced as lines along x
 * are: for marks along y, with its scales and plot swapped; the positions'
 * scale moved `shift` pixels (a dodged series' place). Polylines traced on
 * it are in its coordinates; `untranspose` turns them back.
 */
export function traceFrame(frame: Frame, orient: Orient, shift: number): Frame {
  const along = orient === "x" ? frame.x : frame.y;
  const positions = shift === 0 ? along : shifted(along, shift);
  if (orient === "x") return shift === 0 ? frame : { ...frame, x: positions };
  const { x, y, width, height } = frame.plot;
  return { ...frame, x: positions, y: frame.x, plot: { x: y, y: x, width: height, height: width } };
}

/**
 * A series as `traceFrame` traces it (`frame` is the chart's): positions
 * as x, values as y (and bases as y0), ascending in x as `sorted` says.
 * Where a panel holds only some of the chart's bands, or along y a time x
 * axis' breaks hide some values (and `hides`: layers sharing edges keep
 * them, at the break's seam, so the edges stay shared), its points are
 * copied in order into buffers the size of the series: positions read
 * through the panel's band places, and without the rows a break hides,
 * which the line joins across as lines along x join across hidden
 * positions.
 */
export function traceSeries(
  s: Series,
  frame: Frame,
  orient: Orient,
  sorted: boolean,
  hides = true,
): Series {
  if (!copiesPoints(s, frame, orient, hides)) {
    if (orient === "x") return sorted === s.sorted ? s : { ...s, sorted };
    return { ...s, x: s.y, y: s.x, y0: s.x0, x0: undefined, sorted };
  }
  const places = s.places?.[orient];
  const breaks = hides && orient === "y" ? frame.x.breaks : undefined;
  const along = orient === "x";
  const [positions, values, bases] = along ? [s.x, s.y, s.y0] : [s.y, s.x, s.x0];
  const n = s.length;
  const x = frame.doubles(s.key, "placed", n);
  const y = frame.doubles(s.key, "placed-values", n);
  const y0 = bases && frame.doubles(s.key, "placed-bases", n);
  let length = 0;
  for (let k = 0; k < n; k++) {
    const row = rowOf(s, k);
    if (breaks?.hides(values[row]!)) continue;
    x[length] = places ? places.at(positions[row]!) : positions[row]!;
    y[length] = values[row]!;
    if (y0) y0[length] = bases![row]!;
    length++;
  }
  return {
    ...s,
    x,
    y,
    y0,
    x0: undefined,
    values: y,
    field: undefined,
    rows: undefined,
    length,
    stream: undefined,
    edges: undefined,
    sorted,
    places: undefined,
  };
}

/**
 * Whether `traceSeries` copies a series' points (renumbering them, so
 * indexes over its rows or values do not serve the copy), leaving out the
 * rows a break hides as `hides` says.
 */
export function copiesPoints(s: Series, frame: Frame, orient: Orient, hides: boolean): boolean {
  return (
    s.places?.[orient] !== undefined || (hides && orient === "y" && frame.x.breaks !== undefined)
  );
}

/**
 * [min, max] of a series' positions along y (`log`: positive ones), as
 * `xExtent` reads x: a mark along y spans its positions whatever x shows,
 * as a mark along x spans its positions whatever y shows.
 */
export function positionsExtent(s: Series, log: boolean): [number, number] | undefined {
  return xExtent({ ...s, x: s.y, sorted: s.ySorted ?? false }, log);
}

/** Swaps a polyline traced on a transposed frame (`traceFrame`) back into the chart's coordinates. */
export function untranspose(path: Polyline): void {
  swapPairs(path.coords, path.count * 2);
  if (path.curved) swapPairs(path.controls, path.count * 4);
}

function swapPairs(values: Float32Array, length: number): void {
  for (let i = 0; i < length; i += 2) {
    const x = values[i]!;
    values[i] = values[i + 1]!;
    values[i + 1] = x;
  }
}
