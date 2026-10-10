// Compile-time tests: checked by `npm run typecheck`, never executed.
import { expectTypeOf } from "vitest";
import { time } from "../../src/data/column.ts";
import {
  type CategoryField,
  fromRows,
  type NumberField,
  type NumericField,
  type Schema,
  type Table,
  table,
} from "../../src/data/table.ts";

const t = table({
  when: time(new Float64Array(3)),
  dates: [new Date(), new Date(), null],
  latency: new Float64Array(3),
  count: [1, 2, null],
  host: ["a", "b", "c"],
});

type S = typeof t extends Table<infer S extends Schema> ? S : never;

expectTypeOf<S>().toEqualTypeOf<{
  when: "time";
  dates: "time";
  latency: "number";
  count: "number";
  host: "category";
}>();
expectTypeOf<NumericField<S>>().toEqualTypeOf<"when" | "dates" | "latency" | "count">();
expectTypeOf<NumberField<S>>().toEqualTypeOf<"latency" | "count">();
expectTypeOf<CategoryField<S>>().toEqualTypeOf<"host">();

t.numbers("latency");
// @ts-expect-error categories are not numeric
t.numbers("host");
// @ts-expect-error unknown field
t.numbers("missing");
t.categories("host");
// @ts-expect-error numbers are not categorical
t.categories("latency");

t.appendRow({ when: 1, dates: new Date(), latency: 2, count: null, host: "d" });
// @ts-expect-error every field is required
t.appendRow({ when: 1 });
// Categories take labels, or numbers as labels; times take ISO 8601 strings too.
t.appendRow({ when: "2026-01-21T00:00:00Z", dates: null, latency: 2, count: 3, host: 4 });
// @ts-expect-error category values are strings or numbers
t.appendRow({ when: 1, dates: null, latency: 2, count: 3, host: new Date() });
// @ts-expect-error numbers are not times as strings
t.appendRow({ when: 1, dates: null, latency: "2", count: 3, host: "e" });
t.set("host", 0, "z");
// @ts-expect-error numeric field takes numbers
t.set("latency", 0, "z");

// Values read back are typed by their field: times as epoch milliseconds.
expectTypeOf(t.value("latency", 0)).toEqualTypeOf<number | null>();
expectTypeOf(t.value("when", 0)).toEqualTypeOf<number | null>();
expectTypeOf(t.value("host", 0)).toEqualTypeOf<string | null>();
// @ts-expect-error unknown field
t.value("missing", 0);

const rows = fromRows([{ at: new Date(), value: 1, name: "x", flag: true }]);
rows.numbers("at");
rows.numbers("value");
rows.categories("name");
// @ts-expect-error booleans are not fields
rows.numbers("flag");

// `types` reads properties as other kinds: epoch milliseconds or ISO strings as times, codes as categories.
const typed = fromRows([{ at: 1_767_225_600_000, iso: "2026-01-01", status: 200, value: 1 }], {
  types: { at: "time", iso: "time", status: "category" },
});
type Typed = typeof typed extends Table<infer S extends Schema> ? S : never;
expectTypeOf<Typed>().toEqualTypeOf<{
  at: "time";
  iso: "time";
  status: "category";
  value: "number";
}>();
// @ts-expect-error only the rows' fields have types
fromRows([{ at: 1 }], { types: { other: "time" } });

// Field names known only at runtime fall back to strings checked at runtime.
declare const dynamic: Record<string, Float64Array>;
const runtime = table(dynamic);
runtime.numbers("anything");
expectTypeOf(runtime.value("anything", 0)).toEqualTypeOf<number | null>();
// Tables of any schema read any kind of value.
declare const loose: Table;
expectTypeOf(loose.value("anything", 0)).toEqualTypeOf<number | string | null>();
