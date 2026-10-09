// What 3D charts give GPU painters, checked without one: the batches, the
// triangles they hold (rasterized here in software against the faces the
// CPU draws), and reading and picking from the data alone.

import { afterEach, describe, expect, it, vi } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { line3d } from "../../src/marks/line3d.ts";
import { Point3DMark, point3d } from "../../src/marks/point3d.ts";
import { SurfaceMark, surface } from "../../src/marks/surface.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import type {
  Batches3D,
  FaceGeometry,
  Scene,
  TriangleArrays,
  TriangleBatch3D,
} from "../../src/scene/scene.ts";
import { FaceIndex } from "../../src/three/faces.ts";
import { ScreenGrid } from "../../src/three/hit.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A model drawn as a GPU painter would be given it. */
function build(config: ChartConfig, width = 1200, height = 1000, clouds = true) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText, clouds) };
}

const faces = (scene: Scene) =>
  scene.panels[0]!.marks.find((m) => m.kind === "faces") as FaceGeometry;
const batches = (scene: Scene) => faces(scene).batches;

/** A height field on an n by n grid over [-2, 2], rows in grid order. */
function field(n: number, height: (x: number, y: number) => number) {
  const x = new Float64Array(n * n);
  const y = new Float64Array(n * n);
  const z = new Float64Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      x[k] = (i / (n - 1)) * 4 - 2;
      y[k] = (j / (n - 1)) * 4 - 2;
      z[k] = height(x[k]!, y[k]!);
    }
  return table({ x, y, z });
}

const hills = (x: number, y: number) => Math.sin(x * 1.3) * Math.cos(y) + 0.3 * x;

const cloud = (n: number, opacity = 1) =>
  point3d(
    table({
      x: Float64Array.from({ length: n }, (_, i) => Math.sin(i)),
      y: Float64Array.from({ length: n }, (_, i) => Math.cos(i * 1.3)),
      z: Float64Array.from({ length: n }, (_, i) => (i % 100) / 50 - 1),
    }),
    { x: "x", y: "y", z: "z", fillOpacity: opacity },
  );

describe("3D charts for GPU painters", () => {
  it("are given to them when every layer can be drawn there and the CPU would draw many faces", () => {
    const big = field(102, hills);
    const kinds = (config: ChartConfig) => batches(build(config).scene)?.batches.map((b) => b.kind);
    expect(kinds({ marks: [surface(big, { x: "x", y: "y", z: "z" })] })).toEqual(["triangles"]);
    expect(kinds({ marks: [surface(big, { x: "x", y: "y", z: "z" }), cloud(100)] })).toEqual([
      "triangles",
      "points",
    ]);
    // Too few cells; translucent cells, wires, and translucent points need the CPU.
    expect(kinds({ marks: [surface(field(60, hills), { x: "x", y: "y", z: "z" })] })).toBe(
      undefined,
    );
    expect(
      kinds({ marks: [surface(big, { x: "x", y: "y", z: "z", fillOpacity: 0.5 })] }),
    ).toBeUndefined();
    expect(
      kinds({ marks: [surface(big, { x: "x", y: "y", z: "z", wireframe: true })] }),
    ).toBeUndefined();
    expect(
      kinds({ marks: [surface(big, { x: "x", y: "y", z: "z" }), cloud(100, 0.5)] }),
    ).toBeUndefined();
    expect(kinds({ marks: [cloud(25_000)] })).toEqual(["points"]);
  });

  it("are read by the keyboard and screen readers without placing faces", () => {
    const places = [
      vi.spyOn(Point3DMark.prototype, "place"),
      vi.spyOn(SurfaceMark.prototype, "place"),
    ];
    const { model } = build({
      marks: [surface(field(102, hills), { x: "x", y: "y", z: "z" }), cloud(30_000)],
    });
    expect(model.layoutSummary()).toMatch(
      /^Surface of z over x and y: 102 by 102 grid points, 10404 with values\. .* 30000 points at x, y, z\./,
    );
    const first = model.stepItem(undefined, 1)!;
    expect((model.inspectItem(first) as ItemInspection).values).toMatchObject({ x: -2, y: -2 });
    const last = model.stepItem(undefined, -1)!;
    expect(JSON.parse(last)).toEqual([1, 29_999]);
    expect(model.inspect(600, 500)).toBeDefined();
    for (const place of places) expect(place).not.toHaveBeenCalled();
  });

  it("stand in for a painter that lost its context with nothing of what the CPU cannot draw", () => {
    const { model, scene } = build({
      marks: [surface(field(520, hills), { x: "x", y: "y", z: "z" })],
    });
    // What the canvas draws until a fresh painter is loaded, and what the pointer finds there.
    expect(batches(scene)!.faces(true).count).toBe(0);
    expect(model.inspect(600, 500)).toBeUndefined();
    expect(() => batches(model.scene(estimateText, true))!.faces()).toThrow(
      /drawn only on the GPU/,
    );
  });

  it("keep their batches while the camera turns, and make new ones when the data changes", () => {
    const data = field(102, hills);
    const { model, scene } = build({ marks: [surface(data, { x: "x", y: "y", z: "z" })] });
    const key = (batches(scene)!.batches[0] as TriangleBatch3D).key;
    model.setCamera({ azimuth: 40, elevation: 70 });
    const turned = batches(model.scene(estimateText, true))!.batches[0] as TriangleBatch3D;
    expect(turned.key).toBe(key);
    data.set("z", 0, 3);
    const changed = batches(model.scene(estimateText, true))!.batches[0] as TriangleBatch3D;
    expect(changed.key).not.toBe(key);
  });
});

/**
 * The GPU's picture of a scene's triangles, in software: at each pixel the
 * nearest triangle (by depth interpolated in 1/w, as the GPU does) and its
 * color, read from its last vertex, at the level of the light it faces.
 */
function rasterize(scene: Batches3D, batch: TriangleBatch3D, arrays: TriangleArrays) {
  const { positions, normals, colors, indices } = arrays;
  const vertices = positions.length / 3;
  const m = scene.view;
  const screen = new Float64Array(vertices * 3);
  for (let v = 0; v < vertices; v++) {
    const [x, y, z] = [positions[v * 3]!, positions[v * 3 + 1]!, positions[v * 3 + 2]!];
    const depth = x * m[5]! + y * m[6]! + z * m[7]!;
    const d = scene.distance;
    const k = d === Number.POSITIVE_INFINITY ? scene.scale : (scene.scale * d) / (d - depth);
    screen[v * 3] = scene.cx + (x * m[0]! + y * m[1]!) * k;
    screen[v * 3 + 1] = scene.cy - (x * m[2]! + y * m[3]! + z * m[4]!) * k;
    // Linear on screen: depth orthographically, 1/w in perspective.
    screen[v * 3 + 2] = d === Number.POSITIVE_INFINITY ? depth : 1 / (d - depth);
  }
  const [lx, ly, lz] = scene.light;
  const triangles = indices.length / 3;
  const grid = new ScreenGrid({ x: 0, y: 0, width: 1200, height: 1000 }, triangles, (filer) => {
    for (let t = 0; t < triangles; t++) {
      const xs = [0, 1, 2].map((k) => screen[indices[t * 3 + k]! * 3]!);
      const ys = [0, 1, 2].map((k) => screen[indices[t * 3 + k]! * 3 + 1]!);
      filer.box(t, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
    }
  });
  return (px: number, py: number): { color: number[]; edge: boolean } | undefined => {
    let best = Number.NEGATIVE_INFINITY;
    let found = -1;
    let edge = false;
    grid.near(px, py, 1, (triangle) => {
      const t = triangle * 3;
      const [a, b, c] = [indices[t]!, indices[t + 1]!, indices[t + 2]!];
      const [ax, ay, bx, by, cx, cy] = [
        screen[a * 3]!,
        screen[a * 3 + 1]!,
        screen[b * 3]!,
        screen[b * 3 + 1]!,
        screen[c * 3]!,
        screen[c * 3 + 1]!,
      ];
      const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
      if (Math.abs(det) < 1e-9) return;
      const l1 = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) / det;
      const l2 = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) / det;
      const l0 = 1 - l1 - l2;
      if (Math.min(l0, l1, l2) < -1e-9) return;
      const near = l0 * screen[a * 3 + 2]! + l1 * screen[b * 3 + 2]! + l2 * screen[c * 3 + 2]!;
      if (near > best) {
        best = near;
        found = t;
        edge = Math.min(l0, l1, l2) < 0.03;
      }
    });
    if (found < 0) return undefined;
    const last = indices[found + 2]!;
    const [nx, ny, nz] = [normals[last * 3]!, normals[last * 3 + 1]!, normals[last * 3 + 2]!];
    const levels = batch.levels;
    const level =
      levels === 1
        ? 0
        : nx === 0 && ny === 0 && nz === 0
          ? levels - 1
          : Math.round(Math.abs(nx * lx + ny * ly + nz * lz) * (levels - 1));
    const at = (level * 256 + colors[last]!) * 4;
    return { color: [...batch.shades.subarray(at, at + 3)], edge };
  };
}

/** The CPU's color at each pixel: the face drawn last there, unless the pixel is near its edge. */
function cpuColors(
  drawn: FaceGeometry,
  plot: { x: number; y: number; width: number; height: number },
) {
  const index = new FaceIndex(drawn, plot);
  return (px: number, py: number) => {
    const at = index.find(px, py);
    if (at < 0) return undefined;
    // Away from the face's edges, so rounding does not decide.
    for (const [dx, dy] of [
      [-1, 0],
      [1, 0],
      [0, -1],
      [0, 1],
    ])
      if (index.find(px + dx!, py + dy!) !== at) return undefined;
    const hex = Number.parseInt(drawn.styles[drawn.style[at]!]!.fill.slice(1), 16);
    return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255];
  };
}

describe("surfaces' triangles", () => {
  for (const [name, config] of [
    ["with holes", { holes: true }],
    ["cut at the walls of a narrower domain", { z: { domain: [-0.6, 0.8] } }],
    [
      "in perspective, from below, unlit",
      { camera: { elevation: -35, perspective: true }, shading: false },
    ],
  ] as const)
    it(`show what the CPU draws at every pixel, ${name}`, () => {
      const holes = "holes" in config;
      const data = field(120, (x, y) =>
        holes && Math.abs(x * 13 + y * 7) % 5 < 0.4 ? Number.NaN : hills(x, y),
      );
      const shading = !("shading" in config);
      const options = {
        marks: [surface(data, { x: "x", y: "y", z: "z", shading })],
        ...("z" in config && { z: config.z }),
        ...("camera" in config && { camera: config.camera }),
      };
      const { scene } = build(options as ChartConfig);
      const gpu = batches(scene)!;
      const batch = gpu.batches[0] as TriangleBatch3D;
      const arrays = batch.arrays();
      // Every triangle's last vertex holds its cell's color.
      for (let t = 2; t < arrays.indices.length; t += 3)
        expect(arrays.colors[arrays.indices[t]!]).toBeLessThan(255);
      const shown = rasterize(gpu, batch, arrays);
      const plot = scene.panels[0]!.plot;
      const cpu = cpuColors(gpu.faces(), plot);
      let checked = 0;
      let wrong = 0;
      for (let py = plot.y; py < plot.y + plot.height; py += 4)
        for (let px = plot.x; px < plot.x + plot.width; px += 4) {
          const expected = cpu(px, py);
          const got = shown(px, py);
          if (!expected) continue;
          if (got?.edge) continue;
          checked++;
          if (!got || got.color.some((v, k) => v !== expected[k])) wrong++;
        }
      expect(checked).toBeGreaterThan(1000);
      // Where facing the light falls on a boundary between levels, the GPU's float32 may pick the other.
      expect(wrong / checked).toBeLessThan(0.005);
    });

  it("give three-corner cells missing their last corner a vertex of their own", () => {
    const data = field(102, hills);
    // The grid point after cell (0, 0) has no value.
    data.set("z", 102 + 1, Number.NaN);
    const { scene } = build({ marks: [surface(data, { x: "x", y: "y", z: "z" })] });
    const batch = batches(scene)!.batches[0] as TriangleBatch3D;
    const { positions, indices } = batch.arrays();
    expect(positions.length / 3).toBe(102 * 102 + 1);
    // Cells around the hole: four lose a corner; three of them end at a grid point of their own.
    const triangles = indices.length / 3;
    expect(triangles).toBe(2 * 101 * 101 - 4);
    const own = 102 * 102;
    expect([...indices].filter((v) => v === own)).toHaveLength(1);
    // Small enough for 16-bit indices.
    expect(indices).toBeInstanceOf(Uint16Array);
  });
});

describe("picking on the GPU", () => {
  it("finds the cell under the pointer that the CPU shows there, from the data", () => {
    for (const camera of [
      { azimuth: -60, elevation: 25 },
      { azimuth: 135, elevation: 10, perspective: true },
      { azimuth: 30, elevation: -40 },
    ]) {
      const data = field(102, hills);
      const config = () => ({ marks: [surface(data, { x: "x", y: "y", z: "z" })], camera });
      // The CPU's picture, in a chart of its own: pixels away from cells'
      // edges, where its order and the ray could part, and what it finds there.
      const { model: cpu, scene } = build(config(), 1200, 1000, false);
      const plot = scene.panels[0]!.plot;
      const index = new FaceIndex(faces(scene), plot);
      const pixels: [number, number][] = [];
      for (let py = plot.y; py < plot.y + plot.height; py += 5)
        for (let px = plot.x; px < plot.x + plot.width; px += 5) {
          const at = index.find(px, py);
          if (
            at >= 0 &&
            [-1, 1].every((d) => index.find(px + d, py) === at && index.find(px, py + d) === at)
          )
            pixels.push([px, py]);
        }
      const keyAt =
        (model: ChartModel) =>
        ([px, py]: [number, number]) =>
          (model.inspect(px, py) as ItemInspection | undefined)?.key;
      const onCpu = pixels.map(keyAt(cpu));
      const place = vi.spyOn(SurfaceMark.prototype, "place");
      const pick = vi.spyOn(SurfaceMark.prototype, "pick");
      const { model: gpu, scene: drawn } = build(config());
      expect(batches(drawn)).toBeDefined();
      const onGpu = pixels.map(keyAt(gpu));
      expect(place).not.toHaveBeenCalled();
      expect(pick).toHaveBeenCalled();
      expect(pixels.length).toBeGreaterThan(1000);
      expect(onGpu).toEqual(onCpu);
      vi.restoreAllMocks();
    }
  });

  it("show points on a surface over it, and hide those just under it, as the GPU does", () => {
    // A point over, on, and under a surface drawn after it.
    for (const [height, mark] of [
      [0.4999, 0],
      [0.5, 0],
      [0.5001, 1],
    ] as const) {
      const { model, scene } = build({
        camera: { azimuth: -90, elevation: 90 },
        z: { domain: [0, 3] },
        marks: [
          point3d(table({ x: [0.3], y: [0.3], z: [0.5] }), { x: "x", y: "y", z: "z" }),
          surface(
            field(102, () => height),
            { x: "x", y: "y", z: "z" },
          ),
        ],
      });
      expect(batches(scene)).toBeDefined();
      const at = model.inspectItem(JSON.stringify([0, 0]))!.points[0]!;
      expect([height, model.inspect(at.px, at.py)!.points[0]!.mark]).toEqual([height, mark]);
    }
  });

  it("show points and lines lying on a surface over it, whichever layer comes later", () => {
    const plane = field(102, () => 0.5);
    const dot = table({ x: [0.3], y: [0.3], z: [0.5] });
    const path = table({ x: [-1, 1], y: [-0.4, -0.4], z: [0.5, 0.5] });
    const layers = {
      surface: () => surface(plane, { x: "x", y: "y", z: "z" }),
      point: () => point3d(dot, { x: "x", y: "y", z: "z" }),
      line: () => line3d(path, { x: "x", y: "y", z: "z" }),
    };
    for (const other of ["point", "line"] as const)
      for (const order of [
        ["surface", other],
        [other, "surface"],
      ] as const) {
        const { model, scene } = build({
          camera: { azimuth: -90, elevation: 90 },
          z: { domain: [0, 3] },
          marks: order.map((name) => layers[name]()),
        });
        expect(batches(scene)).toBeDefined();
        // Over the point, or along the line.
        const layer = order.indexOf(other);
        const at = model.inspectItem(JSON.stringify([layer, 0]))!.points[0]!;
        const target = other === "point" ? [at.px, at.py] : [at.px + 100, at.py];
        const found = model.inspect(target[0]!, target[1]!) as ItemInspection;
        expect([order, found.points[0]!.mark]).toEqual([order, layer]);
      }
  });

  it("finds the point nearest the eye within reach of the pointer", () => {
    const { model, scene } = build({ marks: [cloud(30_000)] });
    const view = batches(scene)!;
    const depthOf = (key: string) => {
      const { x, y, z } = (model.inspectItem(key) as ItemInspection).values as Record<
        string,
        number
      >;
      const m = view.view;
      // Depth along the eye, in the box: the axes map x, y, and z from their domains onto -1 to 1.
      const [ax, ay, az] = view.axes!;
      const place = (a: typeof ax, v: number) => a.offset + (v - a.origin) * a.factor;
      return place(ax, x!) * m[5]! + place(ay, y!) * m[6]! + place(az, z!) * m[7]!;
    };
    let checked = 0;
    for (let row = 0; row < 30_000; row += 997) {
      const item = model.inspectItem(JSON.stringify([0, row]))!.points[0]!;
      const found = model.inspect(item.px + 2, item.py) as ItemInspection;
      // The point itself, or another within reach nearer the eye.
      expect(found).toBeDefined();
      expect(depthOf(found.key)).toBeGreaterThanOrEqual(depthOf(JSON.stringify([0, row])) - 1e-6);
      checked++;
    }
    expect(checked).toBe(31);
  });
});
