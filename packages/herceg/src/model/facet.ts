// Small multiples: a chart drawn once per value of a category field, or per
// pair of values of two, each panel showing the rows with its values. A
// chart's `facet` option holds a
// Facet; charts without one never load this module. Panels split series
// without copying data: a panel's series is the same columns read through a
// list of the rows in that panel.

import type { NumericArray } from "../data/column.ts";
import type { Table } from "../data/table.ts";
import type { AxisOptions } from "../guides/options.ts";
import { type Align, aligned } from "../layout/place.ts";
import type { CustomSpec } from "../marks/custom.ts";
import type { LayoutMark } from "../marks/layout-mark.ts";
import { type BandContext, type Bands, type Mark, usesY } from "../marks/mark.ts";
import type { Series } from "../marks/series.ts";
import type { Rect } from "../scene/scene.ts";
import type { FacetSpec, ScaleScope } from "../spec/spec.ts";
import type { MarkSeries } from "./inspect.ts";
import {
  type AnnotatedPanel,
  across,
  annotations,
  checkBands,
  checkFit,
  checkLayouts,
  columnGap,
  type DescribeAnnotation,
  groups,
  groupsOf,
  type HeaderPlace,
  type LayoutConfig,
  leastHeight,
  type PanelAxis,
  PanelBands,
  type PanelChart,
  type PanelGrid,
  type PanelLayout,
  type PanelRoom,
  type PanelSplit,
  type RowSpace,
  rowGap,
  type ScaleGroups,
  trackSizes,
  typedGroups,
} from "./panel-layout.ts";
import { type ScaledConfig, type Scopes, scopesOf } from "./scales.ts";

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

/**
 * Marks that read their table's rows without series (annotations): panels
 * hand them the rows they draw (`MarkSeries.rows`).
 */
const ROWS = new Set(["rule", "region", "text"]);

export class Facet implements PanelLayout {
  columnGap(
    labeled: readonly boolean[],
    right: boolean,
    columns: number,
    room: number,
    title: number,
  ): number {
    return columnGap(labeled, right, columns, room, title);
  }

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
        throw new RangeError(
          `facet columns: expected a whole number of at least 1; received ${columns}`,
        );
      if ("row" in spec || "column" in spec)
        throw new TypeError("facet: a field to wrap, or row and column fields, not both; drop one");
      this.field = spec.field;
      this.columns = columns;
      return;
    }
    const { row, column } = spec;
    if ("columns" in spec)
      throw new TypeError(
        "facet columns: a grid of facets has a column per value of its column field; drop columns",
      );
    if (row === undefined && column === undefined)
      throw new TypeError("facet: needs a field, or a row or column field");
    if (row !== undefined && row === column)
      throw new TypeError(`facet column: "${row}" is the row field too; give two fields`);
    this.row = row;
    this.column = column;
  }

  /** The fields that split rows into panels: the wrapped one, or the row's then the column's. */
  get fields(): string[] {
    if (this.field !== undefined) return [this.field];
    return [this.row, this.column].filter((field) => field !== undefined);
  }

  /**
   * Rejects marks that cannot be split by the fields, panels cannot draw
   * yet, and a y zoom over panels with y scales of their own. A layout mark
   * has every panel to itself, splitting its rows; a map's layers are one
   * mark, each splitting its table's rows unless it repeats. Returns the
   * layout marks drawn.
   */
  check(
    marks: readonly Mark[],
    options: LayoutConfig = { marks: [] },
    layouts: readonly LayoutMark[] = [],
  ): LayoutMark[] {
    let drawn: LayoutMark[] = [];
    if (layouts[0]) {
      const { type } = layouts[0].spec;
      checkLayouts(layouts);
      drawn = layouts[0].views.inPanels(layouts, options, false);
      const [layout] = drawn as [LayoutMark];
      layout.views.interactions(drawn, options, false, type);
      if (drawn.length > 1 || marks.length > 0)
        throw new Error(
          `${type}: has each facet panel to itself; draw other marks in another chart`,
        );
      const parts = layout.layers ?? [layout];
      // A layer of a map may repeat instead (a base map).
      const remedy = layout.layers
        ? `; give it facet: "repeat" to draw it whole in every panel`
        : "";
      for (const { spec, table } of parts) {
        if (spec.facet === undefined) this.#splitting(spec.type, table!, remedy);
        else if (!layout.layers)
          throw new Error(
            `${spec.type} facet: the mark splits its rows into facet panels; drop facet`,
          );
      }
      if (parts.every(({ spec }) => spec.facet !== undefined))
        throw new Error(
          `${type} facet: every layer of the map repeats, so none splits into facet panels; drop facet from one`,
        );
    }
    const scopes = this.scopes(options);
    checkBands(marks, options, scopes);
    // A y zoom moves both y scales through the same pixels, so every panel must share each.
    const { zoom } = options.interaction ?? {};
    if (typeof zoom === "string" && zoom.includes("y")) {
      if (scopes.y !== "chart")
        throw new Error(
          'chart interaction.zoom: panels with y scales of their own cannot zoom along y yet; share y or zoom along "x"',
        );
      if (
        scopes.yRight !== "chart" &&
        marks.some((mark) => mark.spec.axis === "right" && usesY(mark))
      )
        throw new Error(
          `chart interaction.zoom: panels with right y scales of their own (yRight.scope "${scopes.yRight}") cannot zoom along y yet; share them or zoom along "x"`,
        );
    }
    for (const mark of marks) {
      const { type } = mark.spec;
      if (!mark.table || mark.spec.facet === "repeat") continue;
      const repeat = `give it facet: "repeat" to draw it whole in every panel`;
      // A tree's merges have no facet values to split by.
      if (type === "dendrogram")
        throw new Error(`dendrogram facet: merges cannot split into panels; ${repeat}`);
      this.#splitting(type, mark.table, `; ${repeat}`);
      // Custom marks split the rows of the series they show. Those without
      // series (which need one x field and y fields) have no rows to split:
      // their `draw` reads the table whole.
      if (type === "custom" && (mark.spec as CustomSpec).y === undefined)
        throw new Error(`custom facet: without series, it cannot split into panels; ${repeat}`);
    }
    return drawn;
  }

  /** Refuses a table a `type` mark reads that the fields cannot split; `remedy` ends the message. */
  #splitting(type: string, table: Table, remedy: string): void {
    for (const field of this.fields) {
      if (!table.has(field))
        throw new Error(`${type}: no field "${field}" to split into facet panels${remedy}`);
      const kind = table.kind(field);
      if (kind !== "category")
        throw new TypeError(`facet: field "${field}" holds ${kind} values; expected category`);
    }
  }

  /** Marks over a table split its rows, unless they repeat. */
  splits(mark: Mark): boolean {
    return mark.table !== undefined && mark.spec.facet !== "repeat";
  }

  /** Splits one chart's series into panels, keeping splits from one scene to the next. */
  splitter(): Splitter {
    return new Splitter(this, (counts) => this.shape(counts));
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

  scopes(config: ScaledConfig): Scopes {
    return scopesOf(config, "chart");
  }

  /** A grid's rows and columns are its fields' values; wrapped panels can be rearranged. */
  get remedy(): string {
    return this.field !== undefined
      ? "set the facet's columns"
      : "facet by fields with fewer values";
  }

  panelAxis(
    _axis: PanelAxis,
    _index: number,
    chart: AxisOptions | undefined,
  ): AxisOptions | undefined {
    return chart;
  }

  rowGap(grid: PanelGrid, panels: number, space: RowSpace): number {
    return rowGap(grid, panels, space);
  }

  tracks(
    free: number,
    count: number,
    weights: readonly number[] | undefined,
    panels: number,
    columns: number,
    room: PanelRoom,
  ): number[] {
    return trackSizes(free, count, weights, panels, columns, room, this.remedy);
  }

  /** Every panel's axes are the chart's, and draw every mark. */
  groups(
    scope: ScaleScope,
    split: PanelSplit,
    columns: number,
    axis: PanelAxis,
    chart: AxisOptions | undefined,
  ): ScaleGroups {
    return typedGroups(groups(scope, split, columns, axis), axis, () => chart);
  }

  across(
    split: PanelSplit,
    groupOf: readonly number[],
    by: readonly number[],
  ): [number, MarkSeries[]][][] {
    return across(split, groupOf, by);
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
      least: leastHeight(rows, undefined, split.keys.length),
    };
  }

  /**
   * The headers a panel with `values` at `plot` carries: its values above it
   * when wrapped; in a grid, its column's value above the top row and its
   * row's beside the last column (past its right axis' labels, `aside`),
   * reading top to bottom.
   */
  /**
   * A wrapped panel's values above it, at its start unless `align` says;
   * a grid's column values centered above its top row and its row values
   * beside its last column, turned, unless `align` says.
   */
  headers(
    _index: number,
    values: readonly string[],
    row: number,
    column: number,
    plot: Rect,
    grid: PanelGrid,
    fit: (text: string, room: number) => string,
    aside: number,
    align: Align | undefined,
  ): HeaderPlace[] {
    const out: HeaderPlace[] = [];
    // The one panel of a facet without values has nothing to name.
    if (values.length === 0) return out;
    const { header, columnHeader, rowHeader } = grid;
    if (header) {
      const text = fit(values.join(", "), plot.width);
      const { at, anchor } = aligned(align ?? "start", plot.x, plot.width);
      out.push({ text, x: at, y: plot.y - header / 2, anchor, angle: 0 });
    }
    if (columnHeader && row === 0) {
      const text = fit(values.at(-1)!, plot.width);
      const { at, anchor } = aligned(align ?? "center", plot.x, plot.width);
      out.push({ text, x: at, y: plot.y - columnHeader / 2, anchor, angle: 0 });
    }
    if (rowHeader && column === grid.columns - 1) {
      const text = fit(values[0]!, plot.height);
      const x = plot.x + plot.width + aside + rowHeader / 2 + 4;
      // Turned clockwise, the text's start is at the top.
      const { at, anchor } = aligned(align ?? "center", plot.y, plot.height);
      out.push({ text, x, y: at, anchor, angle: 90 });
    }
    return out;
  }

  annotations(
    views: readonly AnnotatedPanel[],
    marks: readonly Mark[],
    describe: DescribeAnnotation,
    panel?: string,
  ): string[] {
    return annotations(views, marks, describe, false, panel);
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

/** A table's codes of a field in order of first appearance, as of a version. */
interface Appearance {
  version: number;
  codes: number[];
}

/** A panel's rows of a series, and whether its x (and y, for series that track it) ascend. */
interface PanelRows {
  rows: Uint32Array;
  sorted: boolean;
  ySorted: boolean | undefined;
}

/** A series' rows split by panel, as of a table version, its rows, x, and y, and the panel list. */
interface Split {
  table: Table;
  version: number;
  rows: Uint32Array | undefined;
  /** The x column, which decides whether each panel's rows are sorted. */
  x: Series["x"];
  /** The y column of series tracking whether y ascends (`ySorted`: lines and areas along y). */
  y: Series["y"] | undefined;
  panels: readonly PanelValues[];
  byPanel: PanelRows[];
}

/** A field's codes per row, and each code's panel offset (-1 for none). */
interface Place {
  codes: ArrayLike<number>;
  place: Int32Array;
}

/** A panel: its key, and its value of each field that splits rows. */
interface PanelValues {
  key: string;
  values: string[];
}

export class Splitter {
  readonly fields: readonly string[];
  readonly #facet: Pick<Facet, "fields" | "splits" | "scopes" | "remedy">;
  readonly #shape: (counts: readonly number[]) => { rows: number; columns: number };
  /** Each field's values, in order of first appearance across the split tables. */
  #dimensions: string[][];
  /** Every combination of the fields' values, rows by columns. */
  #panels: readonly PanelValues[] = [];
  readonly #appearance = new WeakMap<Table, Map<string, Appearance>>();
  /** Each series' split by its key; series of one table's rows share one. */
  readonly #bySeries = new Map<string, Split>();
  /** Each table's rows in each panel, for marks that summarize them (see `#tableRows`). */
  readonly #rows = new WeakMap<
    Table,
    { version: number; panels: readonly PanelValues[]; rows: Uint32Array[] }
  >();
  /** The rows of every panel together, for each list of panels' rows. */
  readonly #unions = new WeakMap<Uint32Array[], Uint32Array>();
  readonly #bands = new PanelBands();

  constructor(
    facet: Pick<Facet, "fields" | "splits" | "scopes" | "remedy">,
    shape: (counts: readonly number[]) => { rows: number; columns: number },
  ) {
    this.fields = facet.fields;
    this.#facet = facet;
    this.#shape = shape;
    this.#dimensions = this.fields.map(() => []);
  }

  /**
   * A panel per facet value, or per pair of values of two fields, in which
   * marks over a table draw the rows with those values and other marks
   * repeat. Rows without a value are in no panel; with no values at all,
   * there is one empty panel. Marks whose drawing combines rows (stacks)
   * combine each panel's apart; marks that summarize rows (histograms, box
   * plots) summarize each panel's rows of their table, as a layout mark
   * (a chart's only mark) does, and annotations over a table draw each
   * panel's rows of it.
   */
  split(
    base: readonly MarkSeries[],
    chart: PanelChart,
    bands: Bands,
    context: BandContext,
  ): PanelSplit {
    const splits = (mark: Mark) => this.#facet.splits(mark);
    const tables = new Set(base.filter(({ mark }) => splits(mark)).map(({ mark }) => mark.table!));
    const { marks } = chart.config;
    const [layout] = chart.layouts;
    // A map's layers each split their rows, unless they repeat.
    const layers = layout ? (layout.layers ?? [layout]) : [];
    for (const layer of layers) if (layer.spec.facet === undefined) tables.add(layer.table!);
    this.#update(tables, chart);
    const empty = this.#panels.length === 0;
    const keys = empty ? [""] : this.#panels.map(({ key }) => key);
    const values = empty ? [[]] : this.#panels.map(({ values }) => values);
    const dimensions = this.#dimensions.map((d) => [...d]);
    const { columns } = this.#shape(dimensions.map((d) => d.length));
    const used = new Set<string>();
    // Per mark, each series' panel parts; undefined for marks that repeat
    // and for marks that summarize rows.
    const parts = base.map(({ mark, series }) => {
      if (!splits(mark) || mark.summarizePanels) return undefined;
      return series.map((s) => {
        used.add(s.key);
        return this.#split(s, mark.table!);
      });
    });
    for (const key of this.#bySeries.keys()) if (!used.has(key)) this.#bySeries.delete(key);
    // Marks that summarize rows read each panel's rows of their table, and
    // choose bins over the panels sharing their binned axis scale.
    const scopes = this.#facet.scopes(chart.config);
    const xGroupOf = groupsOf(scopes.x, keys.length, columns);
    const yGroupOf = groupsOf(scopes.y, keys.length, columns);
    const summaries = base.map(({ mark, series }) =>
      splits(mark) && mark.summarizePanels
        ? mark.summarizePanels(
            series,
            this.#tableRows(mark.table!),
            xGroupOf,
            chart.hidden,
            bands,
            context,
            yGroupOf,
          )
        : undefined,
    );
    // Each mark's series in each panel, in the chart's order.
    const byPanel = base.map(
      ({ series }, i) =>
        summaries[i] ??
        keys.map((_, p) => (parts[i] ? parts[i].flatMap((panels) => panels[p] ?? []) : series)),
    );
    base.forEach(({ mark, series }, i) => {
      if (!parts[i]) return;
      mark.stackPanels?.(byPanel[i]!, chart.hidden, this);
      mark.splitPanels?.(series, byPanel[i]!);
    });
    // Annotations read each panel's rows of their table; all of them, the
    // rows of every panel (not those without facet values).
    const rows = base.map(({ mark }) =>
      splits(mark) && ROWS.has(mark.spec.type) ? this.#tableRows(mark.table!) : undefined,
    );
    const panels = keys.map((_, p) =>
      base.map(({ mark }, i): MarkSeries => {
        const own = rows[i]?.[p];
        return own
          ? { mark, series: byPanel[i]![p]!, rows: [own] }
          : { mark, series: byPanel[i]![p]! };
      }),
    );
    const all = base.map(({ mark, series }, i) => ({
      mark,
      series: summaries[i]?.flat() ?? parts[i]?.flat() ?? series,
      rows: rows[i],
    }));
    const split: PanelSplit = { keys, values, dimensions, panels, all };
    if (layout) {
      const index = layout.indices?.[0] ?? marks.indexOf(layout);
      const byPart = layers.map((layer) =>
        layer.spec.facet === undefined ? this.#tableRows(layer.table!) : undefined,
      );
      // Every panel's map is fitted to the rows of all of them.
      const fitRows = layout.layers && byPart.map((rows) => rows && this.#union(rows));
      split.items = keys.map((_, p) =>
        fitRows
          ? {
              mark: layout,
              index,
              rows: undefined,
              layerRows: byPart.map((rows) => rows?.[p]),
              fitRows,
            }
          : { mark: layout, index, rows: byPart[0]![p] },
      );
    }
    this.#bands.place(split, columns, bands, scopes, context);
    return split;
  }

  /**
   * Finds each field's values in the tables' current rows, keeping the
   * panels while they are unchanged; refuses a shape that could never fit
   * `room` before they are listed.
   */
  #update(tables: Iterable<Table>, room: PanelRoom): void {
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
    const shape = this.#shape(dimensions.map((values) => values.length));
    checkFit(shape, count, room, this.#facet.remedy);
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
    const y = s.ySorted === undefined ? undefined : s.y;
    const current = (split: Split | undefined): split is Split =>
      split?.table === table &&
      split.version === table.version &&
      split.rows === s.rows &&
      split.x === s.x &&
      split.y === y &&
      split.panels === this.#panels;
    let split = this.#bySeries.get(s.key);
    if (!current(split)) {
      // Fields of one table split alike: they share their rows in each panel.
      split = [...this.#bySeries.values()].find(current) ?? {
        table,
        version: table.version,
        rows: s.rows,
        x: s.x,
        y,
        panels: this.#panels,
        byPanel: this.#bucket(table, s.rows, s.length, s.x, s.sorted, y, s.ySorted),
      };
      this.#bySeries.set(s.key, split);
    }
    // A panel's rows are a subset, which no longer streams as its group does.
    return split.byPanel.map(({ rows, sorted, ySorted }) => ({
      ...s,
      rows,
      length: rows.length,
      sorted,
      ...(ySorted !== undefined && { ySorted }),
      stream: undefined,
    }));
  }

  /**
   * The rows of `table` in each panel, ascending: what marks that summarize
   * rows read, whatever series their rows are in. Kept while the table and
   * the panels are unchanged.
   */
  /** The rows of every panel of a table's (see `#tableRows`), kept while they are. */
  #union(rows: Uint32Array[]): Uint32Array {
    let union = this.#unions.get(rows);
    if (!union) {
      union = new Uint32Array(rows.reduce((length, panel) => length + panel.length, 0));
      let at = 0;
      for (const panel of rows) {
        union.set(panel, at);
        at += panel.length;
      }
      this.#unions.set(rows, union);
    }
    return union;
  }

  #tableRows(table: Table): Uint32Array[] {
    const cached = this.#rows.get(table);
    if (cached?.version === table.version && cached.panels === this.#panels) return cached.rows;
    // Without facet values, the one panel is empty.
    const rows =
      this.#panels.length === 0
        ? [new Uint32Array(0)]
        : this.#bucket(table, undefined, table.length).map((panel) => panel.rows);
    this.#rows.set(table, { version: table.version, panels: this.#panels, rows });
    return rows;
  }

  /**
   * The first `length` of `rows` (every row without them) by panel, in
   * order, and whether each panel's `x` is ascending (known for subsets of
   * a `sorted` x), and with `y`, whether its `y` is (known for subsets of a
   * `ySorted` y).
   */
  #bucket(
    table: Table,
    rows: Uint32Array | undefined,
    length: number,
    x?: NumericArray,
    sorted = false,
    y?: NumericArray,
    ySorted = false,
  ): PanelRows[] {
    const rowOf = (k: number) => (rows ? rows[k]! : k);
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
    const panelAt = new Int32Array(length);
    const { codes: a, place: placeA } = first;
    if (!second) {
      for (let k = 0; k < length; k++) {
        const code = a[rowOf(k)]!;
        panelAt[k] = code >= 0 ? placeA[code]! : -1;
      }
    } else {
      const { codes: b, place: placeB } = second;
      for (let k = 0; k < length; k++) {
        const row = rowOf(k);
        const [codeA, codeB] = [a[row]!, b[row]!];
        const pa = codeA >= 0 ? placeA[codeA]! : -1;
        const pb = codeB >= 0 ? placeB[codeB]! : -1;
        panelAt[k] = pa >= 0 && pb >= 0 ? pa + pb : -1;
      }
    }
    const sizes = new Uint32Array(this.#panels.length);
    for (let k = 0; k < length; k++) {
      const panel = panelAt[k]!;
      if (panel >= 0) sizes[panel]!++;
    }
    const byPanel = Array.from(sizes, (size) => ({
      rows: new Uint32Array(size),
      sorted: true,
      ySorted: true,
      filled: 0,
      last: Number.NEGATIVE_INFINITY,
      lastY: Number.NEGATIVE_INFINITY,
    }));
    for (let k = 0; k < length; k++) {
      const at = panelAt[k]!;
      if (at < 0) continue;
      const panel = byPanel[at]!;
      const row = rowOf(k);
      panel.rows[panel.filled++] = row;
      // A subset of an unsorted series may still be sorted (rows grouped by
      // panel); as in isSortedSubset, a missing value leaves it unsorted.
      if (x) {
        const value = x[row]!;
        if (!(value >= panel.last)) panel.sorted = false;
        panel.last = value;
      }
      if (y) {
        const value = y[row]!;
        if (!(value >= panel.lastY)) panel.ySorted = false;
        panel.lastY = value;
      }
    }
    return byPanel.map((panel) => ({
      rows: panel.rows,
      sorted: sorted || (!!x && panel.sorted),
      ySorted: y ? ySorted || panel.ySorted : undefined,
    }));
  }
}
