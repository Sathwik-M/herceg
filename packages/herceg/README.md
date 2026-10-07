# herceg

Framework-independent charts for analytics: columnar data, streaming updates,
level-of-detail rendering, SVG and Canvas output.

> Early development. Line, area, bar, point (scatter), heatmap, and rule marks
> are available; the API may change before 1.0.

## Quick start

```ts
import { createChart, line, rule, table, time } from "herceg";

const metrics = table({
  time: time(timestamps), // Float64Array of epoch ms, or Date[]
  p50: p50Latency, // Float64Array or number[]
  p99: p99Latency,
});

const chart = createChart(document.querySelector("#latency")!, {
  title: "Request latency",
  marks: [line(metrics, { x: "time", y: ["p50", "p99"] }), rule({ y: 250, label: "SLO" })],
  y: { label: "ms" },
});
```

Field names are checked against the table at compile time: `y` only accepts
numeric or time fields, `series` only accepts category fields.

## Data

`table()` builds columnar data. Typed arrays are used without copying; plain
arrays, `Date` arrays, and string arrays are converted once.

```ts
const requests = table({
  time: time(timestamps),
  latency: latencies,
  service: serviceNames, // string[]: a category field
});
requests.numbers("latency"); // Float64Array view of the live rows
requests.categories("service"); // { codes: Int32Array, dictionary: string[] }
```

Row objects can be converted with `fromRows(rows)`. Categories that are
already dictionary-encoded (Arrow dictionaries, pandas categoricals) are used
without decoding: `encodedCategory(codes, dictionary)` takes `Int32Array`
codes (-1 for missing) and the dictionary.

Tables are mutable and charts that read them re-render on the next animation
frame, once per frame however many changes arrive:

```ts
const live = table({ time: time([]), cpu: [] as number[] }, { maxRows: 3_000 });
live.append({ time: [Date.now()], cpu: [0.42] }); // keeps the newest 3,000 rows
live.appendRow({ time: Date.now(), cpu: 0.4 });
live.set("cpu", 0, 0.5);
live.replace("cpu", 0, [0.1, 0.2]); // overwrite rows 0 and 1
live.dropBefore("time", Date.now() - 60_000);
live.reset({ time: newTimes, cpu: newValues });
```

## Marks

```ts
// One line per y field, sharing x.
line(metrics, { x: "time", y: ["p50", "p99"] });
// Long format: one line per category value.
line(requests, { x: "time", y: "latency", series: "service" });
// Options: stroke, strokeWidth, dash, curve ("linear" | "step" | "step-before" | "step-after"), label.

const usage = table({ time: time(timestamps), user: userCpu, system: systemCpu });
area(usage, { x: "time", y: "user" }); // filled to zero
area(usage, { x: "time", y: ["user", "system"], stack: true });
area(metrics, { x: "time", y1: "p50", y2: "p99" }); // band between two fields

rule({ y: 250, label: "SLO" }); // horizontal reference line
rule({ x: deployTime }); // vertical
```

Bars, points, and heatmaps:

```ts
const sales = table({ region: regions, q1: q1Sales, q2: q2Sales });
bar(sales, { x: "region", y: ["q1", "q2"] }); // grouped; stack: true stacks them
bar(requests, { x: "time", y: "latency" }); // number or time x: bars centered on values

point(cars, { x: "weight", y: "mpg", series: "origin", r: 3 });

const load = table({ hour: time(hours), host: hostNames, cpu: cpuValues });
heatmap(load, { x: "hour", y: "host", value: "cpu" });
```

A category field on `x` (bars) or on `x` and `y` (heatmaps) gives a band axis.
Heatmaps also accept number and time fields, with one column or row per
distinct value, up to 4,194,304 cells (bin finer data first). Heatmaps show a
color legend instead of series entries; `colors` takes a ramp of `#rgb` or
`#rrggbb` colors from low to high.

Marks are drawn in array order; rules always draw above other marks.

## Chart options

| Option | Description |
| --- | --- |
| `marks` | Marks to draw, bottom to top (rules are drawn on top). |
| `title`, `description` | Accessible name and description; the title is drawn. |
| `width`, `height` | Fixed size; omitted dimensions follow the container. |
| `x`, `y` | Scale and axis: `type` (`linear`, `log`, `time`), `domain`, `nice`, `zero`, `label`, `grid`, `ticks`, `format` (Intl options), `axis`. |
| `legend` | Shown by default for two or more series; legend entries toggle series. |
| `tooltip` | `true` (default), `false`, or `{ mode: "nearest-x" \| "nearest" }`. |
| `interaction` | `{ zoom: true }` for wheel zoom and drag pan; `{ sync: "name" }` to share cursor and zoom with other charts. |
| `renderer` | `"auto"` (default), `"svg"`, or `"canvas"`. |
| `theme` | `"light"`, `"dark"`, or an object overriding colors and fonts. |
| `locale`, `timeZone` | Label locale and time zone (`"local"`, `"UTC"`, or an IANA name). |

The returned `Chart` has `update(options)`, `setViewport([from, to] | null)`,
`render()`, `toSVG()`, `destroy()`, and `loading` (a promise while the GPU
painter for large point series loads, otherwise undefined).

## Server rendering

`renderToSVG` needs no DOM:

```ts
import { renderToSVG } from "herceg";

const svg = renderToSVG({ width: 640, height: 320, marks: [line(metrics, { x: "time", y: "p99" })] });
```

## Charts from specs

Charts described as JSON, such as those the Python package writes, load
through the `herceg/spec` entry point:

```ts
import { chartFromSpec, specToSVG } from "herceg/spec";

chartFromSpec(element, spec, buffers); // buffers: ArrayBuffers for binary columns
const svg = specToSVG(spec, buffers);
```

A spec's `data` holds tables whose columns are JSON arrays,
`{ type: "time", values }`, binary columns (`{ type: "number" | "time",
dtype: "float64" | "float32" | "int32" | ..., buffer: <index> }`), or
dictionary-encoded categories (`{ type: "category", codes, dictionary }`).
Marks are the same objects as a TypeScript mark's `spec`, with `data` naming
their table.

## Large data

Every point is drawn by default. In the browser, point series of 100,000
points or more are drawn with WebGL2, loaded on demand the first time a chart
needs it; `chart.loading` settles once they are on screen. With
`sampling: "pixel"`, opaque points
whose centers land on the same device pixel are drawn once (above 4,096
points per series), which is faster for dense scatter plots but can drop
subpixel edge coverage. Tooltips find the nearest point through a spatial
grid index. Heatmaps are drawn as one image.

Lines and areas over sorted x are reduced before drawing (M4): within each
device-pixel column, only the first, lowest, highest, and last points of an
unbroken run are kept, so a million-point series draws as a few thousand
points while keeping every column's extremes. Missing values split a line into
separately reduced runs, so data with very many gaps reduces less; dash
patterns can shift slightly because intermediate points are removed.
`renderer: "auto"` moves charts with many drawn points to Canvas. See
`docs/architecture.md` in the repository for details.
