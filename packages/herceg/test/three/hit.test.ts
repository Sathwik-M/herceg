import { describe, expect, it } from "vitest";
import { DEFAULT_CAMERA, View } from "../../src/three/camera.ts";
import { monotone, rayInBox, ScreenGrid, walkGrid } from "../../src/three/hit.ts";

const room = { x: 0, y: 0, width: 400, height: 300 };

describe("pointer rays", () => {
  it("pass through every point that projects to the pixel, farther as t grows", () => {
    for (const perspective of [false, true])
      for (const camera of [
        { azimuth: -60, elevation: 25 },
        { azimuth: 135, elevation: -40 },
        { azimuth: 10, elevation: 90 },
      ]) {
        const view = new View({ ...DEFAULT_CAMERA, ...camera, perspective }, room, [2, 1, 0.5]);
        const out = new Float64Array(2);
        const point = [0.3, -0.7, 0.4];
        const depth = view.project(point[0]!, point[1]!, point[2]!, out, 0);
        const { origin, direction } = view.ray(out[0]!, out[1]!);
        // The point is on the ray: at the t where its depth is reached.
        const along = [0.1, 0.5].map((t) => origin.map((o, k) => o + t * direction[k]!));
        // Along the ray's largest component, the t where the point is reached.
        const k = direction.reduce(
          (best, d, i) => (Math.abs(d) > Math.abs(direction[best]!) ? i : best),
          0,
        );
        const t = (point[k]! - origin[k]!) / direction[k]!;
        origin.forEach((o, k) => {
          expect(o + t * direction[k]!).toBeCloseTo(point[k]!, 9);
        });
        expect(view.depth(along[1]![0]!, along[1]![1]!, along[1]![2]!)).toBeLessThan(
          view.depth(along[0]![0]!, along[0]![1]!, along[0]![2]!),
        );
        expect(view.depth(point[0]!, point[1]!, point[2]!)).toBeCloseTo(depth, 9);
      }
  });

  it("enter and leave the box where they cross its walls", () => {
    expect(rayInBox([-3, 0, 0], [1, 0, 0])).toEqual([2, 4]);
    expect(rayInBox([0, 0, 0], [0, 0, -2])).toEqual([-0.5, 0.5]);
    expect(rayInBox([0, 2, 0], [1, 0, 0])).toBeUndefined();
    expect(rayInBox([-3, -3, 0], [1, 0.2, 0])).toBeUndefined();
  });
});

describe("walking a grid", () => {
  const cellsAlong = (
    u: number[],
    v: number[],
    origin: number[],
    direction: number[],
    t0: number,
    t1: number,
  ) => {
    const cells: [number, number][] = [];
    walkGrid(Float64Array.from(u), Float64Array.from(v), origin, direction, t0, t1, (i, j) => {
      cells.push([i, j]);
      return false;
    });
    return cells;
  };

  it("visits the cells a ray crosses, nearest first, on irregular and reversed grids", () => {
    // From the left along y = 0.5, across three columns of one row.
    expect(cellsAlong([-1, 0, 0.5, 1], [0, 1], [-2, 0.5, 0], [1, 0, 0], 0, 4)).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
    ]);
    // A reversed axis: columns from 1 down to -1.
    expect(cellsAlong([1, 0, -1], [0, 1], [-2, 0.5, 0], [1, 0, 0], 0, 4)).toEqual([
      [1, 0],
      [0, 0],
    ]);
    // Diagonally, through a corner shared by four cells.
    expect(cellsAlong([0, 1, 2], [0, 1, 2], [-1, -1, 0], [1, 1, 0], 0, 4)).toEqual([
      [0, 0],
      [1, 1],
    ]);
    // Straight down: one cell.
    expect(cellsAlong([0, 1, 2], [0, 1, 2], [1.5, 0.5, 1], [0, 0, -1], 0, 2)).toEqual([[1, 0]]);
    // Positions without a place (a log axis' nonpositive values) are no cells.
    expect(
      cellsAlong([Number.NaN, 0, 1], [0, 1], [-2, 0.5, 0], [1, 0, 0], 0, 4).map(([i]) => i),
    ).toEqual([1]);
  });

  it("stops at the first cell that reports a hit", () => {
    const visited: number[] = [];
    walkGrid(
      Float64Array.of(0, 1, 2, 3),
      Float64Array.of(0, 1),
      [-1, 0.5, 0],
      [1, 0, 0],
      0,
      5,
      (i) => {
        visited.push(i);
        return i === 1;
      },
    );
    expect(visited).toEqual([0, 1]);
  });

  it("tells grids whose cells cannot overlap", () => {
    expect(monotone(Float64Array.of(-1, 0, 1))).toBe(true);
    expect(monotone(Float64Array.of(1, 0, -1))).toBe(true);
    expect(monotone(Float64Array.of(Number.NaN, 0, 1))).toBe(true);
    expect(monotone(Float64Array.of(0, 1, 0.5))).toBe(false);
    expect(monotone(Float64Array.of(0, 0, 1))).toBe(false);
    expect(monotone(Float64Array.of(0, Number.NaN, 1))).toBe(false);
  });
});

describe("screen grids", () => {
  it("find items filed by the boxes they cover, within reach", () => {
    const boxes = [
      [10, 10, 10, 10],
      [100, 50, 300, 50],
      [390, 290, 390, 290],
    ];
    const grid = new ScreenGrid(room, boxes.length, (filer) => {
      for (const [i, [x0, y0, x1, y1]] of boxes.entries()) filer.box(i, x0!, y0!, x1!, y1!);
    });
    const near = (x: number, y: number, reach: number) => {
      const found = new Set<number>();
      grid.near(x, y, reach, (i) => found.add(i));
      return [...found];
    };
    expect(near(12, 11, 4)).toEqual([0]);
    expect(near(200, 52, 3)).toEqual([1]);
    expect(near(395, 295, 6)).toEqual([2]);
    expect(near(200, 200, 2)).toEqual([]);
  });

  it("file a segment once in each cell within reach of it, however long it is", () => {
    const filed: number[] = [];
    let count = 0;
    const grid = new ScreenGrid(room, 1, (filer) => {
      count++;
      filer.segment(0, 0, 0, 400, 300, 4);
      // A segment of no finite length is filed nowhere.
      filer.segment(1, 0, 0, Number.POSITIVE_INFINITY, 0, 4);
    });
    expect(count).toBe(2);
    for (let y = 0; y < 300; y += 3)
      for (let x = 0; x < 400; x += 3) {
        const found: number[] = [];
        grid.near(x, y, 0, (item) => found.push(item));
        // Each item at most once a cell.
        expect(new Set(found).size).toBe(found.length);
        if (Math.abs(x * 0.75 - y) / 1.25 < 1) filed.push(found.length);
      }
    // Every point on the segment finds it.
    expect(filed.every((n) => n === 1)).toBe(true);
  });
});
