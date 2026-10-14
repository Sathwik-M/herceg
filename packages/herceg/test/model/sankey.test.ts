import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { line } from "../../src/marks/line.ts";
import { bandTop, sankey } from "../../src/marks/sankey.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type {
  PathShape,
  RectGeometry,
  Scene,
  ShapesGeometry,
  TextGeometry,
} from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { legendOf } from "../helpers/guides.ts";

// Coal and gas feed electricity, homes, and industry; electricity loses some.
// The last four rows are left out: a negative value, a missing target, a
// zero, and a link from coal to itself.
const energy = () =>
  table({
    from: ["Coal", "Coal", "Gas", "Gas", "Electricity", "Electricity", "Electricity"].concat([
      "Coal",
      "Oil",
      "Gas",
      "Coal",
    ]),
    to: ["Electricity", "Industry", "Electricity", "Homes", "Homes", "Industry", "Losses"].concat([
      "Electricity",
      null as unknown as string,
      "Homes",
      "Coal",
    ]),
    amount: [80, 40, 50, 30, 70, 50, 10, -5, 9, 0, 3],
  });

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const chart = (width?: number, height?: number) =>
  build(
    { marks: [sankey(energy(), { source: "from", target: "to", value: "amount" })] },
    width,
    height,
  );

const links = (scene: Scene) =>
  scene.panels[0]!.marks.find((m): m is ShapesGeometry => m.kind === "shapes")!;
const nodes = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is RectGeometry => m.kind === "rect");
const labels = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is TextGeometry => m.kind === "text");

/** Every item, in keyboard order. */
function items(model: ChartModel): ItemInspection[] {
  const out: ItemInspection[] = [];
  let key = model.stepItem(undefined, 1);
  while (key !== undefined && !out.some((item) => item.key === key)) {
    out.push(model.inspectItem(key) as ItemInspection);
    key = model.stepItem(key, 1);
  }
  return out;
}

describe("sankey", () => {
  it("draws a bar per node and a band per source and target", () => {
    const { scene, model } = chart();
    expect(legendOf(scene)).toEqual([]);
    expect(nodes(scene).reduce((sum, m) => sum + m.count, 0)).toBe(6);
    const bands = links(scene).shapes as PathShape[];
    expect(bands).toHaveLength(7);
    // Bands take their source's color, translucent.
    const coal = model.inspectItem(JSON.stringify([0, "Coal"]))!;
    expect(bands[0]!.fill).toBe(coal.points[0]!.color);
    expect(bands[0]!.opacity).toBe(0.35);
    expect(bands[0]!.d).toMatch(/^M[\d. ]+C[\d. ]+L[\d. ]+C[\d. ]+Z$/);
    // Nodes take palette colors in reading order.
    expect(nodes(scene)[0]!.fill).toBe(coal.points[0]!.color);
    expect(model.layoutSummary()).toBe(
      "Sankey of amount: 6 nodes in 3 columns and 7 flows; the largest flow is Coal → Electricity, 80. 1 flow closing a cycle is not drawn.",
    );
  });

  it("reads nodes column by column, then links by source and target", () => {
    const { model } = chart();
    const read = items(model).map(({ points: [item] }) => `${item!.label}: ${item!.text}`);
    expect(read.slice(0, 6)).toEqual([
      "Coal: 120 out",
      "Gas: 80 out",
      "Electricity: 130 in, 130 out",
      expect.stringMatching(/^(Industry: 90 in|Homes: 100 in)$/),
      expect.stringMatching(/^(Industry: 90 in|Homes: 100 in)$/),
      "Losses: 10 in",
    ]);
    expect(read.slice(6, 8)).toEqual(["Coal → Electricity: 80", "Coal → Industry: 40"]);
    expect(read).toHaveLength(13);
    const [first] = items(model);
    expect([first!.axis, first!.label, first!.value]).toEqual(["item", "amount", 120]);
    expect(model.stepItem(undefined, -1)).toBe(JSON.stringify([0, "Electricity", "Losses"]));
  });

  it("finds nodes, then the band under a point, and nothing between bands", () => {
    const { model } = chart();
    const all = items(model);
    const coal = all.find((item) => item.points[0]!.label === "Coal")!;
    const at = (x: number, y: number) => model.inspect(x, y) as ItemInspection | undefined;
    const { px, py } = coal.points[0]!;
    expect(at(px, py)?.key).toBe(coal.key);
    expect(coal.outline).toMatch(/^M[\d. ]+h[\d.]+v[\d.]+h-[\d.]+Z$/);
    // Each band finds itself at its middle, where none overlaps another in this chart.
    for (const item of all.filter((item) => item.points[0]!.label.includes("→"))) {
      const { px, py } = item.points[0]!;
      expect(at(px, py)?.key).toBe(item.key);
    }
    // Just right of the sources, in the padding between Coal and Gas, is nothing.
    const box = (item: ItemInspection) => item.outline.match(/-?[\d.]+/g)!.map(Number);
    const [x, top, width, height] = box(coal);
    const gas = all.find((item) => item.points[0]!.label === "Gas")!;
    expect(at(x! + width! + 1, (top! + height! + box(gas)[1]!) / 2)).toBeUndefined();
  });

  it("hit-tests bands along their curves", () => {
    // The top edge of a band from (0, 0) to (100, 50), sampled along t.
    for (let t = 0; t <= 1; t += 0.05) {
      const x = 100 * (1.5 * t - 1.5 * t * t + t * t * t);
      const y = 50 * t * t * (3 - 2 * t);
      expect(bandTop(0, 100, 0, 50, x)).toBeCloseTo(y, 6);
    }
    expect(bandTop(0, 100, 10, 50, 50)).toBeCloseTo(30, 9);
  });

  it("labels nodes with their values, on the inner side of the outer columns", () => {
    const { scene } = chart();
    const [start, end] = labels(scene);
    expect(start!.anchor).toBe("start");
    expect(start!.labels).toEqual(
      expect.arrayContaining(["Coal 120", "Gas 80", "Electricity 130"]),
    );
    expect(end!.anchor).toBe("end");
    expect(end!.labels).toEqual(expect.arrayContaining(["Homes 100", "Industry 90"]));
    expect(start!.halo).toEqual({ color: "#ffffff", width: 3, opacity: 1 });
    // Every label stays inside the chart.
    for (const mark of [start!, end!]) {
      for (let i = 0; i < mark.count; i++) {
        const x = mark.coords[i * 2]!;
        const width = estimateText(mark.labels[i]!, "12px sans-serif");
        const [left, right] = mark.anchor === "start" ? [x, x + width] : [x - width, x];
        expect(left).toBeGreaterThanOrEqual(0);
        expect(right).toBeLessThanOrEqual(600);
      }
    }
  });

  it("shortens or leaves out labels without room, and draws none when asked", () => {
    // Values go first, then names are shortened; Electricity's label would
    // face Homes' across a gap too narrow for either.
    const shown = labels(chart(160, 90).scene).flatMap((mark) => mark.labels);
    expect(shown.sort()).toEqual(["Coal", "Gas", "Indus…", "Losses"]);
    // Twenty sinks in a short column: labels a line apart, the largest first.
    const fan = table({
      from: Array.from({ length: 20 }, () => "hub"),
      to: Array.from({ length: 20 }, (_, i) => `n${i}`),
      v: Array.from({ length: 20 }, (_, i) => 20 - i),
    });
    const { scene } = build(
      { marks: [sankey(fan, { source: "from", target: "to", value: "v" })] },
      300,
      200,
    );
    const [, sinks] = labels(scene);
    expect(sinks!.count).toBeGreaterThan(5);
    expect(sinks!.count).toBeLessThan(20);
    expect(sinks!.labels[0]).toBe("n0 20");
    const ys = Array.from({ length: sinks!.count }, (_, i) => sinks!.coords[i * 2 + 1]!).sort(
      (a, b) => a - b,
    );
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeGreaterThanOrEqual(15);
    const bare = build({
      marks: [sankey(energy(), { source: "from", target: "to", value: "amount", labels: false })],
    }).scene;
    expect(labels(bare)).toEqual([]);
  });

  it("counts rows without a value, and sums rows of the same source and target", () => {
    const visits = table({
      from: ["home", "home", "home", "search"],
      to: ["search", "search", "cart", "cart"],
    });
    const { model } = build({ marks: [sankey(visits, { source: "from", target: "to" })] });
    const read = items(model).map(({ label, points: [item] }) => [label, item!.label, item!.text]);
    expect(read).toContainEqual(["Count", "home → search", "2"]);
    expect(read).toContainEqual(["Count", "cart", "2 in"]);
    expect(model.layoutSummary()).toBe(
      "Sankey of row counts: 3 nodes in 3 columns and 3 flows; the largest flow is home → search, 2.",
    );
  });

  it("follows the table as it changes", () => {
    const flows = table({ from: ["a"], to: ["b"], v: [1] });
    const { model } = build({
      marks: [sankey(flows, { source: "from", target: "to", value: "v" })],
    });
    expect(model.layoutSummary()).toMatch(/2 nodes in 2 columns and 1 flow;/);
    flows.append({ from: ["b", "a"], to: ["c", "b"], v: [4, 2] });
    model.scene(estimateText);
    expect(model.layoutSummary()).toBe(
      "Sankey of v: 3 nodes in 3 columns and 2 flows; the largest flow is b → c, 4.",
    );
    expect(model.inspectItem(JSON.stringify([0, "a", "b"]))!.points[0]!.text).toBe("3");
  });

  it("says when links close cycles, and when there is nothing to show", () => {
    const loop = table({ from: ["a", "b", "c"], to: ["b", "c", "a"], v: [3, 2, 1] });
    const { model } = build({
      marks: [sankey(loop, { source: "from", target: "to", value: "v" })],
    });
    expect(model.layoutSummary()).toBe(
      "Sankey of v: 3 nodes in 3 columns and 2 flows; the largest flow is a → b, 3. 1 flow closing a cycle is not drawn.",
    );
    const empty = table({ from: category([]), to: category([]), v: [] as number[] });
    const blank = build({ marks: [sankey(empty, { source: "from", target: "to", value: "v" })] });
    expect(links(blank.scene).shapes).toEqual([]);
    expect(blank.model.inspect(300, 200)).toBeUndefined();
    expect(blank.model.stepItem(undefined, 1)).toBeUndefined();
    expect(describeChart(blank.model)).toBe("Sankey of v, with nothing to show.");
  });

  it("leaves out links whose total overflows, and says so", () => {
    const huge = table({ from: ["a", "a", "a"], to: ["b", "b", "c"], v: [1e308, 1e308, 1] });
    const { model } = build({
      marks: [sankey(huge, { source: "from", target: "to", value: "v" })],
    });
    expect(model.layoutSummary()).toBe(
      "Sankey of v: 2 nodes in 2 columns and 1 flow; the largest flow is a → c, 1. 1 flow whose total is too large to represent is not drawn.",
    );
  });

  it("leaves out labels in a panel shorter than a line", () => {
    const { scene } = build(
      {
        title: "Energy",
        marks: [sankey(energy(), { source: "from", target: "to", value: "amount" })],
      },
      600,
      30,
    );
    expect(labels(scene)).toEqual([]);
    expect(scene.panels[0]!.plot.height).toBeLessThan(15);
  });

  it("refuses other marks, facets, axis interaction, and bad options", () => {
    const flows = sankey(energy(), { source: "from", target: "to" });
    const series = table({ t: [1, 2], v: [1, 2] });
    expect(() => build({ marks: [flows, line(series, { x: "t", y: "v" })] })).toThrow(
      "has its chart to itself",
    );
    expect(() => build({ marks: [flows], interaction: { brush: "x" } })).toThrow(
      "sankey brush: no axes to brush",
    );
    expect(() => sankey(energy(), { source: "from", target: "amount" as never })).toThrow(
      'sankey target: field "amount" holds number values; expected category',
    );
    expect(() => sankey(energy(), { source: "from", target: "to", nodeWidth: 0 })).toThrow(
      "nodeWidth",
    );
  });

  it("loads from specs and renders to SVG and PDF", () => {
    const spec: ChartSpec = {
      version: 1,
      width: 500,
      height: 300,
      title: "Energy",
      data: {
        flows: {
          columns: {
            from: { type: "category", codes: [0, 0, 1], dictionary: ["coal", "power"] },
            to: { type: "category", codes: [0, 1, 1], dictionary: ["power", "homes"] },
            v: [5, 2, 4],
          },
        },
      },
      marks: [
        { type: "sankey", data: "flows", source: "from", target: "to", value: "v", sort: "value" },
      ],
    };
    const { config } = loadSpec(spec, []);
    const svg = renderToSVG({ ...config, width: 500, height: 300 });
    expect(svg).toMatch(/<path d="M[^"]*C[^"]*Z" fill="#[0-9a-f]+" fill-opacity="0.35"/);
    expect(svg).toContain(">coal 7</text>");
    expect(renderToPDF({ ...config, width: 500, height: 300 }).length).toBeGreaterThan(500);
    // Specs from outside TypeScript, which the type checker cannot help.
    const bad = (mark: Record<string, unknown>) => () =>
      loadSpec({ ...spec, marks: [{ type: "sankey", data: "flows", ...mark }] } as never, []);
    expect(bad({ source: "from" })).toThrow("marks[0].target: required");
    expect(bad({ source: "from", target: "to", nodeWidth: -1 })).toThrow(
      "marks[0].nodeWidth: expected a positive number",
    );
    expect(bad({ source: "from", target: "to", sort: "size" })).toThrow('"input" or "value"');
  });
});
