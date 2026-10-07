// Annotations: rules, regions, and text from constants or table rows.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { region } from "../../src/marks/region.ts";
import { rule } from "../../src/marks/rule.ts";
import { text } from "../../src/marks/text.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type {
  MarkGeometry,
  RectGeometry,
  RuleGeometry,
  Scene,
  TextGeometry,
} from "../../src/scene/scene.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const of = <K extends MarkGeometry["kind"]>(scene: Scene, kind: K) =>
  scene.marks.filter((m) => m.kind === kind) as Extract<MarkGeometry, { kind: K }>[];

const start = Date.UTC(2026, 0, 1);
const hour = 3_600_000;
const metrics = table({
  time: time(Array.from({ length: 24 }, (_, i) => start + i * hour)),
  value: Array.from({ length: 24 }, (_, i) => 100 + i),
});

describe("rule", () => {
  it("draws one rule per row of a table, with text from a field", () => {
    const deploys = table({
      time: time([start + 2 * hour, start + 30 * hour, start + 5 * hour]),
      version: ["v1", "v2", "v3"],
    });
    const { scene, model } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        rule(deploys, { x: "time", text: "version" }),
      ],
    });
    // The x domain stretches to include every event.
    expect(model.xScale()!.domain[1]).toBeGreaterThanOrEqual(start + 30 * hour);
    const rules = of(scene, "rule") as RuleGeometry[];
    expect(rules.map((r) => r.label)).toEqual(["v1", "v2", "v3"]);
    expect(rules[0]!.x1).toBeCloseTo(model.xScale()!.map(start + 2 * hour), 3);
    expect(rules[0]!.y1).toBe(scene.plot.y);
  });

  it("formats number text for the chart's locale and takes Date constants", () => {
    const limits = table({ y: [1234.5], label: [1234.5] });
    const { scene } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        rule(limits, { y: "y", text: "label" }),
        rule({ x: new Date(start + hour), label: "start" }),
      ],
    });
    expect(of(scene, "rule").map((r) => r.label)).toEqual(["1,234.5", "start"]);
  });

  it("leaves rules outside the view out and needs a table for fields", () => {
    const events = table({ at: [0, 1000] });
    const { scene, model } = build({
      marks: [line(metrics, { x: "time", y: "value" }), rule(events, { x: "at" })],
    });
    model.setViewport([start, start + hour]);
    expect(of(model.scene(estimateText), "rule")).toHaveLength(0);
    expect(of(scene, "rule").length).toBe(2);
    expect(() => rule({ x: "at" } as never)).toThrow(/needs a table/);
  });
});

describe("region", () => {
  it("shades an x range across the plot's height with a label in its corner", () => {
    const { scene, model } = build({
      marks: [
        region({ x1: start + 2 * hour, x2: start + 4 * hour, label: "Maintenance" }),
        line(metrics, { x: "time", y: "value" }),
      ],
    });
    // Regions draw in mark order, so this one is underneath the line.
    expect(scene.marks[0]!.kind).toBe("rect");
    const shade = scene.marks[0] as RectGeometry;
    const x = model.xScale()!;
    const [rx, ry, rw, rh] = Array.from(shade.rects.subarray(0, 4));
    expect(rx).toBeCloseTo(x.map(start + 2 * hour), 3);
    expect(rx! + rw!).toBeCloseTo(x.map(start + 4 * hour), 3);
    expect([ry, rh]).toEqual([scene.plot.y, scene.plot.height]);
    expect([shade.fill, shade.fillOpacity]).toEqual([scene.theme.muted, 0.15]);
    const label = of(scene, "text")[0] as TextGeometry;
    expect(label.labels).toEqual(["Maintenance"]);
    expect([label.anchor, label.coords[0]]).toEqual(["start", rx! + 4]);
  });

  it("shades one region per row and clips them to the plot", () => {
    const incidents = table({
      from: time([start + hour, start + 20 * hour]),
      to: time([start + 3 * hour, start + 40 * hour]),
      title: ["db", "network"],
    });
    const { model } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        region(incidents, { x1: "from", x2: "to", text: "title" }),
      ],
      x: { domain: [start, start + 23 * hour] },
    });
    const scene = model.scene(estimateText);
    const shade = of(scene, "rect")[0] as RectGeometry;
    expect(shade.count).toBe(2);
    // The second incident runs past the domain; it stops at the plot's edge.
    expect(shade.rects[4]! + shade.rects[6]!).toBeCloseTo(scene.plot.x + scene.plot.width, 3);
    expect((of(scene, "text")[0] as TextGeometry).labels).toEqual(["db", "network"]);
  });

  it("shades y ranges across the plot's width and counts them toward y", () => {
    const { scene, model } = build({
      marks: [line(metrics, { x: "time", y: "value" }), region({ y1: 200, y2: 300 })],
    });
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(300);
    const [rx, , rw] = Array.from((of(scene, "rect")[0] as RectGeometry).rects.subarray(0, 4));
    expect([rx, rw]).toEqual([scene.plot.x, scene.plot.width]);
  });

  it("counts rectangles toward y only where they overlap the x view", () => {
    const boxes = table({ x1: [0, 100], x2: [1, 101], y1: [0, 0], y2: [10, 1000] });
    const { model } = build({
      marks: [region(boxes, { x1: "x1", x2: "x2", y1: "y1", y2: "y2" })],
      x: { domain: [0, 2] },
    });
    expect(model.yScale()!.domain[1]).toBe(10);
  });

  it("reaches the bottom of a log axis from zero", () => {
    const positive = table({ x: [1, 2], y: [10, 1000] });
    const { scene } = build({
      marks: [line(positive, { x: "x", y: "y" }), region({ y1: 0, y2: 100 })],
      y: { type: "log" },
    });
    const [, ry, , rh] = Array.from((of(scene, "rect")[0] as RectGeometry).rects.subarray(0, 4));
    expect(ry! + rh!).toBeCloseTo(scene.plot.y + scene.plot.height, 3);
  });

  it("shades from the low end of a reversed log axis", () => {
    const positive = table({ x: [1, 2], y: [1, 100] });
    const { scene, model } = build({
      marks: [line(positive, { x: "x", y: "y" }), region({ y1: 0, y2: 10 })],
      y: { type: "log", domain: [100, 1] },
    });
    const y = model.yScale()!;
    const [, ry, , rh] = Array.from((of(scene, "rect")[0] as RectGeometry).rects.subarray(0, 4));
    expect(Math.min(ry!, ry! + rh!)).toBeCloseTo(Math.min(y.map(1), y.map(10)), 3);
    expect(Math.max(ry!, ry! + rh!)).toBeCloseTo(Math.max(y.map(1), y.map(10)), 3);
  });

  it("leaves out rows with infinite ends", () => {
    const open = table({ from: [0.2, 0.4], to: [Number.POSITIVE_INFINITY, 0.6] });
    const series = table({ x: [0, 1], y: [0, 1] });
    const { scene } = build({
      marks: [line(series, { x: "x", y: "y" }), region(open, { x1: "from", x2: "to" })],
    });
    expect((of(scene, "rect")[0] as RectGeometry).count).toBe(1);
  });

  it("places constants on a category axis by band index", () => {
    const sales = table({ region: ["N", "S", "E"], v: [1, 2, 3] });
    const { scene, model } = build({
      marks: [bar(sales, { x: "region", y: "v" }), region({ x1: -0.5, x2: 0.5 }), rule({ x: 2 })],
    });
    const x = model.xScale()!;
    const shade = of(scene, "rect")[1] as RectGeometry;
    expect(shade.rects[0]).toBeCloseTo(x.map(-0.5), 3);
    expect(shade.rects[0]! + shade.rects[2]!).toBeCloseTo(x.map(0.5), 3);
    expect((of(scene, "rule")[0] as RuleGeometry).x1).toBeCloseTo(x.map(2), 3);
    // Rules on heatmap bands, as before annotations read tables.
    const cells = table({ c: ["a", "b"], r: ["x", "y"], v: [1, 2] });
    const grid = build({ marks: [heatmap(cells, { x: "c", y: "r", value: "v" }), rule({ y: 0 })] });
    expect(of(grid.scene, "rule")).toHaveLength(1);
  });

  it("needs complete pairs", () => {
    expect(() => region({ x1: 1 })).toThrow(/both x1 and x2/);
    expect(() => region({})).toThrow(/needs x1 and x2, y1 and y2, or both/);
  });
});

describe("text", () => {
  it("places a label at a point with offsets, and leaves out points outside the plot", () => {
    const { scene, model } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        text({ x: start + 5 * hour, y: 105, label: "Peak", anchor: "start", dx: 6, dy: -8 }),
        text({ x: start + 100 * hour, y: 105, label: "Gone" }),
      ],
      x: { domain: [start, start + 23 * hour] },
    });
    const [label] = of(scene, "text") as TextGeometry[];
    expect(of(scene, "text")).toHaveLength(1);
    expect(label!.labels).toEqual(["Peak"]);
    expect(label!.coords[0]).toBeCloseTo(model.xScale()!.map(start + 5 * hour) + 6, 3);
    expect(label!.coords[1]).toBeCloseTo(model.yScale()!.map(105) - 8, 3);
    expect([label!.anchor, label!.fill]).toEqual(["start", scene.theme.text]);
  });

  it("labels rows from a table with a category or number field", () => {
    const peaks = table({ at: [start + hour, start + 2 * hour], v: [101, 102], name: ["a", null] });
    const { scene } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        text(peaks, { x: "at", y: "v", text: "name" }),
        text(peaks, { x: "at", y: "v", text: "v" }),
      ],
    });
    const [names, values] = of(scene, "text") as TextGeometry[];
    expect(names!.labels).toEqual(["a", ""]);
    expect(values!.labels).toEqual(["101", "102"]);
  });

  it("only counts labels inside the x view toward y", () => {
    const notes = table({ at: [start, start + 1000 * hour], v: [100, 1e6] });
    const { model } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        text(notes, { x: "at", y: "v", label: "!" }),
      ],
    });
    model.setViewport([start, start + 23 * hour]);
    model.scene(estimateText);
    expect(model.yScale()!.domain[1]).toBeLessThan(1000);
  });

  it("needs exactly one of label or text", () => {
    expect(() => text({ x: 1, y: 1 } as never)).toThrow(/exactly one of label or text/);
    expect(() =>
      text(metrics, { x: "time", y: "value", label: "a", text: "value" } as never),
    ).toThrow(/exactly one of label or text/);
    expect(() => text(metrics, { x: "time", y: "value", text: "time" as never })).toThrow(
      /time; text text needs category or number/,
    );
  });
});

describe("annotations in the text alternative", () => {
  it("lists annotation text and positions after the series", () => {
    const deploys = table({ at: time([start + 3 * hour]), version: ["v41"] });
    const { model } = build({
      marks: [
        region({ x1: start + 5 * hour, x2: start + 6 * hour, label: "Incident" }),
        line(metrics, { x: "time", y: "value", label: "p99" }),
        rule({ y: 140, label: "SLO" }),
        rule(deploys, { x: "at", text: "version" }),
        text({ x: start + 23 * hour, y: 123, label: "123 ms" }),
      ],
    });
    const description = describeChart(model);
    expect(description).toMatch(/^Line chart with 1 series\. p99: 24 points/);
    expect(description).toContain("Region: Incident (x Jan 1, 2026, 05:00 to Jan 1, 2026, 06:00).");
    expect(description).toContain("Rule: SLO (y 140).");
    expect(description).toContain("Rule: v41 (x Jan 1, 2026, 03:00).");
    expect(description).toContain("Label: 123 ms (x Jan 1, 2026, 23:00, y 123).");
  });

  it("describes charts of annotations alone, listing at most ten items", () => {
    const many = table({ at: Array.from({ length: 12 }, (_, i) => i) });
    const { model } = build({ marks: [rule(many, { x: "at" })] });
    const description = describeChart(model);
    expect(description).toBe(
      "Rules: x 0, x 1, x 2, x 3, x 4, x 5, x 6, x 7, x 8, x 9, and 2 more.",
    );
  });
});

describe("annotations in static SVG", () => {
  it("draws regions with the data and text above it, with a halo", () => {
    const svg = renderToSVG({
      width: 400,
      height: 200,
      marks: [
        region({ x1: start + 2 * hour, x2: start + 4 * hour }),
        line(metrics, { x: "time", y: "value" }),
        text({ x: start + 3 * hour, y: 110, label: "a < b" }),
      ],
    });
    const clipped = svg.slice(svg.indexOf("<g clip-path"), svg.indexOf("</g>"));
    expect(clipped.indexOf('fill-opacity="0.15"')).toBeLessThan(clipped.indexOf('fill="none"'));
    expect(svg).toMatch(
      /<g fill="#0b0b0b" text-anchor="middle" stroke="#ffffff" stroke-opacity="0.85"[^>]*paint-order="stroke">/,
    );
    expect(svg).toContain(">a &#60; b</text>");
  });

  it("chooses the halo by the label's own color", () => {
    const svg = renderToSVG({
      width: 400,
      height: 200,
      marks: [
        line(metrics, { x: "time", y: "value" }),
        text({ x: start + 3 * hour, y: 110, label: "light", fill: "#ffffff" }),
      ],
    });
    expect(svg).toContain('<g fill="#ffffff" text-anchor="middle" stroke="#000000"');
    const functional = renderToSVG({
      width: 400,
      height: 200,
      marks: [text({ x: 1, y: 1, label: "light", fill: "rgb(255 255 255)" })],
    });
    expect(functional).toContain('stroke="#000000"');
  });
});
