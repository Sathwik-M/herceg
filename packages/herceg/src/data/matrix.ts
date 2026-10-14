// Matrix tables: values at every x crossed with every y, as a field sampled
// on a grid (a density estimate, a simulation's output) or a matrix of
// pairs (correlations) comes. The coordinates are kept as given, one value
// per column and per row of the matrix; a value per table row is made only
// for a reader that asks for one, so a contour of a million grid points
// holds its values and two short coordinate arrays, not three columns.

import {
  type CategoryColumn,
  type Column,
  type ColumnInput,
  createColumn,
  type NumericArray,
} from "./column.ts";
import { type SchemaOf, Table, type TableOptions } from "./table.ts";

/**
 * A matrix table's coordinates: the fields holding them, and their values
 * (codes for categories), `xs` along each row of the matrix and `ys` from
 * row to row. Row r of the table is at xs[r % xs.length], ys[floor(r / xs.length)].
 */
export interface Matrix {
  readonly x: string;
  readonly y: string;
  readonly xs: NumericArray;
  readonly ys: NumericArray;
}

/** Each matrix table's coordinates, while its rows are still its matrix's. */
const matrices = new WeakMap<Table, Matrix>();

/**
 * The coordinates of a matrix table (`fromMatrix`) whose rows are still its
 * matrix's; undefined for other tables, and for a matrix table once rows
 * are appended, dropped, or reset, or its coordinates replaced.
 */
export function matrixOf(table: Table): Matrix | undefined {
  return matrices.get(table);
}

/**
 * A matrix table: `columns` as `table()` takes them, where the fields named
 * by `axes.x` and `axes.y` hold the matrix's coordinates (one value per
 * column of it, and one per row) and every other field a value at each
 * pair, in rows of x: the value at the i-th x and j-th y is at j × (number
 * of x values) + i, as a NumPy array of shape (y, x) flattens. The table's
 * rows are the pairs in that order; its x and y fields hold each row's
 * coordinates, made when a reader first asks for them. Contours read the
 * matrix as it is (`matrixOf`).
 *
 * ```ts
 * const density = fromMatrix({ x: xs, y: ys, density: values }, { x: "x", y: "y" });
 * contour(density, { x: "x", y: "y", color: "density", variant: "bands" });
 * ```
 */
export function fromMatrix<const T extends Record<string, ColumnInput>>(
  columns: T,
  axes: { x: keyof T & string; y: keyof T & string },
  options?: TableOptions,
): Table<SchemaOf<T>> {
  const { x, y } = axes;
  for (const [axis, field] of [
    ["x", x],
    ["y", y],
  ] as const)
    if (!Object.hasOwn(columns, field))
      throw new Error(
        `fromMatrix ${axis}: no column "${field}"; name one of ${Object.keys(columns)
          .map((name) => `"${name}"`)
          .join(", ")}`,
      );
  if (x === y)
    throw new Error(
      `fromMatrix y: "${y}" also holds x; give the rows' coordinates a column of their own`,
    );
  const coordinates = (field: string) => {
    try {
      const column = createColumn(columns[field]!);
      if (column.kind === "geometry") throw new TypeError("expected numbers, times, or categories");
      return column;
    } catch (error) {
      const Kind = error instanceof RangeError ? RangeError : TypeError;
      throw new Kind(`fromMatrix: column "${field}": ${(error as Error).message}`);
    }
  };
  const xColumn = coordinates(x);
  const yColumn = coordinates(y);
  const nx = xColumn.buffer.length;
  const ny = yColumn.buffer.length;
  const inputs: Record<string, ColumnInput> = Object.create(null);
  for (const [field, input] of Object.entries(columns)) {
    if (field === x) inputs[field] = deferred(xColumn, nx, ny, true);
    else if (field === y) inputs[field] = deferred(yColumn, nx, ny, false);
    else inputs[field] = input;
  }
  let made: Table<SchemaOf<T>>;
  try {
    made = new Table<SchemaOf<T>>(inputs, options);
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new RangeError(
      `fromMatrix: ${error.message}; a matrix of ${nx} x by ${ny} y values holds ${nx * ny} of each`,
    );
  }
  if (made.length === nx * ny) {
    const table = made as unknown as Table;
    matrices.set(table, { x, y, xs: xColumn.buffer, ys: yColumn.buffer });
    // Rows other than the matrix's, or other coordinates, are no matrix.
    const stop = made.subscribe((change) => {
      if (
        change.reset ||
        change.appended > 0 ||
        change.dropped > 0 ||
        change.fields.includes(x) ||
        change.fields.includes(y)
      ) {
        matrices.delete(table);
        stop();
      }
    });
  }
  return made;
}

/**
 * A matrix's coordinates as a column input whose column holds each row's
 * coordinate: along x, the `nx` values over and over (`across`); along y,
 * each of them `nx` times in turn. Its buffer is made when first read.
 */
function deferred(source: Column, nx: number, ny: number, across: boolean): ColumnInput {
  const length = nx * ny;
  const make = (): NumericArray => {
    const values = source.buffer;
    const out = new (values.constructor as new (length: number) => NumericArray)(length);
    if (across) for (let j = 0; j < ny; j++) out.set(values, j * nx);
    else for (let j = 0; j < ny; j++) out.fill(values[j]!, j * nx, (j + 1) * nx);
    return out;
  };
  let buffer: NumericArray | undefined;
  const column = {
    kind: source.kind,
    owned: true,
    ...(source.kind === "category" && {
      dictionary: (source as CategoryColumn).dictionary,
      codes: (source as CategoryColumn).codes,
    }),
    get deferred() {
      return buffer ? undefined : { length, byteLength: source.buffer.byteLength };
    },
    get buffer(): NumericArray {
      buffer ??= make();
      return buffer;
    },
    set buffer(next: NumericArray) {
      buffer = next;
    },
  } as unknown as Column;
  // Tables make columns of inputs that bring their own, as geometry does.
  return { column: () => column } as unknown as ColumnInput;
}
