// What a series' color and legend entry stand for: its identity, a value in
// a scope, the place the value comes from.
//
// - `{ table, field }`: a category field of a table. The series a field
//   splits rows into (`series`, or a `color` field it is inferred from),
//   and a pie's slices, stand for the field's values.
// - `{ table }`: a table's value fields. The series of wide data (`y:
//   ["p50", "p99"]`) and a mark's one series stand for their name: their
//   field's, or the mark's `label` (a band's two fields, "low–high"). Two
//   marks of a table naming their series alike, such as a line and the
//   band around it, list one thing.
// - `{ scale }`: a scale of the chart's `scales`. Marks reading it join its
//   values from any source, by value (the feature compiler resolves these,
//   marks/features/identity.ts).
//
// A table is named by the table its fields come from (data/origin.ts: the
// source of a derived table, or the `origin` of one, while the fields pass
// through unchanged): by its `name` (two tables of one name in a chart are
// refused), else by a name the chart gives it: the place of the first mark
// reading it (`{ "mark": 2 }`, or `{ "mark": "latency" }` for a mark of that
// id), which a new table read in the same place takes after it, as when a
// framework renders again, so its values keep their colors (the table that
// had it, read again, is named anew). Such names are objects, so no table's
// own name is ever one. So marks of one
// table, of tables made from it, and of every panel and facet give a value
// one color and one legend entry, while unrelated tables that happen to share
// a field's name do not; a named scale joins them on purpose. A chart drawn
// on a server names its tables as the browser drawing it again does.
//
// The value is a series' name: its series field's value, or its label.
// Identity keys are JSON, scope first, then the value:
// `{"table":"data","field":"region","value":"eu"}`, `{"table":"data","value":"p99"}`,
// `{"scale":"region","value":"eu"}`. They name legend entries, which hide
// and show every series of their identity. Series keys (`seriesKey`) stay
// the identity of what is drawn: geometry buffers, inspection, and the
// keyboard never confuse two marks drawing the same value.

export type IdentityScope =
  | { readonly scale: string }
  | { readonly table: TableName; readonly field?: string };

/**
 * What identity keys name a table by: its `name`, or for a table without
 * one, the place of the first mark reading it (its `id`, else its index,
 * with `n` where another table took that place's name first).
 */
export type TableName = string | { readonly mark: string | number; readonly n?: number };

/** What an identity key of `scope` starts with, before its value. */
export function prefixOf(scope: IdentityScope): string {
  return `${JSON.stringify(scope).slice(0, -1)},"value":`;
}

/** The key of `value` in `scope`. */
export function identityKey(scope: IdentityScope, value: string): string {
  return identityOf(prefixOf(scope), value);
}

/** The key of `value` in the scope `prefix` starts. */
export function identityOf(prefix: string, value: string): string {
  return `${prefix}${JSON.stringify(value)}}`;
}

/** The scope prefix of an identity key; undefined for other keys (series and item keys). */
export function keyPrefix(key: string): string | undefined {
  const at = key.lastIndexOf(',"value":');
  return key.startsWith('{"') && at > 0 ? key.slice(0, at + 9) : undefined;
}
