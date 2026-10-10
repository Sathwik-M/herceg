// A pivot in a grid, imported with its DOM grid as `herceg/grid/pivot`: a
// grid model (grid/model.ts) of a row pivot (data/pivot.ts). Its rows are
// the pivot's rows; its columns are the rows field's, then one per pivot
// value and aggregate (each value heading its aggregates), then the totals.
// Generated columns are named by their ids, which the model's layout
// (order, widths, pins, hidden columns) and sorting are keyed by, so values
// coming and going never take another column's width or focus. The model
// takes this through `GridPivot`, so grids that show no pivot load none of it.

import type { Fields } from "../data/expression.ts";
import { type PivotColumn, type PivotValue, pivotGroups, type RowPivot } from "../data/pivot.ts";
import type { RowView } from "../data/row-view.ts";
import type { SelectionStore } from "../data/selection.ts";
import type { Schema, Table } from "../data/table.ts";
import type { NumberFormat, TimeFormat } from "../format/format.ts";
import type { TimeZone } from "../format/zone.ts";
import {
  type ColumnContent,
  describeColumns,
  type FormatSettings,
  type GridColumn,
  MIN_COLUMN_WIDTH,
  valueFormatter,
} from "./columns.ts";
import { GridModel, type GridPivot } from "./model.ts";

/** How a pivot grid's column shows: its title, width (120 pixels by default), alignment, and Intl format. */
export interface PivotColumnOptions {
  title?: string;
  width?: number;
  align?: "start" | "center" | "end";
  format?: NumberFormat | TimeFormat;
}

export interface PivotGridModelOptions<
  S extends Schema = Schema,
  R extends string = string,
  P extends string = string,
  O = Record<string, unknown>,
> {
  /** The pivot to show; the application owns it. */
  data: RowPivot<S, R, P, O>;
  /** The rows field's column, titled by the field by default. */
  rowColumn?: PivotColumnOptions;
  /** Each aggregate's columns, by its name, titled by it by default. */
  aggregates?: { readonly [K in keyof O]?: PivotColumnOptions };
  /** Intl options for the pivot field's values over their columns, when they are numbers or times. */
  valueFormat?: NumberFormat | TimeFormat;
  /** Where the selected rows go; a store of the grid's own when left out. */
  selection?: SelectionStore<S>;
  /** The store's channel for the selected rows; "grid-rows" by default. */
  channel?: string;
  /** In CSS pixels; 28 by default. */
  rowHeight?: number;
  /** BCP 47 locale for numbers and times; the runtime's by default. */
  locale?: string;
  /** Zone times are shown in: "UTC", an IANA zone, or "local" (the default). */
  timeZone?: TimeZone;
  /** Text of missing values; empty by default (missing keys read "(missing)"). */
  missing?: string;
}

/**
 * A grid model of a pivot's rows (`createPivotGridModel`): a `GridModel`
 * whose rows are the pivot's, each standing for its rows of the view, and
 * whose columns are generated. Columns and sort keys name the crosstab's
 * fields: the rows field, and each generated column's id.
 */
export type PivotGridModel<S extends Schema = Schema> = Omit<
  GridModel,
  | "data"
  | "selection"
  | "groups"
  | "setGroups"
  | "groupSort"
  | "setGroupSort"
  | "isExpanded"
  | "setExpanded"
  | "expandAll"
  | "collapseAll"
  | "rowAt"
  | "identityAt"
  | "rowIndexOf"
> & {
  /** The view the pivot pivots. */
  readonly data: RowView<S>;
  readonly selection: SelectionStore<S>;
};

/**
 * A grid model of a pivot: a row per row of the pivot, which selects that
 * row's rows of the view, and the columns it generates.
 *
 * ```ts
 * const model = createPivotGridModel({
 *   data: pivotRows(rowView(requests), {
 *     rows: "region",
 *     pivot: "service",
 *     ops: { requests: count(), latency: mean("latency") },
 *   }),
 *   aggregates: { latency: { title: "Latency (ms)", format: { maximumFractionDigits: 1 } } },
 * });
 * createPivotGrid(element, { model, ariaLabel: "Requests by region and service" });
 * ```
 */
export function createPivotGridModel<S extends Schema, R extends string, P extends string, O>(
  options: PivotGridModelOptions<S, R, P, O>,
): PivotGridModel<S> {
  const { data, rowColumn, aggregates, valueFormat, ...rest } = options;
  const pivot = data as unknown as RowPivot;
  const settings: FormatSettings = {
    locale: options.locale,
    timeZone: options.timeZone ?? "local",
    missing: options.missing ?? "",
  };
  const layout = new PivotLayout(pivot, settings, {
    rowColumn: rowColumn ?? {},
    aggregates: (aggregates ?? {}) as Record<string, PivotColumnOptions | undefined>,
    valueFormat,
  });
  const model: GridModel = new GridModel(
    { ...(rest as unknown as Omit<PivotGridModelOptions, "data">), data: pivot.view, columns: [] },
    layout,
  );
  pivots.set(model, pivot);
  return model as unknown as PivotGridModel<S>;
}

/** Each pivot grid model's pivot. */
const pivots = new WeakMap<GridModel, RowPivot>();

/** The pivot a grid model shows, if it is a pivot grid model: for its DOM grid (dom/grid-pivot.ts). */
export function pivotOfModel(model: GridModel): RowPivot | undefined {
  return pivots.get(model);
}

/** What a column's layout says: the model's record of it, apart from what it shows. */
type Layout = Pick<GridColumn, "width" | "pin" | "hidden">;

type Column = GridColumn & { readonly id: string };

interface LayoutOptions {
  readonly rowColumn: PivotColumnOptions;
  readonly aggregates: Record<string, PivotColumnOptions | undefined>;
  readonly valueFormat: NumberFormat | TimeFormat | undefined;
}

/** A generated column: its full title (for menus and announcements) and what it shows. */
interface Described {
  readonly title: string;
  readonly content: ColumnContent;
  readonly width: number | undefined;
}

/** The pivot's columns and their layout, as the grid model takes them (see `GridPivot`). */
class PivotLayout implements GridPivot {
  readonly groups;
  readonly rows: Table;
  readonly fields: Fields;
  readonly #pivot: RowPivot;
  readonly #settings: FormatSettings;
  readonly #options: LayoutOptions;
  readonly #rowColumn: Described;
  /** The crosstab the revision was last counted for, and its values. */
  #seen: object | null = null;
  #values: readonly PivotValue[] = [];
  #revision = 0;
  /** What each generated column shows, by id: kept while it is generated, so its cells need no writing again. */
  #contents = new Map<string, ColumnContent>();
  /**
   * The layout of columns not generated now, by id, given back when they
   * are again, with the column each followed in an order the user chose
   * (null for none: it was first); the oldest are forgotten.
   */
  readonly #gone = new Map<string, { layout: Layout; after?: string | null }>();
  /** The columns' ids in their own order as last generated: what tells an order the user chose. */
  #order: readonly string[] = [];

  constructor(pivot: RowPivot, settings: FormatSettings, options: LayoutOptions) {
    this.#pivot = pivot;
    this.#settings = settings;
    this.#options = options;
    this.groups = pivotGroups(pivot);
    const rowTable = pivot.rowTable as unknown as Table;
    this.rows = rowTable;
    const field = pivot.rows;
    // Generated ids are JSON arrays starting so: a rows field named like one would be two columns.
    if (field.startsWith('["pivot"'))
      throw new Error(`A pivot grid's rows field cannot be named like its columns ("${field}")`);
    const { title, width, align, format } = options.rowColumn;
    check(field, { field, ...(width !== undefined && { width }) });
    for (const [name, aggregate] of Object.entries(options.aggregates))
      if (aggregate?.width !== undefined) check(name, { field: name, width: aggregate.width });
    const column = {
      field,
      ...(title !== undefined && { title }),
      ...(align !== undefined && { align }),
      ...(format !== undefined && { format }),
    } as GridColumn;
    const content = describeColumns(rowTable, [column], settings).get(field)!;
    const missing = settings.missing || "(missing)";
    this.#rowColumn = {
      title: content.title,
      width,
      content: {
        ...content,
        // A row whose key is missing is a row of its own.
        text: (table, row) =>
          (table as Table).value(field, row) === null ? missing : content.text(table, row),
      },
    };
    this.fields = {
      fields: () => [field, ...pivot.read().columns.map(({ id }) => id)],
      has: (name) => name === field || pivot.read().column(name) !== undefined,
      kind: (name) => (name === field ? rowTable.kind(field) : "number"),
      numbers: (name) => (name === field ? rowTable.numbers(field) : this.#valuesOf(name)),
      categories: (name) => rowTable.categories(name),
    };
  }

  get stopped(): boolean {
    return this.#pivot.failure !== null;
  }

  get revision(): number {
    const crosstab = this.#pivot.read();
    if (crosstab !== this.#seen) {
      this.#seen = crosstab;
      const { values } = crosstab;
      const old = this.#values;
      if (values.length !== old.length || values.some((value, i) => value !== old[i])) {
        this.#values = values;
        this.#revision++;
      }
    }
    return this.#revision;
  }

  columns(
    current: readonly Column[],
    given: readonly GridColumn[] | null,
  ): { columns: Column[]; contents: Map<string, ColumnContent> } {
    const described = this.#describe();
    // Layouts by id: the columns', then those given (to restore).
    const layouts = new Map<string, Layout>();
    for (const column of current) layouts.set(column.id, layoutOf(column));
    const named = new Set<string>();
    for (const column of given ?? []) {
      const id = column.id ?? column.field;
      if (named.has(id)) throw new Error(`Two grid columns have the id "${id}"`);
      named.add(id);
      check(id, column);
      layouts.set(id, layoutOf(column));
    }
    const ids = [...described.keys()];
    const idOf = (column: GridColumn) => column.id ?? column.field;
    const placed = (given ?? current).map(idOf).filter((id) => described.has(id));
    // Columns going keep their layout, and where they were in an order the
    // user chose: the current one once the user moved columns, or one given.
    const gone = this.#gone;
    const remember = (columns: readonly GridColumn[], ordered: boolean) => {
      let previous: string | null = null;
      for (const column of columns) {
        const id = idOf(column);
        if (!described.has(id)) {
          gone.delete(id);
          gone.set(id, { layout: layouts.get(id)!, ...(ordered && { after: previous }) });
        }
        previous = id;
      }
    };
    remember(current, !follows(current.map(idOf), this.#order));
    if (given) remember(given, true);
    for (const id of gone.keys()) {
      if (gone.size <= 64 + 2 * ids.length) break;
      gone.delete(id);
    }
    const contents = new Map<string, ColumnContent>();
    const order = arrange(ids, placed, (id) => gone.get(id)?.after);
    this.#order = ids;
    const columns = order.map((id): Column => {
      const { title, content, width } = described.get(id)!;
      contents.set(id, content);
      const layout = layouts.get(id) ?? gone.get(id)?.layout ?? {};
      gone.delete(id);
      return {
        field: id,
        id,
        title,
        ...(width !== undefined && { width }),
        ...layout,
      } as Column;
    });
    this.#contents = contents;
    return { columns, contents };
  }

  /** Every column the pivot generates now, in their own order, by id. */
  #describe(): Map<string, Described> {
    const pivot = this.#pivot;
    const crosstab = pivot.read();
    const settings = this.#settings;
    const several = pivot.aggregates.length > 1;
    const kind = (pivot.view.source as unknown as Table).kind(pivot.pivot) as
      | "number"
      | "time"
      | "category";
    const label = valueFormatter(kind, this.#options.valueFormat, settings);
    const missing = settings.missing || "(missing)";
    const described = new Map<string, Described>([[pivot.rows, this.#rowColumn]]);
    for (const column of crosstab.columns) {
      const { name } = column.aggregate;
      const options = this.#options.aggregates[name] ?? {};
      const aggregate = options.title ?? name;
      const heading =
        column.kind === "total" ? "Total" : column.value === null ? missing : label(column.value);
      const content =
        this.#contents.get(column.id) ??
        this.#content(column, options, {
          title: several ? aggregate : heading,
          heading: several ? heading : undefined,
        });
      described.set(column.id, {
        title: several ? `${heading}, ${aggregate}` : heading,
        content,
        width: options.width,
      });
    }
    return described;
  }

  /** What a generated column shows: its aggregate's value in each row, read from the crosstab as it is. */
  #content(
    column: PivotColumn,
    options: PivotColumnOptions,
    { title, heading }: { title: string; heading: string | undefined },
  ): ColumnContent {
    const pivot = this.#pivot;
    const { name } = column.aggregate;
    const kind = (pivot.table as unknown as Table).kind(name) as "number" | "time";
    const format = valueFormatter(kind, options.format, this.#settings);
    const value = column.kind === "value" ? column.value : undefined;
    const text =
      column.kind === "total"
        ? (_: Table, row: number) =>
            format((pivot.rowTable as unknown as Table).numbers(name)[row]!)
        : (_: Table, row: number) => {
            const crosstab = pivot.read();
            const index = crosstab.indexOf(value!);
            const at = index < 0 ? undefined : crosstab.value(row, index, name);
            return at === undefined ? "" : format(at);
          };
    return {
      kind,
      title,
      align: options.align ?? "end",
      text,
      format,
      aggregate: name,
      ...(heading !== undefined && {
        heading: {
          id:
            column.kind === "total"
              ? "total"
              : JSON.stringify(value === null ? null : String(value)),
          title: heading,
        },
      }),
    };
  }

  /** A generated column's value in each row, NaN where it is missing or absent: what rows sort by. */
  #valuesOf(id: string): Float64Array {
    const pivot = this.#pivot;
    const crosstab = pivot.read();
    const column = crosstab.column(id);
    if (!column) throw new Error(`The pivot has no column "${id}"`);
    const { name } = column.aggregate;
    if (column.kind === "total")
      return Float64Array.from((pivot.rowTable as unknown as Table).numbers(name));
    const values = new Float64Array(crosstab.rowCount);
    const index = crosstab.indexOf(column.value);
    for (let row = 0; row < values.length; row++)
      values[row] = crosstab.value(row, index, name) ?? Number.NaN;
    return values;
  }
}

/**
 * Ids in the order `placed` has them, with the others placed: a column that
 * was in an order the user chose (`after` gives the column it followed,
 * null when it was first) goes back after that column, or after the one
 * that one followed if it is gone too; others go just before the one after
 * them in `ids` (last when none is), so new values go last, before the
 * totals. `ids` itself while `placed` keeps their order and nothing has a
 * place to go back to.
 */
function arrange(
  ids: readonly string[],
  placed: readonly string[],
  after: (id: string) => string | null | undefined,
): string[] {
  const known = new Set(placed);
  const returning = ids.filter((id) => !known.has(id) && after(id) !== undefined);
  if (returning.length === 0 && follows(placed, ids)) return [...ids];
  const order = [...placed];
  for (const id of returning) {
    // Through the columns it followed that are gone too, to one that is here.
    let before = after(id);
    const passed = new Set<string>();
    while (typeof before === "string" && !known.has(before) && !passed.has(before)) {
      passed.add(before);
      before = after(before);
    }
    if (before === null) order.unshift(id);
    else if (typeof before === "string" && known.has(before))
      order.splice(order.indexOf(before) + 1, 0, id);
    // Nothing it followed is known: it goes where new columns do.
    else continue;
    known.add(id);
  }
  for (let k = ids.length - 1; k >= 0; k--) {
    const id = ids[k]!;
    if (known.has(id)) continue;
    // The one after it is placed already: placed, or added on the way here.
    order.splice(k === ids.length - 1 ? order.length : order.indexOf(ids[k + 1]!), 0, id);
    known.add(id);
  }
  return order;
}

/** Whether the ids of `order` that `reference` has come in its order. */
function follows(order: readonly string[], reference: readonly string[]): boolean {
  const [inOrder, inReference] = [new Set(order), new Set(reference)];
  const kept = reference.filter((id) => inOrder.has(id));
  const shared = order.filter((id) => inReference.has(id));
  return kept.length === shared.length && kept.every((id, i) => id === shared[i]);
}

/** A column's layout, without what it shows. */
function layoutOf({ width, pin, hidden }: GridColumn): Layout {
  return {
    ...(width !== undefined && { width }),
    ...(pin !== undefined && { pin }),
    ...(hidden !== undefined && { hidden }),
  };
}

/** Throws unless a column's layout can be taken. */
function check(id: string, { width, pin }: GridColumn) {
  if (width !== undefined && !(Number.isFinite(width) && width >= MIN_COLUMN_WIDTH))
    throw new RangeError(
      `Column "${id}" needs a width of at least ${MIN_COLUMN_WIDTH} pixels, not ${width}`,
    );
  if (pin !== undefined && pin !== "left" && pin !== "right")
    throw new TypeError(`Column "${id}" pins to "left" or "right", not "${pin}"`);
}
