import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { funnel } from "../../src/marks/funnel.ts";
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

const signups = table({
  stage: ["Visit", "Cart", "Checkout", "Purchase"],
  users: [2000, 1200, 800, 300],
});

function build(config: ChartConfig, width = 400, height = 300) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const marks = (scene: Scene) => scene.panels[0]!.marks;
const bars = (scene: Scene) => marks(scene).find((m): m is RectGeometry => m.kind === "rect")!;
const box = (mark: RectGeometry, i: number) => Array.from(mark.rects.subarray(i * 4, i * 4 + 4));
const text = (scene: Scene, key: string) =>
  marks(scene).find((m): m is TextGeometry => m.kind === "text" && m.key === key);

describe("funnel", () => {
  it("centers a bar per stage, top to bottom, as wide as its value is to the largest", () => {
    const { scene } = build({ marks: [funnel(signups, { category: "stage", value: "users" })] });
    const mark = bars(scene);
    expect(mark.count).toBe(4);
    expect(mark.fill).toBe(scene.theme.palette[0]);
    expect(mark.rounded).toBeUndefined();
    const [x0, y0, w0, h0] = box(mark, 0) as number[];
    for (const [i, share] of [0.6, 0.4, 0.15].entries()) {
      const [x, y, w, h] = box(mark, i + 1) as number[];
      expect(w! / w0!).toBeCloseTo(share, 5);
      expect(x! + w! / 2).toBeCloseTo(x0! + w0! / 2, 3);
      expect(h).toBeCloseTo(h0!, 3);
      // Below the previous bar, a gap of 0.3 bars apart.
      expect(y! - y0!).toBeCloseTo((i + 1) * 1.3 * h0!, 3);
    }
    expect(scene.legend).toEqual([]);
  });

  it("joins neighboring bars with faint connectors", () => {
    const { scene } = build({ marks: [funnel(signups, { category: "stage", value: "users" })] });
    const shapes = marks(scene).find((m): m is ShapesGeometry => m.kind === "shapes")!;
    const [connectors] = shapes.shapes as PathShape[];
    expect(connectors!.opacity).toBe(0.15);
    expect(connectors!.fill).toBe(scene.theme.palette[0]);
    expect(connectors!.d.match(/M/g)).toHaveLength(3);
    // The first connector starts at the first bar's bottom corners.
    const [x, y, w, h] = box(bars(scene), 0) as number[];
    const [mx, my, hx] = /^M([\d.]+) ([\d.]+)H([\d.]+)/.exec(connectors!.d)!.slice(1).map(Number);
    expect([mx, my, hx].map((v) => v!.toFixed(1))).toEqual(
      [x!, y! + h!, x! + w!].map((v) => v.toFixed(1)),
    );
    // Connectors draw under the bars.
    expect(marks(scene).indexOf(shapes)).toBeLessThan(marks(scene).indexOf(bars(scene)));
  });

  it("sums values per stage, counts rows without them, and leaves out bad values", () => {
    const visits = table({
      stage: ["a", "b", "a", "b", "c", "c"],
      v: [3, 2, Number.NaN, -4, Number.POSITIVE_INFINITY, 1],
    });
    const summed = build({ marks: [funnel(visits, { category: "stage", value: "v" })] });
    const widths = [0, 1, 2].map((i) => box(bars(summed.scene), i)[2]!);
    expect(widths[1]! / widths[0]!).toBeCloseTo(2 / 3, 5);
    expect(widths[2]! / widths[0]!).toBeCloseTo(1 / 3, 5);
    const counted = build({ marks: [funnel(visits, { category: "stage" })] });
    expect(bars(counted.scene).count).toBe(3);
    expect(box(bars(counted.scene), 2)[2]).toBeCloseTo(box(bars(counted.scene), 0)[2]!, 5);
    expect(counted.model.layoutSummary()).toBe(
      "Funnel of stage: 3 stages from 2 (a) to 2 (c), 100% of the first.",
    );
  });

  it("keeps widths finite for values near the largest double", () => {
    const huge = table({ stage: ["a", "b"], v: [1e307, 5e306] });
    const mark = bars(build({ marks: [funnel(huge, { category: "stage", value: "v" })] }).scene);
    expect(Array.from(mark.rects).every(Number.isFinite)).toBe(true);
    expect(box(mark, 1)[2]! / box(mark, 0)[2]!).toBeCloseTo(0.5, 5);
  });

  it("follows its table, reordering stages sorted by value", () => {
    const live = table({ stage: ["a", "b"], v: [5, 3] });
    const { model } = build({
      marks: [funnel(live, { category: "stage", value: "v", sort: "value" })],
    });
    live.append({ stage: ["b", "c"], v: [4, 9] });
    const scene = model.scene(estimateText);
    expect(text(scene, "funnel-names")!.labels).toEqual(["c", "b", "a"]);
    const widths = [0, 1, 2].map((i) => box(bars(scene), i)[2]!);
    expect(widths[1]! / widths[0]!).toBeCloseTo(7 / 9, 5);
    expect(widths[2]! / widths[0]!).toBeCloseTo(5 / 9, 5);
    expect(model.inspectItem(model.stepItem(undefined, 1)!)!.points[0]!.label).toBe("c");
    expect(model.layoutSummary()).toBe(
      "Funnel of v by stage: 3 stages from 9 (c) to 5 (a), 55.6% of the first.",
    );
  });

  it("keeps the categories' order, or puts the largest stage first", () => {
    const odd = table({ stage: ["x", "y", "z"], v: [1, 3, 2] });
    const input = build({ marks: [funnel(odd, { category: "stage", value: "v" })] });
    expect(text(input.scene, "funnel-names")!.labels).toEqual(["x", "y", "z"]);
    const sorted = build({
      marks: [funnel(odd, { category: "stage", value: "v", sort: "value" })],
    });
    expect(text(sorted.scene, "funnel-names")!.labels).toEqual(["y", "z", "x"]);
    // A stage wider than the one above it widens its connector.
    expect(box(bars(input.scene), 1)[2]).toBeGreaterThan(box(bars(input.scene), 0)[2]!);
  });

  it("names stages left of the bars and writes values on them or beside them", () => {
    const tiny = table({ stage: ["Visit", "Cart", "Purchase"], users: [2000, 1200, 15] });
    const { scene } = build({ marks: [funnel(tiny, { category: "stage", value: "users" })] });
    const names = text(scene, "funnel-names")!;
    expect(names.anchor).toBe("end");
    expect(names.labels).toEqual(["Visit", "Cart", "Purchase"]);
    // Names end left of the widest bar.
    expect(names.coords[0]).toBeLessThan(box(bars(scene), 0)[0]!);
    const inside = text(scene, "funnel-inside")!;
    expect(inside.labels).toEqual(["2,000 · 100%", "1,200 · 60%"]);
    expect(inside.fill).toBe("#ffffff");
    const beside = text(scene, "funnel-beside")!;
    expect([beside.anchor, ...beside.labels]).toEqual(["start", "15 · 0.8%"]);
    const [x, , w] = box(bars(scene), 2) as number[];
    expect(beside.coords[0]).toBeGreaterThan(x! + w!);
  });

  it("shortens long names, falls back to shares, and drops labels without room", () => {
    const long = table({
      stage: ["Visited the landing page", "Signed up", "Activated the trial account"],
      users: [12000, 5400, 3100],
    });
    const narrow = build(
      { marks: [funnel(long, { category: "stage", value: "users" })] },
      260,
      200,
    ).scene;
    const names = text(narrow, "funnel-names")!.labels;
    expect(names[0]).toMatch(/^Visited.*…$/);
    expect(names[1]).toBe("Signed up");
    // The names take at most 35% of the width.
    expect(box(bars(narrow), 0)[0]).toBeLessThanOrEqual(8 + 260 * 0.35 + 10 + 1);
    const values = [
      ...(text(narrow, "funnel-inside")?.labels ?? []),
      ...(text(narrow, "funnel-beside")?.labels ?? []),
    ];
    expect(values).toContain("45%");
    // Bars thinner than a line of text carry no labels; nor do charts asking for none.
    const many = table({ stage: Array.from({ length: 40 }, (_, i) => `s${i}`) });
    const crowded = build({ marks: [funnel(many, { category: "stage" })] }, 400, 200).scene;
    expect(marks(crowded).some((m) => m.kind === "text")).toBe(false);
    const plain = build({
      marks: [funnel(signups, { category: "stage", value: "users", labels: false })],
    }).scene;
    expect(marks(plain).some((m) => m.kind === "text")).toBe(false);
    expect(box(bars(plain), 0)[0]).toBe(8);
  });

  it("reports stages as items, top to bottom, with their shares", () => {
    const { scene, model } = build({
      marks: [funnel(signups, { category: "stage", value: "users" })],
    });
    const texts = [0, 1, 2, 3].map((i) => {
      const key = model.stepItem(undefined, 1 + i)!;
      return model.inspectItem(key)!.points[0]!.text;
    });
    expect(texts).toEqual([
      "2,000",
      "1,200, 60% of the first stage",
      "800, 40% of the first stage, 66.7% of the previous",
      "300, 15% of the first stage, 37.5% of the previous",
    ]);
    // A stage's whole row answers, even beside a narrow bar; the gaps do not.
    const [, y, , h] = box(bars(scene), 3) as number[];
    const found = model.inspect(390, y! + h! / 2) as ItemInspection;
    expect([found.label, found.points[0]!.label, found.value]).toEqual(["users", "Purchase", 300]);
    expect(found.outline).toMatch(/^M.*h.*v.*Z$/);
    expect(model.inspect(200, y! - 2)).toBeUndefined();
    expect(model.layoutSummary()).toBe(
      "Funnel of users by stage: 4 stages from 2,000 (Visit) to 300 (Purchase), 15% of the first.",
    );
  });

  it("has nothing to show without rows", () => {
    const empty = table({ stage: category([]), v: [] as number[] });
    const { scene, model } = build({ marks: [funnel(empty, { category: "stage", value: "v" })] });
    expect(bars(scene).count).toBe(0);
    expect(model.inspect(200, 150)).toBeUndefined();
    expect(model.stepItem(undefined, 1)).toBeUndefined();
    expect(describeChart(model)).toBe("Funnel of v by stage, with nothing to show.");
    const one = table({ stage: ["only"], v: [0] });
    const single = build({ marks: [funnel(one, { category: "stage", value: "v" })] });
    expect(box(bars(single.scene), 0)[2]).toBe(0);
    expect(single.model.layoutSummary()).toBe("Funnel of v by stage: 1 stage, only at 0.");
  });

  it("loads from specs and renders to SVG and PDF", () => {
    const spec = (mark: object) => ({
      version: 1 as const,
      width: 300,
      height: 200,
      data: {
        t: {
          columns: {
            stage: { type: "category", codes: [0, 1], dictionary: ["Visit", "Buy"] },
            v: [10, 4],
          },
        },
      },
      marks: [{ type: "funnel", category: "stage", ...mark }],
    });
    const { config } = loadSpec(spec({ value: "v", sort: "value" }) as never, []);
    const svg = renderToSVG({ ...config, width: 300, height: 200 });
    expect(svg).toContain("10 · 100%");
    // The connector is one path in the bars' color at 15% opacity.
    expect(svg).toMatch(
      /<path d="M[^"]+Z" fill="#3266d6" fill-opacity="0.15" stroke-opacity="0.15"\/>/,
    );
    expect(renderToPDF({ ...config, width: 300, height: 200 }).length).toBeGreaterThan(500);
    const load = (mark: object) => () => loadSpec(spec(mark) as never, []);
    expect(load({ sort: "size" })).toThrow('marks[0].sort: expected "input" or "value"');
    expect(load({ category: undefined })).toThrow("marks[0].category: required");
    expect(load({ value: "stage" })).toThrow("marks[0]: funnel value");
  });
});
