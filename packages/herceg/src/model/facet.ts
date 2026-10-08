// Small multiples: a chart drawn once per value of a category field, or per
// pair of values of two, each panel showing the rows with its values. A
// chart's `facet` option holds a
// Facet; charts without one never load this module. Panels split series
// without copying data: a panel's series is the same columns read through a
// list of the rows in that panel.

import type { Table } from "../data/table.ts";
import type { Mark } from "../marks/mark.ts";
import { rowOf, type Series } from "../marks/series.ts";
import type { Rect, SceneText } from "../scene/scene.ts";
import type { FacetSpec } from "../spec/spec.ts";
import type { MarkSeries } from "./inspect.ts";

export interface FacetOptions {
  /** Panels per row; by default about as many columns as rows. */
  columns?: number;
}

/** Panels in a grid: a row per value of `row` and a column per value of `column`. */
export interface FacetGrid {
  row?: string;
  column?: string;
}

/**
 * Small multiples by the values of category fields, for a chart's `facet`
 * option: one field's values wrapped into rows of panels, or a grid with a
 * row per value of one field and a column per value of another. Marks over
 * a table split its rows by the fields unless they have `facet: "repeat"`;
 * marks without a table repeat in every panel.
 *
 * ```ts
 * createChart(element, { marks: [line(sales, { x: "week", y: "units" })], facet: facet("region") });
 * createChart(element, { marks, facet: facet({ row: "region", column: "product" }) });
 * ```
 */
export function facet(field: string, options?: FacetOptions): Facet;
export function facet(grid: FacetGrid): Facet;
export function facet(by: string | FacetGrid, options: FacetOptions = {}): Facet {
  if (typeof by !== "string") return new Facet(by);
  return new Facet(options.columns === undefined ? { field: by } : { field: by, ...options });
}

/** Marks that cannot split their rows into panels yet; they can repeat in every panel. */
const UNSPLIT = new Set([
  "heatmap",
  "histogram",
  "boxplot",
  "violin",
  "rule",
  "region",
  "text",
  "custom",
]);

export class Facet {
  /** The field whose values wrap into rows of `columns` panels. */
  readonly field: string | undefined;
  readonly columns: number | undefined;
  /** The fields of a grid's rows and columns. */
  readonly row: string | undefined;
  readonly column: string | undefined;

  constructor(spec: FacetSpec) {
    if ("field" in spec) {
      const { columns } = spec;
      if (columns !== undefined && !(Number.isInteger(columns) && columns >= 1))
        throw new RangeError(`Facet columns must be a whole number of at least 1, not ${columns}`);
      if ("row" in spec || "column" in spec)
        throw new TypeError("A facet has a field to wrap, or row and column fields, not both");
      this.field = spec.field;
      this.columns = columns;
      return;
    }
    const { row, column } = spec;
    if ("columns" in spec)
      throw new TypeError(
        "A grid of facets has a column per value of its column field, not columns",
      );
    if (row === undefined && column === undefined)
      throw new TypeError("A facet needs a field, or a row or column field");
    if (row !== undefined && row === column)
      throw new TypeError(`A facet's row and column fields must differ, not both "${row}"`);
    this.row = row;
    this.column = column;
  }

  /** The fields that split rows into panels: the wrapped one, or the row's then the column's. */
  get fields(): string[] {
    if (this.field !== undefined) return [this.field];
    return [this.row, this.column].filter((field) => field !== undefined);
  }

  /** Rejects marks that cannot be split by the fields, or that panels cannot draw yet. */
  check(marks: readonly Mark[]): void {
    for (const mark of marks) {
      const { type } = mark.spec;
      if (mark.spec.axis === "right")
        throw new Error("Charts with facets cannot use the right axis yet");
      if (!mark.table || mark.spec.facet === "repeat") continue;
      const repeat = `give it facet: "repeat" to draw it whole in every panel`;
      for (const field of this.fields) {
        if (!mark.table.has(field))
          throw new Error(
            `A ${type} mark's table has no field "${field}" to split into panels; ${repeat}`,
          );
        const kind = mark.table.kind(field);
        if (kind !== "category")
          throw new TypeError(`Facet field "${field}" is ${kind}; panels need a category field`);
      }
      if (UNSPLIT.has(type))
        throw new Error(`A ${type} mark over a table cannot be split into panels yet; ${repeat}`);
      if (type === "bar" && (mark.spec as { stack?: boolean }).stack)
        throw new Error(`Stacked bars cannot be split into panels yet; ${repeat}`);
    }
  }

  /** Splits one chart's series into panels, keeping splits from one scene to the next. */
  splitter(): Splitter {
    return new Splitter(this.fields, (counts) => this.shape(counts));
  }

  /**
   * Rows and columns of panels for fields with `counts` values each: one
   * field's panels wrapped, or a row per value of the row field and a column
   * per value of the column field. Without values, one empty panel.
   */
  shape(counts: readonly number[]): { rows: number; columns: number } {
    if (counts.some((count) => count === 0)) return { rows: 1, columns: 1 };
    if (this.field !== undefined) {
      const count = counts[0]!;
      const columns = Math.min(count, this.columns ?? Math.ceil(Math.sqrt(count)));
      return { rows: Math.ceil(count / columns), columns };
    }
    return {
      rows: this.row !== undefined ? counts[0]! : 1,
      columns: this.column !== undefined ? counts.at(-1)! : 1,
    };
  }

  /** How a split's panels are placed, with headers a line of text tall. */
  grid(split: PanelSplit, lineHeight: number): PanelGrid {
    const { rows, columns } = this.shape(split.dimensions.map((values) => values.length));
    const header = lineHeight + 4;
    const wrapped = this.field !== undefined;
    return {
      columns,
      rows,
      header: wrapped ? header : 0,
      columnHeader: !wrapped && this.column !== undefined ? header : 0,
      rowHeader: !wrapped && this.row !== undefined ? header : 0,
    };
  }

  /**
   * The headers a panel with `values` at `plot` carries: its values above it
   * when wrapped; in a grid, its column's value above the top row and its
   * row's beside the last column, reading top to bottom.
   */
  headers(
    values: readonly string[],
    row: number,
    column: number,
    plot: Rect,
    grid: PanelGrid,
    fit: (text: string, room: number) => string,
  ): SceneText[] {
    const out: SceneText[] = [];
    // The one panel of a facet without values has nothing to name.
    if (values.length === 0) return out;
    const { header, columnHeader, rowHeader } = grid;
    if (header) {
      const text = fit(values.join(", "), plot.width);
      out.push({ text, x: plot.x, y: plot.y - header / 2, anchor: "start", angle: 0 });
    }
    if (columnHeader && row === 0) {
      const text = fit(values.at(-1)!, plot.width);
      const x = plot.x + plot.width / 2;
      out.push({ text, x, y: plot.y - columnHeader / 2, anchor: "middle", angle: 0 });
    }
    if (rowHeader && column === grid.columns - 1) {
      const text = fit(values[0]!, plot.height);
      const x = plot.x + plot.width + rowHeader / 2 + 4;
      out.push({ text, x, y: plot.y + plot.height / 2, anchor: "middle", angle: 90 });
    }
    return out;
  }

  /** A sentence naming the fields and, up to `max`, the panels by their labels. */
  describe(labels: readonly string[], max: number): string {
    const { field, row, column } = this;
    const by =
      field ??
      [row && `${row} in rows`, column && `${column} in columns`].filter(Boolean).join(" and ");
    // Grid panels are named by both values, so they are listed apart.
    const named = labels.slice(0, max).join(field === undefined ? "; " : ", ");
    const more = labels.length > max ? `, and ${labels.length - max} more` : "";
    return `Panels by ${by}: ${named}${more}.`;
  }
}

/** Where a chart's panels go: a grid of `columns` by `rows`, and the room headers take. */
export interface PanelGrid {
  columns: number;
  rows: number;
  /** Above every panel, for wrapped panels. */
  header: number;
  /** Above the top row and beside the last column, for a grid's columns and rows. */
  columnHeader: number;
  rowHeader: number;
}

/** The panels of a scene: their keys, each one's marks and series, and every mark's across panels. */
export interface PanelSplit {
  keys: string[];
  /** Each panel's value of each field that splits rows, in the facet's field order. */
  values: string[][];
  /** Each field's values in order of first appearance: a grid's rows, then its columns. */
  dimensions: string[][];
  panels: MarkSeries[][];
  /** Each mark's series in all panels; marks that repeat, once. */
  all: MarkSeries[];
}

/** A table's codes of a field in order of first appearance, as of a version. */
interface Appearance {
  version: number;
  codes: number[];
}

/** A series' rows split by panel, as of a table version, its rows and x, and the panel list. */
interface Split {
  table: Table;
  version: number;
  rows: Uint32Array | undefined;
  /** The x column, which decides whether each panel's rows are sorted. */
  x: Series["x"];
  panels: readonly PanelValues[];
  byPanel: { rows: Uint32Array; sorted: boolean }[];
}

/** A field's codes per row, and each code's panel offset (-1 for none). */
interface Place {
  codes: ArrayLike<number>;
  place: Int32Array;
}

/** Sees a split's rows and columns of panels, and throws if the chart cannot draw them. */
export type PanelCheck = (shape: { rows: number; columns: number }, panels: number) => void;

/** A panel: its key, and its value of each field that splits rows. */
interface PanelValues {
  key: string;
  values: string[];
}

export class Splitter {
  readonly fields: readonly string[];
  readonly #shape: (counts: readonly number[]) => { rows: number; columns: number };
  /** Each field's values, in order of first appearance across the split tables. */
  #dimensions: string[][];
  /** Every combination of the fields' values, rows by columns. */
  #panels: readonly PanelValues[] = [];
  readonly #appearance = new WeakMap<Table, Map<string, Appearance>>();
  readonly #splits = new Map<string, Split>();

  constructor(
    fields: readonly string[],
    shape: (counts: readonly number[]) => { rows: number; columns: number },
  ) {
    this.fields = fields;
    this.#shape = shape;
    this.#dimensions = fields.map(() => []);
  }

  /**
   * A panel per facet value, or per pair of values of two fields, in which
   * marks over a table draw the rows with those values and other marks
   * repeat. Rows without a value are in no panel; with no values at all,
   * there is one empty panel.
   */
  split(base: readonly MarkSeries[], check: PanelCheck): PanelSplit {
    const splits = (mark: Mark) => mark.table !== undefined && mark.spec.facet !== "repeat";
    const tables = new Set(base.filter(({ mark }) => splits(mark)).map(({ mark }) => mark.table!));
    this.#update(tables, check);
    const empty = this.#panels.length === 0;
    const keys = empty ? [""] : this.#panels.map(({ key }) => key);
    const values = empty ? [[]] : this.#panels.map(({ values }) => values);
    const used = new Set<string>();
    // Per mark, each series' panel parts; undefined for marks that repeat.
    const parts = base.map(({ mark, series }) => {
      if (!splits(mark)) return undefined;
      return series.map((s) => {
        used.add(s.key);
        return this.#split(s, mark.table!);
      });
    });
    for (const key of this.#splits.keys()) if (!used.has(key)) this.#splits.delete(key);
    const panels = keys.map((_, p) =>
      base.map(({ mark, series }, i) => ({
        mark,
        series: parts[i] ? parts[i].flatMap((byPanel) => byPanel[p] ?? []) : series,
      })),
    );
    const all = base.map(({ mark, series }, i) => ({
      mark,
      series: parts[i] ? parts[i].flat() : series,
    }));
    return { keys, values, dimensions: this.#dimensions.map((d) => [...d]), panels, all };
  }

  /**
   * Finds each field's values in the tables' current rows, keeping the
   * panels while they are unchanged. `check` sees their shape first, and
   * may refuse it before they are listed.
   */
  #update(tables: Iterable<Table>, check: PanelCheck): void {
    const list = [...tables];
    let changed = false;
    const dimensions = this.fields.map((field, f) => {
      const seen = new Set<string>();
      const values: string[] = [];
      for (const table of list) {
        const { dictionary } = table.categories(field as never);
        for (const code of this.#order(table, field)) {
          const value = dictionary[code]!;
          if (seen.has(value)) continue;
          seen.add(value);
          values.push(value);
        }
      }
      const before = this.#dimensions[f]!;
      if (values.length !== before.length || values.some((value, i) => value !== before[i]))
        changed = true;
      return values;
    });
    const count = dimensions.reduce((product, values) => product * values.length, 1);
    check(this.#shape(dimensions.map((values) => values.length)), count);
    if (!changed) return;
    this.#dimensions = dimensions;
    // Rows, then columns: the last field varies fastest. One field's panels
    // are keyed by its values; pairs by both, unambiguously.
    let panels: PanelValues[] = [{ key: "", values: [] }];
    for (const values of dimensions)
      panels = panels.flatMap((panel) =>
        values.map((value) => ({ key: "", values: [...panel.values, value] })),
      );
    for (const panel of panels)
      panel.key = panel.values.length === 1 ? panel.values[0]! : JSON.stringify(panel.values);
    this.#panels = dimensions.some((values) => values.length === 0) ? [] : panels;
  }

  /** The codes of a field a table's rows use, in order of first appearance. */
  #order(table: Table, field: string): number[] {
    let byField = this.#appearance.get(table);
    if (!byField) {
      byField = new Map();
      this.#appearance.set(table, byField);
    }
    const cached = byField.get(field);
    if (cached?.version === table.version) return cached.codes;
    const { codes, dictionary } = table.categories(field as never);
    const seen = new Uint8Array(dictionary.length);
    const order: number[] = [];
    for (let row = 0; row < codes.length && order.length < dictionary.length; row++) {
      const code = codes[row]!;
      if (code < 0 || seen[code]) continue;
      seen[code] = 1;
      order.push(code);
    }
    byField.set(field, { version: table.version, codes: order });
    return order;
  }

  /** One series per panel holding the rows of `s` with that panel's values. */
  #split(s: Series, table: Table): Series[] {
    let split = this.#splits.get(s.key);
    if (
      !split ||
      split.table !== table ||
      split.version !== table.version ||
      split.rows !== s.rows ||
      split.x !== s.x ||
      split.panels !== this.#panels
    ) {
      split = {
        table,
        version: table.version,
        rows: s.rows,
        x: s.x,
        panels: this.#panels,
        byPanel: this.#bucket(s, table),
      };
      this.#splits.set(s.key, split);
    }
    return split.byPanel.map(({ rows, sorted }) => ({ ...s, rows, length: rows.length, sorted }));
  }

  /** The rows of `s` by panel, in series order, and whether each panel's x is ascending. */
  #bucket(s: Series, table: Table): { rows: Uint32Array; sorted: boolean }[] {
    // Per field, each code's value's place among the field's values times
    // the field's stride: the last field varies fastest, as panels are listed.
    const places = this.fields.map((field, f) => {
      const { codes, dictionary } = table.categories(field as never);
      const index = new Map(this.#dimensions[f]!.map((value, i) => [value, i]));
      const stride = this.#dimensions
        .slice(f + 1)
        .reduce((product, values) => product * values.length, 1);
      const place = Int32Array.from(dictionary, (value) => {
        const at = index.get(value);
        return at === undefined ? -1 : at * stride;
      });
      return { codes, place };
    });
    // Each row's panel, found once: this runs for every row of every split
    // series whenever its table changes, so one field's lookup is kept apart
    // from two fields'.
    const [first, second] = places as unknown as [Place, Place | undefined];
    const panelAt = new Int32Array(s.length);
    const { codes: a, place: placeA } = first;
    if (!second) {
      for (let k = 0; k < s.length; k++) {
        const code = a[rowOf(s, k)]!;
        panelAt[k] = code >= 0 ? placeA[code]! : -1;
      }
    } else {
      const { codes: b, place: placeB } = second;
      for (let k = 0; k < s.length; k++) {
        const row = rowOf(s, k);
        const [codeA, codeB] = [a[row]!, b[row]!];
        const pa = codeA >= 0 ? placeA[codeA]! : -1;
        const pb = codeB >= 0 ? placeB[codeB]! : -1;
        panelAt[k] = pa >= 0 && pb >= 0 ? pa + pb : -1;
      }
    }
    const sizes = new Uint32Array(this.#panels.length);
    for (let k = 0; k < s.length; k++) {
      const panel = panelAt[k]!;
      if (panel >= 0) sizes[panel]!++;
    }
    const byPanel = Array.from(sizes, (size) => ({
      rows: new Uint32Array(size),
      sorted: true,
      filled: 0,
      last: Number.NEGATIVE_INFINITY,
    }));
    for (let k = 0; k < s.length; k++) {
      const at = panelAt[k]!;
      if (at < 0) continue;
      const panel = byPanel[at]!;
      const row = rowOf(s, k);
      panel.rows[panel.filled++] = row;
      // A subset of an unsorted series may still be sorted (rows grouped by
      // panel); as in isSortedSubset, a missing x leaves it unsorted.
      const x = s.x[row]!;
      if (!(x >= panel.last)) panel.sorted = false;
      panel.last = x;
    }
    return byPanel.map(({ rows, sorted }) => ({ rows, sorted: s.sorted || sorted }));
  }
}
