import { describe, expect, it, vi } from "vitest";
import { category } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { Line3DMark, line3d } from "../../src/marks/line3d.ts";
import { point3d } from "../../src/marks/point3d.ts";
import { surface } from "../../src/marks/surface.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { FaceGeometry, LineBatch3D, Scene } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { FaceIndex } from "../../src/three/faces.ts";

function build(config: ChartConfig, clouds = false, width = 600, height = 500) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText, clouds) };
}

const facesOf = (scene: Scene) => {
  const mark = scene.panels[0]!.marks.find((m) => m.kind === "faces") as FaceGeometry;
  return mark.batches ? mark.batches.faces() : mark;
};

/** The faces of two corners: segments, as [first vertex x, y, second x, y]. */
function segments(mark: FaceGeometry): number[][] {
  const out: number[][] = [];
  for (let f = 0; f < mark.count; f++) {
    if (mark.starts[f + 1]! - mark.starts[f]! !== 2) continue;
    const [a, b] = [mark.corners[mark.starts[f]!]!, mark.corners[mark.starts[f]! + 1]!];
    out.push([
      mark.vertices[a * 2]!,
      mark.vertices[a * 2 + 1]!,
      mark.vertices[b * 2]!,
      mark.vertices[b * 2 + 1]!,
    ]);
  }
  return out;
}

const keys = (model: ChartModel) => {
  const out: number[] = [];
  for (let key = model.stepItem(undefined, 1); key; ) {
    out.push(JSON.parse(key)[1]);
    const next = model.stepItem(key, 1);
    if (next === key) break;
    key = next;
  }
  return out;
};

// Two paths whose rows interleave; row 4 of "a" has no z.
const flights = table({
  x: [0, 0, 1, 1, 2, 2, 3, 3],
  y: [0, 1, 0, 1, 0, 1, 0, 1],
  z: [0, 2, 1, 3, Number.NaN, 4, 3, 5],
  flight: category(["a", "b", "a", "b", "a", "b", "a", "b"]),
});

describe("3D lines", () => {
  it("draw each series' rows in table order as a path, broken where a row has no value", () => {
    const { model, scene } = build({
      marks: [line3d(flights, { x: "x", y: "y", z: "z", series: "flight" })],
    });
    // a: 0-2, then 6 alone after the gap; b: 1-3-5-7.
    expect(segments(facesOf(scene))).toHaveLength(1 + 3);
    expect(scene.legend.map((entry) => entry.label)).toEqual(["a", "b"]);
    // Samples path after path, each in row order.
    expect(keys(model)).toEqual([0, 2, 6, 1, 3, 5, 7]);
    const first = model.inspectItem(JSON.stringify([0, 2])) as ItemInspection;
    expect(first.points[0]).toMatchObject({ label: "a", text: "x 1, y 0, z 1" });
    expect(first.values).toEqual({ x: 1, y: 0, z: 1, flight: "a" });
    expect(model.layoutSummary()).toMatch(
      /^3D lines of 2 series through x, y, z: 7 points in 3 runs, broken by 1 point without a value\./,
    );
  });

  it("draw nothing for hidden series, and a constant color and width", () => {
    const mark = line3d(flights, {
      x: "x",
      y: "y",
      z: "z",
      series: "flight",
      strokeWidth: 4,
      stroke: "#123456",
    });
    const { model } = build({ marks: [mark] });
    model.hidden.add(model.legendEntries()[0]!.key);
    const scene = model.scene(estimateText);
    const drawn = facesOf(scene);
    expect(segments(drawn)).toHaveLength(3);
    for (let f = 0; f < drawn.count; f++)
      expect(drawn.styles[drawn.style[f]!]).toMatchObject({ stroke: "#123456", strokeWidth: 4 });
    expect(keys(model)).toEqual([1, 3, 5, 7]);
  });

  it("cut segments at the box's walls and read samples outside it where their segment enters", () => {
    const path = table({ x: [-2, 0, 2], y: [0, 0, 0], z: [0, 0, 0] });
    const { model, scene } = build({
      x: { domain: [-1, 1] },
      marks: [line3d(path, { x: "x", y: "y", z: "z" })],
    });
    const drawn = segments(facesOf(scene));
    expect(drawn).toHaveLength(2);
    // Every sample is read; those outside at the wall.
    expect(keys(model)).toEqual([0, 1, 2]);
    const outside = model.inspectItem(JSON.stringify([0, 0]))!.points[0]!;
    expect([outside.px, outside.py]).toEqual([drawn[0]![0], drawn[0]![1]]);
    expect(model.layoutSummary()).toMatch(/3 points in 1 run\./);
  });

  it("are found under the pointer, read at the segment's nearer end", () => {
    const path = table({ x: [0, 1, 2], y: [0, 1, 0], z: [0, 1, 2] });
    const { model, scene } = build({ marks: [line3d(path, { x: "x", y: "y", z: "z" })] });
    const [[ax, ay, bx, by]] = segments(facesOf(scene)) as [number[]];
    const near = (t: number) =>
      (model.inspect(ax! + t * (bx! - ax!), ay! + t * (by! - ay!)) as ItemInspection).key;
    expect(near(0.2)).toBe(JSON.stringify([0, 0]));
    expect(near(0.8)).toBe(JSON.stringify([0, 1]));
    expect(model.inspect(ax! + 40, ay! - 40)).toBeUndefined();
  });

  it("refuse widths that are not positive", () => {
    expect(() => line3d(flights, { x: "x", y: "y", z: "z", strokeWidth: 0 })).toThrow(
      /line3d strokeWidth: expected a positive number of pixels; received 0/,
    );
    expect(() => line3d(flights, { x: "x", y: "y", z: "flight" as never })).toThrow(/line3d z/);
  });
});

/** A plane at z = 0 over [-1, 1] squared, and a line along y = 0 at height `z`. */
function lineAndPlane(z: number) {
  const n = 9;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      xs.push((i / (n - 1)) * 2 - 1);
      ys.push((j / (n - 1)) * 2 - 1);
    }
  const plane = table({ x: xs, y: ys, z: xs.map(() => 0) });
  // Its ends, seen through the plane from the camera, stay over the plane.
  const path = table({ x: [-0.5, 0.5], y: [0.1, 0.1], z: [z, z] });
  return {
    marks: [surface(plane, { x: "x", y: "y", z: "z" }), line3d(path, { x: "x", y: "y", z: "z" })],
    z: { domain: [-1, 1] as [number, number] },
    camera: { azimuth: -60, elevation: 50 },
  };
}

describe("3D lines with surfaces and points", () => {
  it("are hidden by a surface they pass under, and drawn over one they pass over", () => {
    for (const [height, shown] of [
      [-0.5, false],
      [0.5, true],
    ] as const) {
      const { scene } = build(lineAndPlane(height));
      const drawn = facesOf(scene);
      const index = new FaceIndex(drawn, scene.panels[0]!.plot);
      const pieces = segments(drawn);
      // Cut where the line crosses the surface's columns: a piece over each cell.
      expect(pieces).toHaveLength(4);
      let line = 0;
      for (const [ax, ay, bx, by] of pieces) {
        const at = index.find((ax! + bx!) / 2, (ay! + by!) / 2);
        if (drawn.starts[at + 1]! - drawn.starts[at]! === 2) line++;
      }
      expect(line).toBe(shown ? pieces.length : 0);
    }
  });

  it("place points in front of them over them, and behind them under them", () => {
    const path = table({ x: [-1, 1], y: [0, 0], z: [0, 0] });
    const dots = table({ x: [0, 0.5], y: [0, 0], z: [0.6, -0.6] });
    const { model, scene } = build({
      camera: { azimuth: 0, elevation: 90 },
      z: { domain: [-1, 1] },
      marks: [
        line3d(path, { x: "x", y: "y", z: "z", strokeWidth: 10 }),
        point3d(dots, { x: "x", y: "y", z: "z", radius: 3 }),
      ],
    });
    // Seen from above: the point over the line shows; the one under it does not.
    const over = model.inspectItem(JSON.stringify([1, 0]))!.points[0]!;
    const under = model.inspectItem(JSON.stringify([1, 1]))!.points[0]!;
    const index = new FaceIndex(facesOf(scene), scene.panels[0]!.plot);
    const drawn = facesOf(scene);
    const kind = (px: number, py: number) =>
      drawn.starts[index.find(px, py) + 1]! - drawn.starts[index.find(px, py)]!;
    expect(kind(over.px, over.py)).toBe(1);
    expect(kind(under.px, under.py)).toBe(2);
  });
});

describe("3D lines for GPU painters", () => {
  const long = (n: number) =>
    table({
      x: Float64Array.from({ length: n }, (_, i) => Math.cos(i / 50) * (1 + i / n)),
      y: Float64Array.from({ length: n }, (_, i) => Math.sin(i / 50) * (1 + i / n)),
      z: Float64Array.from({ length: n }, (_, i) => (i % 997 === 0 ? Number.NaN : i / n)),
      path: category(Array.from({ length: n }, (_, i) => (i < n / 2 ? "p" : "q"))),
    });

  it("give each point the color of the segment to the next, none at breaks and ends", () => {
    const data = long(30_000);
    const { scene } = build(
      { marks: [line3d(data, { x: "x", y: "y", z: "z", series: "path" })] },
      true,
    );
    const batch = facesOfBatch(scene);
    expect(batch.kind).toBe("lines");
    const { positions, style } = batch.arrays();
    // Rows without a value are left out of the points.
    const missing = Math.ceil(30_000 / 997);
    expect(style).toHaveLength(30_000 - missing);
    expect(positions).toHaveLength(style.length * 3);
    // A run ends at each path's end and before each missing row.
    expect([...style].filter((s) => s === 255)).toHaveLength(2 + missing - 1);
    expect(batch.palette).toHaveLength(2);
  });

  it("cut segments reaching far past the box before float32 would lose them", () => {
    for (const reach of [1e8, 1e16, 1e40]) {
      // Ends far out on either side, at 0 and 1 in y and z.
      const far = table({
        x: Float64Array.from({ length: 30_000 }, (_, i) => (i % 2 === 0 ? -reach : reach)),
        y: Float64Array.from({ length: 30_000 }, (_, i) => i % 2),
        z: Float64Array.from({ length: 30_000 }, (_, i) => i % 2),
      });
      const { scene } = build(
        { x: { domain: [-1, 1] }, marks: [line3d(far, { x: "x", y: "y", z: "z" })] },
        true,
      );
      const { positions, style } = facesOfBatch(scene).arrays();
      // Each segment is a run of its own, from wall to wall, in the middle of y and z.
      expect(style).toHaveLength(2 * 29_999);
      expect([positions[0], positions[3]]).toEqual([-1, 1]);
      expect(positions[1]).toBeCloseTo(0, 5);
      expect(positions[5]).toBeCloseTo(0, 5);
      expect([style[0], style[1]]).toEqual([0, 255]);
      for (const value of positions) expect(Math.abs(value)).toBeLessThanOrEqual(1);
    }
  });

  it("are found under the pointer where the CPU finds them, from the data", () => {
    const data = long(25_000);
    const config = () => ({ marks: [line3d(data, { x: "x", y: "y", z: "z", strokeWidth: 3 })] });
    // The CPU's segments, in a chart of its own, and what it finds at their middles.
    const { model: cpu, scene } = build(config(), false, 1000, 900);
    const pixels = segments(facesOf(scene))
      .filter((_, i) => i % 211 === 0)
      .map(([ax, ay, bx, by]) => [(ax! + bx!) / 2, (ay! + by!) / 2] as const);
    const keyAt =
      (model: ChartModel) =>
      ([px, py]: readonly [number, number]) =>
        (model.inspect(px, py) as ItemInspection | undefined)?.key;
    const onCpu = pixels.map(keyAt(cpu));
    const place = vi.spyOn(Line3DMark.prototype, "place");
    const pick = vi.spyOn(Line3DMark.prototype, "pick");
    const { model: gpu, scene: drawn } = build(config(), true, 1000, 900);
    expect(facesOfBatch(drawn).kind).toBe("lines");
    const onGpu = pixels.map(keyAt(gpu));
    expect(place).not.toHaveBeenCalled();
    expect(pick).toHaveBeenCalled();
    expect(onGpu.filter(Boolean).length).toBeGreaterThan(100);
    // Where lines cross, the CPU's order of whole segments and the GPU's depths may part.
    const same = onGpu.filter((key, i) => key === onCpu[i]).length;
    expect(same / onGpu.length).toBeGreaterThan(0.97);
    vi.restoreAllMocks();
  });
});

function facesOfBatch(scene: Scene): LineBatch3D {
  const mark = scene.panels[0]!.marks.find((m) => m.kind === "faces") as FaceGeometry;
  return mark.batches!.batches[0] as LineBatch3D;
}

describe("3D lines in specs and exports", () => {
  it("load from specs and export to SVG and PDF as round-capped strokes", () => {
    const spec = {
      width: 400,
      height: 300,
      data: { flights: { columns: { x: [0, 1, 2], y: [0, 1, 0], z: [0, 1, 2] } } },
      marks: [{ type: "line3d", data: "flights", x: "x", y: "y", z: "z", strokeWidth: 3 }],
    };
    const options = { ...loadSpec(spec as never).config, width: 400, height: 300 };
    const svg = renderToSVG(options);
    expect(svg).toMatch(
      /<path d="M[^"]+L[^"]+" fill="none" stroke="#[0-9a-f]{6}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/,
    );
    expect(new TextDecoder().decode(renderToPDF(options).subarray(0, 8))).toBe("%PDF-1.4");
    expect(() =>
      loadSpec({ ...spec, marks: [{ type: "line3d", data: "flights", x: "x", y: "y" }] } as never),
    ).toThrow(/z/);
  });
});
