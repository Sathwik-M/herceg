import { describe, expect, it } from "vitest";
import type { GeometrySet } from "../../src/data/geometry.ts";
import {
  degreeBox,
  emptyExtent,
  extendExtent,
  fitTransform,
  pixelShapeOf,
  planeBox,
  planProjection,
  worldBox,
} from "../../src/geo/project.ts";
import { anchorOf, contains, ShapeIndex } from "../../src/geo/shape-index.ts";

/** A set of polygons, each a list of rings of [lon, lat] points. */
function set(...geometries: number[][][][]): GeometrySet {
  const coordinates: number[] = [];
  const ringOffsets = [0];
  const polygonOffsets = [0];
  const geometryOffsets = [0];
  for (const polygons of geometries) {
    for (const polygon of polygons) {
      for (const ring of polygon) {
        coordinates.push(...ring);
        ringOffsets.push(coordinates.length / 2);
      }
      polygonOffsets.push(ringOffsets.length - 1);
    }
    geometryOffsets.push(polygonOffsets.length - 1);
  }
  return {
    coordinates: Float64Array.from(coordinates),
    ringOffsets: Int32Array.from(ringOffsets),
    polygonOffsets: Int32Array.from(polygonOffsets),
    geometryOffsets: Int32Array.from(geometryOffsets),
  };
}

const square = (x: number, y: number, size: number) => [
  x,
  y,
  x + size,
  y,
  x + size,
  y + size,
  x,
  y + size,
];
const room = { x: 0, y: 0, width: 400, height: 200 };

describe("planProjection", () => {
  it("defaults to the central meridian 0 for cylindrical projections", () => {
    const plan = planProjection({ type: "equal-earth" }, emptyExtent());
    expect(plan.clipper.center).toBe(0);
    expect(plan.clipper.limit).toBe(90);
    expect(planProjection({ type: "mercator" }, emptyExtent()).clipper.limit).toBeCloseTo(85.05, 2);
  });

  it("centers conic projections on the data, across the antimeridian too", () => {
    const extent = emptyExtent();
    for (let lon = -125; lon <= -67; lon++) extendExtent(extent, lon, 25 + ((lon + 125) % 25));
    const usa = planProjection({ type: "conic-equal-area" }, extent);
    expect(usa.clipper.center).toBeCloseTo(-95.5, 0);
    // Parallels a sixth of the latitudes in from each end: 25 to 49.
    expect(usa.key).toContain("29 45");
    const pacific = emptyExtent();
    for (const lon of [170, 175, -175, -170]) extendExtent(pacific, lon, 0);
    const center = planProjection({ type: "conic-equal-area" }, pacific).clipper.center;
    expect(Math.abs(center)).toBeGreaterThan(178);
  });

  it("takes a conic projection's center and parallels from its fitted box", () => {
    const plan = planProjection(
      {
        type: "conic-equal-area",
        fit: [
          [170, 10],
          [-170, 40],
        ],
      },
      emptyExtent(),
    );
    expect(Math.abs(plan.clipper.center)).toBe(180);
    expect(plan.key).toContain("15 35");
  });

  it("wraps huge central meridians exactly, and draws with them", () => {
    const plan = planProjection(
      { type: "equirectangular", centralMeridian: 3.0000000000000002e100 },
      emptyExtent(),
    );
    expect(Math.abs(plan.clipper.center)).toBeLessThanOrEqual(180);
    const shapes = set([[square(0, 0, 10)]]);
    expect(planeBox(shapes, 0, plan)[0]).toBeLessThan(Infinity);
  });

  it("keys plans by their projection and parameters", () => {
    const a = planProjection({ type: "equal-earth", centralMeridian: 10 }, emptyExtent());
    const b = planProjection({ type: "equal-earth", centralMeridian: 370 }, emptyExtent());
    expect(a.key).toBe(b.key);
    expect(a.key).not.toBe(planProjection({ type: "equal-earth" }, emptyExtent()).key);
  });
});

describe("fitting", () => {
  it("fits a plane box into the room, centered", () => {
    const t = fitTransform([0, 0, 2, 1], room, 0, 1);
    expect(t.k).toBe(200);
    // The box's middle lands in the room's middle, y pointing down.
    expect(t.x0 + t.k * 1).toBe(200);
    expect(t.y0 - t.k * 0.5).toBe(100);
  });

  it("leaves an inset and gives a box of no size a span", () => {
    expect(fitTransform([0, 0, 2, 1], room, 10, 1).k).toBe(180);
    const point = fitTransform([1, 1, 1, 1], room, 0, 0.5);
    expect(point.k).toBe(400);
    expect(point.x0 + point.k).toBe(200);
  });

  it("measures the world's outline and boxes of degrees in the projection", () => {
    const plan = planProjection({ type: "equirectangular" }, emptyExtent());
    const world = worldBox(plan);
    expect(Array.from(world)).toEqual([-Math.PI, -Math.PI / 2, Math.PI, Math.PI / 2]);
    const box = degreeBox(plan, [
      [-10, 0],
      [20, 30],
    ]);
    expect(box[0]).toBeCloseTo((-10 * Math.PI) / 180, 12);
    expect(box[3]).toBeCloseTo((30 * Math.PI) / 180, 12);
    // Across the antimeridian, with the map centered on it.
    const pacific = planProjection(
      { type: "equirectangular", centralMeridian: 180 },
      emptyExtent(),
    );
    const across = degreeBox(pacific, [
      [170, 0],
      [-170, 10],
    ]);
    expect(across[2]! - across[0]!).toBeCloseTo((20 * Math.PI) / 180, 12);
  });
});

describe("projected shapes", () => {
  const plan = planProjection({ type: "equirectangular" }, emptyExtent());

  it("draws rings in pixels, grouped by polygon, and boxes what is on the map", () => {
    const shapes = set([[square(0, 0, 4), square(1, 1, 1)], [square(10, 0, 1)]], []);
    const t = fitTransform(planeBox(shapes, 0, plan), room, 0, 1);
    const pixels = pixelShapeOf(shapes, 0, plan, t, 0);
    // The 4-degree exterior's edges are divided into 1-degree steps.
    expect(Array.from(pixels.rings)).toEqual([0, 16, 20, 24]);
    expect(Array.from(pixels.parts)).toEqual([0, 2, 3]);
    expect(planeBox(shapes, 0, plan)[2]).toBeCloseTo((11 * Math.PI) / 180, 12);
    expect(planeBox(shapes, 1, plan)[0]).toBe(Infinity);
    expect(pixelShapeOf(shapes, 1, plan, t, 0).coords.length).toBe(0);
  });

  it("drops points closer than the tolerance, and holes of exteriors dropped", () => {
    const shapes = set(
      [[square(0, 0, 10), square(2, 2, 1)]],
      [[square(0, 0, 0.001), square(0.0001, 0.0001, 0.0005)]],
    );
    const t = fitTransform([0, 0, (10 * Math.PI) / 180, (10 * Math.PI) / 180], room, 0, 1);
    const big = pixelShapeOf(shapes, 0, plan, t, 0.35);
    expect(Array.from(big.rings)).toEqual([0, 40, 44]);
    // A shape smaller than the tolerance keeps neither its exterior nor its hole.
    const tiny = pixelShapeOf(shapes, 1, plan, t, 0.35);
    expect(tiny.rings.length).toBe(1);
    expect(tiny.parts.length).toBe(1);
  });
});

describe("pixel precision", () => {
  it("divides edges until the projected curve is within a quarter pixel of what is drawn", () => {
    // A thin box at 80 degrees north, fitted large: its parallels are tight arcs.
    const shapes = set([[[0, 80, 1, 80, 1, 80.1, 0, 80.1]]]);
    const plan = planProjection(
      { type: "conic-equal-area" },
      (() => {
        const extent = emptyExtent();
        extendExtent(extent, 0, 80);
        extendExtent(extent, 1, 80.1);
        return extent;
      })(),
    );
    const t = fitTransform(
      planeBox(shapes, 0, plan),
      { x: 0, y: 0, width: 1000, height: 600 },
      0,
      1,
    );
    const shape = pixelShapeOf(shapes, 0, plan, t, 0);
    // Sample the true southern edge densely and measure its distance to the drawn outline.
    const out = new Float64Array(2);
    const segments: number[][] = [];
    const n = shape.rings[1]!;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      segments.push([
        shape.coords[i * 2]!,
        shape.coords[i * 2 + 1]!,
        shape.coords[j * 2]!,
        shape.coords[j * 2 + 1]!,
      ]);
    }
    const distance = (x: number, y: number) =>
      Math.min(
        ...segments.map(([ax, ay, bx, by]) => {
          const [dx, dy] = [bx! - ax!, by! - ay!];
          const u = Math.max(
            0,
            Math.min(1, ((x - ax!) * dx + (y - ay!) * dy) / (dx * dx + dy * dy)),
          );
          return Math.hypot(x - (ax! + u * dx), y - (ay! + u * dy));
        }),
      );
    let worst = 0;
    for (let i = 0; i <= 200; i++) {
      // Longitudes about the central meridian, the box's middle.
      const lon = i / 200 - plan.clipper.center;
      plan.raw((lon * Math.PI) / 180, (80 * Math.PI) / 180, out);
      worst = Math.max(worst, distance(t.x0 + t.k * out[0]!, t.y0 - t.k * out[1]!));
    }
    expect(worst).toBeLessThan(0.3);
  });
});

describe("fit boxes", () => {
  it("refuse boxes that are not degrees, from south to north, of some width", () => {
    const plan = (fit: [[number, number], [number, number]]) => () =>
      planProjection({ type: "equirectangular", fit }, emptyExtent());
    expect(
      plan([
        [1e20, 0],
        [1e20 + 1, 10],
      ]),
    ).toThrow(/fit box/);
    expect(
      plan([
        [180, 0],
        [180, 10],
      ]),
    ).toThrow(/west apart from east/);
    expect(
      plan([
        [0, 10],
        [10, 5],
      ]),
    ).toThrow(/south below north/);
    expect(
      plan([
        [170, -10],
        [-170, 10],
      ]),
    ).not.toThrow();
  });

  it("are empty beyond the projection's latitudes, and a fit of nothing is finite", () => {
    const mercator = planProjection({ type: "mercator" }, emptyExtent());
    const beyond = degreeBox(mercator, [
      [0, 86],
      [10, 89],
    ]);
    expect(beyond[0]).toBe(Infinity);
    const t = fitTransform(beyond, room, 0, 1);
    expect([t.k, t.x0, t.y0].every(Number.isFinite)).toBe(true);
  });
});

describe("ShapeIndex", () => {
  const plan = planProjection({ type: "equirectangular" }, emptyExtent());
  const shapes = set(
    // A square with a hole, a two-part shape, and a large one under both.
    [[square(0, 0, 10), square(3, 3, 4)]],
    [[square(20, 0, 5)], [square(30, 0, 5)]],
    [[square(-60, -60, 120)]],
  );
  const t = fitTransform([-Math.PI / 3, -Math.PI / 3, Math.PI / 3, Math.PI / 3], room, 0, 1);
  const pixels = [0, 1, 2].map((g) => pixelShapeOf(shapes, g, plan, t, 0.35));
  const px = (lon: number) => t.x0 + (t.k * lon * Math.PI) / 180;
  const py = (lat: number) => t.y0 - (t.k * lat * Math.PI) / 180;

  it("tests points against every ring with the even-odd rule", () => {
    expect(contains(pixels[0]!, px(1), py(1))).toBe(true);
    expect(contains(pixels[0]!, px(5), py(5))).toBe(false);
    expect(contains(pixels[1]!, px(32), py(2))).toBe(true);
    expect(contains(pixels[1]!, px(27), py(2))).toBe(false);
  });

  it("finds the last-drawn shape under a point, holes included", () => {
    // Drawn last, the large shape covers the others.
    const over = new ShapeIndex(pixels, room);
    expect(over.find(px(1), py(1))).toBe(2);
    // Drawn first, it shows through the hole and between the parts.
    const under = new ShapeIndex([pixels[2], pixels[0], pixels[1]], room);
    expect(under.find(px(1), py(1))).toBe(1);
    expect(under.find(px(5), py(5))).toBe(0);
    expect(under.find(px(27), py(2))).toBe(0);
    expect(under.find(px(32), py(2))).toBe(2);
    expect(under.find(px(80), py(80))).toBe(-1);
    expect(new ShapeIndex([undefined, pixels[0]], room).find(px(1), py(1))).toBe(1);
  });

  it("anchors a tooltip inside the shape, not in its hole", () => {
    const [x, y] = anchorOf(pixels[0]!);
    expect(contains(pixels[0]!, x, y)).toBe(true);
    for (const shape of pixels) {
      const [ax, ay] = anchorOf(shape);
      expect(contains(shape, ax, ay)).toBe(true);
    }
  });
});
