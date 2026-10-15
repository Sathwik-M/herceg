// Channels compiled against a mark's table: a constant, a category field's
// values through an ordinal scale (by dictionary code, so reading a row is
// an array lookup), or a condition on each row.

import { compileExpression, type Expression } from "../../data/expression.ts";
import type { Table } from "../../data/table.ts";
import type { ChannelSpec } from "../../spec/encoding.ts";
import type { CategoryScale } from "./scales.ts";

export type Channel<V> =
  | { readonly kind: "value"; readonly value: V }
  | { readonly kind: "field"; readonly field: string; readonly scale: CategoryScale }
  /** The series' name through a scale (`{ series: true, scale }`). */
  | { readonly kind: "series"; readonly scale: CategoryScale }
  | {
      readonly kind: "condition";
      readonly when: (row: number) => boolean;
      readonly then: V;
      readonly otherwise: V;
    };

/**
 * Finds the chart's ordinal scales by name, making the default ones as
 * marks read them; a `field` read through the default "color" scale where
 * the chart declares none takes the colors of what its values stand for.
 */
export type ScaleOf = (name: string, path: string, field?: string) => CategoryScale;

/** The fields a table has, for messages. */
export function fieldsOf(table: Table): string {
  return table
    .fields()
    .map((f) => `"${f}"`)
    .join(", ");
}

/**
 * A field of `table` that holds categories, or an error at `path` (with the
 * code the compiler's ChartError takes, see `placed` in compile.ts).
 */
export function categoryField(table: Table | undefined, field: string, path: string): string {
  if (!table)
    throw new Error(
      `${path}: "${field}" names a field, and fields need a table; pass the table first`,
    );
  if (!table.has(field))
    throw Object.assign(
      new Error(`${path}: no field "${field}"; the table has ${fieldsOf(table)}`),
      { code: "unknown-field" },
    );
  const kind = table.kind(field);
  if (kind !== "category")
    throw Object.assign(
      new TypeError(
        `${path}: field "${field}" holds ${kind} values; channels read categories, through a scale`,
      ),
      { code: "field-type" },
    );
  return field;
}

/** A row predicate of an expression over `table`, or an error at `path`. */
export function predicate(
  table: Table | undefined,
  expression: Expression,
  path: string,
): (row: number) => boolean {
  if (!table)
    throw new Error(
      `${path}: an expression reads rows, and rows need a table; pass the table first`,
    );
  let compiled: ReturnType<typeof compileExpression>;
  try {
    compiled = compileExpression(expression, table);
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  if (compiled.type !== "boolean")
    throw new TypeError(
      `${path}: expected a condition (true or false); the expression gives a ${compiled.type}`,
    );
  // An expression reads the columns of the version it was compiled for:
  // appends and drops move them, so it is compiled again for each version.
  let { at } = compiled;
  let version = table.version;
  return (row) => {
    if (version !== table.version) {
      version = table.version;
      at = compileExpression(expression, table).at;
    }
    return at(row) === true;
  };
}

/**
 * Compiles a channel. `check` refuses values the channel cannot take;
 * `scale` names the scale a field reads by default.
 */
export function compileChannel<V>(
  spec: ChannelSpec<V>,
  table: Table | undefined,
  scales: ScaleOf,
  scale: string,
  check: (value: unknown, path: string) => void,
  path: string,
): Channel<V> {
  if ("value" in spec) {
    check(spec.value, `${path}.value`);
    return { kind: "value", value: spec.value };
  }
  if ("series" in spec) {
    if (spec.series !== true)
      throw new TypeError(
        `${path}.series: expected true, the series' names through a scale; received ${JSON.stringify(spec.series)}`,
      );
    if (spec.scale === undefined)
      throw new TypeError(
        `${path}.scale: required, as the channel names series through a scale; give scale, the name of one of the chart's scales`,
      );
    const named = scales(spec.scale, `${path}.scale`);
    checkOutputs(named, check, path);
    return { kind: "series", scale: named };
  }
  if ("field" in spec) {
    const field = categoryField(table, spec.field, `${path}.field`);
    const named = scales(spec.scale ?? scale, `${path}.scale`, field);
    checkOutputs(named, check, path);
    named.read(table!, field);
    return { kind: "field", field, scale: named };
  }
  const { when, then, otherwise } = spec.condition;
  check(then, `${path}.condition.then`);
  check(otherwise, `${path}.condition.otherwise`);
  return {
    kind: "condition",
    when: predicate(table, when, `${path}.condition.when`),
    then,
    otherwise,
  };
}

/**
 * A scale's place in the chart's options: `scales.color`, or for a name
 * that is not an identifier, `scales["regions:v1"]`, which error paths keep whole.
 */
export function scalePath(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? `scales.${name}` : `scales[${JSON.stringify(name)}]`;
}

/** Checks that a scale's fixed outputs are what the channel at `path` takes. */
export function checkOutputs(
  scale: CategoryScale,
  check: (value: unknown, path: string) => void,
  path: string,
): void {
  const at = `chart ${scalePath(scale.name)}`;
  for (const [value, output] of Object.entries(scale.spec?.map ?? {}))
    check(output, `${at}.map[${JSON.stringify(value)}] (read by ${path})`);
  if (scale.spec?.unknown !== undefined)
    check(scale.spec.unknown, `${at}.unknown (read by ${path})`);
}

/**
 * The channel a `color` short form names: a field of the table, or a
 * color (a name both is refused before, in compile.ts); a string that is
 * neither is refused.
 */
export function colorShortForm(
  value: string,
  table: Table | undefined,
  path: string,
  isColor: (value: string) => boolean,
): ChannelSpec<string> {
  if (table?.has(value)) return { field: value };
  if (isColor(value)) return { value };
  throw new Error(
    `${path}: "${value}" is neither a field nor a color; ${table ? `the table has ${fieldsOf(table)}` : "the mark has no table"}, and colors are hex, rgb(), hsl(), var(), or CSS names`,
  );
}

/** A check of channels' colors, by what `isColor` reads (see `FeatureKit`). */
export function colorCheck(
  isColor: (value: string) => boolean,
): (value: unknown, path: string) => void {
  return (value, path) => {
    if (typeof value !== "string" || !isColor(value))
      throw new TypeError(
        `${path}: expected a color, such as "#3266d6"; received ${JSON.stringify(value)}`,
      );
  };
}

/**
 * Each dictionary code's output of a field channel, for the table's
 * current version: rows read their code's.
 */
export class CodeOutputs<V> {
  readonly #channel: Extract<Channel<V>, { kind: "field" }>;
  #table: Table | undefined;
  #version = -1;
  #outputs: V[] = [];

  constructor(channel: Extract<Channel<V>, { kind: "field" }>) {
    this.#channel = channel;
  }

  /** Each code's output, through the channel's scale with `defaults` and `fallback`. */
  read(table: Table, defaults: readonly V[], fallback: V): readonly V[] {
    if (this.#table !== table || this.#version !== table.version) {
      const { dictionary } = table.categories(this.#channel.field as never);
      this.#outputs = dictionary.map((value) =>
        this.#channel.scale.output(value, defaults, fallback),
      );
      this.#table = table;
      this.#version = table.version;
    }
    return this.#outputs;
  }
}
