// Legend groups: series of the same name in marks of one group share a
// color, a legend entry, and visibility.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { errorBar } from "../../src/marks/errorbar.ts";
import { line } from "../../src/marks/line.ts";
import { legendGroupOf, legendKey } from "../../src/marks/mark.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import type {
  AreaGeometry,
  LineGeometry,
  RectGeometry,
  Scene,
  SegmentGeometry,
} from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { validateSpec } from "../../src/spec/validate.ts";

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(600, 300, 1);
  return model;
}

const kinds = (scene: Scene, kind: string) =>
  scene.panels[0]!.marks.filter((m) => m.kind === kind) as (RectGeometry | SegmentGeometry)[];

// A summary per category and sex: an estimate and its interval.
const summary = table({
  day: ["thu", "thu", "fri", "fri"],
  sex: ["f", "m", "f", "m"],
  mean: [2, 3, 4, 5],
  low: [1, 2, 3, 4],
  high: [3, 4, 5, 6],
});

const bars = (group?: string) =>
  bar(summary, {
    x: "day",
    y: "mean",
    series: "sex",
    ...(group !== undefined && { legendGroup: group }),
  });
const intervals = (group?: string) =>
  errorBar(summary, {
    x: "day",
    y1: "low",
    y2: "high",
    series: "sex",
    ...(group !== undefined && { legendGroup: group }),
  });

describe("legend groups", () => {
  it("give series of the same name one color and one legend entry", () => {
    const model = build({ marks: [bars("sex"), intervals("sex")] });
    const scene = model.scene(estimateText);
    const [f, m] = kinds(scene, "rect") as RectGeometry[];
    const [fBars, mBars] = kinds(scene, "segments") as SegmentGeometry[];
    expect(fBars!.stroke).toBe(f!.fill);
    expect(mBars!.stroke).toBe(m!.fill);
    expect(f!.fill).not.toBe(m!.fill);
    const entries = model.legendEntries();
    expect(entries.map(({ label }) => label)).toEqual(["f", "m"]);
    expect(entries.map(({ key }) => key)).toEqual([legendKey("sex", "f"), legendKey("sex", "m")]);
    expect(scene.legend.map(({ label }) => label)).toEqual(["f", "m"]);
    // Inspection still reads each mark's own series.
    const panel = scene.panels[0]!;
    const inspection = model.inspect(model.xScale()!.map(0), panel.plot.y + 5)!;
    expect(inspection.points.map(({ label }) => label)).toEqual(["f", "m", "f", "m"]);
  });

  it("leave marks without a group, or in other groups, apart", () => {
    const apart = build({ marks: [bars(), intervals()] });
    apart.scene(estimateText);
    expect(apart.legendEntries().map(({ label }) => label)).toEqual(["f", "m", "f", "m"]);
    const others = build({ marks: [bars("a"), intervals("b")] });
    others.scene(estimateText);
    expect(others.legendEntries()).toHaveLength(4);
    expect(new Set(others.legendEntries().map(({ color }) => color)).size).toBe(4);
  });

  it("hide every member with the entry, which grouped bars regroup around", () => {
    const model = build({ marks: [bars("sex"), intervals("sex")] });
    const before = model.scene(estimateText);
    const [shownF] = kinds(before, "rect") as RectGeometry[];
    model.hidden.add(legendKey("sex", "f"));
    const scene = model.scene(estimateText);
    const rects = kinds(scene, "rect") as RectGeometry[];
    const segments = kinds(scene, "segments") as SegmentGeometry[];
    expect(rects).toHaveLength(1);
    expect(segments).toHaveLength(1);
    // The other sex's bars take the whole band.
    expect(rects[0]!.rects[2]).toBeGreaterThan(shownF!.rects[2]!);
    expect(scene.legend.map(({ label, hidden }) => [label, hidden])).toEqual([
      ["f", true],
      ["m", false],
    ]);
    const panel = scene.panels[0]!;
    const inspection = model.inspect(model.xScale()!.map(0), panel.plot.y + 5)!;
    expect(inspection.points.map(({ label }) => label)).toEqual(["m", "m"]);
  });

  it("stack a group's visible series only, also for series new to the group", () => {
    const stacked = (data = summary) => [
      bar(data, { x: "day", y: "mean", series: "sex", stack: true, legendGroup: "sex" }),
    ];
    const model = build({ marks: stacked() });
    model.hidden.add(legendKey("sex", "f"));
    // Hidden before any scene resolved the series: the first scene stacks m alone.
    const scene = model.scene(estimateText);
    const [m] = kinds(scene, "rect") as RectGeometry[];
    const y = model.yScale()!;
    expect(m!.rects[1]! + m!.rects[3]!).toBeCloseTo(y.map(0), 3);
    expect(m!.rects[1]).toBeCloseTo(y.map(3), 3);
  });

  it("match single series by label", () => {
    const rows = table({ t: [0, 1, 2], v: [1, 2, 3], lo: [0, 1, 2], hi: [2, 3, 4] });
    const model = build({
      marks: [
        area(rows, { x: "t", y1: "lo", y2: "hi", label: "latency", legendGroup: "fit" }),
        line(rows, { x: "t", y: "v", label: "latency", legendGroup: "fit" }),
      ],
    });
    const scene = model.scene(estimateText);
    const [band] = kinds(scene, "area") as unknown as AreaGeometry[];
    const [trace] = kinds(scene, "line") as unknown as LineGeometry[];
    expect(band!.fill).toBe(trace!.stroke);
    expect(model.legendEntries().map(({ label }) => label)).toEqual(["latency"]);
  });

  it("keep explicit colors, and still share visibility", () => {
    const model = build({
      marks: [
        bars("sex"),
        errorBar(summary, {
          x: "day",
          y1: "low",
          y2: "high",
          series: "sex",
          stroke: "#444444",
          legendGroup: "sex",
        }),
      ],
    });
    const scene = model.scene(estimateText);
    expect((kinds(scene, "segments") as SegmentGeometry[]).map((s) => s.stroke)).toEqual([
      "#444444",
      "#444444",
    ]);
    // The entry shows the first member's color: the bars'.
    expect(model.legendEntries()[0]!.color).toBe((kinds(scene, "rect")[0] as RectGeometry).fill);
    model.hidden.add(legendKey("sex", "m"));
    expect(kinds(model.scene(estimateText), "segments")).toHaveLength(1);
  });

  it("name their group in their entries' keys", () => {
    expect(legendGroupOf(legendKey("sex", "f"))).toBe("sex");
    expect(legendGroupOf(JSON.stringify([0, "f"]))).toBeUndefined();
    expect(legendGroupOf("f")).toBeUndefined();
  });

  it("must be names", () => {
    expect(() => build({ marks: [bars("")] }).scene(estimateText)).toThrow(/legendGroup/);
  });
});

describe("legend groups in specs", () => {
  const spec = (version: number) => ({
    version,
    data: {
      summary: {
        columns: { day: ["thu", "fri"], mean: [2, 4], low: [1, 3], high: [3, 5] },
      },
    },
    marks: [
      { type: "bar", x: "day", y: "mean", label: "mean", legendGroup: "g" },
      { type: "errorbar", x: "day", y1: "low", y2: "high", label: "mean", legendGroup: "g" },
    ],
  });

  it("need version 10", () => {
    expect(() => validateSpec(spec(6))).toThrow(/marks\[0\]\.legendGroup.*"version": 10 or later/);
    expect(() => validateSpec(spec(9))).toThrow(/"version": 10 or later/);
    expect(() => validateSpec(spec(10))).not.toThrow();
    const { config, unknown } = loadSpec(spec(10) as never);
    expect(unknown).toEqual([]);
    expect(config.marks.map((mark) => mark.spec.legendGroup)).toEqual(["g", "g"]);
  });

  it("must be names, and only on marks with series", () => {
    const empty = spec(10);
    empty.marks[0]!.legendGroup = "";
    expect(() => validateSpec(empty)).toThrow(/marks\[0\]\.legendGroup.*legend group's name/);
  });
});
