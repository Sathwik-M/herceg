import { describe, expect, it } from "vitest";
import { derive } from "../../src/data/derive.ts";
import { col } from "../../src/data/expression.ts";
import { type FeatureCollection, fromGeoJSON } from "../../src/data/geojson.ts";
import { type GeometrySet, geometry, geometryBytes } from "../../src/data/geometry.ts";
import { table } from "../../src/data/table.ts";

/** Three squares, the second with a hole and the third of two parts. */
function squares(): GeometrySet {
  const sq = (x: number, y: number, s: number) => [x, y, x + s, y, x + s, y + s, x, y + s];
  return {
    coordinates: Float64Array.from([
      ...sq(0, 0, 1),
      ...sq(10, 0, 4),
      ...sq(11, 1, 1),
      ...sq(20, 0, 1),
      ...sq(30, 0, 1),
    ]),
    ringOffsets: Int32Array.from([0, 4, 8, 12, 16, 20]),
    polygonOffsets: Int32Array.from([0, 1, 3, 4, 5]),
    geometryOffsets: Int32Array.from([0, 1, 2, 4]),
  };
}

describe("geometry columns", () => {
  it("hold a code per row into shared shapes", () => {
    const shapes = squares();
    const t = table({ name: ["a", "b", "c"], shape: geometry(shapes) });
    expect(t.kind("shape")).toBe("geometry");
    const { codes, set } = t.geometries("shape");
    expect(Array.from(codes)).toEqual([0, 1, 2]);
    expect(set).toBe(shapes);
    expect(t.value("shape", 1)).toBe(1);
    // Rows hold 4 bytes each; the shapes are counted once, wherever they are shared.
    expect(t.byteLength).toBe(3 * 4 + 3 * 4);
    expect(geometryBytes(shapes)).toBe(20 * 16 + (6 + 5 + 4) * 4);
  });

  it("take codes, with -1 for rows without a shape", () => {
    const t = table({ shape: geometry(squares(), Int32Array.from([2, -1, 2, 0])) });
    expect(Array.from(t.geometries("shape").codes)).toEqual([2, -1, 2, 0]);
    expect(t.value("shape", 1)).toBe(-1);
  });

  it("refuse sets whose offsets or coordinates are wrong", () => {
    const good = squares();
    const bad = (change: Partial<GeometrySet>) => () => geometry({ ...good, ...change });
    expect(bad({ ringOffsets: Int32Array.from([1, 4, 8, 12, 16, 20]) })).toThrow(/start at 0/);
    expect(bad({ ringOffsets: Int32Array.from([0, 8, 4, 12, 16, 20]) })).toThrow(/decrease/);
    expect(bad({ polygonOffsets: Int32Array.from([0, 1, 3, 4, 6]) })).toThrow(/end at 6, not at 5/);
    expect(bad({ geometryOffsets: Int32Array.from([0, 1, 2, 3]) })).toThrow(/end at 3, not at 4/);
    expect(bad({ coordinates: good.coordinates.slice(1) })).toThrow(/pairs/);
    const projected = Float64Array.from(good.coordinates);
    projected[0] = 512_000;
    expect(bad({ coordinates: projected })).toThrow(/reproject the data to WGS 84/);
    const missing = Float64Array.from(good.coordinates);
    missing[3] = Number.NaN;
    expect(bad({ coordinates: missing })).toThrow(/not a longitude and latitude/);
    expect(() => geometry(good, Int32Array.from([0, 3]))).toThrow(/code 3 at row 1/);
  });

  it("append and replace codes, refusing codes outside the set before changing anything", () => {
    const t = table({ value: [1, 2], shape: geometry(squares(), Int32Array.from([0, 1])) });
    t.append({ value: [3], shape: [2] });
    expect(Array.from(t.geometries("shape").codes)).toEqual([0, 1, 2]);
    const version = t.version;
    expect(() => t.append({ value: [4], shape: [3] })).toThrow(/code 3/);
    expect(() => t.append({ value: [4], shape: [0.5] })).toThrow(/code 0.5/);
    expect(() => t.replace("shape", 0, [7])).toThrow(/code 7/);
    expect(t.version).toBe(version);
    expect(t.length).toBe(3);
    t.set("shape", 0, -1);
    t.dropFirst(1);
    expect(Array.from(t.geometries("shape").codes)).toEqual([1, 2]);
  });

  it("copy codes passed in before writing to them", () => {
    const codes = Int32Array.from([0, 1]);
    const t = table({ shape: geometry(squares(), codes) });
    t.set("shape", 0, 2);
    expect(Array.from(codes)).toEqual([0, 1]);
  });

  it("are replaced whole by reset", () => {
    const t = table({ shape: geometry(squares()) });
    const other = squares();
    t.reset({ shape: geometry(other, Int32Array.from([1])) });
    expect(t.geometries("shape").set).toBe(other);
    expect(t.length).toBe(1);
    expect(() => t.reset({ shape: [1] as never })).toThrow(/keep field "shape" as geometry/);
  });

  it("go through filters and sorts of derived tables, sharing the shapes", () => {
    const shapes = squares();
    const source = table({ value: [3, 1, 2], shape: geometry(shapes) });
    const derived = derive(source).filter(col("value").gt(1)).sort("value").table();
    expect(Array.from(derived.geometries("shape").codes)).toEqual([2, 0]);
    expect(derived.geometries("shape").set).toBe(shapes);
    // Rows appended to the source follow.
    const rows = derive(source).filter(col("value").gt(1)).table();
    source.append({ value: [5], shape: [1] });
    expect(Array.from(rows.geometries("shape").codes)).toEqual([0, 2, 1]);
  });

  it("cannot be read as values in transforms", () => {
    const source = table({ value: [3, 1], shape: geometry(squares(), Int32Array.from([0, 1])) });
    expect(() =>
      derive(source)
        .bin("shape" as never, { step: 1 })
        .table(),
    ).toThrow(/field "shape" holds geometry values/);
    expect(() =>
      derive(source)
        .sort("shape" as never)
        .table(),
    ).toThrow(/field "shape" holds geometry values/);
    expect(() =>
      derive(source)
        .filter(col("shape" as never).gt(0))
        .table(),
    ).toThrow(/field "shape" holds geometry values/);
  });
});

const world: FeatureCollection = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      id: 840,
      properties: { name: "Oblong", pop: 10, code: "01", member: true, extra: { nested: 1 } },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [0, 0],
            [4, 0],
            [4, 2],
            [0, 2],
            [0, 0],
          ],
          [
            [1, 0.5, 120],
            [1, 1.5],
            [2, 1.5],
            [1, 0.5],
          ],
        ],
      },
    },
    {
      type: "Feature",
      properties: { name: "Twins", pop: null, code: 2, member: false },
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [
            [
              [10, 0],
              [11, 0],
              [11, 1],
              [10, 0],
            ],
          ],
          [
            [
              [12, 0],
              [13, 0],
              [13, 1],
              [12, 0],
            ],
          ],
        ],
      },
    },
    { type: "Feature", id: "x", properties: null, geometry: null },
  ],
};

describe("fromGeoJSON", () => {
  it("packs polygons and multipolygons and makes a column per property", () => {
    const t = fromGeoJSON(world, { name: "world" });
    expect(t.name).toBe("world");
    expect(t.fields()).toEqual(["geometry", "id", "name", "pop", "code", "member"]);
    const { codes, set } = t.geometries("geometry");
    expect(Array.from(codes)).toEqual([0, 1, 2]);
    expect(Array.from(set.geometryOffsets)).toEqual([0, 1, 3, 3]);
    expect(Array.from(set.polygonOffsets)).toEqual([0, 2, 3, 4]);
    expect(Array.from(set.ringOffsets)).toEqual([0, 5, 9, 13, 17]);
    // Altitudes are left out.
    expect(set.coordinates[10]).toBe(1);
    expect(set.coordinates[11]).toBe(0.5);
    expect(t.value("id", 0)).toBe("840");
    expect(t.value("id", 1)).toBeNull();
    expect(t.kind("pop")).toBe("number");
    expect(t.value("pop", 1)).toBeNull();
    // Strings mixed with numbers are text, keeping leading zeros.
    expect(t.kind("code")).toBe("category");
    expect([t.value("code", 0), t.value("code", 1)]).toEqual(["01", "2"]);
    expect([t.value("member", 0), t.value("member", 1)]).toEqual([1, 0]);
  });

  it("makes longitude and latitude fields of points", () => {
    const t = fromGeoJSON({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { city: "A" },
          geometry: { type: "Point", coordinates: [2.35, 48.86] },
        },
        { type: "Feature", properties: { city: "B" }, geometry: null },
      ],
    });
    expect(t.fields()).toEqual(["longitude", "latitude", "city"]);
    expect(t.value("longitude", 0)).toBe(2.35);
    expect(t.value("latitude", 1)).toBeNull();
  });

  it("refuses collections it cannot read, naming the feature", () => {
    const feature = (geometry: unknown, properties: Record<string, unknown> = {}) => ({
      type: "Feature" as const,
      properties,
      geometry: geometry as never,
    });
    const of = (...features: ReturnType<typeof feature>[]) =>
      fromGeoJSON({ type: "FeatureCollection", features });
    expect(() => fromGeoJSON({} as never)).toThrow(/FeatureCollection/);
    expect(() => of(feature({ type: "LineString", coordinates: [] }))).toThrow(
      /Feature 0 is a LineString/,
    );
    expect(() =>
      of(feature({ type: "Point", coordinates: [0, 0] }), feature(world.features[0]!.geometry)),
    ).toThrow(/Feature 1 is a Polygon, but earlier features are points/);
    expect(() => of(feature({ type: "Polygon", coordinates: [[[0, "a"]]] }))).toThrow(
      /Feature 0 has a position/,
    );
    expect(() => of(feature(world.features[0]!.geometry, { geometry: 1 }))).toThrow(
      /named "geometry"/,
    );
    expect(() => fromGeoJSON(world, { geometry: "shape" })).not.toThrow();
  });
});
