// The WebGL painter following point clouds as their tables stream, driven
// directly with clouds of whole columns.
import { afterEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { point } from "../../src/marks/point.ts";
import { cloudPainter } from "../../src/render/webgl.ts";
import type { PointCloud, PointGeometry } from "../../src/scene/scene.ts";

const painter = cloudPainter()!;
const owners: object[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) painter.release(owner);
});

/** A 200 x 200 plot where x and y map 0..2 onto it, painting clouds of one stream. */
function stream() {
  const owner = {};
  owners.push(owner);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 200;
  const context = canvas.getContext("2d")!;
  const key = {};
  let version = 0;
  const cloud = (xs: number[], offset = 0, ys = xs.map(() => 1)): PointCloud => ({
    x: new Float64Array(xs),
    y: new Float64Array(ys),
    rows: undefined,
    start: 0,
    end: xs.length,
    version: version++,
    xMap: { origin: 0, offset: 0, factor: 100, log: false },
    yMap: { origin: 0, offset: 200, factor: -100, log: false },
    stream: { key, offset, modified: 0 },
  });
  const paint = (c: PointCloud) => {
    context.clearRect(0, 0, 200, 200);
    const mark = {
      kind: "point",
      key: "test",
      fill: "#000000",
      fillOpacity: 1,
      opaque: true,
      radius: 4,
      symbol: "circle",
      coords: new Float32Array(),
      count: c.end - c.start,
      cloud: c,
    } as unknown as PointGeometry;
    const drawn = painter.paint(context, mark, { x: 0, y: 0, width: 200, height: 200 }, 1, owner);
    painter.endFrame(owner);
    return drawn;
  };
  const alpha = (x: number, y: number) => context.getImageData(x, y, 1, 1).data[3];
  return { cloud, paint, alpha };
}

describe("streaming point clouds", () => {
  it("upload again for appended points their normalization cannot place", () => {
    const s = stream();
    expect(s.paint(s.cloud([0, 1e-310]))).toBe(true);
    expect(s.paint(s.cloud([0, 1e-310, 5e-311]))).toBe(true);
    // The range so far is tiny, so 1 overflows it; the point is still drawn.
    expect(s.paint(s.cloud([0, 1e-310, 5e-311, 1]))).toBe(true);
    expect(s.alpha(100, 100)).toBe(255);
  });

  it("refit their range once an outlier has been dropped", () => {
    const s = stream();
    // 1e16 makes the GPU too imprecise at this zoom: drawn on the CPU.
    expect(s.paint(s.cloud([1e16, 1, 1]))).toBe(false);
    expect(s.paint(s.cloud([1, 1], 1))).toBe(true);
    expect(s.alpha(100, 100)).toBe(255);
  });

  it("give room back when the window shrinks far below its buffers", () => {
    const s = stream();
    const before = painter.bytes;
    s.paint(s.cloud(Array(10_000).fill(1)));
    // A change uploads again with room to grow.
    s.paint(s.cloud(Array(10_000).fill(1), 1));
    expect(painter.bytes - before).toBeGreaterThan(10_000 * 16);
    s.paint(s.cloud(Array(100).fill(1), 9_901));
    expect(painter.bytes - before).toBeLessThanOrEqual(1024 * 16);
  });

  it("keep series of different field pairs apart, whatever their names", async () => {
    const host = document.createElement("div");
    host.style.cssText = "width:600px;height:300px";
    document.body.append(host);
    const values = (v: number) => new Float64Array(100_000).fill(v);
    const data = table({
      a: values(0.5),
      "b\0c": values(0.5),
      "a\0b": values(1.5),
      c: values(1.5),
    });
    const chart = createChart(host, {
      x: { domain: [0, 2], grid: false },
      y: { domain: [0, 2], grid: false },
      marks: [
        point(data, { x: "a", y: "b\0c", fill: "#ff0000", r: 4 }),
        point(data, { x: "a\0b", y: "c", fill: "#0000ff", r: 4 }),
      ],
    });
    try {
      await chart.loading;
      const canvas = chart.root.querySelector("canvas")!;
      const ratio = canvas.width / canvas.clientWidth;
      const at = (v: number) => [
        Math.round(chart.toPixel(v, { axis: "x" })! * ratio),
        Math.round(chart.toPixel(v, { axis: "y" })! * ratio),
      ];
      const color = (v: number) => {
        const [x, y] = at(v);
        return Array.from(canvas.getContext("2d")!.getImageData(x!, y!, 1, 1).data);
      };
      expect(color(0.5)).toEqual([255, 0, 0, 255]);
      expect(color(1.5)).toEqual([0, 0, 255, 255]);
    } finally {
      chart.destroy();
      host.remove();
    }
  });
});
