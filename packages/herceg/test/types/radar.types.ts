// Radar values are numbers, not times. Compiled by `npm run typecheck`.
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { radar } from "../../src/marks/radar.ts";

const data = table({
  k: ["a", "b", "c"],
  when: time(new Float64Array(3)),
  a: [1, 2, 3],
  b: [2, 3, 4],
  c: [3, 4, 5],
});

radar(data, { category: "k", value: "a" });
radar(data, { fields: ["a", "b", "c"], series: "k" });
// @ts-expect-error times are not radar values
radar(data, { category: "k", value: "when" });
// @ts-expect-error times are not radar values
radar(data, { fields: ["when", "a", "b"], series: "k" });
// @ts-expect-error categories are not radar values
radar(data, { category: "k", value: "k" });
// @ts-expect-error spokes come from a category or from fields, not both
radar(data, { category: "k", value: "a", fields: ["a", "b", "c"] });
