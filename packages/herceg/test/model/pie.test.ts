import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { ArcGeometry, Scene, TextGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { legendOf } from "../helpers/guides.ts";

const sales = table({
  region: ["North", "South", "East", "West", "North", "Lost"],
  revenue: [30, 10, 40, 10, 10, -5],
});

function build(config: ChartConfig, width = 400, height = 300) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const arcs = (scene: Scene) =>
  scene.panels[0]!.marks.find((m): m is ArcGeometry => m.kind === "arc")!;
const sector = (mark: ArcGeometry, i: number) => Array.from(mark.arcs.subarray(i * 6, i * 6 + 6));

describe("pie", () => {
  it("sums values per category into slices, largest first clockwise from the top", () => {
    const { scene, model } = build({
      marks: [pie(sales, { category: "region", value: "revenue" })],
    });
    expect(legendOf(scene).map((entry) => entry.label)).toEqual(["North", "East", "South", "West"]);
    const mark = arcs(scene);
    expect(mark.count).toBe(4);
    // North is 40 of 100: from the top, 40% of the way round.
    const [, , r0, , a0, a1] = sector(mark, 0);
    expect(r0).toBe(0);
    expect(a0).toBeCloseTo(-Math.PI / 2, 5);
    expect(a1! - a0!).toBeCloseTo(0.4 * 2 * Math.PI, 5);
    expect(mark.gap).toBeGreaterThan(0);
    // Negative values count as nothing, so "Lost" has no slice.
    expect(model.layoutSummary()).toBe(
      "Pie of revenue by region: 4 slices totaling 100. Largest: North 40%, East 40%, South 10%.",
    );
  });

  it("keeps the categories' order when asked, and counts rows without a value", () => {
    const { scene } = build({ marks: [pie(sales, { category: "region", sort: "input" })] });
    expect(legendOf(scene).map((entry) => entry.label)).toEqual([
      "North",
      "South",
      "East",
      "West",
      "Lost",
    ]);
    const mark = arcs(scene);
    const [, , , , a0, a1] = sector(mark, 0);
    expect(a1! - a0!).toBeCloseTo((2 / 6) * 2 * Math.PI, 5);
  });

  it("gives the circle to the slices left when others are hidden", () => {
    const { model } = build({ marks: [pie(sales, { category: "region", value: "revenue" })] });
    const [north] = legendOf(model.scene(estimateText));
    model.hidden.add(north!.key);
    const scene = model.scene(estimateText);
    expect(legendOf(scene).find((entry) => entry.label === "North")!.hidden).toBe(true);
    const mark = arcs(scene);
    expect(mark.count).toBe(3);
    const [, , , , a0, a1] = sector(mark, 0);
    expect(a1! - a0!).toBeCloseTo((40 / 60) * 2 * Math.PI, 5);
  });

  it("finds the slice under a point, and nothing in the hole or outside", () => {
    const { scene, model } = build({
      marks: [pie(sales, { category: "region", value: "revenue", innerRadius: 0.5 })],
    });
    const [cx, cy, r0, r] = sector(arcs(scene), 0) as number[];
    const at = (angle: number, radius: number) =>
      model.inspect(cx! + radius * Math.cos(angle), cy! + radius * Math.sin(angle)) as
        | ItemInspection
        | undefined;
    // Just right of the top is the first slice; just left of it, the last.
    const first = at(-Math.PI / 2 + 0.05, (r0! + r!) / 2)!;
    expect([first.axis, first.label, first.points[0]!.label]).toEqual(["item", "revenue", "North"]);
    expect(first.points[0]!.text).toBe("40 (40%)");
    expect(first.value).toBe(40);
    expect(first.outline).toMatch(/^M.*A.*Z$/);
    expect(at(-Math.PI / 2 - 0.05, (r0! + r!) / 2)!.points[0]!.label).toBe("West");
    expect(at(0, r0! / 2)).toBeUndefined();
    expect(at(0, r! + 2)).toBeUndefined();
  });

  it("labels slices beside the pie, and steps through them in order", () => {
    const { scene, model } = build({
      marks: [pie(sales, { category: "region", value: "revenue" })],
    });
    const labels = scene.panels[0]!.marks.filter((m): m is TextGeometry => m.kind === "text");
    expect(labels.flatMap((m) => m.labels).sort()).toEqual(["East", "North", "South", "West"]);
    expect(labels.map((m) => m.anchor).sort()).toEqual(["end", "start"]);
    const keys = legendOf(scene).map((entry) => entry.key);
    expect(model.stepItem(undefined, 1)).toBe(keys[0]);
    expect(model.stepItem(undefined, -1)).toBe(keys[3]);
    expect(model.stepItem(keys[1], 1)).toBe(keys[2]);
    expect(model.stepItem(keys[3], 1)).toBe(keys[3]);
    expect(model.stepItem(keys[2], Number.NEGATIVE_INFINITY)).toBe(keys[0]);
    // Too small a chart has no room for labels; the pie keeps the room.
    const small = build({ marks: [pie(sales, { category: "region" })] }, 120, 90).scene;
    expect(small.panels[0]!.marks.some((m) => m.kind === "text")).toBe(false);
  });

  it("draws a single slice as a whole disc, and nothing without data", () => {
    const one = table({ k: ["only"], v: [5] });
    const mark = arcs(build({ marks: [pie(one, { category: "k", value: "v" })] }).scene);
    const [, , , , a0, a1] = sector(mark, 0);
    expect(a1! - a0!).toBeCloseTo(2 * Math.PI, 5);
    expect(mark.gap).toBe(0);
    const empty = table({ k: category([]), v: [] as number[] });
    const { scene, model } = build({ marks: [pie(empty, { category: "k", value: "v" })] });
    expect(arcs(scene).count).toBe(0);
    expect(model.inspect(200, 150)).toBeUndefined();
    expect(describeChart(model)).toBe("Pie of v by k, with nothing to show.");
  });

  it("leaves out infinite values, and shares out totals too large for a double", () => {
    const odd = table({ k: ["a", "b", "c", "d"], v: [1, Number.POSITIVE_INFINITY, 1e308, 1e308] });
    const { scene, model } = build({ marks: [pie(odd, { category: "k", value: "v" })] });
    const mark = arcs(scene);
    expect(Array.from(mark.arcs).every(Number.isFinite)).toBe(true);
    // b has no slice; c and d have half the circle each, a next to nothing.
    expect(legendOf(scene).map((entry) => entry.label)).toEqual(["c", "d", "a"]);
    const [, , , , a0, a1] = sector(mark, 0);
    expect(a1! - a0!).toBeCloseTo(Math.PI, 5);
    expect(model.layoutSummary()).toMatch(
      /^Pie of v by k: 3 slices totaling .*c 50%, d 50%, a 0%\.$/,
    );
  });

  it("finds nothing in the gaps between slices", () => {
    const halves = table({ k: ["a", "b"], v: [1, 1] });
    const { scene, model } = build({ marks: [pie(halves, { category: "k", value: "v" })] });
    const [cx, cy, , r] = sector(arcs(scene), 0) as number[];
    // The seam at the top, and the center where the slices' points meet.
    expect(model.inspect(cx!, cy! - r! / 2)).toBeUndefined();
    expect(model.inspect(cx!, cy!)).toBeUndefined();
    expect(model.inspect(cx! + 10, cy! - r! / 2)).toBeDefined();
  });

  it("refuses other marks, facets, axis interaction, and bad options", () => {
    const slices = pie(sales, { category: "region" });
    const series = table({ t: [1, 2], v: [1, 2] });
    expect(() => build({ marks: [slices, line(series, { x: "t", y: "v" })] })).toThrow(
      "has its chart to itself",
    );
    expect(() => build({ marks: [slices], interaction: { zoom: true } })).toThrow(
      "pie zoom: no axes to zoom; drop interaction.zoom",
    );
    expect(() => pie(sales, { category: "region", innerRadius: 1 })).toThrow("innerRadius");
    expect(() => pie(sales, { category: "revenue" as never })).toThrow();
  });

  it("loads from specs and renders to SVG and PDF", () => {
    const { config } = loadSpec(
      {
        version: 1,
        width: 400,
        height: 300,
        title: "Revenue",
        data: {
          sales: {
            columns: {
              region: { type: "category", codes: [0, 1], dictionary: ["a", "b"] },
              v: [1, 3],
            },
          },
        },
        marks: [{ type: "pie", data: "sales", category: "region", value: "v", innerRadius: 0.6 }],
      },
      [],
    );
    const svg = renderToSVG({ ...config, width: 400, height: 300 });
    expect(svg).toMatch(/<path d="M[^"]*A[^"]*" fill="#/);
    expect(renderToPDF({ ...config, width: 400, height: 300 }).length).toBeGreaterThan(500);
    expect(() =>
      loadSpec(
        {
          version: 1,
          data: { t: { columns: { k: { type: "category", codes: [0], dictionary: ["a"] } } } },
          marks: [{ type: "pie", category: "k", innerRadius: 2 }],
        },
        [],
      ),
    ).toThrow("innerRadius");
  });
});
