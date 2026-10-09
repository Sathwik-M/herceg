// Compile-time tests: checked by `npm run typecheck`, never executed.
import { time } from "../../src/data/column.ts";
import type { GeometryInput } from "../../src/data/geometry.ts";
import { table } from "../../src/data/table.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { candlestick } from "../../src/marks/candlestick.ts";
import { errorBar } from "../../src/marks/errorbar.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { graph } from "../../src/marks/graph.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { region } from "../../src/marks/region.ts";
import { rule } from "../../src/marks/rule.ts";
import { sankey } from "../../src/marks/sankey.ts";
import { sunburst } from "../../src/marks/sunburst.ts";
import { treemap } from "../../src/marks/treemap.ts";
import type {
  AreaSpec,
  ErrorBarSpec,
  RegionSpec,
  RuleSpec,
  TreemapSpec,
} from "../../src/spec/spec.ts";

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

// Forms of a mark that exclude each other cannot be mixed.
const band = table({ x: [0], low: [1], high: [2] });
area(band, { x: "x", y: "low" });
area(band, { x: "x", y1: "low", y2: "high" });
// @ts-expect-error an area is filled to y or between y1 and y2, not both
area(band, { x: "x", y: "low", y1: "low", y2: "high" });
// @ts-expect-error bands do not stack
area(band, { x: "x", y1: "low", y2: "high", stack: true });
// Areas of a series field stack too, zero or interpolated where a series has no row.
const usage = table({ t: [0], cpu: [1], host: ["a"] });
area(usage, { x: "t", y: "cpu", series: "host", stack: true });
area(usage, { x: "t", y: "cpu", series: "host", stack: true, stackGaps: "interpolate" });
// @ts-expect-error gaps are zero or interpolated
area(usage, { x: "t", y: "cpu", series: "host", stack: true, stackGaps: "linear" });
// @ts-expect-error bands have no gaps to fill
area(band, { x: "x", y1: "low", y2: "high", stackGaps: "zero" });
errorBar(band, { x: "x", y1: "low", y2: "high" });
// @ts-expect-error vertical error bars have no x range
errorBar(band, { x: "x", y1: "low", y2: "high", x1: "low" });
// @ts-expect-error an error bar's ends are two fields or a center and an error
errorBar(band, { x: "x", y: "low", yError: "high", y1: "low" });
rule({ x: 1 });
rule({ y: 1 });
// @ts-expect-error a rule needs a position
rule({});
// @ts-expect-error a rule is vertical or horizontal
rule({ x: 1, y: 1 });
region({ x1: 0, x2: 1 });
region({ y1: 0, y2: 1 });
region({ x1: 0, x2: 1, y1: 0, y2: 1 });
// @ts-expect-error a region needs both ends of a range
region({ x1: 0 });
// @ts-expect-error a region needs a range
region({});

// Shapes are for maps: they place nothing along an axis.
declare const shapes: GeometryInput;
const regions = table({ shape: shapes, name: ["a"], sales: [1] });
bar(regions, { x: "name", y: "sales" });
// @ts-expect-error geometry is not a bar position
bar(regions, { x: "shape", y: "sales" });
// @ts-expect-error geometry is not a heatmap column
heatmap(regions, { x: "shape", y: "name", value: "sales" });
// @ts-expect-error geometry is not a candle position
candlestick(regions, { x: "shape", open: "sales", high: "sales", low: "sales", close: "sales" });
// @ts-expect-error geometry is not an error bar position
errorBar(regions, { x: "shape", y1: "sales", y2: "sales" });
// Nor is a field that may hold geometry.
declare const shapesOrNumbers: GeometryInput | number[];
const either = table({ at: shapesOrNumbers, sales: [1] });
// @ts-expect-error the field may hold geometry
bar(either, { x: "at", y: "sales" });

// Trees are named by a path or by node and parent fields, not both.
const org = table({ team: ["a"], lead: ["b"], group: ["g"], heads: [1], since: time([0]) });
treemap(org, { path: ["group", "team"] });
treemap(org, { node: "team", parent: "lead", value: "heads" });
// @ts-expect-error a tree is named one way
treemap(org, { path: ["group"], node: "team", parent: "lead" });
// @ts-expect-error a tree is named one way
sunburst(org, { path: ["group"], node: "team", parent: "lead" });
// Sizes and shares are numbers, never times.
// @ts-expect-error times do not size nodes
treemap(org, { path: ["group"], value: "since" });
// @ts-expect-error times do not size slices
pie(org, { category: "team", value: "since" });
// @ts-expect-error times do not size flows
sankey(org, { source: "team", target: "lead", value: "since" });

// Only vertical shapes go on the right axis.
boxplot(readings, { x: "stage", y: "cpu", axis: "right" });
boxplot(readings, { x: "cpu", y: "stage", axis: "left" });
// @ts-expect-error horizontal box plots have their categories on the left axis
boxplot(readings, { x: "cpu", y: "stage", axis: "right" });

// Reusable option values can be readonly.
const dashed = [2, 3] as const;
line(readings, { x: "at", y: "cpu", dash: dashed });
rule({ y: 1, dash: dashed });

// Portable specs keep the same forms apart.
const ruleSpec: RuleSpec = { type: "rule", y: 1 };
// @ts-expect-error a rule spec needs a position
const ruleWithout: RuleSpec = { type: "rule" };
// @ts-expect-error a region spec needs both ends of a range
const regionHalf: RegionSpec = { type: "region", x1: 0 };
// @ts-expect-error an area spec is filled to y or between y1 and y2
const areaBoth: AreaSpec = { type: "area", x: "x", y: "a", y1: "a", y2: "b" };
// @ts-expect-error an error bar spec has one orientation
const errorBoth: ErrorBarSpec = { type: "errorbar", x: "x", y1: "a", y2: "b", x1: "a" };
// @ts-expect-error a tree spec is named one way
const treeBoth: TreemapSpec = { type: "treemap", path: ["a"], node: "b", parent: "c" };

export { areaBoth, errorBoth, regionHalf, ruleSpec, ruleWithout, treeBoth };

// A mark's spec is readonly all the way down: give the chart new marks instead.
const drawn = line(readings, { x: "at", y: "cpu", dash: [2, 3] });
// @ts-expect-error specs cannot be edited
drawn.spec.y = "stage";
// @ts-expect-error nor can their arrays
drawn.spec.dash?.push(4);
