// Scale identity: the short forms x, y, and yRight are the scales "x", "y",
// and "yRight"; `scope` says which panels share one instance of each, and an
// instance's type comes from the marks its own panels draw on it.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { rule } from "../../src/marks/rule.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { scopesOf } from "../../src/model/scales.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { loadSpec } from "../../src/spec/load.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const zones = table({ z: ["North", "South", "East"], v: [12, 7, 9] });
const hourly = table({ h: [0, 1, 2, 3], v: [3, 5, 4, 6] });
const two = panels([{ id: "a" }, { id: "b" }], { columns: 2 });

describe("scale scopes", () => {
  it("default to the whole chart for x, y as the layout says, and yRight as y", () => {
    expect(scopesOf({}, "panel")).toEqual({ x: "chart", y: "panel", yRight: "panel" });
    expect(scopesOf({}, "chart")).toEqual({ x: "chart", y: "chart", yRight: "chart" });
    expect(scopesOf({ y: { scope: "row" } }, "chart")).toEqual({
      x: "chart",
      y: "row",
      yRight: "row",
    });
    expect(scopesOf({ x: { scope: "column" }, yRight: { scope: "chart" } }, "panel").yRight).toBe(
      "chart",
    );
  });
});

describe("subplots mixing category and number axes", () => {
  it("put categories on one panel's y and numbers on another's (migration trial bug 1)", () => {
    const { model, scene } = build({
      marks: [
        bar(zones, { x: "v", y: "z", panel: "a" }),
        line(hourly, { x: "h", y: "v", panel: "b" }),
      ],
      panels: two,
    });
    const [a, b] = model.panels();
    expect(a!.y.type).toBe("band");
    expect(a!.y.categories).toEqual(["North", "South", "East"]);
    expect(b!.y.type).toBe("linear");
    expect(b!.y.categories).toBeUndefined();
    // Both draw: the bars along y, the line over numbers.
    expect(scene.panels[0]!.marks.map((m) => m.kind)).toContain("rect");
    expect(scene.panels[1]!.marks.map((m) => m.kind)).toContain("line");
    // Category labels beside the bars, numbers beside the line.
    const labels = (i: number) => scene.panels[i]!.axes.find((axis) => axis.side === "left");
    expect(labels(0)!.ticks.map((t) => t.label)).toEqual(["North", "South", "East"]);
    expect(labels(1)!.ticks.every((t) => /^\d/.test(t.label))).toBe(true);
    // Inspection reads each panel through its own scale.
    const plot = scene.panels[1]!.plot;
    expect(model.inspect(plot.x + 1, plot.y + plot.height / 2, undefined, "b")).toBeDefined();
  });

  it("put categories on one panel's x and numbers on another's, with x of their own", () => {
    const { model } = build({
      marks: [
        bar(zones, { x: "z", y: "v", panel: "a" }),
        line(hourly, { x: "h", y: "v", panel: "b" }),
      ],
      panels: two,
      x: { scope: "panel" },
    });
    const [a, b] = model.panels();
    expect(a!.x.type).toBe("band");
    expect(a!.x.categories).toEqual(["North", "South", "East"]);
    expect(b!.x.type).toBe("linear");
    expect(b!.x.domain[0]).toBeLessThanOrEqual(0);
    expect(b!.x.domain[1]).toBeGreaterThanOrEqual(3);
  });

  it.each([
    ["a heatmap", () => heatmap(zones, { x: "v", y: "z", color: "v", panel: "a" })],
    ["points", () => point(zones, { x: "v", y: "z", panel: "a" })],
  ])("put %s on a category y beside a line", (_, make) => {
    const { model } = build({
      marks: [make(), line(hourly, { x: "h", y: "v", panel: "b" })],
      panels: two,
    });
    const [a, b] = model.panels();
    expect(a!.y.type).toBe("band");
    expect(b!.y.type).toBe("linear");
  });

  it("render the trial's subplots to SVG and from a spec", () => {
    const config: ChartConfig = {
      marks: [
        bar(zones, { x: "z", y: "v", panel: "a" }),
        line(hourly, { x: "h", y: "v", panel: "b" }),
      ],
      panels: two,
      x: { scope: "panel" },
    };
    const svg = renderToSVG({ ...config, width: 600, height: 300 });
    expect(svg).toContain(">North</text>");
    const { config: loaded } = loadSpec(
      {
        data: {
          zones: { columns: { z: ["North", "South"], v: [1, 2] } },
          hourly: { columns: { h: [0, 1], v: [3, 4] } },
        },
        marks: [
          { type: "bar", data: "zones", x: "z", y: "v", panel: "a" },
          { type: "line", data: "hourly", x: "h", y: "v", panel: "b" },
        ],
        panels: [{ id: "a" }, { id: "b" }],
        x: { scope: "panel" },
      },
      [],
    );
    const [a, b] = build(loaded).model.panels();
    expect(a!.x.type).toBe("band");
    expect(b!.x.type).toBe("linear");
  });

  it("refuse categories and numbers on one shared instance, naming the scale and panels", () => {
    expect(() =>
      build({
        marks: [
          bar(zones, { x: "z", y: "v", panel: "a" }),
          line(hourly, { x: "h", y: "v", panel: "b" }),
        ],
        panels: two,
      }),
    ).toThrow(
      'line x: numbers in panel "b" cannot share scale "x" with the categories of the bar in panel "a"; give x scope "panel"',
    );
    expect(() =>
      build({
        marks: [
          bar(zones, { x: "v", y: "z", panel: "a" }),
          line(hourly, { x: "h", y: "v", panel: "b" }),
        ],
        panels: two,
        y: { scope: "chart" },
      }),
    ).toThrow('give y scope "panel"');
    // In one panel, or across facet panels drawing the same marks, scopes cannot part them.
    expect(() =>
      build({ marks: [bar(zones, { x: "z", y: "v" }), line(hourly, { x: "h", y: "v" })] }),
    ).toThrow(/^line x: numbers cannot share a category axis$/);
    const regions = table({ z: ["N", "S"], v: [1, 2], h: [0, 1], r: ["x", "y"] });
    expect(() =>
      build({
        marks: [bar(regions, { x: "z", y: "v" }), line(regions, { x: "h", y: "v" })],
        facet: facet("r"),
        x: { scope: "panel" },
      }),
    ).toThrow(/^line x: numbers cannot share a category axis$/);
  });

  it("let a mark in every panel place only what each panel's scale takes", () => {
    // A vertical rule places nothing along y, so it fits beside categories and numbers.
    const { model } = build({
      marks: [
        bar(zones, { x: "v", y: "z", panel: "a" }),
        line(hourly, { x: "h", y: "v", panel: "b" }),
        rule({ x: 2, panel: "*" }),
      ],
      panels: two,
    });
    expect(model.panels().map((p) => p.y.type)).toEqual(["band", "linear"]);
  });

  it("refuse scope on a panel's own axis settings", () => {
    expect(() =>
      loadSpec(
        {
          data: { t: { columns: { x: [1], y: [1] } } },
          marks: [{ type: "line", data: "t", x: "x", y: "y", panel: "a" }],
          panels: [{ id: "a", y: { scope: "panel" } as never }],
        },
        [],
      ),
    ).toThrow(
      'spec.panels[0].y.scope: expected scope on the chart\'s x, y, or yRight only; received "panel"',
    );
  });
});
