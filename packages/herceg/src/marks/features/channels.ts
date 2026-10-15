// Channels compiled against a mark's table: a constant, a category field's
// values through an ordinal scale (by dictionary code, so reading a row is
// an array lookup), or a condition on each row.

import { compileExpression, type Expression } from "../../data/expression.ts";
import type { Table } from "../../data/table.ts";
import type { ChannelSpec } from "../../spec/encoding.ts";
import type { OrdinalScale } from "./scales.ts";

export type Channel<V> =
  | { readonly kind: "value"; readonly value: V }
  | { readonly kind: "field"; readonly field: string; readonly scale: OrdinalScale }
  | {
      readonly kind: "condition";
      readonly when: (row: number) => boolean;
      readonly then: V;
      readonly otherwise: V;
    };

/** Finds the chart's ordinal scales by name, making the default ones as marks read them. */
export type ScaleOf = (name: string, path: string) => OrdinalScale;

/** The fields a table has, for messages. */
export function fieldsOf(table: Table): string {
  return table
    .fields()
    .map((f) => `"${f}"`)
    .join(", ");
}

/** A field of `table` that holds categories, or an error at `path`. */
export function categoryField(table: Table | undefined, field: string, path: string): string {
  if (!table)
    throw new Error(
      `${path}: "${field}" names a field, and fields need a table; pass the table first`,
    );
  if (!table.has(field))
    throw new Error(`${path}: no field "${field}"; the table has ${fieldsOf(table)}`);
  const kind = table.kind(field);
  if (kind !== "category")
    throw new TypeError(
      `${path}: field "${field}" holds ${kind} values; channels read categories, through a scale`,
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
  if ("field" in spec) {
    const field = categoryField(table, spec.field, `${path}.field`);
    const named = scales(spec.scale ?? scale, `${path}.scale`);
    // The scale's fixed outputs must be what the channel takes.
    const at = `chart scales.${named.name}`;
    for (const [value, output] of Object.entries(named.spec?.map ?? {}))
      check(output, `${at}.map[${JSON.stringify(value)}] (read by ${path})`);
    if (named.spec?.unknown !== undefined)
      check(named.spec.unknown, `${at}.unknown (read by ${path})`);
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
 * The channel a `color` short form names: a field of the table, or a
 * color; a string that could be either, or neither, is refused.
 */
export function colorShortForm(
  value: string,
  table: Table | undefined,
  path: string,
  isColor: (value: string) => boolean,
): ChannelSpec<string> {
  const field = table?.has(value) ?? false;
  const color = isColor(value);
  if (field && color)
    throw new Error(
      `${path}: "${value}" names both a field and a color; give encode.color: { field: "${value}" } or { value: "${value}" }`,
    );
  if (field) return { field: value };
  if (color) return { value };
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
