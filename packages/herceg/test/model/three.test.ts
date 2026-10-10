import { describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { line } from "../../src/marks/line.ts";
import { boxRoom, joinLayers3D } from "../../src/marks/plot3d.ts";
import { point3d } from "../../src/marks/point3d.ts";
import {
  MAX_CPU_GRID_POINTS,
  MAX_GRID_POINTS,
  type SurfaceMark,
  surface,
} from "../../src/marks/surface.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel, type ItemInspection } from "../../src/model/model.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { FaceGeometry, Scene, TextGeometry } from "../../src/scene/scene.ts";
import { LIGHT } from "../../src/theme.ts";
import { View } from "../../src/three/camera.ts";
import { FaceIndex } from "../../src/three/faces.ts";

function build(config: ChartConfig, width = 500, height = 400) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const faces = (scene: Scene) =>
  scene.panels[0]!.marks.find((m) => m.kind === "faces") as FaceGeometry;
const texts = (scene: Scene, key: string) =>
  (scene.panels[0]!.marks.find((m) => m.key === key) as TextGeometry).labels;

/** A height field on an n by n grid over [-2, 2]: rows in grid order. */
function field(n: number, height: (x: number, y: number) => number) {
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const a = (i / (n - 1)) * 4 - 2;
      const b = (j / (n - 1)) * 4 - 2;
      x.push(a);
      y.push(b);
      z.push(height(a, b));
    }
  return table({ x, y, z });
}

const clusters = table({
  x: [0, 1, 2, 3, 4, 5],
  y: [5, 4, 3, 2, 1, 0],
  z: [0, 2, 4, 6, 8, 10],
  group: category(["a", "a", "b", "b", "c", "c"]),
});

describe("3D scatter", () => {
  it("draws one disc per point, far ones first", () => {
    const { scene, model } = build({
      marks: [point3d(clusters, { x: "x", y: "y", z: "z", series: "group" })],
    });
    const mark = faces(scene);
    expect(mark.count).toBe(6);
    expect(scene.legend.map((entry) => entry.label)).toEqual(["a", "b", "c"]);
    // Discs of one corner each, in three series' colors.
    expect(new Set(Array.from(mark.style.subarray(0, 6), (s) => mark.styles[s]!.fill)).size).toBe(
      3,
    );
    const camera = model.camera!;
    const view = new View(camera, boxRoom(scene.panels[0]!.plot, model.theme));
    const join = joinLayers3D(model.config.marks as never, model.config);
    const [ax, ay, az] = join.axes();
    const depth = (row: number) =>
      view.depth(
        ax.place(clusters.numbers("x")[row]!),
        ay.place(clusters.numbers("y")[row]!),
        az.place(clusters.numbers("z")[row]!),
      );
    // Drawn in ascending depth: inspect each disc's center and read its row back.
    const drawn: number[] = [];
    for (let k = 0; k < mark.count; k++) {
      const vertex = mark.corners[mark.starts[k]!]!;
      const item = model.inspect(
        mark.vertices[vertex * 2]!,
        mark.vertices[vertex * 2 + 1]!,
      ) as ItemInspection;
      drawn.push(JSON.parse(item.key)[1]);
    }
    const depths = drawn.map(depth);
    expect([...depths].sort((a, b) => a - b)).toEqual(depths);
  });

  it("reads points in row order, with every value in tooltips", () => {
    const { model } = build({
      marks: [point3d(clusters, { x: "x", y: "y", z: "z", series: "group" })],
    });
    const first = model.stepItem(undefined, 1)!;
    const item = model.inspectItem(first) as ItemInspection;
    expect(JSON.parse(first)).toEqual([0, 0]);
    expect(item.points[0]).toMatchObject({ label: "a", text: "x 0, y 5, z 0" });
    expect(item.values).toEqual({ x: 0, y: 5, z: 0, group: "a" });
    expect(model.stepItem(first, 5)).toBe(JSON.stringify([0, 5]));
    expect(model.layoutSummary()).toMatch(
      /^6 points in 3 series at x, y, z\. Axes: x from 0 to 5;/,
    );
  });

  it("keeps item keys through rows dropped from the front", () => {
    const stream = table({ x: [0, 1, 2], y: [0, 1, 2], z: [0, 1, 2] });
    const mark = point3d(stream, { x: "x", y: "y", z: "z" });
    const { model } = build({ marks: [mark] });
    const key = model.stepItem(undefined, 1)!;
    stream.dropFirst(1);
    stream.append({ x: [3], y: [3], z: [3] });
    model.scene(estimateText);
    // The key of the row that was first is gone; the next row's key reads it.
    expect(model.inspectItem(key)).toBeUndefined();
    const item = model.inspectItem(JSON.stringify([0, 1])) as ItemInspection;
    expect(item.values).toEqual({ x: 1, y: 1, z: 1 });
  });

  it("keeps each layer's points apart", () => {
    const a = table({ x: [0, 1], y: [0, 1], z: [0, 1] });
    const b = table({ x: [2, 3, 4], y: [2, 3, 4], z: [2, 3, 4] });
    const { model } = build({
      marks: [
        point3d(a, { x: "x", y: "y", z: "z", id: "a" }),
        point3d(b, { x: "x", y: "y", z: "z", id: "b" }),
      ],
    });
    const item = (key: unknown[]) => model.inspectItem(JSON.stringify(key)) as ItemInspection;
    expect(item(["a", 1]).values).toEqual({ x: 1, y: 1, z: 1 });
    expect(item(["b", 0]).values).toEqual({ x: 2, y: 2, z: 2 });
    expect(model.stepItem(JSON.stringify(["a", 1]), 1)).toBe(JSON.stringify(["b", 0]));
    // One mark drawn twice is two layers, each with its own points.
    const twice = point3d(b, { x: "x", y: "y", z: "z" });
    const { model: again } = build({ marks: [twice, twice] });
    expect((again.inspectItem(JSON.stringify([0, 2])) as ItemInspection).values).toEqual({
      x: 4,
      y: 4,
      z: 4,
    });
    expect((again.inspectItem(JSON.stringify([1, 0])) as ItemInspection).values).toEqual({
      x: 2,
      y: 2,
      z: 2,
    });
  });

  it("leaves out hidden series, points outside a fixed domain, and missing values", () => {
    const data = table({
      x: [0, 1, 2, Number.NaN],
      y: [0, 1, 2, 3],
      z: [0, 1, 20, 3],
      s: category(["p", "q", "p", "q"]),
    });
    const config: ChartConfig = {
      marks: [point3d(data, { x: "x", y: "y", z: "z", series: "s" })],
      z: { domain: [0, 10] },
    };
    const { scene, model } = build(config);
    expect(faces(scene).count).toBe(2);
    model.hidden.add(scene.legend[1]!.key);
    expect(faces(model.scene(estimateText)).count).toBe(1);
  });

  it("colors by a number field with a color legend", () => {
    const { scene } = build({
      marks: [
        point3d(clusters, { x: "x", y: "y", z: "z", color: "z", colors: ["#000000", "#ffffff"] }),
      ],
    });
    expect(scene.colorLegends[0]!.title.text).toBe("z");
    const mark = faces(scene);
    expect(
      new Set(Array.from(mark.style.subarray(0, mark.count), (s) => mark.styles[s]!.fill)).size,
    ).toBe(6);
  });

  it("colors by a category field with a color key", () => {
    const { scene, model } = build({
      marks: [point3d(clusters, { x: "x", y: "y", z: "z", color: "group" })],
    });
    const mark = faces(scene);
    const fills = new Set(
      Array.from(mark.style.subarray(0, mark.count), (s) => mark.styles[s]!.fill),
    );
    expect(fills).toEqual(new Set(LIGHT.palette.slice(0, 3)));
    expect(scene.glyphLegends[0]!.entries.map((e) => [e.label.text, e.fill])).toEqual([
      ["a", LIGHT.palette[0]],
      ["b", LIGHT.palette[1]],
      ["c", LIGHT.palette[2]],
    ]);
    const first = model.inspectItem(model.stepItem(undefined, 1)!) as ItemInspection;
    expect(first.points[0]).toMatchObject({
      text: "x 0, y 5, z 0, group a",
      color: LIGHT.palette[0],
    });
  });

  it("labels time axes as times", () => {
    const day = 86_400_000;
    const data = table({
      t: time(Float64Array.from([0, 10, 20], (d) => Date.UTC(2024, 0, 1) + d * day)),
      y: [1, 2, 3],
      z: [1, 2, 3],
    });
    const { scene } = build({
      timeZone: "UTC",
      marks: [point3d(data, { x: "t", y: "y", z: "z" })],
    });
    expect(texts(scene, "box-ticks").some((label) => /Jan/.test(label))).toBe(true);
  });
});

describe("surfaces", () => {
  it("draws a cell per four grid points with values, three making a triangle", () => {
    const data = table({
      x: [0, 1, 0, 1, 2, 2],
      y: [0, 0, 1, 1, 0, 1],
      z: [1, 2, 3, 4, 5, Number.NaN],
    });
    const { scene } = build({ marks: [surface(data, { x: "x", y: "y", z: "z" })] });
    const mark = faces(scene);
    const sizes = Array.from(
      { length: mark.count },
      (_, k) => mark.starts[k + 1]! - mark.starts[k]!,
    );
    expect(sizes.sort()).toEqual([3, 4]);
  });

  it("takes the last row with a value at each grid point", () => {
    const data = table({ x: [0, 1, 0, 1, 0], y: [0, 0, 1, 1, 0], z: [1, 2, 3, 4, 9] });
    const { model } = build({ marks: [surface(data, { x: "x", y: "y", z: "z" })] });
    const values = [];
    for (let key = model.stepItem(undefined, 1); key; ) {
      values.push(model.inspectItem(key)!.value);
      const next = model.stepItem(key, 1);
      key = next === key ? undefined : next;
    }
    expect(values).toEqual([9, 2, 3, 4]);
  });

  it("reads grid points that gain values", () => {
    const data = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [0, 1, 1, Number.NaN] });
    const { model } = build({ marks: [surface(data, { x: "x", y: "y", z: "z" })] });
    data.reset({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [0, 1, 1, 2] });
    model.scene(estimateText);
    expect(model.inspectItem(JSON.stringify([0, 3]))!.value).toBe(2);
  });

  it("refuses grids larger than it holds, and on the CPU larger than it draws there", () => {
    const n = Math.ceil(Math.sqrt(MAX_GRID_POINTS)) + 1;
    const scattered = table({
      x: Float64Array.from({ length: n }, (_, i) => i),
      y: Float64Array.from({ length: n }, (_, i) => i * 2),
      z: new Float64Array(n),
    });
    expect(() => surface(scattered, { x: "x", y: "y", z: "z" })).toThrow(
      /surface x, y: expected at most 1,048,576 grid points/,
    );
    // A grid the GPU draws, but an export cannot.
    const side = Math.ceil(Math.sqrt(MAX_CPU_GRID_POINTS)) + 1;
    const large = field(side, (x, y) => x * y);
    expect(() =>
      renderToSVG({ width: 300, height: 200, marks: [surface(large, { x: "x", y: "y", z: "z" })] }),
    ).toThrow(
      /draw only on the GPU, in the browser with WebGL2, opaque, without a wireframe.*at most 250,000/,
    );
  });

  it("places categories evenly along an axis", () => {
    const data = table({
      m: category(["Jan", "Feb", "Jan", "Feb"]),
      y: [0, 0, 1, 1],
      z: [1, 2, 3, 4],
    });
    const { scene, model } = build({ marks: [surface(data, { x: "m", y: "y", z: "z" })] });
    expect(texts(scene, "box-ticks")).toEqual(expect.arrayContaining(["Jan", "Feb"]));
    const item = model.inspectItem(model.stepItem(undefined, 1)!) as ItemInspection;
    expect(item.points[0]!.text).toBe("m Jan, y 0, z 1");
  });

  it("cuts cells at the walls of a fixed domain", () => {
    const { scene } = build({
      marks: [
        surface(
          field(9, (x) => x * 3),
          { x: "x", y: "y", z: "z" },
        ),
      ],
      z: { domain: [-2, 2] },
    });
    // z = 3x is inside the box for |x| <= 2/3: two columns of eight cells
    // lie in it whole, and two more reach into it, cut triangle by triangle.
    const mark = faces(scene);
    expect(mark.count).toBe(16 + 2 * 16);
    // Cut at the floor and the ceiling, every corner lies in the box, which is in the plot.
    const plot = scene.panels[0]!.plot;
    for (let c = 0; c < mark.starts[mark.count]!; c++) {
      const v = mark.corners[c]!;
      expect(mark.vertices[v * 2]).toBeGreaterThanOrEqual(plot.x);
      expect(mark.vertices[v * 2 + 1]).toBeLessThanOrEqual(plot.y + plot.height);
    }
  });

  it("cuts each triangle of a cell, not the cell, so cuts keep to the surface", () => {
    // High corners on the diagonal a-c, low ones off it: below z = 1 lie two corners of triangles.
    const saddle = table({ x: [0, 1, 1, 0], y: [0, 0, 1, 1], z: [2, 0, 2, 0] });
    const { scene } = build({
      marks: [surface(saddle, { x: "x", y: "y", z: "z" })],
      z: { domain: [0, 1] },
    });
    const mark = faces(scene);
    expect(mark.count).toBe(2);
    expect([mark.starts[1]! - mark.starts[0]!, mark.starts[2]! - mark.starts[1]!]).toEqual([3, 3]);
  });

  it("describes its grid", () => {
    const { model } = build({
      marks: [
        surface(
          field(5, (x, y) => x + y),
          { x: "x", y: "y", z: "z" },
        ),
      ],
    });
    expect(model.layoutSummary()).toMatch(
      /^Surface of z over x and y: 5 by 5 grid points, 25 with values\. Highest 4 at 2, 2; lowest -4 at -2, -2\./,
    );
  });
});

/**
 * Checks that what is drawn last at each pixel is what is nearest the eye
 * there, comparing painting order with depths found by brute force over
 * every triangle of the surface.
 */
function checkVisibility(
  camera: { azimuth: number; elevation: number; perspective?: boolean },
  options: { reversed?: boolean; holes?: boolean } = {},
) {
  const data = field(14, (x, y) =>
    // A few missing grid points leave triangles and holes.
    options.holes && Math.abs(x * 13 + y * 7) % 5 < 0.3
      ? Number.NaN
      : Math.sin(x * 1.3) * Math.cos(y) + 0.3 * x,
  );
  const mark = surface(data, { x: "x", y: "y", z: "z" }) as SurfaceMark;
  const { scene, model } = build({
    marks: [mark],
    camera,
    ...(options.reversed && { x: { domain: [2, -2] } }),
  });
  const drawn = faces(scene);
  const plot = scene.panels[0]!.plot;
  const view = new View(model.camera!, boxRoom(plot, model.theme));
  const [ax, ay, az] = joinLayers3D([mark], model.config).axes();
  const xs = data.numbers("x");
  const ys = data.numbers("y");
  const zs = data.numbers("z");
  const out = new Float64Array(2);
  // Screen position and nearness of each grid point (rows are in grid order):
  // depth, or in perspective the magnification, which is linear on screen.
  const screen = Array.from({ length: data.length }, (_, row) => {
    const depth = view.project(ax.place(xs[row]!), ay.place(ys[row]!), az.place(zs[row]!), out, 0);
    const near = camera.perspective ? 1 / (view.distance - depth) : depth;
    return [out[0]!, out[1]!, Number.isNaN(zs[row]!) ? Number.NaN : near] as const;
  });
  const n = 14;
  const triangles: { cell: number; p: (readonly [number, number, number])[] }[] = [];
  for (let j = 0; j + 1 < n; j++)
    for (let i = 0; i + 1 < n; i++) {
      const a = j * n + i;
      // The triangles drawn: a fan of the corners with values, as the surface splits cells.
      const held = [a, a + 1, a + n + 1, a + n].filter((p) => !Number.isNaN(screen[p]![2]));
      if (held.length < 3) continue;
      const p = held.map((k) => screen[k]!);
      triangles.push({ cell: a, p: [p[0]!, p[1]!, p[2]!] });
      if (p.length === 4) triangles.push({ cell: a, p: [p[0]!, p[2]!, p[3]!] });
    }
  const index = new FaceIndex(drawn, plot);
  let checked = 0;
  let wrong = 0;
  for (let py = plot.y; py < plot.y + plot.height; py += 2)
    for (let px = plot.x; px < plot.x + plot.width; px += 2) {
      let best: number | undefined;
      let nearest = Number.NEGATIVE_INFINITY;
      let edge = false;
      for (const { cell, p } of triangles) {
        const [a, b, c] = p;
        const det = (b![0] - a![0]) * (c![1] - a![1]) - (c![0] - a![0]) * (b![1] - a![1]);
        if (Math.abs(det) < 1e-9) continue;
        const l1 = ((px - a![0]) * (c![1] - a![1]) - (c![0] - a![0]) * (py - a![1])) / det;
        const l2 = ((b![0] - a![0]) * (py - a![1]) - (px - a![0]) * (b![1] - a![1])) / det;
        const l0 = 1 - l1 - l2;
        if (Math.min(l0, l1, l2) < -1e-9) continue;
        // Near an edge, which triangle covers the pixel is a matter of rounding.
        if (Math.min(l0, l1, l2) < 0.02) edge = true;
        const depth = l0 * a![2] + l1 * b![2] + l2 * c![2];
        if (depth > nearest) {
          nearest = depth;
          best = cell;
        }
      }
      if (best === undefined || edge) continue;
      const found = index.find(px, py);
      checked++;
      const local = model.inspect(px, py) as ItemInspection;
      if (found < 0 || !local) {
        wrong++;
        continue;
      }
      // The cell found is the cell nearest: its item is one of its corners.
      const row = JSON.parse(local.key)[1] as number;
      const corners = [best, best + 1, best + n + 1, best + n];
      if (!corners.includes(row)) wrong++;
    }
  return { checked, wrong };
}

describe("drawing order", () => {
  it("draws a surface's cells so the nearest shows at every pixel, from any side", () => {
    for (const camera of [
      { azimuth: -60, elevation: 25 },
      { azimuth: 30, elevation: 60 },
      { azimuth: 135, elevation: 10 },
      { azimuth: -150, elevation: -30 },
      { azimuth: 90, elevation: 5 },
    ]) {
      const { checked, wrong } = checkVisibility(camera);
      expect(checked).toBeGreaterThan(800);
      expect(wrong).toBe(0);
    }
  });

  it("keeps it in perspective, on a reversed axis, and around holes", () => {
    for (const [camera, options] of [
      [{ azimuth: -60, elevation: 25, perspective: true }, {}],
      [{ azimuth: 100, elevation: 70, perspective: true }, {}],
      // The eye above the grid itself.
      [{ azimuth: 40, elevation: 85, perspective: true }, {}],
      [{ azimuth: 30, elevation: 20 }, { reversed: true }],
      [{ azimuth: -120, elevation: 35 }, { holes: true }],
    ] as const) {
      const { checked, wrong } = checkVisibility(camera, options);
      expect(checked).toBeGreaterThan(400);
      expect(wrong).toBe(0);
    }
  });

  it("hides points under a surface and shows those above, from above and below", () => {
    // Points near the surface, so the surface is between them and the eye.
    const flat = field(6, () => 0);
    const points = table({ x: [0.5, -0.5], y: [0.5, -0.5], z: [0.3, -0.3] });
    for (const elevation of [30, -30]) {
      const { scene, model } = build({
        marks: [
          surface(flat, { x: "x", y: "y", z: "z" }),
          point3d(points, { x: "x", y: "y", z: "z" }),
        ],
        camera: { azimuth: -60, elevation },
        z: { domain: [-4, 4] },
      });
      const mark = faces(scene);
      const plot = scene.panels[0]!.plot;
      const view = new View(model.camera!, boxRoom(plot, model.theme));
      const [ax, ay, az] = joinLayers3D(model.config.marks as never, model.config).axes();
      const out = new Float64Array(2);
      const shown = [0, 1].map((row) => {
        view.project(
          ax.place(points.numbers("x")[row]!),
          ay.place(points.numbers("y")[row]!),
          az.place(points.numbers("z")[row]!),
          out,
          0,
        );
        const found = new FaceIndex(mark, plot).find(out[0]!, out[1]!);
        // A disc has one corner.
        return mark.starts[found + 1]! - mark.starts[found]! === 1;
      });
      expect(shown).toEqual(elevation > 0 ? [true, false] : [false, true]);
    }
  });
});

describe("points and a sloping surface", () => {
  it("hide a point the surface rises in front of, though it is above the surface where it lies", () => {
    // z = x seen from +x, 25 degrees up: the surface rises toward the eye faster than the ray.
    const slope = table({ x: [-1, 1, -1, 1], y: [-1, -1, 1, 1], z: [-1, 1, -1, 1] });
    const point = table({ x: [0], y: [0], z: [0.1] });
    const { scene, model } = build({
      marks: [
        surface(slope, { x: "x", y: "y", z: "z" }),
        point3d(point, { x: "x", y: "y", z: "z" }),
      ],
      camera: { azimuth: 0, elevation: 25 },
      x: { domain: [-1, 1] },
      y: { domain: [-1, 1] },
      z: { domain: [-1, 1] },
    });
    const mark = faces(scene);
    const view = new View(model.camera!, boxRoom(scene.panels[0]!.plot, model.theme));
    const out = new Float64Array(2);
    view.project(0, 0, 0.1, out, 0);
    const found = new FaceIndex(mark, scene.panels[0]!.plot).find(out[0]!, out[1]!);
    expect(mark.starts[found + 1]! - mark.starts[found]!).toBeGreaterThan(1);
    // Seen from -x, the same point shows.
    model.setCamera({ azimuth: 180 });
    const again = faces(model.scene(estimateText));
    new View(model.camera!, boxRoom(scene.panels[0]!.plot, model.theme)).project(0, 0, 0.1, out, 0);
    const shown = new FaceIndex(again, scene.panels[0]!.plot).find(out[0]!, out[1]!);
    expect(again.starts[shown + 1]! - again.starts[shown]!).toBe(1);
  });
});

describe("points and surfaces", () => {
  const unit = { domain: [-1, 1] as [number, number] };

  /** Where the box's center is drawn. */
  function center(model: ChartModel, scene: Scene): [number, number] {
    const out = new Float64Array(2);
    new View(model.camera!, boxRoom(scene.panels[0]!.plot, model.theme)).project(0, 0, 0, out, 0);
    return [out[0]!, out[1]!];
  }

  /** What the chart shows at the point's place: whether a disc, and its text. */
  function shownAt(model: ChartModel, scene: Scene, point: [number, number, number]) {
    const view = new View(model.camera!, boxRoom(scene.panels[0]!.plot, model.theme));
    const out = new Float64Array(2);
    view.project(...point, out, 0);
    const mark = faces(scene);
    const found = new FaceIndex(mark, scene.panels[0]!.plot).find(out[0]!, out[1]!);
    const item = model.inspect(out[0]!, out[1]!) as ItemInspection | undefined;
    return {
      disc: mark.starts[found + 1]! - mark.starts[found]! === 1,
      text: item?.points[0]?.text,
    };
  }

  it("show a point the surface crosses in front of it only outside the box", () => {
    // The ray from the point to the eye meets the cell above the ceiling, which is cut away.
    const cell = table({ x: [-1, 1, 1, -1], y: [-1, -1, 1, 1], z: [1.24, 0.02, 3.2, -3.47] });
    const point = table({ x: [-0.375], y: [0.376], z: [0.076] });
    const { model, scene } = build({
      marks: [
        surface(cell, { x: "x", y: "y", z: "z" }),
        point3d(point, { x: "x", y: "y", z: "z" }),
      ],
      camera: { azimuth: -108.6, elevation: 49.1 },
      x: unit,
      y: unit,
      z: unit,
    });
    expect(shownAt(model, scene, [-0.375, 0.376, 0.076]).disc).toBe(true);
  });

  it("show a point whose center shows, though a nearer cell overlaps its edge", () => {
    const grid = table({
      x: [-1, 0, 1, -1, 0, 1],
      y: [-1, -1, -1, 0, 0, 0],
      z: [-0.9, 1, Number.NaN, Number.NaN, 0.4, 0.6],
    });
    const point = table({ x: [-0.1], y: [-0.1], z: [0.3] });
    const { model, scene } = build(
      {
        marks: [
          surface(grid, { x: "x", y: "y", z: "z" }),
          point3d(point, { x: "x", y: "y", z: "z", radius: 10 }),
        ],
        camera: { azimuth: 108, elevation: 60 },
        x: unit,
        y: unit,
        z: unit,
      },
      300,
      250,
    );
    expect(shownAt(model, scene, [-0.1, -0.1, 0.3]).disc).toBe(true);
  });

  it("draw points over a surface by depth, though they lie over different cells", () => {
    // Seen from above, a near point and a far one beside it over the next row of cells.
    const points = table({ x: [0, 0], y: [-0.01, 0.01], z: [0.8, -0.8] });
    const flat = field(3, () => -1);
    for (const marks of [[], [surface(flat, { x: "x", y: "y", z: "z" })]]) {
      const { model, scene } = build({
        marks: [...marks, point3d(points, { x: "x", y: "y", z: "z", radius: 10 })],
        camera: { azimuth: 90, elevation: 90 },
        x: unit,
        y: unit,
        z: unit,
      });
      expect(shownAt(model, scene, [0, 0, 0.8]).text).toMatch(/z 0\.8/);
    }
  });

  it("leave out grid points a log axis has no place for", () => {
    const grid = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [0, 1, 1, 1] });
    const config: ChartConfig = {
      marks: [surface(grid, { x: "x", y: "y", z: "z" })],
      z: { type: "log", domain: [0.1, 10] },
    };
    const mark = faces(build(config).scene);
    expect(mark.count).toBe(1);
    expect(mark.starts[1]! - mark.starts[0]!).toBe(3);
    expect(renderToSVG({ ...config, width: 500, height: 400 })).not.toContain("NaN");
  });

  it("read a cell cut at the walls with no grid point in the box", () => {
    const wide = table({ x: [-2, 2, -2, 2], y: [-2, -2, 2, 2], z: [0, 0, 0, 0] });
    const { model, scene } = build({
      marks: [surface(wide, { x: "x", y: "y", z: "z" })],
      x: unit,
      y: unit,
      z: unit,
    });
    expect(faces(scene).count).toBe(2);
    const shown = shownAt(model, scene, [0, 0, 0]);
    expect(shown.text).toMatch(/^x -?2, y -?2, z 0/);
    expect(model.layoutSummary()).toMatch(
      /2 by 2 grid points, 4 with values, none of them in the box\. Highest 0 at/,
    );
    // The keyboard reads its corners too, as the pointer does.
    const first = model.stepItem(undefined, 1)!;
    expect(model.inspectItem(first)!.points[0]!.text).toMatch(/^x -2, y -2, z 0/);
    const key = (model.inspect(...center(model, scene)) as ItemInspection).key;
    expect(model.inspectItem(key)).toBeDefined();
  });

  it("report the mark and the row of what they show", () => {
    const flat = table({
      x: [-1, 0, 1, -1, 0, 1, -1, 0, 1],
      y: [-1, -1, -1, 0, 0, 0, 1, 1, 1],
      z: [-1, -1, -1, -1, -1, -1, -1, -1, -1],
    });
    const points = table({ x: [1, 0], y: [1, 0], z: [0.5, 0.5] });
    const { model, scene } = build({
      marks: [
        surface(flat, { x: "x", y: "y", z: "z", id: "ground" }),
        point3d(points, { x: "x", y: "y", z: "z", id: "dots" }),
      ],
      x: unit,
      y: unit,
      z: unit,
    });
    const view = new View(model.camera!, boxRoom(scene.panels[0]!.plot, model.theme));
    const out = new Float64Array(2);
    view.project(0, 0, 0.5, out, 0);
    expect((model.inspect(out[0]!, out[1]!) as ItemInspection).points[0]).toMatchObject({
      mark: 1,
      markId: "dots",
      row: 1,
    });
    // Inside the first cell, nearest its first corner.
    view.project(-0.9, -0.9, -1, out, 0);
    expect((model.inspect(out[0]!, out[1]!) as ItemInspection).points[0]).toMatchObject({
      mark: 0,
      markId: "ground",
      row: 0,
    });
  });

  it("color cells of the largest finite values", () => {
    const huge = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [1e308, 1e308, 1e308, 1e308] });
    expect(faces(build({ marks: [surface(huge, { x: "x", y: "y", z: "z" })] }).scene).count).toBe(
      1,
    );
    // Three corners, colored by a field at either end of the finite numbers.
    for (const value of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
      const triangle = table({
        x: [0, 1, 0, 1],
        y: [0, 0, 1, 1],
        z: [0, 0, 0, Number.NaN],
        c: [value, value, value, value],
      });
      const marks = [surface(triangle, { x: "x", y: "y", z: "z", color: "c" })];
      expect(faces(build({ marks }).scene).count).toBe(1);
    }
  });

  it("draw no wire along the diagonals of cut cells", () => {
    const cell = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [0, 0, 0, 0] });
    const { model, scene } = build({
      marks: [surface(cell, { x: "x", y: "y", z: "z", wireframe: true })],
      x: { domain: [0.25, 0.75] },
    });
    const mark = faces(scene);
    expect(mark.count).toBe(2);
    for (let k = 0; k < mark.count; k++)
      expect(mark.styles[mark.style[k]!]!.stroke).not.toBe(model.theme.axis);
  });
});

describe("3D charts", () => {
  const scatter = () => point3d(clusters, { x: "x", y: "y", z: "z" });

  it("keep their camera until it is set or configured differently", () => {
    const model = new ChartModel({ marks: [scatter()], camera: { azimuth: 10 } });
    expect(model.camera).toEqual({ azimuth: 10, elevation: 25, zoom: 1, perspective: false });
    expect(model.setCamera({ elevation: 40 })).toBe(true);
    expect(model.setCamera({ elevation: 40 })).toBe(false);
    expect(model.camera!.azimuth).toBe(10);
    model.update({ marks: [scatter()], camera: { azimuth: 10 } });
    expect(model.camera!.elevation).toBe(40);
    model.update({ marks: [scatter()], camera: { azimuth: 20 } });
    expect(model.camera).toMatchObject({ azimuth: 20, elevation: 25 });
    model.setCamera({ zoom: 3 });
    model.setCamera(null);
    expect(model.camera!.zoom).toBe(1);
    expect(() => model.setCamera({ elevation: 100 })).toThrow(/elevation/);
    model.update({ marks: [line(clusters, { x: "x", y: "y" })] });
    expect(model.camera).toBeUndefined();
    expect(() => model.setCamera({})).toThrow("setCamera: only 3D charts have a camera");
  });

  it("refuse options and marks they cannot draw", () => {
    // Other charts leave 3D options alone, as they do a map's projection.
    expect(
      () => new ChartModel({ marks: [line(clusters, { x: "x", y: "y" })], camera: {} }),
    ).not.toThrow();
    expect(
      () => new ChartModel({ marks: [scatter(), line(clusters, { x: "x", y: "y" })] }),
    ).toThrow(/its chart to itself/);
    expect(() => new ChartModel({ marks: [scatter()], interaction: { zoom: "x" } })).toThrow(
      /chart interaction\.zoom: expected true or false in a 3D chart; received "x"/,
    );
    expect(() => new ChartModel({ marks: [scatter()], interaction: { brush: "x" } })).toThrow(
      /brush/,
    );
    expect(() => new ChartModel({ marks: [scatter()], interaction: { zoom: true } })).not.toThrow();
    const mixed = table({ x: category(["a", "b"]), y: [0, 1], z: [0, 1] });
    const { model } = build({ marks: [scatter()] });
    expect(() =>
      model.update({ marks: [scatter(), surface(mixed, { x: "x", y: "y", z: "z" })] }),
    ).not.toThrow();
    expect(() => model.scene(estimateText)).toThrow(/chart x: a 3D axis takes one kind of field/);
  });

  it("export to SVG and PDF", () => {
    const options = {
      width: 400,
      height: 300,
      marks: [
        surface(
          field(6, (x, y) => x * y),
          { x: "x", y: "y", z: "z", wireframe: true },
        ),
        scatter(),
      ],
    };
    const svg = renderToSVG(options);
    expect(svg).toMatch(/<path d="M[^"]+" fill="#[0-9a-f]{6}"/);
    expect(svg).toContain(">x</text>");
    expect(new TextDecoder().decode(renderToPDF(options).subarray(0, 8))).toBe("%PDF-1.4");
  });

  it("describe their axes and camera", () => {
    const { model } = build({ title: "Clusters", marks: [scatter()], x: { title: "East" } });
    expect(describeChart(model)).toBe(
      "6 points at x, y, z. Axes: East from 0 to 5; y from 0 to 5; z from 0 to 10. Seen from azimuth -60°, elevation 25°.",
    );
  });
});
