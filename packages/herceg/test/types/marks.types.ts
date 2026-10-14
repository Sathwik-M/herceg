// Compile-time tests: checked by `npm run typecheck`, never executed.
import { time } from "../../src/data/column.ts";
import type { GeometryInput } from "../../src/data/geometry.ts";
import { table } from "../../src/data/table.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { candlestick } from "../../src/marks/candlestick.ts";
import { custom } from "../../src/marks/custom.ts";
import { dendrogram } from "../../src/marks/dendrogram.ts";
import { errorBar } from "../../src/marks/errorbar.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { graph } from "../../src/marks/graph.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { region } from "../../src/marks/region.ts";
import { rug } from "../../src/marks/rug.ts";
import { rule } from "../../src/marks/rule.ts";
import { sankey } from "../../src/marks/sankey.ts";
import { sunburst } from "../../src/marks/sunburst.ts";
import { treemap } from "../../src/marks/treemap.ts";
import { violin } from "../../src/marks/violin.ts";
import type {
  AreaSpec,
  BoxPlotInput,
  BoxPlotSpec,
  Dash,
  ErrorBarSpec,
  HeatmapSpec,
  HistogramSpec,
  LineSpec,
  RegionSpec,
  RugSpec,
  RuleSpec,
  TreemapSpec,
  ViolinSpec,
} from "../../src/spec/spec.ts";

const readings = table({ at: time([0]), cpu: [1], stage: ["a"] });

// Explicit animation keys infer number, time, or category fields.
point(readings, { x: "at", y: "cpu", animationKey: "cpu" });
point(readings, { x: "at", y: "cpu", animationKey: "stage" });
point(readings, { x: "at", y: "cpu", animationKey: "at" });
// @ts-expect-error the key must be a field of the table
point(readings, { x: "at", y: "cpu", animationKey: "missing" });
// @ts-expect-error animation keys belong to point marks
line(readings, { x: "at", y: "cpu", animationKey: "stage" });

// Tooltip fields are fields of the mark's table, of any kind but shapes, and
// only marks whose points are rows take them.
line(readings, {
  x: "at",
  y: "cpu",
  tooltip: { fields: ["stage", { field: "cpu", label: "CPU", format: { style: "percent" } }] },
});
// @ts-expect-error a tooltip field must be a field of the table
line(readings, { x: "at", y: "cpu", tooltip: { fields: ["cpuu"] } });
// @ts-expect-error entries name their field
bar(readings, { x: "stage", y: "cpu", tooltip: { fields: [{ label: "CPU" }] } });
// @ts-expect-error histogram bins summarize rows, so they have no fields to show
histogram(readings, { x: "cpu", tooltip: { fields: ["stage"] } });

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
graph(talks, { source: "from", target: "to", nodes: people, node: "name", color: "team" });
graph(talks, { source: "from", target: "to", nodes: people, node: "name", size: "followers" });
// @ts-expect-error numbers are not node names
graph(talks, { source: "messages", target: "to" });
// @ts-expect-error "from" is a field of the links, not the nodes
graph(talks, { source: "from", target: "to", nodes: people, node: "from" });
// @ts-expect-error categories do not size nodes
graph(talks, { source: "from", target: "to", nodes: people, node: "name", size: "team" });
// @ts-expect-error groups are a field of a nodes table
graph(talks, { source: "from", target: "to", color: "from" });
// @ts-expect-error a nodes table needs the field naming its nodes
graph(talks, { source: "from", target: "to", nodes: people });
// Layouts by name, or with their own options.
graph(talks, { source: "from", target: "to", layout: "circular" });
graph(talks, { source: "from", target: "to", layout: { type: "force", settle: false } });
graph(talks, { source: "from", target: "to", layout: { type: "circular", sort: "name" } });
graph(talks, { source: "from", target: "to", layout: { type: "layered", direction: "right" } });
// @ts-expect-error a circle does not settle
graph(talks, { source: "from", target: "to", layout: { type: "circular", settle: true } });
// @ts-expect-error layers go down, right, up, or left
graph(talks, { source: "from", target: "to", layout: { type: "layered", direction: "around" } });
// @ts-expect-error no such layout
graph(talks, { source: "from", target: "to", layout: "tree" });

// Forms of a mark that exclude each other cannot be mixed.
const band = table({ x: [0], low: [1], high: [2] });
area(band, { x: "x", y: "low" });
area(band, { x: "x", y1: "low", y2: "high" });
// @ts-expect-error an area is filled to y or between y1 and y2, not both
area(band, { x: "x", y: "low", y1: "low", y2: "high" });
// @ts-expect-error bands do not stack
area(band, { x: "x", y1: "low", y2: "high", stack: true });
// Areas of a series field stack too, zero or interpolated where a series has no row.
bar(readings, { x: "stage", y: "cpu", stack: "fill" });
area(readings, { x: "at", y: "cpu", stack: "wiggle", stackOrder: "inside-out" });
area(readings, { x: "cpu", y: "at", orient: "y", stack: "center" });
// @ts-expect-error stream offsets belong to areas
bar(readings, { x: "stage", y: "cpu", stack: "center" });
// @ts-expect-error bands do not have a stack order
area(band, { x: "x", y1: "low", y2: "high", stackOrder: "inside-out" });
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
// @ts-expect-error geometry cannot identify animated points
point(regions, { x: "sales", y: "sales", animationKey: "shape" });
// @ts-expect-error geometry is not a bar position
bar(regions, { x: "shape", y: "sales" });
// @ts-expect-error geometry is not a heatmap column
heatmap(regions, { x: "shape", y: "name", color: "sales" });
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

for (const dash of ["-", "--", ":", "-."] as const) {
  line(readings, { x: "at", y: "cpu", dash });
  rule({ y: 1, dash });
  custom({
    draw({ path }) {
      path("M0 0L1 1", { dash });
    },
  });
  const lineStyle: LineSpec = { type: "line", x: "at", y: "cpu", dash };
  const ruleStyle: RuleSpec = { type: "rule", y: 1, dash };
  void [lineStyle, ruleStyle];
}
// @ts-expect-error a dash string must be one of the four styles
const unsupportedDash: Dash = "dashed";
void unsupportedDash;

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
const cellsBetween: HeatmapSpec = { type: "heatmap", x1: "a", x2: "b", y: "c", color: "v" };
// @ts-expect-error a heatmap spec places cells along each axis
const cellsNowhere: HeatmapSpec = { type: "heatmap", color: "v" };
// @ts-expect-error cells between edges need both of them
const cellsHalf: HeatmapSpec = { type: "heatmap", x1: "a", y: "c", color: "v" };
// @ts-expect-error cells sit at values or between edges along an axis, not both
const cellsBoth: HeatmapSpec = { type: "heatmap", x: "a", x1: "a", x2: "b", y: "c", color: "v" };

export {
  areaBoth,
  cellsBetween,
  cellsBoth,
  cellsHalf,
  cellsNowhere,
  errorBoth,
  regionHalf,
  ruleSpec,
  ruleWithout,
  treeBoth,
};

// A mark's spec is readonly all the way down: give the chart new marks instead.
const drawn = line(readings, { x: "at", y: "cpu", dash: [2, 3] });
// @ts-expect-error specs cannot be edited
drawn.spec.y = "stage";
// @ts-expect-error nor can their arrays
drawn.spec.dash?.push(4);

const boxes = table({
  group: ["a"],
  low: [0],
  q1: [1],
  median: [2],
  q3: [3],
  high: [4],
  count: [20],
});
const boxFields = { low: "low", q1: "q1", median: "median", q3: "q3", high: "high" } as const;
boxplot(boxes, { x: "group", ...boxFields });
boxplot(boxes, { y: "group", ...boxFields, count: "count", notch: true });
boxplot(boxes, { x: "group", y: "median", whiskers: "range", notch: true });
boxplot(boxes, { x: "group", y: "median", whiskers: 2 });
// @ts-expect-error even a partial summary excludes a raw value axis
boxplot(boxes, { x: "group", y: "median", median: "median" });
// @ts-expect-error median alone is not a complete precomputed box
boxplot(boxes, { x: "group", median: "median" });
// @ts-expect-error raw values and statistic fields exclude each other
boxplot(boxes, { x: "group", y: "median", ...boxFields });
// @ts-expect-error precomputed whisker ends forbid a whisker rule
boxplot(boxes, { x: "group", ...boxFields, whiskers: "tukey" });
// @ts-expect-error precomputed notches need count
boxplot(boxes, { x: "group", ...boxFields, notch: true });
// @ts-expect-error statistic fields must be numeric
boxplot(boxes, { x: "group", ...boxFields, low: "group" });
// @ts-expect-error all five statistics are required
boxplot(boxes, { x: "group", low: "low" });
// @ts-expect-error the category field must be categorical
boxplot(boxes, { x: "median", ...boxFields });
// @ts-expect-error horizontal boxes cannot use the right axis
boxplot(boxes, { y: "group", ...boxFields, axis: "right" });
const precomputedBoxSpec: BoxPlotSpec = {
  type: "boxplot",
  x: "group",
  ...boxFields,
  count: "count",
  notch: true,
};
const rawBoxInput: BoxPlotInput = { x: "group", y: "median", notch: true };
const rawBoxSpec: BoxPlotSpec = { type: "boxplot", ...rawBoxInput };
// @ts-expect-error a complete summary cannot also name raw y values
const mixedBoxInput: BoxPlotInput = { x: "group", y: "median", ...boxFields };
// @ts-expect-error median alone is also a statistic: it excludes raw y values
const partialMixedBoxInput: BoxPlotInput = { x: "group", y: "median", median: "median" };
// @ts-expect-error a precomputed box requires all five statistics
const partialBoxInput: BoxPlotInput = { x: "group", median: "median" };
// @ts-expect-error precomputed notches require the observation count field
const noCountBoxInput: BoxPlotInput = { x: "group", ...boxFields, notch: true };
// @ts-expect-error the portable spec also excludes mixed forms
const mixedBoxSpec: BoxPlotSpec = { ...precomputedBoxSpec, y: "median" };
// @ts-expect-error the portable spec requires notch count
const noCountBoxSpec: BoxPlotSpec = { type: "boxplot", x: "group", ...boxFields, notch: true };
void [
  precomputedBoxSpec,
  rawBoxInput,
  rawBoxSpec,
  mixedBoxInput,
  partialMixedBoxInput,
  partialBoxInput,
  noCountBoxInput,
  mixedBoxSpec,
  noCountBoxSpec,
];

const tips = table({ day: ["thu"], sex: ["f"], tip: [1], low: [0], high: [2] });
bar(tips, { x: "day", y: "tip", series: "sex", legendGroup: "sex" });
errorBar(tips, { x: "day", y1: "low", y2: "high", series: "sex", dodge: true, legendGroup: "sex" });
point(tips, { x: "day", y: "tip", series: "sex", dodge: true, jitter: { width: 0.4, seed: 2 } });
point(tips, { x: "day", y: "tip", jitter: { width: 0.4 } });
// @ts-expect-error jitter takes a width
point(tips, { x: "day", y: "tip", jitter: { seed: 2 } });
// @ts-expect-error jitter is an object, not a width
point(tips, { x: "day", y: "tip", jitter: 0.4 });
// Swarms pack points in their bands, in place of jitter.
point(tips, { x: "day", y: "tip", series: "sex", dodge: true, swarm: true });
// @ts-expect-error a swarm is on or off
point(tips, { x: "day", y: "tip", swarm: 0.5 });

// Lines and areas over categories (dodged like bars) and along y.
line(tips, { x: "day", y: "tip", series: "sex", dodge: true, legendGroup: "sex" });
line(tips, { x: "tip", y: "day" });
line(tips, { x: ["low", "high"], y: "tip", orient: "y" });
area(tips, { x: "tip", y: "low", orient: "y" });
area(tips, { y: "tip", x1: "low", x2: "high" });
area(tips, { x: "day", y: "tip", series: "sex", stack: true });
// @ts-expect-error several value fields along x need a line along y
line(tips, { x: ["low", "high"], y: "tip" });
// @ts-expect-error along x, y holds numbers
line(tips, { x: "tip", y: "day", orient: "x" });
// @ts-expect-error along y, x holds numbers
line(tips, { x: "day", y: "tip", orient: "y" });
// @ts-expect-error a band along y has no y values
area(tips, { y: "tip", x1: "low", x2: "high", x: "low" });
// @ts-expect-error lines along y use the left axis
line(tips, { x: "tip", y: "low", orient: "y", axis: "right" });
// @ts-expect-error a legend group is a name
line(tips, { x: "tip", y: "tip", legendGroup: 1 });
// @ts-expect-error annotations have no series to group
rule(tips, { y: "tip", legendGroup: "sex" });

// Histogram position and layout forms exclude each other.
histogram(readings, {
  y: "at",
  bins: [0, 1, 2] as const,
  normalize: "probability",
  commonNorm: true,
  cumulative: true,
  dodge: true,
});
// With x and y both, a 2D histogram's cells, binned along each axis.
histogram(readings, { x: "at", y: "cpu", bins: { x: 20, y: [0, 50, 100] }, normalize: "density" });
// @ts-expect-error 2D histograms count one distribution: no series, stacks, or dodges
histogram(readings, { x: "at", y: "cpu", stack: true });
// @ts-expect-error per-axis bins are for 2D histograms
histogram(readings, { x: "at", bins: { x: 10 } });
// @ts-expect-error color ramps color 2D histograms' cells; bars take fill
histogram(readings, { x: "at", colors: ["#000000", "#ffffff"] });
// @ts-expect-error the binned axis is required
histogram(readings, { bins: 10 });
// @ts-expect-error binned fields must be numeric or time
histogram(readings, { y: "stage" });
// @ts-expect-error horizontal histograms cannot use the right axis
histogram(readings, { y: "cpu", axis: "right" });
// @ts-expect-error dodge and stack exclude each other
histogram(readings, { x: "at", stack: true, dodge: true });
// Weights, filled stacks, steps, and frequencies.
histogram(usage, {
  x: "cpu",
  series: "host",
  weight: "cpu",
  stack: "fill",
  element: "step",
  normalize: "frequency",
});
// @ts-expect-error weights are number fields
histogram(usage, { x: "cpu", weight: "host" });
// @ts-expect-error a filled stack is not dodged
histogram(usage, { x: "cpu", series: "host", stack: "fill", dodge: true });
// @ts-expect-error bins are drawn as bars, steps, or polygons
histogram(usage, { x: "cpu", element: "line" });

export const horizontalHistogramSpec: HistogramSpec = { type: "histogram", y: "v", dodge: true };
export const cellHistogramSpec: HistogramSpec = { type: "histogram", x: "v", y: "w", bins: 30 };
export const invalidHistogramSpec: HistogramSpec = {
  type: "histogram",
  x: "v",
  y: "v",
  // @ts-expect-error the spec's 2D form takes no series
  series: "s",
};
// @ts-expect-error the spec excludes stack with dodge
export const stackedDodgeSpec: HistogramSpec = {
  type: "histogram",
  x: "v",
  stack: true,
  dodge: true,
};
// @ts-expect-error the spec excludes right horizontal axes
export const rightHistogramSpec: HistogramSpec = { type: "histogram", y: "v", axis: "right" };
// Linkage child ids and heights are number fields, never categories or times.

const linkage = table({ first: [0], second: [1], height: [2], label: ["a"], timestamp: time([0]) });
dendrogram(linkage, {
  first: "first",
  second: "second",
  height: "height",
  leaves: ["a", "b"],
  side: "right",
});
// @ts-expect-error child ids must be number fields
dendrogram(linkage, { first: "label", second: "second", height: "height", leaves: ["a", "b"] });
// @ts-expect-error merge heights cannot be time fields
dendrogram(linkage, { first: "first", second: "second", height: "timestamp", leaves: ["a", "b"] });
// @ts-expect-error fields must exist
dendrogram(linkage, { first: "first", second: "missing", height: "height", leaves: ["a", "b"] });
// @ts-expect-error leaves are string category labels
dendrogram(linkage, { first: "first", second: "second", height: "height", leaves: [1, 2] });
dendrogram(linkage, {
  first: "first",
  second: "second",
  height: "height",
  leaves: ["a", "b"],
  // @ts-expect-error height is plot-relative, with no axis option
  axis: "right",
});
rug(readings, { x: "at", side: "top" });
rug(readings, { y: "cpu", side: "right" });
// @ts-expect-error exactly one observed axis
rug(readings, { x: "at", y: "cpu" });
// @ts-expect-error an observed axis is required
rug(readings, {});
// @ts-expect-error numeric or time observations only
rug(readings, { x: "stage" });
// @ts-expect-error category series only
rug(readings, { x: "at", series: "cpu" });
// @ts-expect-error x ticks stand at bottom or top
rug(readings, { x: "at", side: "right" });
// @ts-expect-error y rugs cannot use the right value axis
rug(readings, { y: "cpu", axis: "right" });
// @ts-expect-error a portable rug spec needs one axis
const rugMissing: RugSpec = { type: "rug" };
// @ts-expect-error a portable rug spec cannot have two axes
const rugBoth: RugSpec = { type: "rug", x: "at", y: "cpu" };

export { rugBoth, rugMissing };

violin(readings, { x: "stage", y: "cpu", series: "stage", split: true, inner: "quartiles" });
violin(readings, { x: "cpu", y: "stage", inner: "none" });
// @ts-expect-error split is boolean
violin(readings, { x: "stage", y: "cpu", split: "true" });
// @ts-expect-error inner takes only the supported interiors
violin(readings, { x: "stage", y: "cpu", inner: "points" });
// @ts-expect-error a series field is categorical
violin(readings, { x: "stage", y: "cpu", series: "cpu", split: true });
const splitViolinSpec: ViolinSpec = {
  type: "violin",
  x: "g",
  y: "v",
  series: "s",
  split: true,
  inner: "quartiles",
};
// @ts-expect-error inner takes only the supported interiors
const invalidViolinSpec: ViolinSpec = { type: "violin", x: "g", y: "v", inner: "points" };
void splitViolinSpec;
void invalidViolinSpec;

// Heatmaps: cells at x and y, placed along number and time axes, a step
// wide, or banded; or the days of a time field as a calendar.
const days = table({ day: time([0, 86_400_000]), hour: [0, 1], host: ["a", "b"], n: [1, 2] });
heatmap(days, { x: "hour", y: "host", color: "n", xStep: 1 });
heatmap(days, { x: "hour", y: "day", color: "n", xBanded: true, yStep: 3_600_000 });
heatmap(days, { date: "day", color: "n", calendar: "months" });
heatmap(days, { date: "day", color: "n", weekStart: "sun" });
// @ts-expect-error a step is for cells along an axis, not bands
heatmap(days, { x: "hour", y: "host", color: "n", xStep: 1, xBanded: true });
// @ts-expect-error a calendar places its date itself
heatmap(days, { date: "day", x: "hour", color: "n" });
// @ts-expect-error a calendar's date is a time field
heatmap(days, { date: "hour", color: "n" });
// @ts-expect-error calendars are by weeks or months
heatmap(days, { date: "day", color: "n", calendar: "years" });
// @ts-expect-error a heatmap needs x and y, or a date
heatmap(days, { x: "hour", color: "n" });
