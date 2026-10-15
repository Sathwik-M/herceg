// Annotations' places as coordinates (values, fractions, pixels, offsets)
// and their labels as objects: text or a field, placed and styled.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { line } from "../../src/marks/line.ts";
import { region } from "../../src/marks/region.ts";
import { rule } from "../../src/marks/rule.ts";
import { text } from "../../src/marks/text.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type {
  AxisGuide,
  LabelsGeometry,
  RuleGeometry,
  Scene,
  TextGeometry,
} from "../../src/scene/scene.ts";
import { validateSpec } from "../../src/spec/validate.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel(
    { locale: "en-US", timeZone: "UTC", ...config },
    undefined,
    ...staticCompilers(),
  );
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const marksOf = <K extends string>(scene: Scene, kind: K) =>
  scene.panels[0]!.marks.filter((m) => m.kind === kind);
const labels = (scene: Scene) =>
  (marksOf(scene, "labels") as LabelsGeometry[]).flatMap((g) => g.items);
const yAxisOf = (scene: Scene) =>
  scene.panels[0]!.axes.find((a): a is AxisGuide => a.kind === "axis" && a.scale === "y")!;

const data = table({ x: [0, 1, 2, 3], y: [1, 2, 1.5, 2.5] });

describe("rule labels", () => {
  it("go at the rule's end above it by default, as plain text", () => {
    const { scene } = build({
      marks: [line(data, { x: "x", y: "y" }), rule({ y: 2, label: "goal" })],
    });
    const [goal] = marksOf(scene, "rule") as RuleGeometry[];
    expect(goal!.label).toBe("goal");
    expect(labels(scene)).toEqual([]);
  });

  it("go at the start, middle, or end of the rule", () => {
    const placed = (attachment: "start" | "center" | "end") => {
      const { scene } = build({
        marks: [
          line(data, { x: "x", y: "y" }),
          rule({ y: 2, label: { text: "goal", place: { attachment } } }),
        ],
      });
      const [item] = labels(scene);
      return [item!.anchor, Math.round(item!.x)];
    };
    const { scene } = build({ marks: [line(data, { x: "x", y: "y" })] });
    const plot = scene.panels[0]!.plot;
    expect(placed("start")).toEqual(["start", Math.round(plot.x + 4)]);
    expect(placed("center")).toEqual(["middle", Math.round(plot.x + plot.width / 2)]);
    expect(placed("end")).toEqual(["end", Math.round(plot.x + plot.width - 4)]);
  });

  it("go outside the plot left of the y axis' labels, which make room for them", () => {
    const threshold = rule({
      y: 2,
      label: { text: "Threshold", place: { attachment: "start", outside: true } },
    });
    const without = build({ marks: [line(data, { x: "x", y: "y" })] }).scene;
    const { scene } = build({ marks: [line(data, { x: "x", y: "y" }), threshold] });
    const plot = scene.panels[0]!.plot;
    const width = estimateText(
      "Threshold",
      '12px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
    );
    // The plot moves right by the label's track and the chart's edge spacing beside it.
    expect(plot.x - without.panels[0]!.plot.x).toBeCloseTo(Math.ceil(width) + 8, 0);
    const [item] = labels(scene);
    expect(item!.anchor).toBe("end");
    // Right-aligned before the axis' widest label, which ends at the plot.
    const ticks = yAxisOf(scene).items.filter((i) => i.type === "text");
    const leftmost = Math.min(
      ...ticks.map((t) => (t.type === "text" ? t.x - estimateText(t.text, t.paint.css) : 0)),
    );
    expect(item!.x).toBeLessThan(leftmost);
    expect(item!.x - width).toBeGreaterThanOrEqual(0);
  });

  it("take a track of their own beyond the y axis' title, or right of the plot at the end", () => {
    const threshold = (attachment: "start" | "end") =>
      rule({ y: 2, label: { text: "Threshold", place: { attachment, outside: true } } });
    const { scene } = build({
      y: { title: "ms" },
      marks: [line(data, { x: "x", y: "y" }), threshold("start"), threshold("end")],
    });
    const [left, right] = labels(scene);
    const title = yAxisOf(scene).items.find((i) => i.type === "text" && i.text === "ms")!;
    expect(left!.x).toBeLessThan((title as { x: number }).x);
    const plot = scene.panels[0]!.plot;
    expect(right!.anchor).toBe("start");
    expect(right!.x).toBeGreaterThan(plot.x + plot.width);
  });

  it("go beyond each panel's y labels in a grid, with tracks beside the outer columns", () => {
    const sites = table({ x: [0, 1, 0, 1], y: [1, 2, 1, 2], site: ["a", "a", "b", "b"] });
    const { scene } = build({
      facet: facet("site", { columns: 2 }),
      marks: [
        line(sites, { x: "x", y: "y" }),
        rule({ y: 1.5, label: { text: "T", place: { attachment: "start", outside: true } } }),
      ],
    });
    const [first, second] = scene.panels;
    const at = (panel: typeof first) =>
      (panel!.marks.find((m) => m.kind === "labels") as LabelsGeometry).items[0]!.x;
    expect(at(first)).toBeLessThan(first!.plot.x);
    expect(at(second)).toBeLessThan(second!.plot.x);
    expect(at(second)).toBeGreaterThan(first!.plot.x + first!.plot.width);
  });

  it("refuse an outside label at the middle", () => {
    expect(() =>
      rule({ y: 2, label: { text: "x", place: { attachment: "center", outside: true } } }),
    ).toThrow(
      'rule label.place: a label outside the plot goes at the rule\'s start or end; give attachment "start" or "end"',
    );
  });

  it("take a style of their own and a field's values in a pattern", () => {
    const limits = table({ y: [1.25, 2.5] });
    const { scene } = build({
      marks: [
        line(data, { x: "x", y: "y" }),
        rule(limits, {
          y: "y",
          label: {
            field: "y",
            format: { number: ".2f" },
            style: { fontSize: 14, color: "#c00000" },
          },
        }),
      ],
    });
    expect(labels(scene).map((i) => [i.text, i.paint.size, i.paint.color])).toEqual([
      ["1.25", 14, "#c00000"],
      ["2.50", 14, "#c00000"],
    ]);
  });

  it("run along a span and draw at a stroke opacity", () => {
    const { scene } = build({
      marks: [
        line(data, { x: "x", y: "y" }),
        rule({ y: 2, span: [{ fraction: 0.25 }, { data: 3 }], strokeOpacity: 0.5 }),
      ],
    });
    const [r] = marksOf(scene, "rule") as RuleGeometry[];
    const plot = scene.panels[0]!.plot;
    expect(r!.x1).toBeCloseTo(plot.x + plot.width * 0.25, 6);
    expect(r!.x2).toBeCloseTo(plot.x + plot.width, 6);
    expect(r!.opacity).toBe(0.5);
    const svg = renderToSVG({
      width: 300,
      height: 200,
      marks: [line(data, { x: "x", y: "y" }), rule({ y: 2, strokeOpacity: 0.5 })],
    });
    expect(svg).toContain('stroke-opacity="0.5"');
  });

  it("read spans from fields of their table, a rule per row", () => {
    const windows = table({ from: [0, 2], to: [1, 3] });
    const mark = rule(windows, { y: 2, span: [{ field: "from" }, { field: "to" }] });
    expect((mark as unknown as { table: unknown }).table).toBe(windows);
    const { scene, model } = build({ marks: [line(data, { x: "x", y: "y" }), mark] });
    const drawn = marksOf(scene, "rule") as RuleGeometry[];
    const x = model.xScale()!;
    expect(drawn.map((r) => [x.invert(r.x1), x.invert(r.x2)])).toEqual([
      [expect.closeTo(0, 6), expect.closeTo(1, 6)],
      [expect.closeTo(2, 6), expect.closeTo(3, 6)],
    ]);
  });

  it("widen the other axis by their spans when they say so", () => {
    const { model } = build({
      marks: [
        line(data, { x: "x", y: "y" }),
        rule({ y: 2, span: [{ data: 0 }, { data: 8 }], contributeDomain: true }),
      ],
    });
    expect(model.xScale()!.domain[1]).toBeGreaterThanOrEqual(8);
  });

  it("refuse a scale other than its axis'", () => {
    expect(() => rule({ y: { data: 2, scale: "yRight" } })).toThrow(
      'rule y.scale: "yRight" is not this y axis\' scale ("y"); give axis: "right"',
    );
  });
});

describe("text places", () => {
  it("mix a fraction of the plot's width with a data value", () => {
    const { scene, model } = build({
      marks: [
        line(data, { x: "x", y: "y" }),
        text({ at: { x: { fraction: 0.03 }, y: { data: 1.7 } }, label: "here" }),
      ],
    });
    const [label] = marksOf(scene, "text") as TextGeometry[];
    const plot = scene.panels[0]!.plot;
    expect(label!.coords[0]).toBeCloseTo(plot.x + 0.03 * plot.width, 3);
    expect(label!.coords[1]).toBeCloseTo(model.yScale()!.map(1.7), 3);
  });

  it("take pixels from the top and offsets, and categories by their values", () => {
    const sales = table({ month: ["Jan", "Feb", "Mar"], v: [1, 2, 3] });
    const { scene, model } = build({
      marks: [
        line(sales, { x: "month", y: "v" }),
        text({ x: { data: "Feb" }, y: { px: 10, offset: 5 }, label: "mid" }),
      ],
    });
    const [label] = marksOf(scene, "text") as TextGeometry[];
    expect(label!.coords[0]).toBeCloseTo(model.xScale()!.map(1), 3);
    expect(label!.coords[1]).toBeCloseTo(scene.panels[0]!.plot.y + 15, 3);
  });

  it("write values and fields at their places as coordinates, as specs take them", () => {
    const at = text({ at: { x: 1, y: new Date(5) }, label: "a" });
    expect(at.spec.at).toEqual({ x: { data: 1 }, y: { data: 5 } });
    expect(() => validateSpec({ marks: [at.spec as never] })).not.toThrow();
    const rows = table({ t: [1], v: [2], name: ["n"] });
    const fields = text(rows, { at: { x: "t", y: { fraction: 0.5 } }, label: { field: "name" } });
    expect(fields.spec.at).toEqual({ x: { field: "t" }, y: { fraction: 0.5 } });
  });

  it("refuse both at and its short forms", () => {
    expect(() =>
      text({ x: 1, y: 2, at: { x: { data: 1 }, y: { data: 2 } }, label: "a" } as never),
    ).toThrow("text at: a place, or its short forms x and y, not both; drop at or x and y");
  });
});

describe("text styles", () => {
  it("draw labels in a style of their own with a box behind them", () => {
    const { scene } = build({
      marks: [
        line(data, { x: "x", y: "y" }),
        text({
          x: 1,
          y: 2,
          label: {
            text: "Peak",
            style: {
              fontSize: 16,
              fontWeight: 700,
              color: "#222222",
              background: { fill: "#ffffff", radius: 3 },
              padding: 4,
              align: "start",
            },
          },
          halo: false,
        }),
      ],
    });
    const [item] = labels(scene);
    expect([item!.text, item!.paint.size, item!.paint.weight, item!.anchor]).toEqual([
      "Peak",
      16,
      700,
      "start",
    ]);
    expect(item!.box).toBeDefined();
    expect(item!.halo).toBeUndefined();
  });

  it("write numbers with Intl options in marks the compiler draws", () => {
    const peaks = table({ x: [1], y: [2], v: [1234.5] });
    const svg = renderToSVG({
      width: 300,
      height: 200,
      locale: "en-US",
      marks: [
        line(data, { x: "x", y: "y" }),
        text(peaks, {
          x: "x",
          y: "y",
          label: { field: "v", format: { maximumFractionDigits: 0 } },
          style: { leader: { stroke: "#999999" } },
          overlap: "move",
        }),
      ],
    });
    expect(svg).toContain(">1,235<");
  });

  it("keep plain text as text marks have always drawn it, with a color of its own", () => {
    const { scene } = build({
      marks: [
        line(data, { x: "x", y: "y" }),
        text({ x: 1, y: 2, label: { text: "a", style: { color: "#cc0000" } } }),
      ],
    });
    const [label] = marksOf(scene, "text") as TextGeometry[];
    expect(label!.fill).toBe("#cc0000");
  });
});

describe("region domains", () => {
  it("count a y range across a fraction of the plot when they say so", () => {
    const { model } = build({
      marks: [
        line(data, { x: "x", y: "y" }),
        region({
          x1: { fraction: 0 },
          x2: { fraction: 0.5 },
          y1: 10,
          y2: 20,
          contributeDomain: true,
        }),
      ],
    });
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(20);
  });
});

describe("region labels", () => {
  it("go along the edge their place names, inside or outside", () => {
    const at = (place: object) => {
      const { scene } = build({
        marks: [
          region({ x1: 1, x2: 2, y1: 1.2, y2: 2.2, label: { text: "r", place } }),
          line(data, { x: "x", y: "y" }),
        ],
      });
      // Plain text at the place asked for, with its anchor.
      const [label] = marksOf(scene, "text") as TextGeometry[];
      return { anchor: label!.anchor, x: label!.coords[0]!, y: label!.coords[1]! };
    };
    const { scene, model } = build({ marks: [line(data, { x: "x", y: "y" })] });
    void scene;
    const x = model.xScale()!;
    const y = model.yScale()!;
    const bottom = at({ side: "bottom", attachment: "end" });
    expect(bottom.anchor).toBe("end");
    expect(bottom.x).toBeCloseTo(x.map(2) - 4, 3);
    expect(bottom.y).toBeLessThan(y.map(1.2));
    const above = at({ side: "top", outside: true, attachment: "center" });
    expect(above.x).toBeCloseTo((x.map(1) + x.map(2)) / 2, 3);
    expect(above.y).toBeLessThan(y.map(2.2));
  });
});
