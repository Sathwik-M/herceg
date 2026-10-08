// Compile-time tests: checked by `npm run typecheck`, never executed.
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { gauge } from "../../src/marks/gauge.ts";

const readings = table({ at: time([0]), cpu: [1], stage: ["a"] });

// Gauges show, and funnels sum, numbers: not times or categories.
gauge(readings, { value: "cpu" });
// @ts-expect-error times are not numbers
gauge(readings, { value: "at" });
// @ts-expect-error categories are not numbers
gauge(readings, { value: "stage" });
funnel(readings, { category: "stage", value: "cpu" });
// @ts-expect-error times are not numbers
funnel(readings, { category: "stage", value: "at" });
