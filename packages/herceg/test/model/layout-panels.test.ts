// Layout marks in facet panels and subplots: each panel's rows, one legend
// and one color per item key across panels, and what tooltips, the keyboard,
// and the description read, panel by panel.
import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { radar } from "../../src/marks/radar.ts";
import { sankey } from "../../src/marks/sankey.ts";
import { sunburst } from "../../src/marks/sunburst.ts";
import { TreeData } from "../../src/marks/tree-data.ts";
import { treemap } from "../../src/marks/treemap.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import type { Rect, SegmentGeometry, TextGeometry } from "../../src/scene/scene.ts";
import { legendOf } from "../helpers/guides.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

/** Every item of a panel, in reading order. */
function items(model: ChartModel, panel: string) {
  const out: { label: string; text: string; color: string; key: string }[] = [];
  let key = model.stepItem(undefined, 1, panel);
  while (key !== undefined && !out.some((item) => item.key === key)) {
    const point = model.inspectItem(key, panel)!.points[0]!;
    out.push({ label: point.label, text: point.text, color: point.color, key });
    key = model.stepItem(key, 1, panel);
  }
  return out;
}

// North: a 50, b 30, c 20. South: a 10, b 30.
const sales = table({
  region: ["North", "North", "North", "South", "South"],
  product: ["a", "b", "c", "a", "b"],
  revenue: [50, 30, 20, 10, 30],
  week: [0, 1, 2, 3, 4],
});
const shares = (options: { panel?: string } = {}) =>
  pie(sales, { category: "product", value: "revenue", ...options });

describe("pies in facet panels", () => {
  it("sum only their panel's rows", () => {
    const { model } = build({ marks: [shares()], facet: facet("region") });
    expect(items(model, "North").map(({ label, text }) => `${label} ${text}`)).toEqual([
      "a 50 (50%)",
      "b 30 (30%)",
      "c 20 (20%)",
    ]);
    expect(items(model, "South").map(({ label, text }) => `${label} ${text}`)).toEqual([
      "b 30 (75%)",
      "a 10 (25%)",
    ]);
  });

  it("give a category one key, one color, and one legend entry in every panel", () => {
    const { model, scene } = build({ marks: [shares()], facet: facet("region") });
    expect(legendOf(scene).map(({ label }) => label)).toEqual(["a", "b", "c"]);
    const colors = new Map(legendOf(scene).map(({ key, color }) => [key, color]));
    for (const panel of ["North", "South"])
      for (const { key, color } of items(model, panel)) expect(color).toBe(colors.get(key));
    expect(new Set(colors.values()).size).toBe(3);
  });

  it("hide a category in every panel through the legend", () => {
    const { model } = build({ marks: [shares()], facet: facet("region") });
    const [a] = items(model, "North");
    model.hidden.add(a!.key);
    model.scene(estimateText);
    expect(items(model, "North").map(({ label, text }) => `${label} ${text}`)).toEqual([
      "b 30 (60%)",
      "c 20 (40%)",
    ]);
    expect(items(model, "South").map(({ label, text }) => `${label} ${text}`)).toEqual([
      "b 30 (100%)",
    ]);
  });

  it("find the slice under the pointer in the panel holding it", () => {
    const { model } = build({ marks: [shares()], facet: facet("region") });
    const [, south] = model.allPanels();
    const { plot } = south!;
    const found = model.inspect(plot.x + plot.width / 2 + 10, plot.y + plot.height / 2);
    expect(found!.panel).toBe("South");
    expect(found!.points[0]!.label).toBe("b");
    // A pixel of the panel off the pie, and one in no panel, find nothing.
    expect(model.inspect(plot.x + 1, plot.y + 1)).toBeUndefined();
    expect(model.inspect(1, 1)).toBeUndefined();
  });

  it("keep their labels and leader lines inside their panel", () => {
    const { scene } = build({ marks: [shares()], facet: facet("region") }, 420, 260);
    for (const panel of scene.panels) {
      const inside = (x: number, y: number, plot: Rect) =>
        x >= plot.x - 0.5 &&
        x <= plot.x + plot.width + 0.5 &&
        y >= plot.y - 0.5 &&
        y <= plot.y + plot.height + 0.5;
      const leaders = panel.marks.find((m) => m.kind === "segments") as SegmentGeometry;
      for (let k = 0; k < leaders.count * 2; k++)
        expect(inside(leaders.coords[k * 2]!, leaders.coords[k * 2 + 1]!, panel.plot)).toBe(true);
      for (const labels of panel.marks.filter((m) => m.kind === "text") as TextGeometry[])
        for (let k = 0; k < labels.count; k++)
          expect(inside(labels.coords[k * 2]!, labels.coords[k * 2 + 1]!, panel.plot)).toBe(true);
    }
  });

  it("describe each panel after its name, up to twenty", () => {
    const { model } = build({ marks: [shares()], facet: facet("region") });
    expect(describeChart(model)).toBe(
      "Panels by region: North, South. North: Pie of revenue by product: 3 slices totaling 100. Largest: a 50%, b 30%, c 20%. South: Pie of revenue by product: 2 slices totaling 40. Largest: b 75%, a 25%.",
    );
    const many = table({
      region: Array.from({ length: 25 }, (_, i) => `r${i}`),
      product: Array.from({ length: 25 }, () => "a"),
    });
    const big = build(
      { marks: [pie(many, { category: "product" })], facet: facet("region") },
      1200,
      1200,
    );
    const said = describeChart(big.model);
    expect(said).toContain("r19: Pie of product: 1 slice totaling 1.");
    expect(said).not.toContain("r20: Pie");
    expect(said).toContain("5 more panels.");
  });

  it("draw one empty panel when the facet field has no values", () => {
    const none = table({ region: category([]), product: category([]) });
    const { model, scene } = build({
      marks: [pie(none, { category: "product" })],
      facet: facet("region"),
    });
    expect(scene.panels).toHaveLength(1);
    expect(model.stepItem(undefined, 1, "")).toBeUndefined();
    expect(describeChart(model)).toContain("Pie of product, with nothing to show.");
  });

  it("follow their table as rows arrive, and let go of panels when the chart changes", () => {
    const live = table({ region: ["North"], product: ["a"], revenue: [1] });
    const config = {
      marks: [pie(live, { category: "product", value: "revenue" })],
      facet: facet("region"),
    };
    const { model } = build(config);
    expect(model.allPanels().map(({ key }) => key)).toEqual(["North"]);
    live.append({ region: ["South", "North"], product: ["b", "b"], revenue: [2, 3] });
    model.scene(estimateText);
    expect(model.allPanels().map(({ key }) => key)).toEqual(["North", "South"]);
    const north = items(model, "North");
    expect(north.map(({ text }) => text)).toEqual(["3 (75%)", "1 (25%)"]);
    model.update({ marks: [line(sales, { x: "week", y: "revenue" })] });
    model.scene(estimateText);
    expect(model.allPanels().map(({ key, items }) => [key, items])).toEqual([["", false]]);
    expect(model.inspectItem(north[0]!.key, "North")).toBeUndefined();
    expect(model.layoutSummary()).toBeUndefined();
  });
});

describe("a layout mark in a subplot", () => {
  const subplots = (marks: ChartConfig["marks"], columns = 2) => ({
    marks,
    panels: panels(
      [
        { id: "trend", title: "Trend" },
        { id: "share", title: "Share" },
      ],
      { columns },
    ),
  });

  it("keeps every mark's place among the chart's as its identity, the pie first or not", () => {
    for (const first of ["pie", "line"]) {
      const marks =
        first === "pie"
          ? [shares({ panel: "share" }), line(sales, { x: "week", y: "revenue", panel: "trend" })]
          : [line(sales, { x: "week", y: "revenue", panel: "trend" }), shares({ panel: "share" })];
      const { model } = build(subplots(marks));
      const pieAt = first === "pie" ? 0 : 1;
      const [slice] = items(model, "share");
      expect(JSON.parse(slice!.key)[0]).toBe(pieAt);
      expect(model.inspectItem(slice!.key, "share")!.points[0]!.mark).toBe(pieAt);
      const [series] = model.keyboardStops("trend");
      expect(JSON.parse(series!.key)[0]).toBe(1 - pieAt);
      expect(model.inspectPosition(series!.key, 0, "trend")!.points[0]!.mark).toBe(1 - pieAt);
      // The legend follows the marks' order.
      const labels = model.legendEntries().map(({ label }) => label);
      expect(labels.indexOf("revenue") < labels.indexOf("a")).toBe(first === "line");
    }
  });

  it("draws without axes while the line's panel keeps its own, the pie below it or beside it", () => {
    const marks = [
      line(sales, { x: "week", y: "revenue", panel: "trend" }),
      shares({ panel: "share" }),
    ];
    for (const columns of [1, 2]) {
      const { scene, model } = build(subplots(marks, columns));
      const [trend, share] = scene.panels;
      expect(trend!.axes.map(({ side }) => side).sort()).toEqual(["bottom", "left"]);
      expect(trend!.axes.find(({ side }) => side === "bottom")!.ticks.length).toBeGreaterThan(0);
      expect(share!.axes).toEqual([]);
      expect(share!.grid).toEqual({ x: [], y: [] });
      expect(model.panels().map(({ key }) => key)).toEqual(["trend"]);
      expect(model.allPanels().map(({ key, items }) => [key, items])).toEqual([
        ["trend", false],
        ["share", true],
      ]);
      if (columns === 1) {
        // The line's x labels go between it and the pie under it.
        const labelsEnd = trend!.plot.y + trend!.plot.height + 25;
        expect(share!.plot.y).toBeGreaterThan(labelsEnd);
      }
    }
  });

  it("leaves room between rows for the x title of the line above it", () => {
    const marks = [
      line(sales, { x: "week", y: "revenue", panel: "trend" }),
      shares({ panel: "share" }),
    ];
    for (const titled of [false, true]) {
      const { scene } = build({
        marks,
        panels: panels([{ id: "trend", ...(titled && { title: "Trend" }) }, { id: "share" }]),
        x: { title: "Week" },
      });
      const [trend, share] = scene.panels;
      const title = trend!.axes.find(({ side }) => side === "bottom")!.title!;
      expect(title.text).toBe("Week");
      // Below the line's plot, and clear of the pie's (and of its header's line).
      expect(title.y).toBeGreaterThan(trend!.plot.y + trend!.plot.height);
      expect(title.y + 8).toBeLessThan(share!.plot.y);
    }
  });

  it("leaves the pie's panel out of the room y labels take", () => {
    const marks = [
      line(sales, { x: "week", y: "revenue", panel: "trend" }),
      shares({ panel: "share" }),
    ];
    const plain = build({
      marks,
      panels: panels([{ id: "trend" }, { id: "share" }], { columns: 2 }),
    });
    // The chart's y format, which only the pie's panel would take, labels nothing.
    const wide = build({
      marks,
      panels: panels(
        [{ id: "trend", y: { format: { maximumFractionDigits: 0 } } }, { id: "share" }],
        { columns: 2 },
      ),
      y: { format: { minimumFractionDigits: 20 } },
    });
    expect(wide.scene.panels[0]!.plot).toEqual(plain.scene.panels[0]!.plot);
    // Nor does a y title only the pie's panel would take.
    const untitled = build({
      marks,
      panels: panels([{ id: "trend", y: { title: "" } }, { id: "share" }], { columns: 2 }),
      y: { title: "Revenue" },
    });
    expect(untitled.scene.panels[0]!.plot).toEqual(plain.scene.panels[0]!.plot);
  });

  it("leaves a scale's room for glyphs to the panels with axes, in weighted grids", () => {
    const dots = point(sales, { x: "week", y: "revenue", radius: 12, panel: "trend" });
    for (const across of [true, false]) {
      const { model } = build({
        marks: [dots, shares({ panel: "share" })],
        panels: panels(
          [{ id: "trend" }, { id: "share" }],
          across ? { columns: 2, columnWidths: [10, 1] } : { rowHeights: [10, 1] },
        ),
        y: { scope: "chart" },
      });
      const [trend] = model.panels();
      const { plot, x, y } = trend!;
      // The dots reach about their radius past their values, not a narrow panel's share.
      if (across) expect(x.map(0) - plot.x).toBeLessThan(30);
      else expect(plot.y + plot.height - y.map(10)).toBeLessThan(30);
    }
  });

  it("is named in the description, beside the line's series", () => {
    const { model } = build(
      subplots([
        line(sales, { x: "week", y: "revenue", panel: "trend" }),
        shares({ panel: "share" }),
      ]),
    );
    expect(describeChart(model)).toBe(
      "Line chart with 1 series. Panels: Trend, Share. Share: Pie of revenue by product: 3 slices totaling 140. Largest: a 42.9%, b 42.9%, c 14.3%. revenue: 5 points, from 10 to 50, last 30.",
    );
  });
});

describe("other layout marks in facet panels", () => {
  const regions = facet("region");

  it("treemaps and sunbursts total each panel's rows over the table's tree", () => {
    for (const make of [treemap, sunburst]) {
      const { model } = build({
        marks: [make(sales, { path: ["product"], value: "revenue" })],
        facet: regions,
      });
      expect(model.layoutSummary("North")).toContain("3 leaves in 3 groups totaling 100");
      expect(model.layoutSummary("South")).toContain("2 leaves in 2 groups totaling 40");
      expect(model.layoutSummary("South")).toContain("Largest: b 75%, a 25%");
    }
  });

  it("trees keep only the part their panel's rows give a value", () => {
    const leaves = table({
      region: Array.from({ length: 100 }, (_, i) => `r${i % 4}`),
      leaf: Array.from({ length: 100 }, (_, i) => `leaf ${i}`),
      value: Array.from({ length: 100 }, (_, i) => 1 + (i % 3)),
    });
    const data = new TreeData(
      leaves as unknown as Table,
      { path: ["leaf"], value: "value" },
      "treemap",
    );
    const rows = Uint32Array.from({ length: 25 }, (_, k) => k * 4);
    const part = data.view(rows);
    expect(data.view().tree.size).toBe(101);
    expect(part.tree.size).toBe(26);
    expect(part.tops).toHaveLength(25);
    // A node's key is the same in the part as in the whole tree.
    const whole = data.view();
    expect(data.keyOf("t", part, 1)).toBe(data.keyOf("t", whole, 1));
    expect(data.view(rows)).toBe(part);
  });

  it("gauges show the last finite value of their panel's rows", () => {
    const readings = table({
      region: ["North", "South", "North", "South"],
      value: [10, 20, 30, Number.NaN],
    });
    const { model } = build({ marks: [gauge(readings, { value: "value" })], facet: regions });
    const read = (panel: string) => model.inspectItem(model.stepItem(undefined, 1, panel)!, panel)!;
    expect(read("North").points[0]!).toMatchObject({ value: 30, row: 2 });
    expect(read("South").points[0]!).toMatchObject({ value: 20, row: 1 });
  });

  it("funnels have the stages their panel's rows name, with zeros kept", () => {
    const steps = table({
      region: ["North", "North", "North", "South", "South"],
      stage: ["visit", "cart", "buy", "visit", "cart"],
      users: [100, 40, 0, 50, 10],
    });
    const { model } = build({
      marks: [funnel(steps, { category: "stage", value: "users" })],
      facet: regions,
    });
    expect(items(model, "North").map(({ label }) => label)).toEqual(["visit", "cart", "buy"]);
    expect(items(model, "South").map(({ label }) => label)).toEqual(["visit", "cart"]);
  });

  it("radars share the table's spokes, each panel its own values", () => {
    const scores = table({
      region: ["North", "North", "North", "South", "South"],
      skill: ["speed", "power", "range", "speed", "power"],
      score: [3, 6, 9, 4, 8],
    });
    const { model } = build({
      marks: [radar(scores, { category: "skill", value: "score" })],
      facet: regions,
    });
    expect(model.layoutSummary("North")).toContain("3 spokes");
    expect(model.layoutSummary("South")).toContain("3 spokes");
    expect(items(model, "South").map(({ text }) => text.split(":")[0])).toEqual(["speed", "power"]);
  });

  it("Sankey diagrams draw the flows of their panel's rows", () => {
    const flows = table({
      region: ["North", "North", "South"],
      from: ["a", "b", "a"],
      to: ["b", "c", "c"],
      amount: [3, 2, 4],
    });
    const { model } = build({
      marks: [sankey(flows, { source: "from", target: "to", value: "amount" })],
      facet: regions,
    });
    expect(model.layoutSummary("North")).toContain("3 nodes");
    expect(model.layoutSummary("South")).toContain("2 nodes");
    expect(items(model, "South").map(({ label }) => label)).toEqual(["a", "c", "a → c"]);
  });
});
