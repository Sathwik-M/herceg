// Small multiples: a chart drawn once per value of a category field, each
// panel showing the rows with that value. A chart's `facet` option holds a
// Facet; charts without one never load this module. Panels split series
// without copying data: a panel's series is the same columns read through a
// list of the rows in that panel.

import type { Table } from "../data/table.ts";
import type { Mark } from "../marks/mark.ts";
import { rowOf, type Series } from "../marks/series.ts";
import type { MarkSeries } from "./inspect.ts";

export interface FacetOptions {
  /** Panels per row; by default about as many columns as rows. */
  columns?: number;
}

/**
 * Small multiples by the values of a category field, for a chart's `facet`
 * option. Marks over a table split its rows by the field unless they have
 * `facet: "repeat"`; marks without a table repeat in every panel.
 *
 * ```ts
 * createChart(element, { marks: [line(sales, { x: "week", y: "units" })], facet: facet("region") });
 * ```
 */
export function facet(field: string, options: FacetOptions = {}): Facet {
  return new Facet(field, options.columns);
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
  readonly field: string;
  readonly columns: number | undefined;

  constructor(field: string, columns?: number) {
    if (columns !== undefined && !(Number.isInteger(columns) && columns >= 1))
      throw new RangeError(`Facet columns must be a whole number of at least 1, not ${columns}`);
    this.field = field;
    this.columns = columns;
  }

  /** Rejects marks that cannot be split by the field, or that panels cannot draw yet. */
  check(marks: readonly Mark[]): void {
    const { field } = this;
    for (const mark of marks) {
      const { type } = mark.spec;
      if (mark.spec.axis === "right")
        throw new Error("Charts with facets cannot use the right axis yet");
      if (!mark.table || mark.spec.facet === "repeat") continue;
      const repeat = `give it facet: "repeat" to draw it whole in every panel`;
      if (!mark.table.has(field))
        throw new Error(
          `A ${type} mark's table has no field "${field}" to split into panels; ${repeat}`,
        );
      const kind = mark.table.kind(field);
      if (kind !== "category")
        throw new TypeError(`Facet field "${field}" is ${kind}; panels need a category field`);
      if (UNSPLIT.has(type))
        throw new Error(`A ${type} mark over a table cannot be split into panels yet; ${repeat}`);
      if (type === "bar" && (mark.spec as { stack?: boolean }).stack)
        throw new Error(`Stacked bars cannot be split into panels yet; ${repeat}`);
    }
  }

  /** Splits one chart's series into panels, keeping splits from one scene to the next. */
  splitter(): Splitter {
    return new Splitter(this.field);
  }
}

/** The panels of a scene: their keys, each one's marks and series, and every mark's across panels. */
export interface PanelSplit {
  keys: string[];
  panels: MarkSeries[][];
  /** Each mark's series in all panels; marks that repeat, once. */
  all: MarkSeries[];
}

/** A table's facet codes in order of first appearance, as of a version. */
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
  panels: readonly string[];
  byPanel: { rows: Uint32Array; sorted: boolean }[];
}

export class Splitter {
  readonly field: string;
  /** Panel values, in order of first appearance across the split tables. */
  #panels: readonly string[] = [];
  readonly #appearance = new WeakMap<Table, Appearance>();
  readonly #splits = new Map<string, Split>();

  constructor(field: string) {
    this.field = field;
  }

  /**
   * A panel per facet value, in which marks over a table draw the rows with
   * that value and other marks repeat. Rows without a value are in no panel;
   * with no values at all, there is one empty panel.
   */
  split(base: readonly MarkSeries[]): PanelSplit {
    const splits = (mark: Mark) => mark.table !== undefined && mark.spec.facet !== "repeat";
    this.#update(new Set(base.filter(({ mark }) => splits(mark)).map(({ mark }) => mark.table!)));
    const keys = this.#panels.length > 0 ? [...this.#panels] : [""];
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
    return { keys, panels, all };
  }

  #categories(table: Table) {
    return table.categories(this.field as never);
  }

  /** Finds the panels of the tables' current rows, keeping the list while it is unchanged. */
  #update(tables: Iterable<Table>): void {
    const seen = new Set<string>();
    const panels: string[] = [];
    for (const table of tables) {
      const { dictionary } = this.#categories(table);
      for (const code of this.#order(table)) {
        const value = dictionary[code]!;
        if (seen.has(value)) continue;
        seen.add(value);
        panels.push(value);
      }
    }
    const same =
      panels.length === this.#panels.length &&
      panels.every((value, i) => value === this.#panels[i]);
    if (!same) this.#panels = panels;
  }

  /** The codes a table's rows use, in order of first appearance. */
  #order(table: Table): number[] {
    const cached = this.#appearance.get(table);
    if (cached?.version === table.version) return cached.codes;
    const { codes, dictionary } = this.#categories(table);
    const seen = new Uint8Array(dictionary.length);
    const order: number[] = [];
    for (let row = 0; row < codes.length && order.length < dictionary.length; row++) {
      const code = codes[row]!;
      if (code < 0 || seen[code]) continue;
      seen[code] = 1;
      order.push(code);
    }
    this.#appearance.set(table, { version: table.version, codes: order });
    return order;
  }

  /** One series per panel holding the rows of `s` with that panel's value. */
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
    const { codes, dictionary } = this.#categories(table);
    const index = new Map(this.#panels.map((value, i) => [value, i]));
    const panelOf = Int32Array.from(dictionary, (value) => index.get(value) ?? -1);
    const sizes = new Uint32Array(this.#panels.length);
    for (let k = 0; k < s.length; k++) {
      const code = codes[rowOf(s, k)]!;
      if (code >= 0 && panelOf[code]! >= 0) sizes[panelOf[code]!]!++;
    }
    const byPanel = Array.from(sizes, (size) => ({
      rows: new Uint32Array(size),
      sorted: true,
      filled: 0,
      last: Number.NEGATIVE_INFINITY,
    }));
    for (let k = 0; k < s.length; k++) {
      const row = rowOf(s, k);
      const code = codes[row]!;
      const panel = code >= 0 ? byPanel[panelOf[code]!] : undefined;
      if (!panel) continue;
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
