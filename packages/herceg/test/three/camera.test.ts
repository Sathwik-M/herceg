import { describe, expect, it } from "vitest";
import {
  checkCamera,
  DEFAULT_CAMERA,
  resolveCamera,
  View,
  wrapDegrees,
} from "../../src/three/camera.ts";

const room = { x: 0, y: 0, width: 400, height: 300 };
const corners = [-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x, y, z])));

function project(view: View, x: number, y: number, z: number) {
  const out = new Float64Array(2);
  const depth = view.project(x, y, z, out, 0);
  return { x: out[0]!, y: out[1]!, depth };
}

describe("cameras", () => {
  it("fill in defaults, wrap the azimuth, and keep elevation and zoom in range", () => {
    expect(resolveCamera(undefined)).toEqual(DEFAULT_CAMERA);
    expect(resolveCamera({ azimuth: 270 }).azimuth).toBe(-90);
    expect(resolveCamera({ azimuth: -180 }).azimuth).toBe(180);
    expect(resolveCamera({ elevation: 30 }, { ...DEFAULT_CAMERA, azimuth: 10 })).toEqual({
      ...DEFAULT_CAMERA,
      azimuth: 10,
      elevation: 30,
    });
    expect(wrapDegrees(725)).toBe(5);
  });

  it("refuse settings out of range", () => {
    expect(() => checkCamera({ elevation: 91 })).toThrow(/elevation must be from -90 to 90/);
    expect(() => checkCamera({ zoom: 0 })).toThrow(/zoom must be from 0.5 to 10/);
    expect(() => checkCamera({ azimuth: Number.NaN })).toThrow(/azimuth/);
    expect(() => checkCamera({ azimuth: 400, elevation: -90, zoom: 10 })).not.toThrow();
  });
});

describe("views", () => {
  it("look from the eye's direction, with z up the screen", () => {
    // From +x at the floor's height, +y is to the right and +z up.
    const view = new View({ ...DEFAULT_CAMERA, azimuth: 0, elevation: 0 }, room);
    const center = project(view, 0, 0, 0);
    expect(center).toMatchObject({ x: 200, y: 150, depth: 0 });
    expect(project(view, 0, 1, 0).x).toBeGreaterThan(200);
    expect(project(view, 0, 0, 1).y).toBeLessThan(150);
    expect(project(view, 1, 0, 0).depth).toBeGreaterThan(0);
    expect(project(view, 1, 0, 0).x).toBeCloseTo(200);
  });

  it("are defined straight above and below", () => {
    for (const elevation of [90, -90]) {
      const view = new View({ ...DEFAULT_CAMERA, azimuth: 0, elevation }, room);
      const p = project(view, 0, 1, 0);
      expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
      expect(project(view, 0, 0, 1).depth).toBe(elevation > 0 ? 1 : -1);
    }
  });

  it("fit the box in the room at every angle, at a size that does not change as it turns", () => {
    for (const perspective of [false, true]) {
      let tallest = 0;
      for (let azimuth = -180; azimuth < 180; azimuth += 7) {
        for (let elevation = -90; elevation <= 90; elevation += 9) {
          const view = new View({ azimuth, elevation, zoom: 1, perspective }, room);
          for (const [x, y, z] of corners) {
            const p = project(view, x!, y!, z!);
            expect(p.x).toBeGreaterThanOrEqual(-1e-9);
            expect(p.x).toBeLessThanOrEqual(400 + 1e-9);
            expect(p.y).toBeGreaterThanOrEqual(-1e-9);
            expect(p.y).toBeLessThanOrEqual(300 + 1e-9);
            tallest = Math.max(tallest, Math.abs(p.y - 150));
          }
          expect(view.scale).toBe(new View({ ...view.camera, azimuth: 0 }, room).scale);
        }
      }
      // The bound is near what the box reaches at some angle.
      expect(tallest).toBeGreaterThan(perspective ? 130 : 149);
    }
  });

  it("magnify with zoom and keep a box's aspect", () => {
    const one = new View(DEFAULT_CAMERA, room);
    const two = new View({ ...DEFAULT_CAMERA, zoom: 2 }, room);
    expect(two.scale).toBeCloseTo(one.scale * 2);
    const flat = new View({ ...DEFAULT_CAMERA, azimuth: 0, elevation: 0 }, room, [2, 2, 1]);
    expect(flat.half).toEqual([1, 1, 0.5]);
    const top = project(flat, 0, 0, 1);
    const side = project(flat, 0, 1, 0);
    expect(150 - top.y).toBeCloseTo((side.x - 200) / 2);
  });

  it("make nearer things larger in perspective", () => {
    const view = new View({ ...DEFAULT_CAMERA, azimuth: 0, elevation: 0, perspective: true }, room);
    const near = project(view, 1, 1, 0);
    const far = project(view, -1, 1, 0);
    expect(near.x - 200).toBeGreaterThan(far.x - 200);
    expect(view.eyePosition()[0]).toBeGreaterThan(1);
  });
});
