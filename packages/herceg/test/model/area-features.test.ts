// Areas' features: conditional bands (`where`), continuity, colors by
// category, and looks by series.
import { describe, expect, it } from "vitest";
import { col } from "../../src/data/expr.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import type { Polyline } from "../../src/lod/polyline.ts";
import { area } from "../../src/marks/area.ts";
import { line } from "../../src/marks/line.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import type { AreaGeometry, LineGeometry, Scene } from "../../src/scene/scene.ts";
import { LIGHT } from "../../src/theme.ts";

function build(config: ChartConfig) {
  const model = new ChartModel(
    { locale: "en-US", timeZone: "UTC", ...config },
    undefined,
    ...staticCompilers(),
  );
  model.setSize(600, 300, 1);
  return { model, scene: model.scene(estimateText) };
}

const areas = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is AreaGeometry => m.kind === "area");

/** The x pixels where each run of a polyline starts and ends. */
const ends = (path: Polyline) =>
  path.starts.map((start, r) => [path.coords[start * 2]!, path.coords[(path.runEnd(r) - 1) * 2]!]);

// Efficiency falls under the limit (1) from t = 1.5 to 3.5 on straight lines.
const runs = table({ t: [0, 1, 2, 3, 4], e: [0, 0.5, 1.5, 1.5, 0.5], limit: [1, 1, 1, 1, 1] });

describe("conditional bands", () => {
  it("shade between two fields where a condition holds, meeting the lines where it changes", () => {
    const { scene, model } = build({
      marks: [
        area(runs, { x: "t", y1: "e", y2: "limit", where: col("e").lt(col("limit")) }),
        line(runs, { x: "t", y: "e" }),
      ],
    });
    const [band] = areas(scene);
    const x = model.xScale()!;
    const upper = ends(band!.upper).map(([a, b]) => [x.invert(a!), x.invert(b!)]);
    const lower = ends(band!.lower!).map(([a, b]) => [x.invert(a!), x.invert(b!)]);
    // Both edges share their runs and their crossings.
    expect(upper).toEqual([
      [expect.closeTo(0, 6), expect.closeTo(1.5, 6)],
      [expect.closeTo(3.5, 6), expect.closeTo(4, 6)],
    ]);
    expect(lower).toEqual(upper);
    // At a crossing, the band closes on the line: both edges at the limit.
    const y = model.yScale()!;
    const crossing = band!.upper.runEnd(0) - 1;
    expect(y.invert(band!.upper.coords[crossing * 2 + 1]!)).toBeCloseTo(1, 6);
  });

  it("end steps where the rows they belong to end", () => {
    const { scene, model } = build({
      marks: [
        area(runs, {
          x: "t",
          y1: "e",
          y2: "limit",
          curve: "step-after",
          where: col("e").lt(col("limit")),
        }),
      ],
    });
    const x = model.xScale()!;
    const [band] = areas(scene);
    expect(ends(band!.upper).map(([a, b]) => [x.invert(a!), x.invert(b!)])).toEqual([
      [expect.closeTo(0, 6), expect.closeTo(2, 6)],
      [expect.closeTo(4, 6), expect.closeTo(4, 6)],
    ]);
  });

  it("meet no condition change from a row without a place", () => {
    // Row 2 has no x, so the band's run ends at row 1: the step-after
    // crossing at row 3 belongs to row 2, which draws nothing.
    const holed = table({ t: [1, 2, Number.NaN, 3], e: [0, 0, 0, 2], limit: [1, 1, 1, 1] });
    const { scene, model } = build({
      marks: [
        area(holed, {
          x: "t",
          y1: "e",
          y2: "limit",
          curve: "step-after",
          where: col("e").lt(col("limit")),
        }),
      ],
    });
    const x = model.xScale()!;
    const [band] = areas(scene);
    expect(ends(band!.upper).map(([a, b]) => [x.invert(a!), x.invert(b!)])).toEqual([
      [expect.closeTo(1, 6), expect.closeTo(2, 6)],
    ]);
  });

  it("share their runs between edges where only one edge has a gap", () => {
    const gappy = table({
      t: [0, 1, 2, 3, 4],
      e: [0, 0.5, 0.2, 0.3, 0.4],
      limit: [1, 1, Number.NaN, 1, 1],
    });
    const { scene } = build({
      marks: [area(gappy, { x: "t", y1: "e", y2: "limit", where: col("e").lt(1) })],
    });
    const [band] = areas(scene);
    expect(band!.upper.starts).toEqual(band!.lower!.starts);
    expect(band!.upper.starts).toHaveLength(2);
  });

  it("refuse stacked areas", () => {
    const wide = table({ t: [0, 1], a: [1, 2], b: [2, 3] });
    expect(() =>
      build({ marks: [area(wide, { x: "t", y: ["a", "b"], stack: true, where: col("a").gt(1) })] }),
    ).toThrow("area (mark 0) where: stacked areas cannot leave rows out yet; drop it or the stack");
  });
});

describe("area continuity", () => {
  it("leaves gaps where neighbors are too far apart, also in areas filled to zero", () => {
    const gappy = table({ t: [0, 1, 2, 10, 11], v: [1, 2, 3, 4, 5] });
    const { scene } = build({
      marks: [area(gappy, { x: "t", y: "v", continuity: { maxGap: 2 } })],
    });
    expect(areas(scene)[0]!.upper.starts).toEqual([0, 3]);
  });
});

describe("area looks", () => {
  const sites = table({
    t: [0, 1, 0, 1],
    v: [1, 2, 3, 4],
    site: ["A", "A", "B", "B"],
  });

  it("color series by category through the color scale, and map a series' look", () => {
    const { scene } = build({
      scales: { color: { type: "ordinal", map: { B: "#00ab41" } } },
      marks: [
        area(sites, {
          x: "t",
          y: "v",
          series: "site",
          color: "site",
          style: { by: { map: { B: { fillOpacity: 0.6, stroke: "#222222" } } } },
        }),
      ],
    });
    const [a, b] = areas(scene);
    expect([a!.fill, b!.fill]).toEqual([LIGHT.palette[0], "#00ab41"]);
    expect(b!.fillOpacity).toBe(0.6);
    expect(b!.stroke).toBe("#222222");
  });

  it("take opacity in their fill and outline", () => {
    const { scene } = build({
      marks: [
        area(sites, {
          x: "t",
          y: "v",
          series: "site",
          fillOpacity: 0.5,
          opacity: 0.5,
          strokeOpacity: 0.8,
        }),
      ],
    });
    const [a] = areas(scene);
    expect(a!.fillOpacity).toBe(0.25);
    expect(a!.strokeOpacity).toBeCloseTo(0.4, 6);
  });
});

describe("lines and areas together", () => {
  it("share a series' color through the color scale", () => {
    const sites = table({ t: [0, 1, 0, 1], v: [1, 2, 3, 4], site: ["A", "A", "B", "B"] });
    const { scene } = build({
      marks: [
        area(sites, { x: "t", y: "v", series: "site", color: "site" }),
        line(sites, { x: "t", y: "v", series: "site", color: "site" }),
      ],
    });
    const lines = scene.panels[0]!.marks.filter((m): m is LineGeometry => m.kind === "line");
    expect(areas(scene).map((a) => a.fill)).toEqual(lines.map((l) => l.stroke));
  });
});
