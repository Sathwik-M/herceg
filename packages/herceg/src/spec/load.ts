// Turns a portable chart specification into a chart configuration: tables
// from `data`, marks from `marks`. This is how charts built outside
// TypeScript (the Python package, saved specs) reach the engine.

import { type ColumnInput, encodedCategory, type NumericArray, time } from "../data/column.ts";
import { deriveTable } from "../data/derive.ts";
import { geometry } from "../data/geometry.ts";
import { fromMatrix } from "../data/matrix.ts";
import { RowSet } from "../data/row-set.ts";
import {
  type DataSelection,
  type SelectionStore,
  selectionStore,
  selectRows,
  selectWhere,
} from "../data/selection.ts";
import { type Table, table } from "../data/table.ts";
import { readsTable } from "../marks/annotation.ts";
import { AreaMark } from "../marks/area.ts";
import { BarMark } from "../marks/bar.ts";
import { BoxenMark } from "../marks/boxen.ts";
import { BoxPlotMark } from "../marks/boxplot.ts";
import { CandlestickMark } from "../marks/candlestick.ts";
import { ContourMark } from "../marks/contour.ts";
import { DendrogramMark } from "../marks/dendrogram.ts";
import { ErrorBarMark } from "../marks/errorbar.ts";
import { FunnelMark } from "../marks/funnel.ts";
import { GaugeMark } from "../marks/gauge.ts";
import { GeoPointMark } from "../marks/geopoint.ts";
import { GeoShapeMark } from "../marks/geoshape.ts";
import { GraphMark } from "../marks/graph.ts";
import { HeatmapMark } from "../marks/heatmap.ts";
import { HistogramMark } from "../marks/histogram.ts";
import { Histogram2DMark } from "../marks/histogram2d.ts";
import { type LayoutMark, tablesOf } from "../marks/layout-mark.ts";
import { LineMark } from "../marks/line.ts";
import { Line3DMark } from "../marks/line3d.ts";
import type { ChartMark, Mark } from "../marks/mark.ts";
import { PieMark } from "../marks/pie.ts";
import { PointMark } from "../marks/point.ts";
import { Point3DMark } from "../marks/point3d.ts";
import { RadarMark } from "../marks/radar.ts";
import { RegionMark } from "../marks/region.ts";
import { RugMark } from "../marks/rug.ts";
import { RuleMark } from "../marks/rule.ts";
import { SankeyMark } from "../marks/sankey.ts";
import { SunburstMark } from "../marks/sunburst.ts";
import { SurfaceMark } from "../marks/surface.ts";
import { TextMark } from "../marks/text.ts";
import { TreemapMark } from "../marks/treemap.ts";
import { ViolinMark } from "../marks/violin.ts";
import { Facet } from "../model/facet.ts";
import type { ChartConfig } from "../model/model.ts";
import { rangeNavigator } from "../model/navigator.ts";
import { Panels } from "../model/panels.ts";
import { type RowSelection, rowSelection } from "../model/row-selection.ts";
import { timeBreaks } from "../scale/breaks.ts";
import { scheme } from "../scale/schemes.ts";
import type {
  BinaryType,
  ChartSpec,
  ColumnSpec,
  ColumnsSpec,
  DataSpec,
  Histogram1DSpec,
  Histogram2DSpec,
  MarkSpec,
  RowSelectionSpec,
  SelectionSpec,
} from "./spec.ts";
import { describeUnknown, findUnknown, unknownError } from "./validate.ts";

/** Bytes of a binary column: an ArrayBuffer, or a view such as a Uint8Array or DataView. */
export type SpecBuffer = ArrayBuffer | ArrayBufferView;

export interface LoadedSpec {
  /** Chart options with marks, ready for `createChart` or `renderToSVG`. */
  config: ChartConfig & { width?: number; height?: number };
  /** The spec's tables by name; changing them updates charts built from the spec. */
  tables: Map<string, Table>;
  /** The selection stores `rowSelection` binds, by table name: those given in `stores`, or new ones. */
  stores: Map<string, SelectionStore>;
  /** Paths of the properties this herceg does not know, such as `marks[0].strokeWidht`. */
  unknown: string[];
}

export interface LoadOptions {
  /**
   * What to do about properties the spec format does not have, such as
   * misspellings: "error" (the default) throws, naming the property and the
   * one it likely meant; "warn" logs them and loads the rest; "ignore" loads
   * the rest quietly. Unknown properties never change the chart.
   */
  unknown?: "error" | "warn" | "ignore";
  /**
   * Tables to use instead of making them from the spec's `data`, by name
   * (a map, such as another loaded spec's `tables`, or an object): charts
   * loaded from several specs share rows (and so selections) only through
   * tables they share. The spec's own columns for them are not read.
   */
  tables?: ByName<AnyTable>;
  /**
   * The selection stores `rowSelection` binds, by table name; a store of a
   * table's own is made for each one left out. Each must be of that table.
   */
  stores?: ByName<AnyStore>;
}

/** Values by name: a map, or an object of them. */
type ByName<T> = ReadonlyMap<string, T> | Readonly<Record<string, T>>;

/**
 * Tables and stores of any schema, which the loader reads by field name:
 * a table's schema types its fields only where it is used by name.
 */
// biome-ignore lint/suspicious/noExplicitAny: the erasure point of tables of several schemas.
type AnyTable = Table<any>;
// biome-ignore lint/suspicious/noExplicitAny: as for tables.
type AnyStore = SelectionStore<any>;

const TYPED: Record<
  BinaryType,
  {
    new (buffer: ArrayBuffer, offset: number, length: number): NumericArray;
    BYTES_PER_ELEMENT: number;
  }
> = {
  float64: Float64Array,
  float32: Float32Array,
  int32: Int32Array,
  uint32: Uint32Array,
  int16: Int16Array,
  uint16: Uint16Array,
  int8: Int8Array,
  uint8: Uint8Array,
};

/**
 * Builds tables and marks from a chart specification. Binary columns read
 * `buffers` (their `buffer` field is an index into it) without copying when
 * the bytes are aligned for their type. Errors name the offending table,
 * column, or mark. For a spec of unknown shape, such as parsed JSON, check
 * it with `validateSpec` first.
 */
export function loadSpec(
  spec: ChartSpec,
  buffers: readonly SpecBuffer[] = [],
  options: LoadOptions = {},
): LoadedSpec {
  const found = findUnknown(spec);
  const handling = options.unknown ?? "error";
  if (found.length > 0 && handling === "error") throw new TypeError(unknownError(found));
  if (found.length > 0 && handling === "warn")
    console.warn(
      `herceg spec: ignoring properties the format does not have: ${found.map(describeUnknown).join(", ")}`,
    );
  const unknown = found.map(({ path }) => path);
  const tables = loadTables(spec.data ?? {}, buffers, byName(options.tables));
  const marks = spec.marks.map((mark, index) => loadMark(mark, index, tables));
  const {
    data: _data,
    marks: _marks,
    version: _version,
    facet: split,
    panels,
    grid,
    x,
    navigator: strip,
    rowSelection: bindings,
    ...chart
  } = spec;
  const stores = new Map<string, SelectionStore>();
  const rows =
    bindings && loadRowSelection(bindings, tables, marks, buffers, byName(options.stores), stores);
  const facet = split && new Facet(split);
  const subplots = panels && new Panels(panels, grid);
  const navigator = strip ? rangeNavigator(strip === true ? {} : strip) : undefined;
  // Breaks become the TimeBreaks that resolve them.
  const { breaks, ...axis } = x ?? {};
  const xAxis = x && { ...axis, ...(breaks && { breaks: timeBreaks(breaks) }) };
  return {
    config: {
      ...chart,
      marks,
      ...(xAxis && { x: xAxis }),
      ...(facet && { facet }),
      ...(subplots && { panels: subplots }),
      ...(navigator && { navigator }),
      ...(rows && { rowSelection: rows }),
    },
    tables,
    stores,
    unknown,
  };
}

function byName<T>(values: ByName<T> | undefined): ReadonlyMap<string, T> | undefined {
  if (values === undefined || values instanceof Map) return values as ReadonlyMap<string, T>;
  return new Map(Object.entries(values));
}

/**
 * A spec's row selection, its bindings' tables resolved by name (or, left
 * out, the one table the marks read) and their stores taken from `given`
 * or made, into `stores`.
 */
function loadRowSelection(
  spec: RowSelectionSpec | readonly RowSelectionSpec[],
  tables: ReadonlyMap<string, Table>,
  marks: readonly ChartMark[],
  buffers: readonly SpecBuffer[],
  given: ReadonlyMap<string, SelectionStore> | undefined,
  stores: Map<string, SelectionStore>,
): RowSelection {
  const read = [...new Set(marks.flatMap((mark) => tablesOf(mark)))];
  const bindings = (Array.isArray(spec) ? spec : [spec]) as readonly RowSelectionSpec[];
  return rowSelection(
    ...bindings.map(({ data, channel, events, effect, selection }, i) => {
      const path = Array.isArray(spec) ? `spec.rowSelection[${i}]` : "spec.rowSelection";
      let name = data;
      if (name === undefined) {
        if (read.length !== 1)
          throw new Error(`${path}.data: missing; the marks read several tables, so name one`);
        name = [...tables].find(([, table]) => table === read[0])?.[0];
      }
      const table = name === undefined ? undefined : tables.get(name);
      if (!table)
        throw new Error(
          `${path}.data: no table ${JSON.stringify(name)} in spec.data; name one of ${names(tables)}`,
        );
      let store = given?.get(name!) ?? stores.get(name!);
      if (store && store.source !== table)
        throw new Error(
          `stores.${name}: the store given is of another table; give a store of table "${name}"`,
        );
      if (!store) {
        // A store given keeps what it holds; one made here starts with the spec's.
        store = selectionStore(table);
        if (selection) {
          const at = `${path}.selection`;
          const held = loadSelection(selection, table, buffers, at);
          try {
            store.set(channel, held);
          } catch (error) {
            // A condition of fields the table lacks, or not true or false.
            throw new TypeError(`${at}.expression: ${(error as Error).message}`);
          }
        }
      }
      stores.set(name!, store);
      return {
        store,
        channel,
        ...(events && { events }),
        ...(effect && { effect }),
      };
    }),
  );
}

/** A spec's selection of `table`'s rows: its condition, or its rows by position. */
function loadSelection(
  spec: SelectionSpec,
  table: Table,
  buffers: readonly SpecBuffer[],
  path: string,
): DataSelection {
  if (spec.kind === "predicate") return selectWhere(spec.expression);
  const positions =
    typeof spec.rows === "number" ? binary("uint32", spec.rows, buffers) : spec.rows;
  for (let i = 0; i < positions.length; i++) {
    const row = positions[i]!;
    if (!(Number.isInteger(row) && row >= 0 && row < table.length))
      throw new RangeError(
        `${path}.rows[${i}]: expected a position among the table's ${table.length} rows; received ${row}`,
      );
  }
  return selectRows(new RowSet(table).addAll(positions));
}

/**
 * Every table of the spec; derived tables after the tables they derive
 * from. Tables in `given` are used rather than made from their columns.
 */
function loadTables(
  data: Record<string, DataSpec>,
  buffers: readonly SpecBuffer[],
  given?: ReadonlyMap<string, Table>,
): Map<string, Table> {
  const tables = new Map<string, Table>();
  const loading = new Set<string>();
  const load = (name: string): Table => {
    const done = tables.get(name) ?? given?.get(name);
    if (done) {
      tables.set(name, done);
      return done;
    }
    const entry = data[name];
    if (!entry) throw new Error(`spec.data: no table "${name}"`);
    if (!("source" in entry)) {
      const loaded = loadTable(name, entry, buffers);
      tables.set(name, loaded);
      return loaded;
    }
    if (loading.has(name))
      throw new Error(
        `spec.data.${name}.source: the table derives from itself; derive it from another`,
      );
    loading.add(name);
    if (!Object.hasOwn(data, entry.source))
      throw new Error(
        `spec.data.${name}.source: no table "${entry.source}" in spec.data; name one of ${names(data)}`,
      );
    const source = load(entry.source);
    let derived: Table;
    try {
      derived = deriveTable(source, entry.transform, { name });
    } catch (error) {
      throw within(`spec.data.${name}`, error);
    }
    tables.set(name, derived);
    return derived;
  };
  for (const name of Object.keys(data)) load(name);
  return tables;
}

function loadTable(name: string, data: ColumnsSpec, buffers: readonly SpecBuffer[]): Table {
  // A null-prototype record keeps fields such as "__proto__" ordinary keys.
  const columns: Record<string, ColumnInput> = Object.create(null);
  for (const [field, column] of Object.entries(data.columns)) {
    try {
      columns[field] = loadColumn(column, buffers);
    } catch (error) {
      throw within(`spec.data.${name}.columns.${field}`, error);
    }
  }
  try {
    return data.matrix
      ? fromMatrix(columns, { x: data.matrix.x, y: data.matrix.y }, { name })
      : table(columns, { name });
  } catch (error) {
    throw within(`spec.data.${name}`, error);
  }
}

/** `Array.isArray`, typed to narrow readonly arrays too, as spec columns are. */
const isList = Array.isArray as (value: unknown) => value is readonly unknown[];

function loadColumn(column: ColumnSpec, buffers: readonly SpecBuffer[]): ColumnInput {
  if (isList(column)) return inlineValues(column);
  if (typeof column !== "object" || column === null) {
    throw new TypeError("expected an array of values or a column object; received neither");
  }
  switch (column.type) {
    case "time":
      return "values" in column
        ? time(timeValues(column.values))
        : time(binary(column.dtype, column.buffer, buffers));
    case "number":
      return binary(column.dtype, column.buffer, buffers);
    case "category": {
      if (
        !Array.isArray(column.dictionary) ||
        column.dictionary.some((v) => typeof v !== "string")
      ) {
        throw new TypeError("dictionary: expected an array of strings");
      }
      const codes =
        typeof column.codes === "number"
          ? (binary("int32", column.codes, buffers) as Int32Array)
          : inlineCodes(column.codes, column.dictionary.length);
      return encodedCategory(codes, column.dictionary);
    }
    case "geometry": {
      // Offsets and codes are int32, coordinates float64, as buffers or JSON arrays.
      const ints = (value: unknown, name: string) => {
        if (typeof value === "number") return binary("int32", value, buffers) as Int32Array;
        const list = numberList(value, name);
        const bad = list.findIndex((v) => !Number.isInteger(v) || Math.abs(v) > 2 ** 31 - 1);
        if (bad >= 0)
          throw new TypeError(`${name}[${bad}]: expected an int32; received ${list[bad]}`);
        return Int32Array.from(list);
      };
      const coordinates =
        typeof column.coordinates === "number"
          ? (binary("float64", column.coordinates, buffers) as Float64Array)
          : Float64Array.from(numberList(column.coordinates, "coordinates"));
      return geometry(
        {
          coordinates,
          ringOffsets: ints(column.ringOffsets, "ringOffsets"),
          polygonOffsets: ints(column.polygonOffsets, "polygonOffsets"),
          geometryOffsets: ints(column.geometryOffsets, "geometryOffsets"),
        },
        column.codes === undefined ? undefined : ints(column.codes, "codes"),
      );
    }
    default:
      throw new TypeError(
        `type: expected "number", "time", "category", or "geometry"; received ${JSON.stringify((column as { type: unknown }).type)}`,
      );
  }
}

/** A JSON array: numbers (null for missing) or strings (null for missing), not a mix. */
function inlineValues(values: readonly unknown[]): ColumnInput {
  let kind: "number" | "string" | undefined;
  values.forEach((value, row) => {
    if (value === null) return;
    const type = typeof value;
    if (type !== "number" && type !== "string") {
      throw new TypeError(
        `row ${row}: expected a number, string, or null; received ${JSON.stringify(value)}`,
      );
    }
    kind ??= type;
    if (type !== kind)
      throw new TypeError(
        `row ${row}: a ${type} in a column of ${kind}s; give one kind per column`,
      );
  });
  return values as ColumnInput;
}

/** A JSON array of finite numbers. */
function numberList(values: unknown, name: string): number[] {
  if (!Array.isArray(values)) throw new TypeError(`${name}: expected a buffer index or an array`);
  values.forEach((value, i) => {
    if (typeof value !== "number" || !Number.isFinite(value))
      throw new TypeError(
        `${name}[${i}]: expected a finite number; received ${JSON.stringify(value)}`,
      );
  });
  return values;
}

function timeValues(values: unknown): number[] {
  if (!Array.isArray(values)) throw new TypeError("values: expected an array of times");
  return values.map((value, row) => {
    if (value === null) return Number.NaN;
    const time = typeof value === "string" ? Date.parse(value) : value;
    if (typeof time !== "number" || Number.isNaN(time)) {
      throw new TypeError(
        `row ${row}: expected epoch milliseconds or an ISO 8601 time; received ${JSON.stringify(value)}`,
      );
    }
    return time;
  });
}

function inlineCodes(codes: unknown, size: number): Int32Array {
  if (!Array.isArray(codes)) throw new TypeError("codes: expected a buffer index or an array");
  return Int32Array.from(codes, (code, row) => {
    if (!Number.isInteger(code) || code < -1 || code >= size) {
      throw new RangeError(
        `row ${row}: code ${JSON.stringify(code)} is outside the dictionary; codes run from -1 to ${size - 1}`,
      );
    }
    return code;
  });
}

/** Whether this machine stores multi-byte numbers little-endian, as the spec does. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/**
 * A typed view of buffer `index`, copied only when its bytes are misaligned
 * or this machine is big-endian.
 */
function binary(dtype: BinaryType, index: number, buffers: readonly SpecBuffer[]): NumericArray {
  const Typed = Object.hasOwn(TYPED, dtype) ? TYPED[dtype] : undefined;
  if (!Typed)
    throw new TypeError(
      `dtype: expected ${Object.keys(TYPED)
        .map((type) => `"${type}"`)
        .join(", ")}; received ${JSON.stringify(dtype)}`,
    );
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError(`buffer: expected a buffer index; received ${JSON.stringify(index)}`);
  }
  const source = buffers[index];
  if (source === undefined)
    throw new RangeError(
      `buffer: buffer ${index} is missing; ${buffers.length} were delivered with the spec`,
    );
  const bytes = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer as ArrayBuffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  const size = Typed.BYTES_PER_ELEMENT;
  if (bytes.byteLength % size !== 0) {
    throw new RangeError(
      `buffer: buffer ${index} has ${bytes.byteLength} bytes, not a whole number of ${dtype} values; check dtype`,
    );
  }
  if (!LITTLE_ENDIAN && size > 1) return swapped(Typed, bytes);
  const aligned = bytes.byteOffset % size === 0 ? bytes : bytes.slice();
  return new Typed(aligned.buffer as ArrayBuffer, aligned.byteOffset, aligned.byteLength / size);
}

/** Little-endian bytes reversed per value into native order, for big-endian machines. */
function swapped(Typed: (typeof TYPED)[BinaryType], bytes: Uint8Array): NumericArray {
  const size = Typed.BYTES_PER_ELEMENT;
  const copy = bytes.slice();
  for (let at = 0; at < copy.length; at += size) copy.subarray(at, at + size).reverse();
  return new Typed(copy.buffer, 0, copy.length / size);
}

function loadMark(spec: MarkSpec, index: number, tables: Map<string, Table>): Mark | LayoutMark {
  try {
    // Annotations read a table only when a position or their text is a field.
    switch (spec.type) {
      case "rule":
        return new RuleMark(spec, annotationTable(spec, [spec.x, spec.y], tables));
      case "region":
        return new RegionMark(
          spec,
          annotationTable(spec, [spec.x1, spec.x2, spec.y1, spec.y2], tables),
        );
      case "text":
        return new TextMark(spec, annotationTable(spec, [spec.x, spec.y], tables));
    }
    const source = tableFor(spec.data, tables);
    switch (spec.type) {
      case "line":
        return new LineMark(spec, source);
      case "area":
        return new AreaMark(spec, source);
      case "bar":
        return new BarMark(spec, source);
      case "point":
        return new PointMark(withScheme(spec), source);
      case "dendrogram":
        return new DendrogramMark(spec, source);
      case "heatmap":
        return new HeatmapMark(withScheme(spec), source);
      case "contour":
        return new ContourMark(withScheme(spec), source);
      case "rug":
        return new RugMark(spec, source);
      case "errorbar":
        return new ErrorBarMark(spec, source);
      case "candlestick":
        return new CandlestickMark(spec, source);
      case "histogram":
        return spec.x !== undefined && spec.y !== undefined
          ? new Histogram2DMark(withScheme(spec as Histogram2DSpec), source)
          : new HistogramMark(spec as Histogram1DSpec, source);
      case "pie":
        return new PieMark(spec, source);
      case "boxplot":
        return new BoxPlotMark(spec, source);
      case "boxen":
        return new BoxenMark(spec, source);
      case "violin":
        return new ViolinMark(spec, source);
      case "treemap":
        return new TreemapMark(spec, source);
      case "sunburst":
        return new SunburstMark(spec, source);
      case "gauge":
        return new GaugeMark(spec, source);
      case "funnel":
        return new FunnelMark(spec, source);
      case "radar":
        return new RadarMark(spec, source);
      case "sankey":
        return new SankeyMark(spec, source);
      case "geoshape":
        return new GeoShapeMark(withScheme(spec), source);
      case "geopoint":
        return new GeoPointMark(withScheme(spec), source);
      case "point3d":
        return new Point3DMark(withScheme(spec), source);
      case "line3d":
        return new Line3DMark(spec, source);
      case "surface":
        return new SurfaceMark(withScheme(spec), source);
      case "graph":
        return new GraphMark(
          spec,
          source,
          spec.nodes === undefined ? undefined : tableFor(spec.nodes, tables),
        );
      default:
        throw new TypeError(
          `type: not a mark type; received ${JSON.stringify((spec as { type: unknown }).type)}`,
        );
    }
  } catch (error) {
    throw within(`marks[${index}]`, error);
  }
}

/** An error of the same kind (TypeError, RangeError, Error) whose message starts at `location`. */
function within(location: string, error: unknown): Error {
  const message = `${location}: ${(error as Error).message}`;
  if (error instanceof RangeError) return new RangeError(message);
  if (error instanceof TypeError) return new TypeError(message);
  return new Error(message);
}

/** A list of tables' names, as an error suggests them. */
function names(tables: ReadonlyMap<string, unknown> | Record<string, unknown>): string {
  const all = tables instanceof Map ? [...tables.keys()] : Object.keys(tables);
  return all.map((name) => `"${name}"`).join(", ") || "(none)";
}

/** A mark's spec with a named color scheme replaced by the scheme's colors. */
function withScheme<T extends { colors?: string | readonly string[] | undefined }>(spec: T): T {
  return typeof spec.colors === "string" ? { ...spec, colors: [...scheme(spec.colors)] } : spec;
}

function annotationTable(
  spec: { data?: string; textField?: string },
  positions: readonly (number | string | undefined)[],
  tables: Map<string, Table>,
): Table | undefined {
  return readsTable(positions, spec.textField) ? tableFor(spec.data, tables) : undefined;
}

function tableFor(name: string | undefined, tables: Map<string, Table>): Table {
  if (name !== undefined) {
    const found = tables.get(name);
    if (!found)
      throw new Error(`data: no table "${name}" in spec.data; name one of ${names(tables)}`);
    return found;
  }
  if (tables.size === 0) throw new Error("data: the spec has no tables; add one to spec.data");
  if (tables.size > 1)
    throw new Error(`data: missing; the spec has several tables, so name one of ${names(tables)}`);
  return tables.values().next().value!;
}
