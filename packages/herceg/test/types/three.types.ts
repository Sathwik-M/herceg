// Fields of 3D marks: positions are numbers or times (and categories for a
// surface's floor), heights and colors numbers. Compiled by `npm run typecheck`.
import { category, time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { point3d } from "../../src/marks/point3d.ts";
import { surface } from "../../src/marks/surface.ts";

const data = table({
  a: [1, 2],
  b: [3, 4],
  c: [5, 6],
  when: time(new Float64Array(2)),
  kind: category(["p", "q"]),
});

point3d(data, { x: "a", y: "when", z: "c", series: "kind", name: "kind", color: "b" });
// @ts-expect-error categories have no place along a 3D scatter's axes
point3d(data, { x: "kind", y: "b", z: "c" });
// @ts-expect-error series are categories
point3d(data, { x: "a", y: "b", z: "c", series: "a" });
// @ts-expect-error colors come from numbers, not times
point3d(data, { x: "a", y: "b", z: "c", color: "when" });
// @ts-expect-error not a field of the table
point3d(data, { x: "a", y: "b", z: "nope" });

surface(data, { x: "kind", y: "when", z: "c", color: "a" });
// @ts-expect-error heights are numbers
surface(data, { x: "a", y: "b", z: "when" });
// @ts-expect-error heights are numbers
surface(data, { x: "a", y: "b", z: "kind" });
