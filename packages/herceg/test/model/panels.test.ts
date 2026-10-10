// Subplots: panels drawing the marks that name them, sharing x.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { rule } from "../../src/marks/rule.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type AxisInspection, type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { LineGeometry, Panel, RectGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const metrics = table({
  t: [0, 1, 2, 3],
  latency: [120, 180, 150, 400],
  requests: [5, 9, 7, 6],
});
const stacked = panels([
  { id: "latency", title: "Latency", y: { label: "ms" } },
  { id: "traffic", title: "Requests" },
]);
const marks = [
  line(metrics, { x: "t", y: "latency", panel: "latency" }),
  bar(metrics, { x: "t", y: "requests", panel: "traffic" }),
  rule({ x: 2, label: "deploy", panel: "*" }),
];
const kinds = (panel: Panel) => panel.marks.map((m) => m.kind);
const axis = (panel: Panel, orient: string) => panel.axes.find((a) => a.orient === orient);

describe("panels", () => {
  it("draw each mark in the panel it names, sharing x, each with a y scale of its own", () => {
    const { model, scene } = build({ marks, panels: stacked });
    const [top, bottom] = scene.panels as [Panel, Panel];
    expect(scene.panels.map((p) => p.key)).toEqual(["latency", "traffic"]);
    expect(model.panels().map((p) => p.label)).toEqual(["Latency", "Requests"]);
    // The line above, the bars below, and the deploy rule in both.
    expect(kinds(top)).toContain("line");
    expect(kinds(top)).not.toContain("rect");
    expect(kinds(bottom)).toContain("rect");
    expect(kinds(bottom)).not.toContain("line");
    expect(kinds(top).filter((k) => k === "rule")).toHaveLength(1);
    expect(kinds(bottom).filter((k) => k === "rule")).toHaveLength(1);
    // Stacked, one column.
    expect(bottom.plot.x).toBe(top.plot.x);
    expect(bottom.plot.y).toBeGreaterThan(top.plot.y + top.plot.height);
    // One x scale; y domains from each panel's own marks.
    const [a, b] = model.panels();
    expect(a!.x.domain).toEqual(b!.x.domain);
    expect(Math.max(...a!.y.domain)).toBeGreaterThanOrEqual(400);
    expect(Math.max(...b!.y.domain)).toBeLessThan(20);
    // x labels under the bottom panel only; titles above each panel; the
    // first panel's y title centered on it.
    expect(axis(top, "bottom")).toBeUndefined();
    expect(axis(bottom, "bottom")).toBeDefined();
    expect(scene.headers.map((h) => h.text)).toEqual(["Latency", "Requests"]);
    const title = axis(top, "left")!.title!;
    expect(title.text).toBe("ms");
    expect(title.y).toBeCloseTo(top.plot.y + top.plot.height / 2);
    expect(axis(bottom, "left")!.title).toBeUndefined();
    expect(describeChart(model)).toContain("Panels: Latency, Requests.");
  });

  it("keep a mark's identity wherever it draws, and report the panel inspected", () => {
    const { model, scene } = build({ marks, panels: stacked });
    const lineKey = (scene.panels[0]!.marks.find((m) => m.kind === "line") as LineGeometry).key;
    // The same key as in a chart without panels: the mark's place in the chart.
    const plain = build({
      marks: [line(metrics, { x: "t", y: "latency" }), bar(metrics, { x: "t", y: "requests" })],
    }).scene;
    expect(plain.panels[0]!.marks.find((m) => m.kind === "line")!.key).toBe(lineKey);
    const bars = scene.panels[1]!.marks.find((m) => m.kind === "rect") as RectGeometry;
    const [bx, by, bw, bh] = Array.from(bars.rects.subarray(0, 4)) as number[];
    const hit = model.inspect(bx! + bw! / 2, by! + bh! / 2) as AxisInspection;
    expect(hit.panel).toBe("traffic");
    expect(hit.points.map((p) => p.label)).toEqual(["requests"]);
  });

  it("let a panel set its own y axis, of another type", () => {
    const { model } = build({
      marks,
      panels: panels([
        { id: "latency", y: { type: "log" } },
        { id: "traffic", y: { domain: [0, 50] } },
      ]),
    });
    const [a, b] = model.panels();
    expect(a!.y.type).toBe("log");
    expect(b!.y.type).toBe("linear");
    expect(b!.y.domain).toEqual([0, 50]);
  });

  it("place panels in rows of the grid's columns, labeling y beside each", () => {
    const { scene } = build({ marks, panels: panels(stacked.list, { columns: 2 }) });
    const [left, right] = scene.panels as [Panel, Panel];
    expect(right.plot.y).toBe(left.plot.y);
    expect(right.plot.x).toBeGreaterThan(left.plot.x + left.plot.width);
    expect(axis(left, "left")).toBeDefined();
    expect(axis(right, "left")).toBeDefined();
  });

  it("share a y scale when asked, if the panels agree on it", () => {
    const { model } = build({ marks, panels: stacked, resolve: { y: "shared" } });
    const [a, b] = model.panels();
    expect(a!.y.domain).toEqual(b!.y.domain);
    expect(() =>
      build({
        marks,
        resolve: { y: "shared" },
        panels: panels([{ id: "latency", y: { type: "log" } }, { id: "traffic" }]),
      }),
    ).toThrow('Panel "traffic" shares a y scale with others');
  });

  it("refuse marks without a panel or naming an unknown one, and what panels cannot do yet", () => {
    const loose = line(metrics, { x: "t", y: "latency" });
    expect(() => build({ marks: [loose], panels: stacked })).toThrow("needs a panel");
    const lost = line(metrics, { x: "t", y: "latency", panel: "errors" });
    expect(() => build({ marks: [lost], panels: stacked })).toThrow('names the panel "errors"');
    expect(() => build({ marks, panels: stacked, interaction: { zoom: "xy" } })).toThrow(
      "along x only",
    );
    expect(() =>
      build({
        marks: [line(table({ t: [0], v: [1], g: ["a"] }), { x: "t", y: "v", panel: "latency" })],
        panels: stacked,
        facet: facet("g"),
      }),
    ).toThrow("facets or panels, not both");
    const slices = pie(table({ k: ["a"], v: [1] }), { category: "k", value: "v" });
    expect(() => build({ marks: [slices], panels: stacked })).toThrow(
      "needs the id of the panel it draws in",
    );
    expect(() => panels([])).toThrow("at least one panel");
    expect(() => panels([{ id: "a" }, { id: "a" }])).toThrow('Two panels have the id "a"');
    expect(() => panels([{ id: "*" }])).toThrow("other than");
    expect(() => panels([{ id: "a" }], { columns: 0 })).toThrow("whole number");
  });

  it("load from spec version 2 and render titles in SVG", () => {
    const spec = (version: 1 | 2) => ({
      version,
      data: { m: { columns: { t: [0, 1], a: [1, 2], b: [30, 40] } } },
      marks: [
        { type: "line" as const, x: "t", y: "a", panel: "top" },
        { type: "line" as const, x: "t", y: "b", panel: "bottom" },
      ],
      panels: [
        { id: "top", title: "Top" },
        { id: "bottom", title: "Bottom", y: { label: "units" } },
      ],
      grid: { columns: 1 },
    });
    const { config } = loadSpec(spec(2), []);
    const svg = renderToSVG({ ...config, width: 400, height: 300 });
    expect(svg).toContain(">Top</text>");
    expect(svg).toContain(">units</text>");
    expect(() => loadSpec(spec(1), [])).toThrow(
      'spec.panels: expected a spec with "version": 2 or later',
    );
    const duplicated = { ...spec(2), panels: [{ id: "top" }, { id: "top" }] };
    expect(() => loadSpec(duplicated, [])).toThrow("a name no other panel has");
  });

  it("read each panel's own axis settings, also when panels share a scale", () => {
    const logs = panels([
      { id: "latency", y: { type: "log", domain: [1, 1000] } },
      { id: "traffic", y: { type: "log", domain: [1, 1000] } },
    ]);
    const shared = build({ marks, panels: logs, resolve: { y: "shared" } }).model.panels();
    expect(shared.map((p) => [p.y.type, p.y.domain])).toEqual([
      ["log", [1, 1000]],
      ["log", [1, 1000]],
    ]);
    // Settings agree when they come out the same, whether set or inherited.
    const inherited = panels([{ id: "latency", y: { type: "log" } }, { id: "traffic" }]);
    expect(() =>
      build({ marks, panels: inherited, y: { type: "log" }, resolve: { y: "shared" } }),
    ).not.toThrow();
    // A time panel and a number panel cannot share a scale.
    const mixed = panels([{ id: "latency" }, { id: "traffic", y: { type: "time" } }]);
    expect(() => build({ marks, panels: mixed, resolve: { y: "shared" } })).toThrow(
      'Panel "traffic" shares a y scale',
    );
    // Formats are part of a shared scale.
    const formats = panels(
      [{ id: "latency", y: { format: { style: "percent" } } }, { id: "traffic" }],
      { columns: 2 },
    );
    expect(() => build({ marks, panels: formats, resolve: { y: "rows" } })).toThrow("format");
  });

  it("show, grid, and title each panel's y axis as its own settings say", () => {
    const own = panels(
      [
        { id: "latency", y: { axis: false } },
        { id: "traffic", y: { grid: true, label: "requests" } },
      ],
      { columns: 2 },
    );
    const { scene } = build({ marks, panels: own, y: { grid: false }, resolve: { y: "rows" } });
    const [left, right] = scene.panels as [Panel, Panel];
    expect(axis(left, "left")).toBeUndefined();
    expect(left.grid.y).toEqual([]);
    expect(right.grid.y.length).toBeGreaterThan(0);
    // The second column's panel keeps its title and labels, sharing its row's scale.
    expect(axis(right, "left")!.title!.text).toBe("requests");
    expect(axis(right, "left")!.ticks.length).toBeGreaterThan(0);
  });

  it("label a panel of annotations only, and choose tooltips by each panel's marks", () => {
    const { scene, model } = build({
      marks: [
        line(metrics, { x: "t", y: ["latency", "requests"], panel: "latency" }),
        rule({ y: 100, label: "limit", panel: "traffic" }),
      ],
      panels: stacked,
    });
    expect(axis(scene.panels[1]!, "left")!.ticks.length).toBeGreaterThan(0);
    // Both lines at the hovered x, as in a chart of lines alone.
    const [top] = model.panels();
    const hit = model.inspect(top!.x.map(1), top!.y.map(180)) as AxisInspection;
    expect(hit.points).toHaveLength(2);
  });

  it("describe a mark with the panel it draws in", () => {
    const times = table({ t: [0, 1], at: time([Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2)]) });
    const { model } = build({
      marks: [
        line(metrics, { x: "t", y: "latency", panel: "latency" }),
        line(times, { x: "t", y: "at", panel: "traffic" }),
        rule({ y: Date.UTC(2026, 0, 1, 12), label: "noon", panel: "traffic" }),
      ],
      panels: panels([{ id: "latency" }, { id: "traffic", y: { type: "time" } }]),
    });
    // The rule in the time panel reads as a time, not as milliseconds.
    expect(describeChart(model)).toContain("noon (y Jan 1, 2026, 12:00)");
  });

  it("refuse panels named without panels, in charts and specs", () => {
    const named = line(metrics, { x: "t", y: "latency", panel: "latency" });
    expect(() => build({ marks: [named] })).toThrow("names a panel, but the chart has no panels");
    const spec = (extra: object) => () =>
      loadSpec(
        {
          version: 2,
          data: { m: { columns: { t: [0, 1], a: [1, 2] } } },
          marks: [{ type: "line", x: "t", y: "a" }],
          ...extra,
        } as never,
        [],
      );
    expect(spec({ grid: { columns: 2 } })).toThrow("spec.grid: expected a spec with panels");
    expect(spec({ panels: [{ id: "top" }] })).toThrow("marks[0].panel");
  });

  it("size rows by their relative heights, planning each row's axis over its own height", () => {
    const tall = panels(stacked.list, { rowHeights: [3, 1] });
    const { scene, model } = build({ marks, panels: tall });
    const [top, bottom] = scene.panels as [Panel, Panel];
    expect(top.plot.height / bottom.plot.height).toBeCloseTo(3, 1);
    expect(bottom.plot.y).toBeGreaterThan(top.plot.y + top.plot.height);
    // Each y scale spans its own panel.
    const [, b] = model.panels();
    expect(Math.max(...b!.y.range)).toBeCloseTo(bottom.plot.y + bottom.plot.height);
    expect(Math.min(...b!.y.range)).toBeCloseTo(bottom.plot.y);
    // A shared scale keeps one domain over rows of different heights, each
    // row's labels on its own ticks.
    const shared = build({ marks, panels: tall, resolve: { y: "shared" } });
    const [s0, s1] = shared.model.panels();
    expect(s1!.y.domain).toEqual(s0!.y.domain);
    for (const result of [scene, shared.scene]) {
      for (const panel of result.panels) {
        const ticks = panel.axes.find((axis) => axis.orient === "left")!.ticks;
        expect(ticks.length).toBeGreaterThan(1);
        for (const { position } of ticks) {
          expect(position).toBeGreaterThanOrEqual(panel.plot.y - 0.5);
          expect(position).toBeLessThanOrEqual(panel.plot.y + panel.plot.height + 0.5);
        }
      }
    }
    expect(() => panels(stacked.list, { rowHeights: [1] })).toThrow("needs 2 row heights");
    expect(() => panels(stacked.list, { rowHeights: [1, 0] })).toThrow("positive numbers");
  });

  it("leave room for points at the ends of a shared scale in every row", () => {
    const ends = table({ t: [0, 1], v: [0, 100] });
    const dots = (panel: string) => point(ends, { x: "t", y: "v", r: 10, panel });
    const { model } = build({
      marks: [dots("latency"), dots("traffic")],
      panels: panels(stacked.list, { rowHeights: [3, 1] }),
      resolve: { y: "shared" },
    });
    for (const { y, plot } of model.panels()) {
      expect(y.map(100) - plot.y).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(plot.y + plot.height - y.map(0)).toBeGreaterThanOrEqual(10 - 1e-9);
    }
  });

  it("lay out huge weights as their ratio, and format tooltips for each row's height", () => {
    const heights = (rowHeights: number[]) =>
      build({ marks, panels: panels(stacked.list, { rowHeights }) }).scene.panels.map(
        (panel) => panel.plot.height,
      );
    expect(heights([1e307, 1e307])).toEqual(heights([1, 1]));
    expect(heights([1e308, 1e308])).toEqual(heights([1, 1]));
    // A time axis in a tall row shows tooltip values finer than in a short one.
    const times = table({ t: [0, 1], at: time([0, 120_100]) });
    const timeline = (panel: string) => line(times, { x: "t", y: "at", panel });
    const { model } = build({
      marks: [timeline("latency"), timeline("traffic")],
      panels: panels(
        [
          { id: "latency", y: { type: "time", nice: false } },
          { id: "traffic", y: { type: "time", nice: false } },
        ],
        { rowHeights: [1, 6] },
      ),
    });
    const short = model.formatsOf(undefined, "latency").y(120_100);
    const tall = model.formatsOf(undefined, "traffic").y(120_100);
    expect(tall.length).toBeGreaterThan(short.length);
  });
});

describe("panels in weighted columns", () => {
  const side = panels(stacked.list, { columns: 2, columnWidths: [3, 1] });

  it("size columns by their relative widths, sharing x over columns of different widths", () => {
    const { scene, model } = build({ marks, panels: side });
    const [left, right] = scene.panels as [Panel, Panel];
    expect(left.plot.width / right.plot.width).toBeCloseTo(3, 1);
    expect(right.plot.x).toBeGreaterThan(left.plot.x + left.plot.width);
    const [a, b] = model.panels();
    expect(b!.x.domain).toEqual(a!.x.domain);
    expect(a!.x.range).toEqual([left.plot.x, left.plot.x + left.plot.width]);
    expect(b!.x.range).toEqual([right.plot.x, right.plot.x + right.plot.width]);
    // Each column's labels are on ticks for its width, inside its panel.
    const ticks = (panel: Panel) => axis(panel, "bottom")!.ticks;
    expect(ticks(left).length).toBeGreaterThan(ticks(right).length);
    for (const panel of [left, right]) {
      for (const { position } of ticks(panel)) {
        expect(position).toBeGreaterThanOrEqual(panel.plot.x - 0.5);
        expect(position).toBeLessThanOrEqual(panel.plot.x + panel.plot.width + 0.5);
      }
    }
    // Tooltips resolve x as finely as each column's width does.
    const times = table({ t: time([0, 3_600_000]), v: [1, 2] });
    const timeline = (panel: string) => line(times, { x: "t", y: "v", panel });
    const timed = build({
      marks: [timeline("latency"), timeline("traffic")],
      panels: panels(stacked.list, { columns: 2, columnWidths: [12, 1] }),
    }).model;
    const wide = timed.formatsOf(undefined, "latency").x(1_234_567);
    const narrow = timed.formatsOf(undefined, "traffic").x(1_234_567);
    expect(wide.length).toBeGreaterThan(narrow.length);
  });

  it("leave room for points at the ends of a shared x scale in every column", () => {
    const ends = table({ t: [0, 1], v: [0, 100] });
    const dots = (panel: string) => point(ends, { x: "t", y: "v", r: 10, panel });
    const { model } = build({ marks: [dots("latency"), dots("traffic")], panels: side });
    for (const { x, plot } of model.panels()) {
      expect(x.map(0) - plot.x).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(plot.x + plot.width - x.map(1)).toBeGreaterThanOrEqual(10 - 1e-9);
    }
  });

  it("keep x labels clear of the next column's y labels", () => {
    const { scene } = build({ marks, panels: side, resolve: { y: "independent" } }, 500, 300);
    const [left, right] = scene.panels as [Panel, Panel];
    const last = axis(left, "bottom")!.ticks.at(-1)!;
    const end = last.position + estimateText(last.label, scene.theme.font) / 2;
    const widestY = Math.max(
      ...axis(right, "left")!.ticks.map((t) => estimateText(t.label, scene.theme.font)),
    );
    expect(end).toBeLessThan(right.plot.x - widestY);
  });

  it("lay equal columns out as before weights existed", () => {
    // Labels reaching into the gap between two columns once rounded it to 65 pixels.
    const values = table({ x: [10000, 20000, 30000], y: [1, 4, 2] });
    const { scene } = build(
      {
        marks: [point(values, { x: "x", y: "y", panel: "*" })],
        panels: panels(
          [
            { id: "a", title: "A" },
            { id: "b", title: "B" },
          ],
          { columns: 2 },
        ),
        x: { format: { useGrouping: false } },
        theme: { font: "monospace", fontSize: 10 },
      },
      599,
      600,
    );
    const [left, right] = scene.panels as [Panel, Panel];
    expect([left.plot.width, right.plot.width]).toEqual([241, 241]);
    expect(right.plot.x - (left.plot.x + left.plot.width)).toBe(65);
  });

  it("give x scales of their own and category axes each column's width", () => {
    const { model, scene } = build({ marks, panels: side, resolve: { x: "independent" } });
    for (const [i, { x }] of model.panels().entries()) {
      const { plot } = scene.panels[i]!;
      expect(x.range).toEqual([plot.x, plot.x + plot.width]);
    }
    const sales = table({ region: ["n", "s", "e"], v: [3, 5, 2] });
    const bars = build({
      marks: [bar(sales, { x: "region", y: "v", panel: "*" })],
      panels: side,
    });
    const [wide, narrow] = bars.scene.panels as [Panel, Panel];
    const [first, second] = bars.model.panels();
    expect(first!.x.range).toEqual([wide.plot.x, wide.plot.x + wide.plot.width]);
    expect(second!.x.range).toEqual([narrow.plot.x, narrow.plot.x + narrow.plot.width]);
    // Bars fill the same share of each column.
    const barWidth = (panel: Panel) =>
      (panel.marks.find((m) => m.kind === "rect") as RectGeometry).rects[2]!;
    expect(barWidth(wide) / barWidth(narrow)).toBeCloseTo(wide.plot.width / narrow.plot.width, 5);
  });

  it("check their widths, in options and in specs", () => {
    expect(() => panels(stacked.list, { columns: 2, columnWidths: [1] })).toThrow(
      "needs 2 column widths",
    );
    // A grid has no more columns than panels.
    expect(() => panels(stacked.list, { columns: 3, columnWidths: [1, 1, 1] })).toThrow(
      "A grid of 2 columns needs 2 column widths, not 3",
    );
    expect(() => panels(stacked.list, { columns: 2, columnWidths: [1, Number.NaN] })).toThrow(
      "positive numbers",
    );
    // Holes in sparse arrays are not weights.
    expect(() => panels(stacked.list, { columns: 2, columnWidths: new Array<number>(2) })).toThrow(
      "positive numbers",
    );
    expect(() => panels(stacked.list, { rowHeights: new Array<number>(2) })).toThrow(
      "positive numbers",
    );
    const spec = (columnWidths: unknown) => () =>
      loadSpec({
        version: 3,
        data: { m: { columns: { t: [0, 1], v: [1, 2] } } },
        panels: [{ id: "a" }, { id: "b" }],
        grid: { columns: 2, columnWidths },
        marks: [{ type: "line", data: "m", x: "t", y: "v", panel: "*" }],
      } as never);
    expect(spec([2, 1])().config.panels).toBeDefined();
    expect(spec([2, -1])).toThrow("spec.grid.columnWidths[1]");
    expect(spec([])).toThrow("spec.grid.columnWidths");
  });
});

describe("panels with x scales of their own", () => {
  const day = Date.UTC(2026, 9, 9);
  const series = table({
    time: time([day, day + 3_600_000, day + 7_200_000]),
    latency: [120, 180, 150],
  });
  const histogram = table({ ms: [100, 150, 200], count: [4, 9, 2] });
  const config = (resolve?: ChartConfig["resolve"]): ChartConfig => ({
    marks: [
      line(series, { x: "time", y: "latency", panel: "series" }),
      bar(histogram, { x: "ms", y: "count", panel: "spread" }),
    ],
    panels: panels(
      [
        { id: "series", title: "Over time", x: { label: "Time" } },
        { id: "spread", title: "Spread", x: { label: "Latency (ms)" } },
      ],
      { rowHeights: [2, 1] },
    ),
    ...(resolve && { resolve }),
  });

  it("give each panel its own x type, domain, labels, and title", () => {
    const { model, scene } = build(config({ x: "independent" }));
    const [a, b] = model.panels();
    expect(a!.x.type).toBe("time");
    expect(b!.x.type).toBe("linear");
    expect(Math.min(...b!.x.domain)).toBeLessThanOrEqual(100);
    expect(Math.max(...b!.x.domain)).toBeLessThan(1000);
    const [top, bottom] = scene.panels as [Panel, Panel];
    expect(axis(top, "bottom")!.title!.text).toBe("Time");
    expect(axis(bottom, "bottom")!.title!.text).toBe("Latency (ms)");
    // The title sits under the panel's labels, above the next panel's header.
    const title = axis(top, "bottom")!.title!;
    expect(title.x).toBeCloseTo(top.plot.x + top.plot.width / 2, 5);
    expect(title.y).toBeGreaterThan(top.plot.y + top.plot.height);
    expect(title.y).toBeLessThan(bottom.plot.y - 10);
    // Weighted rows keep their weights.
    expect(top.plot.height / bottom.plot.height).toBeCloseTo(2, 5);
    // Tooltips format each panel's x as its own scale does.
    expect(model.formatsOf(undefined, "series").x(day)).toMatch(/Oct|2026|00:00/);
    expect(model.formatsOf(undefined, "spread").x(150)).toBe("150");
  });

  it("share x by default, with the first panel's settings", () => {
    const shared = config();
    const { model, scene } = build({
      ...shared,
      marks: [
        line(metrics, { x: "t", y: "latency", panel: "series" }),
        bar(metrics, { x: "t", y: "requests", panel: "spread" }),
      ],
      panels: panels([
        { id: "series", x: { label: "t" } },
        { id: "spread", x: { label: "t" } },
      ]),
    });
    expect(model.sharesX).toBe(true);
    const [top, bottom] = scene.panels as [Panel, Panel];
    expect(axis(top, "bottom")).toBeUndefined();
    expect(axis(bottom, "bottom")!.title!.text).toBe("t");
    // Panels sharing x must agree on how it is set up, its title included.
    expect(() =>
      build({
        ...shared,
        marks: [line(metrics, { x: "t", y: "latency", panel: "series" })],
        panels: panels([
          { id: "series", x: { label: "a" } },
          { id: "spread", x: { label: "b" } },
        ]),
      }),
    ).toThrow('Panel "spread" shares an x scale with others but differs');
    expect(() =>
      build({
        ...shared,
        marks: [line(metrics, { x: "t", y: "latency", panel: "series" })],
        panels: panels([{ id: "series" }, { id: "spread", x: { domain: [0, 1] } }]),
        resolve: { x: "independent" },
      }),
    ).not.toThrow();
  });

  it("let a panel show the x axis the chart leaves out, and the other way round", () => {
    const { scene } = build({
      ...config({ x: "independent" }),
      x: { axis: false },
      panels: panels([{ id: "series" }, { id: "spread", x: { axis: true } }]),
    });
    const [top, bottom] = scene.panels as [Panel, Panel];
    expect(axis(top, "bottom")).toBeUndefined();
    expect(axis(bottom, "bottom")!.ticks.length).toBeGreaterThan(0);
    const hidden = build({
      ...config({ x: "independent" }),
      panels: panels([{ id: "series", x: { axis: false } }, { id: "spread" }]),
    });
    expect(hidden.scene.panels.map((p) => axis(p, "bottom") !== undefined)).toEqual([false, true]);
  });

  it("center a row's x title under the row, whichever of its panels are labeled", () => {
    const list = ["a", "b", "c"].map((id) => ({ id, x: { label: "t" } }));
    const { scene } = build({
      marks: ["a", "b", "c"].map((panel) => line(metrics, { x: "t", y: "latency", panel })),
      panels: panels(
        list.map((p) => (p.id === "b" ? { ...p, x: { ...p.x, axis: false } } : p)),
        { columns: 2 },
      ),
      resolve: { x: "rows" },
    });
    const [a, b, c] = scene.panels as [Panel, Panel, Panel];
    // b's labels are left out; the row's title still centers on a and b.
    expect(axis(b, "bottom")).toBeUndefined();
    const title = axis(a, "bottom")!.title!;
    expect(title.x).toBeCloseTo((a.plot.x + b.plot.x + b.plot.width) / 2, 5);
    // The last row holds c alone.
    expect(axis(c, "bottom")!.title!.x).toBeCloseTo(c.plot.x + c.plot.width / 2, 5);
  });

  it("label a shared y fully in weighted rows with x titles between them", () => {
    // Two rows sharing y, the first twice as tall, each with x labels and a title.
    const readings = table({ t: [0, 1, 2, 3], v: [-5, 25, 10, 0] });
    const { model, scene } = build(
      {
        marks: [
          point(readings, { x: "t", y: "v", panel: "a" }),
          point(readings, { x: "t", y: "v", panel: "b" }),
        ],
        panels: panels(
          [
            { id: "a", x: { label: "First" } },
            { id: "b", x: { label: "Second" } },
          ],
          { rowHeights: [2, 1] },
        ),
        resolve: { x: "independent", y: "shared" },
      },
      400,
      300,
    );
    const [a, b] = model.panels();
    expect(b!.plot.height).toBeLessThan(100);
    expect(a!.plot.height / b!.plot.height).toBeCloseTo(2, 5);
    const yLabels = scene.panels.map((p) => axis(p, "left")!.ticks.map((t) => t.label));
    // Both rows, planned on the shorter one's two ticks and the taller
    // one's own count, label the rounded values of one domain.
    expect(yLabels).toEqual([
      ["-20", "0", "20", "40"],
      ["-20", "0", "20", "40"],
    ]);
    expect(a!.y.domain).toEqual(b!.y.domain);
    expect(scene.panels.map((p) => axis(p, "bottom")!.title!.text)).toEqual(["First", "Second"]);
  });

  it("load panels' x settings from specs", () => {
    const { config: loaded } = loadSpec(
      {
        version: 3,
        data: { m: { columns: { t: [0, 1], v: [1, 2] } } },
        marks: [{ type: "line", data: "m", x: "t", y: "v", panel: "a" }],
        panels: [{ id: "a", x: { label: "Seconds", type: "log" } }, { id: "b" }],
        resolve: { x: "independent" },
      },
      [],
    );
    const { model, scene } = build(loaded);
    expect(model.panels()[0]!.x.type).toBe("log");
    expect(axis(scene.panels[0]!, "bottom")!.title!.text).toBe("Seconds");
    expect(() =>
      loadSpec(
        {
          version: 3,
          marks: [],
          panels: [{ id: "a", x: { type: "radial" } as never }],
        },
        [],
      ),
    ).toThrow("panels[0].x.type");
    expect(() =>
      loadSpec({ version: 2, marks: [], panels: [{ id: "a", x: { label: "s" } }] }, []),
    ).toThrow('spec.panels[0].x: expected a spec with "version": 3');
  });
});
