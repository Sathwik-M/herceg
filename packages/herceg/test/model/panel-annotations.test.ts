// Annotations over a table in charts with facets: each row's rule, region,
// or label draws in its own row's panel; constants and repeats in every one.
import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { region } from "../../src/marks/region.ts";
import { rule } from "../../src/marks/rule.ts";
import { text } from "../../src/marks/text.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type {
  MarkGeometry,
  Panel,
  RectGeometry,
  RuleGeometry,
  SegmentGeometry,
  TextGeometry,
} from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const of = <K extends MarkGeometry["kind"]>(panel: Panel, kind: K) =>
  panel.marks.filter((m) => m.kind === kind) as Extract<MarkGeometry, { kind: K }>[];
const labels = (panel: Panel) => of(panel, "text").flatMap((t) => t.labels);
const rules = (panel: Panel) => of(panel, "rule").map((r) => r.label);

// Two regions' series, and their events interleaved, with one event in no region.
const sales = table({
  t: [0, 1, 2, 3, 0, 1, 2, 3],
  v: [1, 2, 3, 4, 10, 20, 30, 40],
  region: ["N", "N", "N", "N", "S", "S", "S", "S"],
});
const events = () =>
  table({
    at: [0.5, 1.5, 2.5, 9, 2],
    end: [1, 2, 3, 10, 2.5],
    v: [2, 25, 3.5, 5, 4],
    note: ["n1", "s1", "n2", "lost", "s2"],
    region: ["N", "S", "N", null, "S"],
  });

describe("annotations over a table in facets", () => {
  it("draw each row in its own row's panel, constants and repeats in every one", () => {
    const notes = events();
    const { scene } = build({
      marks: [
        line(sales, { x: "t", y: "v" }),
        rule(notes, { x: "at", text: "note" }),
        region(notes, { x1: "at", x2: "end", text: "note" }),
        text(notes, { x: "at", y: "v", text: "note" }),
        rule({ y: 30, label: "goal" }),
        rule(notes, { x: "at", text: "note", facet: "repeat", stroke: "red" }),
      ],
      facet: facet("region"),
      x: { domain: [0, 4] },
    });
    const [n, s] = scene.panels;
    // The repeated rules draw every row in view (not 9); the split ones their panel's.
    const split = (panel: Panel) =>
      of(panel, "rule").filter((r) => r.stroke !== "red" && r.label !== "goal");
    expect(split(n!).map((r) => r.label)).toEqual(["n1", "n2"]);
    expect(split(s!).map((r) => r.label)).toEqual(["s1", "s2"]);
    for (const panel of [n!, s!]) {
      expect(rules(panel)).toContain("goal");
      expect(of(panel, "rule").filter((r) => r.stroke === "red")).toHaveLength(4);
    }
    expect(labels(n!)).toEqual(["n1", "n2", "n1", "n2"]);
    expect(labels(s!)).toEqual(["s1", "s2", "s1", "s2"]);
    expect(of(n!, "rect").find((r) => r.fill !== "transparent")!.count).toBe(2);
    // Rules keep their row as their key in whichever panel draws them.
    expect(split(s!).map((r) => r.key)).toEqual(["1:1", "1:4"]);
  });

  it("leave rows without a facet value out of drawing and of domains", () => {
    const { model, scene } = build({
      marks: [line(sales, { x: "t", y: "v" }), rule(events(), { x: "at" })],
      facet: facet("region"),
    });
    // The rule at 9 has no region: no panel draws it, and no domain reaches it.
    expect(model.xScale()!.domain[1]).toBeLessThan(9);
    expect(model.dataXExtent()![1]).toBe(3);
    expect(scene.panels.flatMap((p) => of(p, "rule"))).toHaveLength(4);
  });

  it("fit each panel's own rows on scales of their own, and every panel's on shared ones", () => {
    const peaks = table({ y: [5, 500], region: ["N", "S"] });
    const config = (y: "shared" | "independent"): ChartConfig => ({
      marks: [line(sales, { x: "t", y: "v" }), rule(peaks, { y: "y", text: "region" })],
      facet: facet("region"),
      resolve: { y },
    });
    const own = build(config("independent")).model.panels();
    expect(own[0]!.y.domain[1]).toBeLessThan(100);
    expect(own[1]!.y.domain[1]).toBeGreaterThanOrEqual(500);
    const shared = build(config("shared")).model.panels();
    expect(shared[0]!.y.domain).toEqual(shared[1]!.y.domain);
    expect(shared[0]!.y.domain[1]).toBeGreaterThanOrEqual(500);
    // Rows of a grid: each row's scale fits its panels' rules only.
    const grid = table({
      t: [0, 1, 0, 1],
      v: [1, 2, 3, 4],
      region: ["N", "N", "S", "S"],
      product: ["a", "b", "a", "b"],
    });
    const marks = table({ y: [50, 7], region: ["N", "S"], product: ["b", "a"] });
    const { model, scene } = build({
      marks: [line(grid, { x: "t", y: "v" }), rule(marks, { y: "y", text: "product" })],
      facet: facet({ row: "region", column: "product" }),
      resolve: { y: "rows" },
    });
    const [na, nb, sa, sb] = model.panels();
    expect(na!.y.domain).toEqual(nb!.y.domain);
    expect(na!.y.domain[1]).toBeGreaterThanOrEqual(50);
    expect(sa!.y.domain[1]).toBeLessThan(50);
    expect(scene.panels.map((p) => rules(p))).toEqual([[], ["b"], ["a"], []]);
    expect(sb!.y.domain).toEqual(sa!.y.domain);
  });

  it("keep their rows beside marks whose categories panels resolve apart", () => {
    const units = table({
      product: ["a", "b", "c", "d"],
      units: [1, 2, 3, 4],
      region: ["N", "N", "S", "S"],
    });
    const limits = table({ y: [1.5, 3.5], region: ["N", "S"] });
    const { model, scene } = build({
      marks: [bar(units, { x: "product", y: "units" }), rule(limits, { y: "y", text: "region" })],
      facet: facet("region"),
      resolve: { x: "independent", y: "independent" },
    });
    expect(model.panels().map((p) => p.x.categories)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(scene.panels.map((p) => rules(p))).toEqual([["N"], ["S"]]);
  });

  it("hide and move labels against their own panel's only, with leaders there", () => {
    // Two labels at nearly one point in each panel: the second of each is
    // hidden or moved; in one panel, the other panel's two would be hidden too.
    const crowded = table({
      at: [1, 1.1, 1, 1.1],
      v: [5, 5.2, 5, 5.2],
      note: ["a long label one", "a long label two", "another one", "another two"],
      region: ["N", "N", "S", "S"],
    });
    for (const overlap of ["hide", "move"] as const) {
      const { scene } = build({
        marks: [
          line(sales, { x: "t", y: "v" }),
          text(crowded, { x: "at", y: "v", text: "note", overlap }),
        ],
        facet: facet("region"),
        y: { domain: [0, 10] },
      });
      const [n, s] = scene.panels;
      if (overlap === "hide") {
        expect(labels(n!)).toEqual(["a long label one"]);
        expect(labels(s!)).toEqual(["another one"]);
      } else {
        expect(labels(n!)).toEqual(["a long label one", "a long label two"]);
        expect(labels(s!)).toEqual(["another one", "another two"]);
        // Moved labels stay in their own panel's plot.
        for (const panel of [n!, s!]) {
          const [t] = of(panel, "text") as TextGeometry[];
          for (let k = 0; k < t!.count; k++) {
            expect(t!.coords[k * 2]!).toBeGreaterThanOrEqual(panel.plot.x);
            expect(t!.coords[k * 2]!).toBeLessThanOrEqual(panel.plot.x + panel.plot.width);
          }
        }
      }
    }
    // A tight cluster in each panel: labels pushed past the first ring get
    // a leader in their panel.
    const names = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const many = table({
      at: names.map((_, i) => 1.5 + (i % 5) * 0.02),
      v: names.map((_, i) => 5 + Math.floor((i % 10) / 5) * 0.1),
      note: names,
      region: names.map((_, i) => (i < 10 ? "N" : "S")),
    });
    const { scene } = build({
      marks: [
        line(sales, { x: "t", y: "v" }),
        text(many, { x: "at", y: "v", text: "note", dy: -12, overlap: "move" }),
      ],
      facet: facet("region"),
      y: { domain: [0, 10] },
    });
    for (const panel of scene.panels) {
      const leaders = of(panel, "segments") as SegmentGeometry[];
      expect(leaders.length).toBe(1);
      for (let k = 0; k < leaders[0]!.count; k++) {
        const x = leaders[0]!.coords[k * 4]!;
        expect(x).toBeGreaterThanOrEqual(panel.plot.x);
        expect(x).toBeLessThanOrEqual(panel.plot.x + panel.plot.width);
      }
    }
    const own = (panel: number) => labels(scene.panels[panel]!).map((l) => Number(l.slice(1)));
    expect(own(0).every((i) => i < 10)).toBe(true);
    expect(own(1).every((i) => i >= 10)).toBe(true);
  });

  it("draw with buffers as large as their panel's rows, not the table's", () => {
    const rows = 4000;
    const big = table({
      at: Float64Array.from({ length: rows }, (_, i) => i % 4),
      end: Float64Array.from({ length: rows }, (_, i) => (i % 4) + 0.5),
      v: Float64Array.from({ length: rows }, (_, i) => i % 10),
      note: Array.from({ length: rows }, (_, i) => `e${i % 7}`),
      region: Array.from({ length: rows }, (_, i) => `r${i % 20}`),
    });
    const { scene } = build(
      {
        marks: [
          region(big, { x1: "at", x2: "end", text: "note" }),
          text(big, { x: "at", y: "v", text: "note", overlap: "hide" }),
        ],
        facet: facet("region", { columns: 5 }),
      },
      1000,
      800,
    );
    expect(scene.panels).toHaveLength(20);
    for (const panel of scene.panels) {
      const [rects] = of(panel, "rect") as RectGeometry[];
      expect(rects!.count).toBe(rows / 20);
      expect(rects!.rects.length).toBeLessThanOrEqual((rows / 20) * 4 * 1.5);
      for (const t of of(panel, "text")) expect(t.coords.length).toBeLessThanOrEqual(rows / 4);
    }
  });

  it("follow their table as it streams, and draw in static SVG", () => {
    const notes = events();
    const { model, scene } = build({
      marks: [line(sales, { x: "t", y: "v" }), rule(notes, { x: "at", text: "note" })],
      facet: facet("region"),
    });
    expect(rules(scene.panels[1]!)).toEqual(["s1", "s2"]);
    notes.append({ at: [3], end: [3], v: [1], note: ["s3"], region: ["S"] });
    const next = model.scene(estimateText);
    expect(rules(next.panels[0]!)).toEqual(["n1", "n2"]);
    expect(rules(next.panels[1]!)).toEqual(["s1", "s2", "s3"]);
    const svg = renderToSVG({
      marks: [line(sales, { x: "t", y: "v" }), rule(notes, { x: "at", text: "note" })],
      facet: facet("region"),
      width: 600,
      height: 300,
    });
    for (const note of ["n1", "s3"]) expect(svg).toContain(`>${note}</text>`);
  });

  it("load from specs over a table without facet: repeat", () => {
    const { config } = loadSpec(
      {
        version: 2,
        data: {
          sales: { columns: { t: [0, 1, 0, 1], v: [1, 2, 3, 4], region: ["N", "N", "S", "S"] } },
          events: { columns: { at: [0.5, 0.25], note: ["n", "s"], region: ["N", "S"] } },
        },
        marks: [
          { type: "line", data: "sales", x: "t", y: "v" },
          { type: "rule", data: "events", x: "at", text: "note" },
        ],
        facet: { field: "region" },
      },
      [],
    );
    const { scene } = build(config);
    expect(scene.panels.map((p) => rules(p))).toEqual([["n"], ["s"]]);
  });
});

describe("annotations of panels in the text alternative", () => {
  it("describe what every panel draws once, and each panel's own after its name", () => {
    const { model } = build({
      marks: [
        line(sales, { x: "t", y: "v" }),
        rule(events(), { x: "at", text: "note" }),
        rule({ y: 30, label: "goal" }),
      ],
      facet: facet("region"),
    });
    expect(model.annotationSummaries()).toEqual([
      "Rule: goal (y 30).",
      "N: Rules: n1 (x 0.5), n2 (x 2.5).",
      "S: Rules: s1 (x 1.5), s2 (x 2).",
    ]);
    expect(model.annotationSummaries("S")).toEqual(["Rules: s1 (x 1.5), s2 (x 2)."]);
    expect(model.annotationSummaries("missing")).toEqual([]);
    expect(describeChart(model)).toContain("N: Rules: n1 (x 0.5), n2 (x 2.5).");
  });

  it("name subplots' own annotations by their panel, and those of every panel once", () => {
    const { model } = build({
      marks: [
        line(sales, { x: "t", y: "v", panel: "a" }),
        rule({ x: 1, label: "deploy", panel: "*" }),
        rule({ y: 2, label: "limit", panel: "b" }),
      ],
      panels: panels([{ id: "a", title: "Latency" }, { id: "b" }]),
    });
    expect(model.annotationSummaries()).toEqual(["Rule: deploy (x 1).", "b: Rule: limit (y 2)."]);
    expect(model.annotationSummaries("a")).toEqual([]);
    expect(model.annotationSummaries("b")).toEqual(["Rule: limit (y 2)."]);
  });

  it("describe at most twenty panels' own, saying how many more there are", () => {
    const regions = Array.from({ length: 25 }, (_, i) => `r${i}`);
    const { model } = build(
      {
        marks: [rule(table({ at: regions.map((_, i) => i), region: regions }), { x: "at" })],
        facet: facet("region", { columns: 5 }),
      },
      1000,
      1000,
    );
    const summaries = model.annotationSummaries();
    expect(summaries).toHaveLength(21);
    expect(summaries[0]).toBe("r0: Rule: x 0.");
    expect(summaries.at(-1)).toBe("Annotations in 5 more panels.");
  });
});

describe("annotations over an empty table in facets", () => {
  it("draw nothing and describe nothing", () => {
    const none = table({ at: [] as number[], region: category([]) });
    const { model, scene } = build({
      marks: [line(sales, { x: "t", y: "v" }), rule(none, { x: "at" })],
      facet: facet("region"),
    });
    expect(scene.panels.flatMap((p) => of(p, "rule") as RuleGeometry[])).toEqual([]);
    expect(model.annotationSummaries()).toEqual([]);
  });
});
