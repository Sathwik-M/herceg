// Compile-time tests: checked by `npm run typecheck`, never executed.
import { expectTypeOf } from "vitest";
import { time } from "../../src/data/column.ts";
import {
  type CategoryField,
  fromRows,
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
// @ts-expect-error category values are strings
t.appendRow({ when: 1, dates: null, latency: 2, count: 3, host: 4 });
t.set("host", 0, "z");
// @ts-expect-error numeric field takes numbers
t.set("latency", 0, "z");

const rows = fromRows([{ at: new Date(), value: 1, name: "x", flag: true }]);
rows.numbers("at");
rows.numbers("value");
rows.categories("name");
// @ts-expect-error booleans are not fields
rows.numbers("flag");

// Field names known only at runtime fall back to strings checked at runtime.
declare const dynamic: Record<string, Float64Array>;
const runtime = table(dynamic);
runtime.numbers("anything");
