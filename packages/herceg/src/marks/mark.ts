import type { FieldKind } from "../data/column.ts";
import type { Schema, Table } from "../data/table.ts";
import type { Polyline } from "../lod/polyline.ts";
import type { ContinuousScale } from "../scale/scale.ts";
import type { MarkGeometry, Rect } from "../scene/scene.ts";
import type { MarkSpec } from "../spec/spec.ts";
import type { Theme } from "../theme.ts";
import { groupRows, isSortedSubset, type Series, TableCache } from "./series.ts";

/**
 * Identifies a mark within a chart: its explicit `id`, or its index. Series
 * keys combine it with the series' source as JSON, so no pair of mark and
 * series names can produce the same key.
 */
export type MarkKey = string | number;

export function seriesKey(mark: MarkKey, source: string): string {
  return JSON.stringify([mark, source]);
}

/**
 * Color for a series key. A chart assigns each key a palette slot the first
 * time it appears and keeps it, so colors follow series, not their order.
 */
export type Palette = (seriesKey: string) => string;

/** Everything a mark needs to produce geometry for one frame. */
export interface Frame {
  x: ContinuousScale;
  y: ContinuousScale;
  plot: Rect;
  pixelRatio: number;
  theme: Theme;
  hidden: ReadonlySet<string>;
  /**
   * A polyline buffer reused across frames, one per series key and stage
   * (for example "line", "upper", "upper-step").
   */
  polyline(seriesKey: string, stage: string): Polyline;
}

/**
 * A mark draws one visual layer. It pairs a portable spec with the table it
 * reads (if any) and holds caches that depend only on the data, so the same
 * mark can be shown by several charts.
 */
export interface Mark<S extends MarkSpec = MarkSpec> {
  readonly spec: S;
  readonly table: Table | undefined;
  /** Kind of the x field, so the chart can pick a time or numeric x scale. */
  xKind(): FieldKind | undefined;
  /**
   * Resolves series for the current data. `key` prefixes series keys,
   * `palette` returns the color for a series key, and `hidden` holds keys of
   * series the user hid.
   */
  series(key: MarkKey, palette: Palette, hidden: ReadonlySet<string>): Series[];
  /** Include zero in the y domain. */
  readonly zero: boolean;
  /** x extent; with `log`, of positive values only. */
  xExtent(series: readonly Series[], log: boolean): readonly [number, number] | undefined;
  /** y extent of what the x range [x0, x1] shows; with `log`, of positive values only. */
  yExtent(
    series: readonly Series[],
    x0: number,
    x1: number,
    log: boolean,
  ): readonly [number, number] | undefined;
  geometry(series: readonly Series[], frame: Frame): MarkGeometry[];
}

export function requireField(
  table: Table,
  field: string,
  kinds: readonly FieldKind[],
  role: string,
): void {
  if (!table.has(field)) {
    throw new Error(
      `Unknown field "${field}" for ${role}; the table has ${table
        .fields()
        .map((f) => `"${f}"`)
        .join(", ")}`,
    );
  }
  const kind = table.kind(field);
  if (!kinds.includes(kind))
    throw new TypeError(`Field "${field}" is ${kind}; ${role} needs ${kinds.join(" or ")}`);
}

export const NUMERIC: readonly FieldKind[] = ["number", "time"];
export const CATEGORY: readonly FieldKind[] = ["category"];

/** One y column per series before colors and keys are assigned. */
export interface SeriesSource {
  id: string;
  label: string;
  y: string;
  rows: Uint32Array | undefined;
  /** x ascends over the source's rows. */
  sorted: boolean;
}

/**
 * Splits a table into series sources: one per y field, or one per category of
 * the `series` field. Cached until the table changes.
 */
export class SeriesSplitter {
  readonly table: Table<Schema>;
  readonly xField: string;
  readonly yFields: readonly string[];
  readonly seriesField: string | undefined;
  readonly label: string | undefined;
  readonly #cache = new TableCache<SeriesSource[]>();

  constructor(
    table: Table<Schema>,
    xField: string,
    yFields: readonly string[],
    seriesField: string | undefined,
    label: string | undefined,
  ) {
    this.table = table;
    this.xField = xField;
    this.yFields = yFields;
    this.seriesField = seriesField;
    this.label = label;
    if (seriesField !== undefined && yFields.length > 1) {
      throw new Error("Use either several y fields or a series field, not both");
    }
  }

  sources(): SeriesSource[] {
    return this.#cache.get(this.table, () => {
      const field = this.seriesField;
      if (field === undefined) {
        const sorted = this.table.isSorted(this.xField as never);
        return this.yFields.map((y) => ({
          id: y,
          label: this.yFields.length === 1 ? (this.label ?? y) : y,
          y,
          rows: undefined,
          sorted,
        }));
      }
      const x = this.table.numbers(this.xField as never);
      const { codes, dictionary } = this.table.categories(field as never);
      const groups = groupRows(codes, dictionary.length);
      // Categories with no remaining rows (for example after a rolling
      // window moved past them) produce no series.
      return dictionary.flatMap((name, code) => {
        const rows = groups[code]!;
        if (rows.length === 0) return [];
        return [
          { id: name, label: name, y: this.yFields[0]!, rows, sorted: isSortedSubset(x, rows) },
        ];
      });
    });
  }
}

/** Builds series from sources: keys, colors, sortedness, column views. */
export function buildSeries(
  table: Table<Schema>,
  sources: readonly SeriesSource[],
  xField: string,
  key: MarkKey,
  palette: Palette,
  stroke: string | undefined,
): Series[] {
  const x = table.numbers(xField as never);
  return sources.map((source) => {
    const y = table.numbers(source.y as never);
    const length = source.rows?.length ?? x.length;
    const id = seriesKey(key, source.id);
    return {
      key: id,
      label: source.label,
      color: stroke ?? palette(id),
      x,
      y,
      y0: undefined,
      values: y,
      range: false,
      rows: source.rows,
      length,
      sorted: source.sorted,
    };
  });
}
