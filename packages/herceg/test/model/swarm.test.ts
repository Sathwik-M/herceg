// Beeswarm placement: points packed across their band without overlap.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { point } from "../../src/marks/point.ts";
import { MAX_NEIGHBORS, packSwarm } from "../../src/marks/swarm.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import type { PointGeometry, Scene } from "../../src/scene/scene.ts";
import { validateSpec } from "../../src/spec/validate.ts";
import layouts from "../fixtures/swarm-layout.json";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}
const pointsOf = (scene: Scene, panel = 0) =>
  scene.panels[panel]!.marks.filter((m): m is PointGeometry => m.kind === "point");
const coords = (g: PointGeometry) =>
  Array.from({ length: g.count }, (_, i) => [g.coords[i * 2]!, g.coords[i * 2 + 1]!] as const);

/** Pairs of points closer than their radii allow. */
function overlaps(points: readonly (readonly [number, number])[], radius: number): number {
  let found = 0;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length; j++) {
      const [a, b] = [points[i]!, points[j]!];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 2 * radius - 1e-3) found++;
    }
  return found;
}

describe("packSwarm", () => {
  it("places each point at the free place nearest the center, without overlap", () => {
    const values = Float64Array.from([0, 0, 0, 1, 20]);
    const radii = new Float64Array(5).fill(2);
    const out = new Float64Array(5);
    expect(packSwarm(values, radii, 0, 5, 100, out)).toBe(0);
    // The first is centered, the next two beside it (left first), the far one centered again.
    expect(out[0]).toBe(0);
    expect(out[1]).toBeCloseTo(-4.5, 6);
    expect(out[2]).toBeCloseTo(4.5, 6);
    expect(out[4]).toBe(0);
    const placed = Array.from(values, (v, i) => [out[i]!, v] as const);
    expect(overlaps(placed, 2)).toBe(0);
  });

  it("stands points that do not fit at the nearer edge and counts them", () => {
    const n = 40;
    const values = new Float64Array(n);
    const radii = new Float64Array(n).fill(3);
    const out = new Float64Array(n);
    // Centered in a band 30 pixels wide, three points of radius 3 fit side by side.
    const edged = packSwarm(values, radii, 0, n, 30, out);
    expect(edged).toBe(n - 3);
    expect([...out.slice(0, 3)]).toEqual([0, -6.5, 6.5]);
    for (const offset of out) expect(Math.abs(offset)).toBeLessThanOrEqual(12 + 1e-9);
    // Points wider than the band all stand at its center, at an edge of nothing.
    expect(packSwarm(values, radii, 0, 3, 4, out)).toBe(3);
  });

  it.each(layouts.cases)(
    "lays out a fixture of $pixels.length points as herceg.express's port does",
    ({ pixels, radius, width, edged, offsets }) => {
      const out = new Float64Array(pixels.length);
      const values = Float64Array.from(pixels);
      expect(
        packSwarm(
          values,
          new Float64Array(pixels.length).fill(radius),
          0,
          pixels.length,
          width,
          out,
        ),
      ).toBe(edged);
      expect([...out].map((v) => Math.round(v * 1e6) / 1e6)).toEqual(offsets);
    },
  );

  it("is bounded: 10,000 points of one value take a bounded number of neighbors each", () => {
    const n = 10_000;
    const values = Float64Array.from({ length: n }, (_, i) => i * 0.01);
    const radii = new Float64Array(n).fill(2.5);
    const out = new Float64Array(n);
    const started = performance.now();
    const edged = packSwarm(values, radii, 0, n, 80, out);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(edged).toBeGreaterThan(0);
    expect(MAX_NEIGHBORS).toBeGreaterThan(100);
  });
});

describe("point swarm", () => {
  const tips = table({
    day: ["thu", "thu", "thu", "thu", "fri", "fri", "fri", "thu", "thu", "fri"],
    tip: [2, 2, 2.1, 3, 2, 2, 2.02, 2.05, 1.98, 5],
    sex: ["f", "m", "f", "m", "f", "m", "f", "m", "f", "m"],
  });

  it("packs each band's points without overlap, centered on their bands", () => {
    const { model, scene } = build({ marks: [point(tips, { x: "day", y: "tip", swarm: true })] });
    const [drawn] = pointsOf(scene);
    const placed = coords(drawn!);
    expect(overlaps(placed, 2.5)).toBe(0);
    const x = model.xScale()!;
    const half = Math.abs(x.bandwidth!) / 2;
    for (const [px] of placed) {
      const band = Math.round(x.invert(px));
      expect(Math.abs(px - x.map(band))).toBeLessThanOrEqual(half);
    }
    // Inspection finds a point where it is drawn.
    const [px, py] = placed[1]!;
    const found = model.inspect(px, py, "nearest")!;
    expect(found.points[0]!.px).toBeCloseTo(px, 3);
    expect(found.points[0]!.py).toBeCloseTo(py, 3);
  });

  it("packs swarms along a category y, values on x", () => {
    const { model, scene } = build({ marks: [point(tips, { x: "tip", y: "day", swarm: true })] });
    const placed = coords(pointsOf(scene)[0]!);
    expect(placed.every(([px, py]) => Number.isFinite(px) && Number.isFinite(py))).toBe(true);
    expect(overlaps(placed, 2.5)).toBe(0);
    const y = model.yScale()!;
    for (const [, py] of placed) {
      const band = Math.round(y.invert(py));
      expect(Math.abs(py - y.map(band))).toBeLessThanOrEqual(Math.abs(y.bandwidth!) / 2);
    }
  });

  it("packs swarms on reversed value axes as on others", () => {
    const n = 600;
    const spaced = table({
      g: Array.from({ length: n }, () => "a"),
      v: Float64Array.from({ length: n }, (_, i) => i),
    });
    const offsets = (domain: [number, number]) => {
      const { scene, model } = build({
        marks: [point(spaced, { x: "g", y: "v", swarm: true, radius: 1 })],
        y: { domain },
      });
      const center = model.xScale()!.map(0);
      return coords(pointsOf(scene)[0]!).map(([px]) => Math.round(Math.abs(px - center) * 1000));
    };
    // Mirrored along y, every point stands as far from the center as
    // unreversed (on a side that ties may break the other way), none at an edge.
    const upright = offsets([0, 600]);
    expect(offsets([600, 0])).toEqual(upright);
    expect(Math.max(...upright)).toBeLessThan(10_000);
  });

  it("lays out nothing for dodged swarms without a point in view", () => {
    const { scene } = build({
      marks: [point(tips, { x: "day", y: "tip", series: "sex", dodge: true, swarm: true })],
      y: { domain: [100, 200] },
    });
    expect(pointsOf(scene).every((g) => g.count === 0)).toBe(true);
  });

  it("packs each dodged series in its share of the band", () => {
    const { model, scene } = build({
      marks: [point(tips, { x: "day", y: "tip", series: "sex", dodge: true, swarm: true })],
    });
    const x = model.xScale()!;
    const quarter = Math.abs(x.bandwidth!) / 4;
    pointsOf(scene).forEach((g, slot) => {
      for (const [px] of coords(g)) {
        const band = Math.round(x.invert(px));
        const center = x.map(band) + (slot === 0 ? -quarter : quarter);
        expect(Math.abs(px - center)).toBeLessThanOrEqual(quarter + 1e-6);
      }
    });
    const all = pointsOf(scene).flatMap(coords);
    expect(overlaps(all, 2.5)).toBe(0);
  });

  it("packs the swarms of each facet panel, of its own rows", () => {
    const { model, scene } = build({
      marks: [point(tips, { x: "day", y: "tip", swarm: true })],
      facet: facet("sex"),
    });
    model.panels().forEach((panel, p) => {
      const placed = coords(pointsOf(scene, p)[0]!);
      expect(placed).toHaveLength(5);
      expect(overlaps(placed, 2.5)).toBe(0);
      const half = Math.abs(panel.x.bandwidth!) / 2;
      for (const [px] of placed) {
        const band = Math.round(panel.x.invert(px));
        expect(Math.abs(px - panel.x.map(band))).toBeLessThanOrEqual(half);
      }
    });
  });

  it("lays swarms out again for the plot's size", () => {
    const many = table({
      g: Array.from({ length: 60 }, () => "a"),
      v: Array.from({ length: 60 }, (_, i) => Math.floor(i / 3)),
    });
    const tall = build({ marks: [point(many, { x: "g", y: "v", swarm: true })] }, 300, 600);
    const short = build({ marks: [point(many, { x: "g", y: "v", swarm: true })] }, 300, 120);
    const spread = (scene: Scene) => {
      const xs = coords(pointsOf(scene)[0]!).map(([px]) => px);
      return Math.max(...xs) - Math.min(...xs);
    };
    expect(spread(short.scene)).toBeGreaterThan(spread(tall.scene));
    expect(overlaps(coords(pointsOf(short.scene)[0]!), 2.5)).toBe(0);
  });

  it("refuses swarms off a category axis, with jitter, or sampled", () => {
    const data = table({ x: [1, 2], y: [1, 2], g: ["a", "b"] });
    expect(() => point(data, { x: "x", y: "y", swarm: true })).toThrow(
      "point swarm: needs one category position, x or y",
    );
    expect(() => point(data, { x: "g", y: "y", swarm: true, jitter: { width: 0.5 } })).toThrow(
      "point swarm: places points itself; drop jitter or swarm",
    );
    expect(() => point(data, { x: "g", y: "y", swarm: true, sampling: "pixel" })).toThrow(
      'point sampling: a swarm places every point; drop sampling: "pixel"',
    );
    expect(() =>
      validateSpec({ marks: [{ type: "point", x: "g", y: "y", swarm: "yes" }] }),
    ).toThrow(/marks\[0\]\.swarm: expected true or false; received "yes"/);
  });
});
