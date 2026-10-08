// Compile-time tests: checked by `npm run typecheck`, never executed.
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { graph } from "../../src/marks/graph.ts";

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

// Networks: link ends are categories of the links table; node fields belong
// to the nodes table, and need it.
const talks = table({ from: ["a"], to: ["b"], messages: [1] });
const people = table({ name: ["a"], team: ["x"], followers: [1] });
graph(talks, { source: "from", target: "to", value: "messages" });
graph(talks, { source: "from", target: "to", nodes: people, node: "name", group: "team" });
graph(talks, { source: "from", target: "to", nodes: people, node: "name", size: "followers" });
// @ts-expect-error numbers are not node names
graph(talks, { source: "messages", target: "to" });
// @ts-expect-error "from" is a field of the links, not the nodes
graph(talks, { source: "from", target: "to", nodes: people, node: "from" });
// @ts-expect-error categories do not size nodes
graph(talks, { source: "from", target: "to", nodes: people, node: "name", size: "team" });
// @ts-expect-error groups are a field of a nodes table
graph(talks, { source: "from", target: "to", group: "from" });
// @ts-expect-error a nodes table needs the field naming its nodes
graph(talks, { source: "from", target: "to", nodes: people });
