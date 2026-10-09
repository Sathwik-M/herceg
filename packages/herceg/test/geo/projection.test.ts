import { describe, expect, it } from "vitest";
import {
  albers,
  equalEarth,
  equirectangular,
  MERCATOR_LIMIT,
  mercator,
  naturalEarth,
  type RawProjection,
} from "../../src/geo/projection.ts";

const RADIANS = Math.PI / 180;

function at(projection: RawProjection, lon: number, lat: number): [number, number] {
  const out = new Float64Array(2);
  projection(lon * RADIANS, lat * RADIANS, out);
  return [out[0]!, out[1]!];
}

// Reference values from d3-geo 3's raw projections.
describe("projections", () => {
  it("equirectangular maps degrees to radians", () => {
    expect(at(equirectangular, 100, 45)).toEqual([100 * RADIANS, 45 * RADIANS]);
  });

  it("mercator matches d3 and is square at its latitude limit", () => {
    const [x, y] = at(mercator, -75, -33.5);
    expect(x).toBeCloseTo(-1.309, 3);
    expect(y).toBeCloseTo(-0.621162608681, 10);
    expect(at(mercator, 100, 45)[1]).toBeCloseTo(0.88137358702, 10);
    expect(MERCATOR_LIMIT).toBeCloseTo(85.0511287798, 9);
    expect(at(mercator, 0, MERCATOR_LIMIT)[1]).toBeCloseTo(Math.PI, 9);
  });

  it("equal earth matches d3", () => {
    expect(at(equalEarth, 180, 0)[0]).toBeCloseTo(2.7066299837, 9);
    expect(at(equalEarth, 0, 90)[1]).toBeCloseTo(1.31736275916, 9);
    const [x, y] = at(equalEarth, -75, -33.5);
    expect(x).toBeCloseTo(-1.037178336, 8);
    expect(y).toBeCloseTo(-0.657917606543, 9);
    const [px, py] = at(equalEarth, 179.9, 89);
    expect(px).toBeCloseTo(1.60339797759, 9);
    expect(py).toBeCloseTo(1.31706444371, 9);
  });

  it("natural earth matches d3", () => {
    expect(at(naturalEarth, 180, 0)[0]).toBeCloseTo(2.73538472348, 9);
    expect(at(naturalEarth, 0, -90)[1]).toBeCloseTo(-1.42239050673, 9);
    const [x, y] = at(naturalEarth, 100, 45);
    expect(x).toBeCloseTo(1.36888197555, 9);
    expect(y).toBeCloseTo(0.793051394413, 9);
  });

  it("conic equal-area matches d3 with Albers' US parallels", () => {
    const usa = albers(29.5 * RADIANS, 45.5 * RADIANS);
    const [x, y] = at(usa, -75, -33.5);
    expect(x).toBeCloseTo(-1.67189942935, 9);
    expect(y).toBeCloseTo(0.268722325817, 9);
    expect(at(usa, 0, 90)[1]).toBeCloseTo(1.29539795018, 9);
    expect(at(usa, 0, -90)[1]).toBeCloseTo(-0.724257194853, 9);
    expect(at(usa, 180, 0)).toEqual([
      expect.closeTo(1.82849122187, 9),
      expect.closeTo(2.54043294787, 9),
    ]);
  });

  it("conic parallels symmetric about the equator give the cylindrical equal-area projection", () => {
    const cylinder = albers(-30 * RADIANS, 30 * RADIANS);
    const [x, y] = at(cylinder, 90, 30);
    const cos = Math.cos(-30 * RADIANS);
    expect(x).toBeCloseTo(90 * RADIANS * cos, 12);
    expect(y).toBeCloseTo(Math.sin(30 * RADIANS) / cos, 12);
  });

  it("conic projections stay finite at both poles", () => {
    const north = albers(50 * RADIANS, 70 * RADIANS);
    for (const lat of [90, -90])
      for (const lon of [-180, 0, 180])
        expect(at(north, lon, lat).every(Number.isFinite)).toBe(true);
  });
});
