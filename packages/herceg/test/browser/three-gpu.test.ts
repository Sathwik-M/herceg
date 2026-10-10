import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { table } from "../../src/data/table.ts";
import { type Chart, createChart } from "../../src/dom/chart.ts";
import { canvasMeasurer } from "../../src/layout/text.ts";
import { line3d } from "../../src/marks/line3d.ts";
import { point3d } from "../../src/marks/point3d.ts";
import { surface } from "../../src/marks/surface.ts";
import { cloudPainter } from "../../src/render/webgl.ts";
import type { FaceGeometry, Rect } from "../../src/scene/scene.ts";
import { FaceIndex } from "../../src/three/faces.ts";
import { modelOf } from "./helpers.ts";

// The page's WebGL contexts, so a test can lose one.
const contexts: WebGL2RenderingContext[] = [];
const getContext = OffscreenCanvas.prototype.getContext;
OffscreenCanvas.prototype.getContext = function (this: OffscreenCanvas, ...args: unknown[]) {
  const context = (getContext as (...a: unknown[]) => unknown).apply(this, args);
  if (args[0] === "webgl2" && context) contexts.push(context as WebGL2RenderingContext);
  return context;
} as typeof getContext;

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:640px;height:520px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
  vi.restoreAllMocks();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** A height field on an n by n grid over [-2, 2], rows in grid order: enough cells for the GPU from n = 102. */
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

/** Text measured as the chart measures it, so scenes made again lay out as drawn. */
const measure = canvasMeasurer(document.createElement("canvas").getContext("2d")!);

/** A chart's scene made again, and its faces on the CPU, which a GPU painter stands in for. */
function facesOf(chart: Chart): { faces: FaceGeometry; plot: Rect } {
  const panel = modelOf(chart).scene(measure, true).panels[0]!;
  const mark = panel.marks.find((m) => m.kind === "faces") as FaceGeometry;
  return { faces: mark.batches ? mark.batches.faces() : mark, plot: panel.plot };
}

function pixel(chart: Chart, x: number, y: number): number[] {
  const canvas = chart.root.querySelector("canvas")!;
  const ratio = canvas.width / chart.root.clientWidth;
  const data = canvas
    .getContext("2d")!
    .getImageData(Math.floor(x * ratio), Math.floor(y * ratio), 1, 1).data;
  return [...data];
}

describe("3D charts on the GPU", () => {
  it("draw large surfaces with the CPU's colors and shading", async () => {
    host.style.cssText = "width:1000px;height:900px";
    const before = cloudPainter()!.bytes;
    const n = 102;
    const gpu = createChart(host, {
      locale: "en-US",
      marks: [surface(field(n, hills), { x: "x", y: "y", z: "z" })],
    });
    await gpu.loading;
    // Positions, normals, and colors per grid point, and 16-bit indices of two triangles per cell.
    const cells = (n - 1) * (n - 1);
    expect(cloudPainter()!.bytes - before).toBe(n * n * 25 + cells * 12);
    // At the center of each cell it shows there, the GPU draws the cell in the CPU's color.
    const { faces, plot } = facesOf(gpu);
    const index = new FaceIndex(faces, plot);
    let checked = 0;
    let different = 0;
    for (let f = 0; f < faces.count; f++) {
      let [cx, cy] = [0, 0];
      if (faces.starts[f + 1]! - faces.starts[f]! !== 4) continue;
      for (let c = faces.starts[f]!; c < faces.starts[f + 1]!; c++) {
        cx += faces.vertices[faces.corners[c]! * 2]! / 4;
        cy += faces.vertices[faces.corners[c]! * 2 + 1]! / 4;
      }
      // A pixel well inside the cell: the cell shows at its center and at its neighbors'.
      const [x, y] = [Math.floor(cx) + 0.5, Math.floor(cy) + 0.5];
      const around = [
        [0, 0],
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];
      if (!around.every(([dx, dy]) => index.find(x + dx!, y + dy!) === f)) continue;
      const hex = Number.parseInt(faces.styles[faces.style[f]!]!.fill.slice(1), 16);
      const expected = [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, 255];
      checked++;
      // Where facing the light falls at a boundary between levels, float32 may pick the other.
      if (pixel(gpu, x, y).some((v, k) => Math.abs(v - expected[k]!) > 1)) different++;
    }
    expect(checked).toBeGreaterThan(3000);
    expect(different / checked).toBeLessThan(0.01);
    gpu.destroy();
    expect(cloudPainter()!.bytes).toBe(before);
  });

  it("hide points behind a surface, show those in front, and find what shows", async () => {
    const n = 110;
    const flat = field(n, () => 0);
    // Seen from above: one point under the floor's middle, one above it.
    const points = table({ x: [0.5, -0.5], y: [0.5, -0.5], z: [-1, 1] });
    const chart = createChart(host, {
      locale: "en-US",
      camera: { azimuth: -60, elevation: 60 },
      marks: [
        surface(flat, { x: "x", y: "y", z: "z", colors: ["#0000ff", "#0000ff"], shading: false }),
        point3d(points, { x: "x", y: "y", z: "z", fill: "#ff0000", radius: 6 }),
      ],
    });
    await chart.loading;
    const model = modelOf(chart);
    const under = model.inspectItem(JSON.stringify([1, 0]))!.points[0]!;
    const over = model.inspectItem(JSON.stringify([1, 1]))!.points[0]!;
    expect(pixel(chart, under.px, under.py).slice(0, 3)).toEqual([0, 0, 255]);
    expect(pixel(chart, over.px, over.py).slice(0, 3)).toEqual([255, 0, 0]);
    // The pointer finds what the GPU drew there: the surface over the hidden point.
    expect(model.inspect(under.px, under.py)!.points[0]!.mark).toBe(0);
    expect(model.inspect(over.px, over.py)!.points[0]).toMatchObject({ mark: 1, row: 1 });
    // Without opening faces: the keyboard and the summary read the data.
    expect(model.layoutSummary()).toMatch(/^Surface of z over x and y: 110 by 110 grid points/);
    chart.destroy();
  });

  it("draw lines as ribbons a constant width, in depth with surfaces and points", async () => {
    const plane = field(110, () => 0);
    // Seen from above: a red line over the plane, a green one under it, and a point over the red one.
    const over = table({ x: [-1, 1], y: [0.5, 0.5], z: [0.5, 0.5] });
    const under = table({ x: [-1, 1], y: [-0.5, -0.5], z: [-0.5, -0.5] });
    const dot = table({ x: [0], y: [0.5], z: [0.8] });
    const chart = createChart(host, {
      locale: "en-US",
      camera: { azimuth: -90, elevation: 90 },
      z: { domain: [-1, 1] },
      marks: [
        surface(plane, { x: "x", y: "y", z: "z", colors: ["#0000ff", "#0000ff"], shading: false }),
        line3d(over, { x: "x", y: "y", z: "z", stroke: "#ff0000", strokeWidth: 8 }),
        line3d(under, { x: "x", y: "y", z: "z", stroke: "#00ff00", strokeWidth: 8 }),
        point3d(dot, { x: "x", y: "y", z: "z", fill: "#ffff00", radius: 3 }),
      ],
    });
    await chart.loading;
    const model = modelOf(chart);
    const at = (layer: number, row: number) =>
      model.inspectItem(JSON.stringify([layer, row]))!.points[0]!;
    // A little off the middle, clear of the point.
    const along = (layer: number): [number, number] => [
      at(layer, 0).px * 0.3 + at(layer, 1).px * 0.7,
      at(layer, 0).py * 0.3 + at(layer, 1).py * 0.7,
    ];
    const [ox, oy] = along(1);
    const [ux, uy] = along(2);
    expect(pixel(chart, ox, oy).slice(0, 3)).toEqual([255, 0, 0]);
    expect(pixel(chart, ux, uy).slice(0, 3)).toEqual([0, 0, 255]);
    const top = at(3, 0);
    expect(pixel(chart, top.px, top.py).slice(0, 3)).toEqual([255, 255, 0]);
    // Eight pixels wide on screen, across the line (which runs along x on screen).
    const across = [-6, -2.5, 2.5, 6].map((dy) => pixel(chart, ox, oy + dy).slice(0, 3));
    expect(across).toEqual([
      [0, 0, 255],
      [255, 0, 0],
      [255, 0, 0],
      [0, 0, 255],
    ]);
    // The pointer finds what shows: the line over the plane, the plane over the other line.
    expect(model.inspect(ox, oy)!.points[0]!.mark).toBe(1);
    expect(model.inspect(ux, uy)!.points[0]!.mark).toBe(0);
    chart.destroy();
  });

  it("draw lines reaching far past the box from wall to wall", async () => {
    const chart = createChart(host, {
      locale: "en-US",
      camera: { azimuth: -90, elevation: 90 },
      x: { domain: [-2, 2] },
      z: { domain: [-1, 1] },
      marks: [
        surface(
          field(110, () => 0),
          { x: "x", y: "y", z: "z", colors: ["#0000ff", "#0000ff"], shading: false },
        ),
        line3d(table({ x: [-1e8, 1e8], y: [0.5, 0.5], z: [0.5, 0.5] }), {
          x: "x",
          y: "y",
          z: "z",
          stroke: "#ff0000",
          strokeWidth: 6,
        }),
      ],
    });
    await chart.loading;
    const model = modelOf(chart);
    // Both ends are read where the line enters the box.
    const [a, b] = [0, 1].map((row) => model.inspectItem(JSON.stringify([1, row]))!.points[0]!);
    for (const t of [0.1, 0.5, 0.9]) {
      const [x, y] = [a!.px + t * (b!.px - a!.px), a!.py + t * (b!.py - a!.py)];
      expect(pixel(chart, x, y).slice(0, 3)).toEqual([255, 0, 0]);
      expect(model.inspect(x, y)!.points[0]!.mark).toBe(1);
    }
    chart.destroy();
  });

  it("show points on a surface over it, and find them there, in either order", async () => {
    // Heights where float32 places the point and the cells a step or two apart.
    for (const perspective of [false, true])
      for (const height of [1.7, 1.9, 2.3, 2.7])
        for (const pointFirst of [true, false]) {
          const point = point3d(table({ x: [0.3], y: [0.3], z: [height] }), {
            x: "x",
            y: "y",
            z: "z",
            fill: "#ff0000",
            radius: 6,
          });
          const plane = surface(
            field(110, () => height),
            {
              x: "x",
              y: "y",
              z: "z",
              colors: ["#0000ff", "#0000ff"],
              shading: false,
            },
          );
          const chart = createChart(host, {
            camera: { azimuth: -90, elevation: 90, perspective },
            z: { domain: [0, 3] },
            marks: pointFirst ? [point, plane] : [plane, point],
          });
          await chart.loading;
          const model = modelOf(chart);
          const layer = pointFirst ? 0 : 1;
          const at = model.inspectItem(JSON.stringify([layer, 0]))!.points[0]!;
          const what = [perspective, height, pointFirst];
          expect([...what, ...pixel(chart, at.px, at.py).slice(0, 3)]).toEqual([
            ...what,
            255,
            0,
            0,
          ]);
          expect([...what, model.inspect(at.px, at.py)!.points[0]!.mark]).toEqual([...what, layer]);
          chart.destroy();
        }
  });

  it("keep points on a surface over it when a narrower domain magnifies them", async () => {
    for (const perspective of [false, true]) {
      const marks = [
        point3d(table({ x: [0.3], y: [0.3], z: [0.5] }), {
          x: "x",
          y: "y",
          z: "z",
          fill: "#ff0000",
          radius: 6,
        }),
        surface(
          field(110, () => 0.5),
          {
            x: "x",
            y: "y",
            z: "z",
            colors: ["#0000ff", "#0000ff"],
            shading: false,
          },
        ),
      ];
      const camera = { azimuth: -90, elevation: 90, perspective };
      const chart = createChart(host, { camera, z: { domain: [0, 3] }, marks });
      await chart.loading;
      // The points' upload is placed for the first domain; the second is 1,500 times narrower.
      chart.update({ camera, z: { domain: [0.499, 0.501] }, marks });
      chart.render();
      const model = modelOf(chart);
      const at = model.inspectItem(JSON.stringify([0, 0]))!.points[0]!;
      expect([perspective, ...pixel(chart, at.px, at.py).slice(0, 3)]).toEqual([
        perspective,
        255,
        0,
        0,
      ]);
      expect([perspective, model.inspect(at.px, at.py)!.points[0]!.mark]).toEqual([perspective, 0]);
      chart.destroy();
    }
  });

  it("keep an upload per domain for charts sharing points, and upload nothing as they turn", async () => {
    const n = 50_000;
    const shared = table({
      x: Float64Array.from({ length: n }, (_, i) => (i % 500) / 100),
      y: Float64Array.from({ length: n }, (_, i) => Math.floor(i / 500) / 100),
      z: Float64Array.from({ length: n }, (_, i) => (i % 7) / 7),
    });
    const other = document.createElement("div");
    other.style.cssText = host.style.cssText;
    document.body.append(other);
    const charts = [
      [host, [0, 1]],
      [other, [4, 5]],
    ].map(([element, domain]) =>
      createChart(element as HTMLDivElement, {
        x: { domain: domain as [number, number] },
        marks: [point3d(shared, { x: "x", y: "y", z: "z" })],
      }),
    );
    for (const chart of charts) await chart.loading;
    const before = cloudPainter()!.bytes;
    const uploads = vi.spyOn(WebGL2RenderingContext.prototype, "bufferData");
    for (let step = 1; step <= 4; step++)
      for (const chart of charts) {
        chart.setCamera({ azimuth: -60 + step * 7 });
        chart.render();
      }
    expect(uploads).not.toHaveBeenCalled();
    expect(cloudPainter()!.bytes).toBe(before);
    for (const chart of charts) chart.destroy();
    other.remove();
  });

  it("hide points just under a surface, and find the surface there", async () => {
    const chart = createChart(host, {
      camera: { azimuth: -90, elevation: 90 },
      z: { domain: [0, 3] },
      marks: [
        point3d(table({ x: [0.3], y: [0.3], z: [0.5] }), {
          x: "x",
          y: "y",
          z: "z",
          fill: "#ff0000",
          radius: 6,
        }),
        surface(
          field(110, () => 0.5001),
          {
            x: "x",
            y: "y",
            z: "z",
            colors: ["#0000ff", "#0000ff"],
            shading: false,
          },
        ),
      ],
    });
    await chart.loading;
    const model = modelOf(chart);
    const at = model.inspectItem(JSON.stringify([0, 0]))!.points[0]!;
    expect(pixel(chart, at.px, at.py).slice(0, 3)).toEqual([0, 0, 255]);
    expect(model.inspect(at.px, at.py)!.points[0]!.mark).toBe(1);
    chart.destroy();
  });

  it("upload nothing while turning", async () => {
    const chart = createChart(host, {
      marks: [surface(field(110, hills), { x: "x", y: "y", z: "z" })],
    });
    await chart.loading;
    const uploads = vi.spyOn(WebGL2RenderingContext.prototype, "bufferData");
    for (let step = 1; step <= 5; step++) {
      chart.setCamera({ azimuth: -60 + step * 7 });
      await frame();
    }
    expect(uploads).not.toHaveBeenCalled();
    chart.destroy();
  });

  it("refuse, clearly, surfaces too large for the CPU when the GPU cannot draw the chart", async () => {
    // Points far larger than sprites can be keep the chart off the GPU.
    const chart = createChart(host, {
      marks: [
        surface(field(520, hills), { x: "x", y: "y", z: "z" }),
        point3d(table({ x: [0], y: [0], z: [0] }), { x: "x", y: "y", z: "z", radius: 5000 }),
      ],
    });
    await expect(chart.loading).rejects.toThrow(/surface: .* grid points draw only on the GPU/);
    chart.destroy();
  });

  it("draw nothing of surfaces too large for the CPU while the context is lost", async () => {
    const chart = createChart(host, {
      marks: [surface(field(520, hills), { x: "x", y: "y", z: "z" })],
    });
    await chart.loading;
    const painter = cloudPainter()!;
    contexts.at(-1)!.getExtension("WEBGL_lose_context")!.loseContext();
    await expect.poll(() => painter.usable).toBe(false);
    chart.setCamera({ azimuth: 10 });
    expect(() => chart.render()).not.toThrow();
    await chart.loading;
    await frame();
    expect(cloudPainter()!.bytes).toBeGreaterThan(520 * 520 * 25);
    chart.destroy();
  });

  it("draw on the CPU while the GPU's context is lost, and on a new one after", async () => {
    const marks = [surface(field(110, hills), { x: "x", y: "y", z: "z" })];
    const chart = createChart(host, { marks });
    await chart.loading;
    const painter = cloudPainter()!;
    expect(painter.bytes).toBeGreaterThan(0);
    const lost = contexts.at(-1)!;
    lost.getExtension("WEBGL_lose_context")!.loseContext();
    await expect.poll(() => painter.usable).toBe(false);
    chart.setCamera({ azimuth: 10 });
    chart.render();
    // Meanwhile the CPU draws the cells.
    expect(facesOf(chart).faces.count).toBeGreaterThan(10_000);
    await chart.loading;
    await frame();
    const fresh = cloudPainter()!;
    expect(fresh).not.toBe(painter);
    expect(fresh.bytes).toBeGreaterThan(0);
    chart.destroy();
    expect(fresh.bytes).toBe(0);
  });
});
