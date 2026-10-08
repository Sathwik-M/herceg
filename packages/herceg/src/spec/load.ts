// Turns a portable chart specification into a chart configuration: tables
// from `data`, marks from `marks`. This is how charts built outside
// TypeScript (the Python package, saved specs) reach the engine.

import { type ColumnInput, encodedCategory, type NumericArray, time } from "../data/column.ts";
import { deriveTable } from "../data/derive.ts";
import { type Table, table } from "../data/table.ts";
import { readsTable } from "../marks/annotation.ts";
import { AreaMark } from "../marks/area.ts";
import { BarMark } from "../marks/bar.ts";
import { BoxPlotMark } from "../marks/boxplot.ts";
import { CandlestickMark } from "../marks/candlestick.ts";
import { ErrorBarMark } from "../marks/errorbar.ts";
import { FunnelMark } from "../marks/funnel.ts";
import { GaugeMark } from "../marks/gauge.ts";
import { HeatmapMark } from "../marks/heatmap.ts";
import { HistogramMark } from "../marks/histogram.ts";
import type { LayoutMark } from "../marks/layout-mark.ts";
import { LineMark } from "../marks/line.ts";
import type { Mark } from "../marks/mark.ts";
import { PieMark } from "../marks/pie.ts";
import { PointMark } from "../marks/point.ts";
import { RadarMark } from "../marks/radar.ts";
import { RegionMark } from "../marks/region.ts";
import { RuleMark } from "../marks/rule.ts";
import { SunburstMark } from "../marks/sunburst.ts";
import { TextMark } from "../marks/text.ts";
import { TreemapMark } from "../marks/treemap.ts";
import { ViolinMark } from "../marks/violin.ts";
import { Facet } from "../model/facet.ts";
import type { ChartConfig } from "../model/model.ts";
import { scheme } from "../scale/schemes.ts";
import {
  type BinaryType,
  type ChartSpec,
  type ColumnSpec,
  type ColumnsSpec,
  type DataSpec,
  type MarkSpec,
  SPEC_VERSION,
} from "./spec.ts";
import { validateSpec } from "./validate.ts";

/** Bytes of a binary column: an ArrayBuffer, or a view such as a Uint8Array or DataView. */
export type SpecBuffer = ArrayBuffer | ArrayBufferView;

export interface LoadedSpec {
  /** Chart options with marks, ready for `createChart` or `renderToSVG`. */
  config: ChartConfig & { width?: number; height?: number };
  /** The spec's tables by name; changing them updates charts built from the spec. */
  tables: Map<string, Table>;
}

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
 * column, or mark.
 */
export function loadSpec(spec: ChartSpec, buffers: readonly SpecBuffer[] = []): LoadedSpec {
  if (spec?.version !== undefined && spec.version !== 1 && spec.version !== SPEC_VERSION) {
    throw new Error(
      `Unsupported spec version ${spec.version}; this herceg reads versions 1 to ${SPEC_VERSION}`,
    );
  }
  // An older reader would draw shared axes; a spec asking otherwise says so.
  if (spec.resolve !== undefined && spec.version !== 2)
    throw new Error('"resolve" needs "version": 2, so that older readers refuse the spec');
  validateSpec(spec);
  const tables = loadTables(spec.data ?? {}, buffers);
  const marks = spec.marks.map((mark, index) => loadMark(mark, index, tables));
  const { data: _data, marks: _marks, version: _version, facet: panels, ...options } = spec;
  const facet = panels && new Facet(panels);
  return { config: { ...options, marks, ...(facet && { facet }) }, tables };
}

/** Every table of the spec; derived tables after the tables they derive from. */
function loadTables(
  data: Record<string, DataSpec>,
  buffers: readonly SpecBuffer[],
): Map<string, Table> {
  const tables = new Map<string, Table>();
  const loading = new Set<string>();
  const load = (name: string): Table => {
    const done = tables.get(name);
    if (done) return done;
    const entry = data[name];
    if (!entry) throw new Error(`Unknown table "${name}"`);
    if (!("source" in entry)) {
      const loaded = loadTable(name, entry, buffers);
      tables.set(name, loaded);
      return loaded;
    }
    if (loading.has(name)) throw new Error(`Table "${name}" derives from itself`);
    loading.add(name);
    if (!Object.hasOwn(data, entry.source))
      throw new Error(`Table "${name}" derives from unknown table "${entry.source}"`);
    const source = load(entry.source);
    let derived: Table;
    try {
      derived = deriveTable(source, entry.transform, { name });
    } catch (error) {
      throw new Error(`Table "${name}": ${(error as Error).message}`);
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
      throw new Error(`Column "${field}" of table "${name}": ${(error as Error).message}`);
    }
  }
  try {
    return table(columns, { name });
  } catch (error) {
    throw new Error(`Table "${name}": ${(error as Error).message}`);
  }
}

function loadColumn(column: ColumnSpec, buffers: readonly SpecBuffer[]): ColumnInput {
  if (Array.isArray(column)) return inlineValues(column);
  if (typeof column !== "object" || column === null) {
    throw new TypeError("expected an array of values or a column object");
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
        throw new TypeError("a category dictionary must be an array of strings");
      }
      const codes =
        typeof column.codes === "number"
          ? (binary("int32", column.codes, buffers) as Int32Array)
          : inlineCodes(column.codes, column.dictionary.length);
      return encodedCategory(codes, column.dictionary);
    }
    default:
      throw new TypeError(
        `Unknown column type ${JSON.stringify((column as { type: unknown }).type)}`,
      );
  }
}

/** A JSON array: numbers (null for missing) or strings (null for missing), not a mix. */
function inlineValues(values: unknown[]): ColumnInput {
  let kind: "number" | "string" | undefined;
  values.forEach((value, row) => {
    if (value === null) return;
    const type = typeof value;
    if (type !== "number" && type !== "string") {
      throw new TypeError(
        `row ${row} holds ${JSON.stringify(value)}; expected a number, string, or null`,
      );
    }
    kind ??= type;
    if (type !== kind) throw new TypeError(`row ${row} mixes ${type}s into a column of ${kind}s`);
  });
  return values as ColumnInput;
}

function timeValues(values: unknown): number[] {
  if (!Array.isArray(values)) throw new TypeError("time values must be an array");
  return values.map((value, row) => {
    if (value === null) return Number.NaN;
    const time = typeof value === "string" ? Date.parse(value) : value;
    if (typeof time !== "number" || Number.isNaN(time)) {
      throw new TypeError(`row ${row} holds ${JSON.stringify(value)}, not a time`);
    }
    return time;
  });
}

function inlineCodes(codes: unknown, size: number): Int32Array {
  if (!Array.isArray(codes))
    throw new TypeError("category codes must be a buffer index or an array");
  return Int32Array.from(codes, (code, row) => {
    if (!Number.isInteger(code) || code < -1 || code >= size) {
      throw new RangeError(`row ${row} holds code ${JSON.stringify(code)}, outside the dictionary`);
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
  if (!Typed) throw new TypeError(`Unknown binary type ${JSON.stringify(dtype)}`);
  if (!Number.isInteger(index) || index < 0) {
    throw new TypeError(`buffer must be a buffer index, got ${JSON.stringify(index)}`);
  }
  const source = buffers[index];
  if (source === undefined)
    throw new RangeError(`Buffer ${index} is missing (${buffers.length} delivered)`);
  const bytes = ArrayBuffer.isView(source)
    ? new Uint8Array(source.buffer as ArrayBuffer, source.byteOffset, source.byteLength)
    : new Uint8Array(source);
  const size = Typed.BYTES_PER_ELEMENT;
  if (bytes.byteLength % size !== 0) {
    throw new RangeError(
      `Buffer ${index} has ${bytes.byteLength} bytes, not a whole number of ${dtype} values`,
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
      case "heatmap":
        return new HeatmapMark(withScheme(spec), source);
      case "errorbar":
        return new ErrorBarMark(spec, source);
      case "candlestick":
        return new CandlestickMark(spec, source);
      case "histogram":
        return new HistogramMark(spec, source);
      case "pie":
        return new PieMark(spec, source);
      case "boxplot":
        return new BoxPlotMark(spec, source);
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
      default:
        throw new TypeError(
          `unknown mark type ${JSON.stringify((spec as { type: unknown }).type)}`,
        );
    }
  } catch (error) {
    throw new Error(`Mark ${index} (${String(spec?.type)}): ${(error as Error).message}`);
  }
}

/** A mark's spec with a named color scheme replaced by the scheme's colors. */
function withScheme<T extends { colors?: string | string[] | undefined }>(spec: T): T {
  return typeof spec.colors === "string" ? { ...spec, colors: [...scheme(spec.colors)] } : spec;
}

function annotationTable(
  spec: { data?: string; text?: string },
  positions: readonly (number | string | undefined)[],
  tables: Map<string, Table>,
): Table | undefined {
  return readsTable(positions, spec.text) ? tableFor(spec.data, tables) : undefined;
}

function tableFor(name: string | undefined, tables: Map<string, Table>): Table {
  if (name !== undefined) {
    const found = tables.get(name);
    if (!found) throw new Error(`no table named "${name}" in data`);
    return found;
  }
  if (tables.size !== 1) {
    throw new Error(
      `set \`data\` to one of ${[...tables.keys()].map((n) => `"${n}"`).join(", ") || "the spec's tables (none given)"}`,
    );
  }
  return tables.values().next().value!;
}
