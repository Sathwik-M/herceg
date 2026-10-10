// Grid queries: what a remote grid asks of the data where it lives, as
// plain JSON that a server (a database behind an API, a worker) can run.
// A query names the rows (a filter, a portable expression), their order,
// and optionally groups with aggregates; it says nothing of how the grid
// lays them out (widths, order, pins) or what the user does with them
// (expansion, focus, selection, the window of rows asked for), which stay
// with the grid. Semantics are those of the local grid: filters as
// `compileExpression` evaluates them, orders as data/order.ts sorts, groups
// and aggregates as data/groups.ts computes them.

import { compileExpression, type Expression, type Fields } from "../data/expression.ts";
import type { GroupOp } from "../data/groups.ts";
import type { SortKey } from "../data/order.ts";
import type { PositionField, Schema } from "../data/table.ts";

/** What a remote source's rows hold: numbers, times (epoch milliseconds), and categories. */
export type GridFieldKind = "number" | "time" | "category";

/** A record's key: a string, or a number that is a safe integer. */
export type RowKey = string | number;

/**
 * The fields of a remote source's rows. `key` names the field whose value
 * is each record's own, unique and unchanging across queries; without one,
 * rows can be read and selected by condition, not one by one. `version`
 * changes when the fields do.
 */
export interface GridSchema<S extends Schema = Schema> {
  readonly source: string;
  readonly version: string;
  readonly fields: Readonly<S>;
  readonly key: (keyof S & string) | null;
}

/**
 * An aggregate of each group's rows, named `as`: `count` counts rows (with a
 * field, its finite values); the others read a number or time field's
 * finite values: their sum (0 without any), mean, minimum, or maximum
 * (missing without any). Means, minimums, and maximums of times are times.
 */
export type GridAggregate<F extends string = string> =
  | { readonly op: "count"; readonly field?: F; readonly as: string }
  | { readonly op: Exclude<GroupOp, "count">; readonly field: F; readonly as: string };

/**
 * Groups of the rows by the values of `by`, level by level (by the first
 * field, then within each group by the second, and so on), each with the
 * aggregates of the rows it holds. `sort` orders each level's groups among
 * their siblings, by the keys that level has: aggregates order every level,
 * and a grouping field its own level and those below. Ties, and groups
 * without keys, go by their own grouping value, ascending, missing last.
 */
export interface GridGrouping<F extends string = string> {
  readonly by: readonly F[];
  readonly aggregate: readonly GridAggregate<F>[];
  readonly sort?: readonly SortKey[];
}

/**
 * A query of a remote source's rows. Version 1 runs, in order: `filter`
 * keeps the rows where it is true (a missing result keeps none); `group`
 * groups them and computes aggregates over each group's rows; groups are
 * ordered among their siblings; rows are ordered by `sort` (within their
 * group when grouped), missing values last in either direction, categories
 * by their labels in UTF-16 code unit order, and ties by the source's key,
 * ascending (or an order the source keeps fixed, without one).
 */
export interface GridQuery<F extends string = string> {
  readonly version: 1;
  readonly source: string;
  readonly filter?: Expression;
  readonly sort?: readonly SortKey<F>[];
  readonly group?: GridGrouping<F>;
}

/** A query of a source with this schema, its fields checked by TypeScript. */
export type GridQueryOf<S extends Schema> = GridQuery<PositionField<S>>;

const QUERY_KEYS = new Set(["version", "source", "filter", "sort", "group"]);
const GROUP_KEYS = new Set(["by", "aggregate", "sort"]);
const AGGREGATE_KEYS = new Set(["op", "field", "as"]);
const SORT_KEYS = new Set(["field", "order"]);
const OPS = new Set<string>(["count", "sum", "mean", "min", "max"]);

/**
 * Checks a query against a source's schema and gives it back frozen: an
 * unknown property, a field the schema lacks or an aggregate cannot read,
 * a filter that is not a true-or-false expression, and repeated names are
 * refused, so a server never ignores what it does not understand.
 */
export function validateGridQuery<S extends Schema>(
  query: unknown,
  schema: GridSchema<S>,
): GridQueryOf<S> {
  const q = record(query, "A grid query", QUERY_KEYS);
  if (q.version !== 1) throw new TypeError(`Grid queries are version 1, not ${show(q.version)}`);
  if (q.source !== schema.source)
    throw new Error(`The query is of "${show(q.source)}", not the source "${schema.source}"`);
  const fields = schemaFields(schema);
  const has = (field: unknown): field is string =>
    typeof field === "string" && Object.hasOwn(schema.fields, field);
  if (q.filter !== undefined) {
    checkJson(q.filter as Expression);
    const test = compileExpression(q.filter as Expression, fields);
    if (test.type !== "boolean")
      throw new TypeError(`A query's filter must be true or false, not a ${test.type}`);
  }
  const sort = sortKeys(q.sort, "sort", has);
  let group: GridGrouping | undefined;
  if (q.group !== undefined) {
    const g = record(q.group, "A query's group", GROUP_KEYS);
    if (!Array.isArray(g.by) || g.by.length === 0)
      throw new TypeError("A query's group needs fields to group by");
    const by: string[] = [];
    for (const field of g.by as unknown[]) {
      if (!has(field)) throw new Error(`Unknown grouping field ${show(field)}`);
      by.push(field);
    }
    if (new Set(by).size < by.length) throw new Error("A query groups by a field once");
    if (!Array.isArray(g.aggregate)) throw new TypeError("A query's group needs an aggregate list");
    const names = new Set<string>();
    const aggregate = g.aggregate.map((value: unknown) => {
      const a = record(value, "An aggregate", AGGREGATE_KEYS);
      if (typeof a.op !== "string" || !OPS.has(a.op))
        throw new TypeError(`Unknown aggregate operation ${show(a.op)}`);
      if (typeof a.as !== "string" || a.as === "")
        throw new TypeError("An aggregate needs a name (`as`)");
      if (names.has(a.as) || by.includes(a.as))
        throw new Error(`Two fields of the groups are named "${a.as}"`);
      names.add(a.as);
      if (a.field === undefined && a.op !== "count")
        throw new TypeError(`"${a.op}" needs a field (aggregate "${a.as}")`);
      if (a.field !== undefined && (!has(a.field) || schema.fields[a.field] === "category"))
        throw new Error(`Aggregate "${a.as}" needs a number or time field, not ${show(a.field)}`);
      return Object.freeze({ ...a }) as GridAggregate;
    });
    const groupSort = sortKeys(
      g.sort,
      "group sort",
      (field): field is string => by.includes(field as string) || names.has(field as string),
    );
    group = Object.freeze({
      by: Object.freeze(by),
      aggregate: Object.freeze(aggregate),
      ...(groupSort && { sort: groupSort }),
    });
  }
  return Object.freeze({
    version: 1,
    source: schema.source,
    ...(q.filter !== undefined && { filter: frozen(q.filter as Expression) }),
    ...(sort && { sort }),
    ...(group && { group }),
  }) as GridQueryOf<S>;
}

/**
 * Throws unless an expression crosses JSON unchanged: numbers finite
 * anywhere in it (JSON writes infinities and NaN as null, which is the
 * missing value).
 */
export function checkJson(expression: Expression): void {
  if (typeof expression === "number" && !Number.isFinite(expression))
    throw new TypeError(`Expressions sent to a source need finite numbers, not ${expression}`);
  if (Array.isArray(expression)) for (const operand of expression.slice(1)) checkJson(operand);
}

/** The fields a query reads: its filter's, sort keys', grouping fields, and aggregates'. */
export function queryFields(query: GridQuery): string[] {
  const fields = new Set<string>(expressionFields(query.filter));
  for (const { field } of query.sort ?? []) fields.add(field);
  for (const field of query.group?.by ?? []) fields.add(field);
  for (const { field } of query.group?.aggregate ?? []) if (field !== undefined) fields.add(field);
  return [...fields];
}

/** The fields an expression reads. */
export function expressionFields(expression: Expression | undefined): string[] {
  if (!Array.isArray(expression)) return [];
  const [operator, ...operands] = expression as readonly [string, ...Expression[]];
  if (operator === "field") return typeof operands[0] === "string" ? [operands[0]] : [];
  return operands.flatMap(expressionFields);
}

/**
 * A schema's fields as expressions read them, holding no rows: what
 * queries and conditions are checked against.
 */
export function schemaFields(schema: GridSchema): Fields {
  const names = Object.keys(schema.fields);
  return {
    fields: () => names,
    has: (name) => Object.hasOwn(schema.fields, name),
    kind: (name) => schema.fields[name]!,
    numbers: () => new Float64Array(0),
    categories: () => ({ codes: new Int32Array(0), dictionary: [] }),
  };
}

function sortKeys(
  value: unknown,
  what: string,
  has: (field: unknown) => field is string,
): readonly SortKey[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError(`A query's ${what} must be a list of keys`);
  const keys = value.map((entry: unknown) => {
    const key = record(entry, `A ${what} key`, SORT_KEYS);
    if (!has(key.field)) throw new Error(`Unknown ${what} field ${show(key.field)}`);
    if (key.order !== undefined && key.order !== "ascending" && key.order !== "descending")
      throw new TypeError(`Sort orders are "ascending" or "descending", not ${show(key.order)}`);
    return Object.freeze({ ...key }) as unknown as SortKey;
  });
  return Object.freeze(keys);
}

/** A plain object with no properties but `allowed`. */
function record(
  value: unknown,
  what: string,
  allowed: ReadonlySet<string>,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError(`${what} must be an object`);
  for (const key of Object.keys(value))
    if (!allowed.has(key)) throw new TypeError(`${what} has an unknown property "${key}"`);
  return value as Record<string, unknown>;
}

function frozen(expression: Expression): Expression {
  return (
    Array.isArray(expression) ? Object.freeze(expression.map(frozen)) : expression
  ) as Expression;
}

function show(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(JSON.stringify(value) ?? value);
}
