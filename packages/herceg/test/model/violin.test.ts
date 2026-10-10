import { describe, expect, it } from "vitest";
import { silverman } from "../../src/data/density.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import type { Polyline } from "../../src/lod/polyline.ts";
import { violin } from "../../src/marks/violin.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type AxisInspection, type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type {
  AreaGeometry,
  LineGeometry,
  PointGeometry,
  RectGeometry,
  Scene,
  SegmentGeometry,
} from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";

const latency = table({
  region: ["n", "n", "n", "n", "n", "s", "s", "s", "s", "s", "s", "s", "s"],
  version: ["a", "a", "b", "b", "b", "a", "a", "a", "b", "b", "b", "b", "b"],
  ms: [10, 20, 30, 40, 50, 5, 6, 7, 8, 9, 10, 11, 100],
});

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const geometry = <T>(scene: Scene, kind: string) =>
  scene.panels[0]!.marks.filter((m) => m.kind === kind) as T[];

/** The pixel extent of a polyline's run along one coordinate (0 for x, 1 for y). */
function extent(coords: Float32Array, start: number, end: number, axis: 0 | 1) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = start; i < end; i++) {
    min = Math.min(min, coords[i * 2 + axis]!);
    max = Math.max(max, coords[i * 2 + axis]!);
  }
  return [min, max] as const;
}

describe("violin", () => {
  it("draws each group's density with its whisker range, quartile box, and median", () => {
    const { scene, model } = build({
      marks: [violin(latency, { x: "region", y: "ms", series: "version" })],
    });
    expect(scene.legend.map((entry) => entry.label)).toEqual(["a", "b"]);
    const areas = geometry<AreaGeometry>(scene, "area");
    expect(areas.map((m) => m.upper.starts.length)).toEqual([2, 2]);
    expect(areas[0]!.fillOpacity).toBe(0.25);
    const outlines = geometry<LineGeometry>(scene, "line");
    // Each outline is closed: it ends where it starts.
    const path = outlines[0]!.path;
    const end = path.runEnd(0) - 1;
    expect([path.coords[end * 2], path.coords[end * 2 + 1]]).toEqual([
      path.coords[0],
      path.coords[1],
    ]);
    expect(geometry<SegmentGeometry>(scene, "segments").map((m) => m.count)).toEqual([2, 2]);
    expect(geometry<RectGeometry>(scene, "rect").map((m) => m.count)).toEqual([2, 2]);
    const medians = geometry<PointGeometry>(scene, "point");
    expect(medians.map((m) => m.count)).toEqual([2, 2]);
    // Median dots are the surface's color, over the colored box.
    expect(medians[0]!.fill).toBe("#ffffff");
    // The y domain reaches two bandwidths past the extreme values.
    const tail = 100 + 2 * silverman([8, 9, 10, 11, 100]);
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(tail);
  });

  it("makes every violin as wide at its densest", () => {
    const { scene } = build({ marks: [violin(latency, { x: "region", y: "ms" })] });
    const { upper, lower } = geometry<AreaGeometry>(scene, "area")[0]! as AreaGeometry & {
      lower: Polyline;
    };
    const widths = [0, 1].map((run) => {
      const [, right] = extent(upper.coords, upper.starts[run]!, upper.runEnd(run), 0);
      const [left] = extent(lower.coords, lower.starts[run]!, lower.runEnd(run), 0);
      return right - left;
    });
    expect(widths[0]).toBeCloseTo(widths[1]!, 3);
    expect(widths[0]).toBeGreaterThan(100);
  });

  it("reports a violin's statistics in tooltips and summaries", () => {
    const { scene, model } = build({ marks: [violin(latency, { x: "region", y: "ms" })] });
    const box = geometry<RectGeometry>(scene, "rect")[0]!;
    const inspection = model.inspect(box.rects[0]! + 1, box.rects[1]! + 1) as AxisInspection;
    expect(inspection.label).toBe("n");
    expect(inspection.points[0]!.text).toBe(
      "median 30, quartiles 20 to 40, values from 10 to 50, 5 values",
    );
    expect(describeChart(model)).toContain("ms: 2 violins, medians from 8.5 (s) to 30 (n)");
  });

  it("lays violins along y when the categories are on y", () => {
    const { scene, model } = build({ marks: [violin(latency, { x: "ms", y: "region" })] });
    expect(model.yScale()!.type).toBe("band");
    expect(model.tooltipMode()).toBe("nearest-y");
    const { upper, lower } = geometry<AreaGeometry>(scene, "area")[0]! as AreaGeometry & {
      lower: Polyline;
    };
    // The upper edge is above the lower one, and the violin spans values along x.
    const [top] = extent(upper.coords, 0, upper.runEnd(0), 1);
    const [, bottom] = extent(lower.coords, 0, lower.runEnd(0), 1);
    expect(top).toBeLessThan(bottom);
    const [left, right] = extent(upper.coords, 0, upper.runEnd(0), 0);
    expect(right - left).toBeGreaterThan(bottom - top);
  });

  it("draws values that do not vary as a line, and takes a bandwidth for every violin", () => {
    const flat = table({ g: ["a", "a", "b", "b", "b"], v: [4, 4, 1, 2, 3] });
    const { scene } = build({ marks: [violin(flat, { x: "g", y: "v" })] });
    expect(geometry<AreaGeometry>(scene, "area")[0]!.upper.starts).toHaveLength(1);
    // The flat group's line across, and the other's whisker range.
    const lines = geometry<SegmentGeometry>(scene, "segments")[0]!;
    expect(lines.count).toBe(2);
    expect(lines.coords[1]).toBe(lines.coords[3]);
    expect(geometry<RectGeometry>(scene, "rect")[0]!.count).toBe(1);

    const wide = build({ marks: [violin(flat, { x: "g", y: "v", bandwidth: 5 })] });
    expect(geometry<AreaGeometry>(wide.scene, "area")[0]!.upper.starts).toHaveLength(2);
    const [lo, hi] = wide.model.yScale()!.domain;
    expect(lo).toBeLessThanOrEqual(1 - 10);
    expect(hi).toBeGreaterThanOrEqual(4 + 10);
  });

  it("reaches a log axis down to the statistics and density it can place", () => {
    const signed = table({ g: ["a", "a", "a", "a", "a"], v: [-100, -10, 0.001, 2, 3] });
    const vertical = build({
      marks: [violin(signed, { x: "g", y: "v" })],
      y: { type: "log", nice: false },
    });
    const horizontal = build({
      marks: [violin(signed, { x: "v", y: "g" })],
      x: { type: "log", nice: false },
    });
    for (const scale of [vertical.model.yScale()!, horizontal.model.xScale()!]) {
      // The median, 0.001, is in view.
      expect(Math.min(...scale.domain)).toBeLessThanOrEqual(0.001);
      expect(Math.min(...scale.domain)).toBeGreaterThan(0);
    }
    // The density turns positive between two of its points, past where the values do.
    const straddling = table({ g: ["a", "a"], v: [-13, 68] });
    for (const [x, y, axis] of [
      ["g", "v", "y"],
      ["v", "g", "x"],
    ] as const) {
      const { model } = build({
        marks: [violin(straddling, { x, y, bandwidth: 10 } as never)],
        [axis]: { type: "log", nice: false },
      });
      const scale = axis === "y" ? model.yScale()! : model.xScale()!;
      expect(Math.min(...scale.domain)).toBeLessThan(2);
    }
  });

  it("keeps geometry finite for tiny values and shows what it can of failed densities", () => {
    const tiny = table({ g: ["a", "a", "a"], v: [1e-308, 2e-308, 3e-308] });
    const { scene } = build({
      marks: [violin(tiny, { x: "g", y: "v", bandwidth: 1e-308 })],
      y: { type: "log" },
    });
    const { upper } = geometry<AreaGeometry>(scene, "area")[0]!;
    expect(upper.count).toBeGreaterThan(0);
    expect(Array.from(upper.coords.subarray(0, upper.count * 2)).every(Number.isFinite)).toBe(true);
    // A span beyond the largest double: no density, but the box and median show.
    const huge = table({ g: ["a", "a", "a"], v: [-8e307, 0, 8e307] });
    const failed = build({ marks: [violin(huge, { x: "g", y: "v" })] });
    expect(geometry<AreaGeometry>(failed.scene, "area")[0]!.upper.count).toBe(0);
    expect(geometry<RectGeometry>(failed.scene, "rect")[0]!.count).toBe(1);
    expect(geometry<PointGeometry>(failed.scene, "point")[0]!.count).toBe(1);
  });

  it("refuses bandwidths that are not positive numbers", () => {
    for (const bandwidth of [0, -1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(() => violin(latency, { x: "region", y: "ms", bandwidth })).toThrow(
        "violin bandwidth: expected a positive number; received",
      );
  });

  it("draws what a log axis can place", () => {
    const skewed = table({ g: ["a", "a", "a", "a", "a"], v: [1, 2, 3, 4, 100] });
    const { scene, model } = build({
      marks: [violin(skewed, { x: "g", y: "v" })],
      y: { type: "log" },
    });
    // The density reaches below zero, which the log axis cannot place.
    expect(model.yScale()!.domain[0]).toBeGreaterThan(0);
    const { upper } = geometry<AreaGeometry>(scene, "area")[0]!;
    expect(upper.count).toBeGreaterThan(10);
    expect(Array.from(upper.coords.subarray(0, upper.count * 2)).every(Number.isFinite)).toBe(true);
  });

  it("splits by facets, and refuses data without a category axis", () => {
    const faceted = table({ g: ["a", "b"], p: ["P", "Q"], v: [1, 2] });
    const split = build({ marks: [violin(faceted, { x: "g", y: "v" })], facet: facet("p") });
    expect(split.model.panels().map((p) => split.model.panelSeries(p.key)[0]!.length)).toEqual([
      1, 1,
    ]);
    const numbers = table({ a: [1, 2], b: [3, 4] });
    expect(() => violin(numbers, { x: "a" as never, y: "b" })).toThrow(
      "violin x, y: expected a category field and a number or time field",
    );
  });

  it("loads from the portable spec and renders to SVG and PDF", () => {
    const { config } = loadSpec(
      {
        version: 1,
        data: {
          t: {
            columns: {
              g: { type: "category", codes: [0, 0, 0, 1, 1, 1], dictionary: ["a", "b"] },
              v: [1, 2, 4, 3, 5, 6],
            },
          },
        },
        marks: [{ type: "violin", x: "g", y: "v", bandwidth: 1 }],
      },
      [],
    );
    const svg = renderToSVG({ ...config, width: 400, height: 300 });
    expect(svg).toMatch(/<path d="M[^"]*" fill="#[0-9a-f]+" fill-opacity="0.25"/);
    expect(renderToPDF({ ...config, width: 400, height: 300 }).length).toBeGreaterThan(500);
    const bad = (bandwidth: unknown) => () =>
      loadSpec(
        {
          version: 1,
          data: {
            t: { columns: { g: { type: "category", codes: [0], dictionary: ["a"] }, v: [1] } },
          },
          marks: [{ type: "violin", x: "g", y: "v", bandwidth } as never],
        },
        [],
      );
    expect(bad(0)).toThrow("bandwidth");
    expect(bad("1")).toThrow("bandwidth");
  });
});
