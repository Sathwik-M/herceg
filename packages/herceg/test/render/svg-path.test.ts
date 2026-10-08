import { describe, expect, it } from "vitest";
import { tracePath } from "../../src/render/svg-path.ts";

/** The path as absolute commands, with coordinates rounded to 0.01. */
function trace(d: string): string[] {
  const out: string[] = [];
  const r = (...values: number[]) => values.map((v) => Math.round(v * 100) / 100 + 0).join(" ");
  tracePath(d, {
    moveTo: (x, y) => out.push(`M ${r(x, y)}`),
    lineTo: (x, y) => out.push(`L ${r(x, y)}`),
    bezierCurveTo: (...v) => out.push(`C ${r(...v)}`),
    closePath: () => out.push("Z"),
  });
  return out;
}

describe("tracePath", () => {
  it("resolves relative commands and implicit lines", () => {
    expect(trace("M10 10 20 10l0 10h-5v-5H0V0z")).toEqual([
      "M 10 10",
      "L 20 10",
      "L 20 20",
      "L 15 20",
      "L 15 15",
      "L 0 15",
      "L 0 0",
      "Z",
    ]);
    expect(trace("m1,1 2,0m1 1 1 0")).toEqual(["M 1 1", "L 3 1", "M 4 2", "L 5 2"]);
  });

  it("reads compact numbers", () => {
    expect(trace("M.5.5L-1-1e1L1.5e-1,2")).toEqual(["M 0.5 0.5", "L -1 -10", "L 0.15 2"]);
  });

  it("reflects control points of smooth curves", () => {
    expect(trace("M0 0C0 10 10 10 10 0S20 -10 20 0")).toEqual([
      "M 0 0",
      "C 0 10 10 10 10 0",
      "C 10 -10 20 -10 20 0",
    ]);
    // A quadratic curve is the cubic with control points 2/3 of the way to its control.
    expect(trace("M0 0Q15 30 30 0T60 0")).toEqual([
      "M 0 0",
      "C 10 20 20 20 30 0",
      "C 40 -20 50 -20 60 0",
    ]);
    // S without a preceding curve uses the current point as its first control.
    expect(trace("M0 0S10 10 20 0")).toEqual(["M 0 0", "C 0 0 10 10 20 0"]);
  });

  it("turns arcs into quarter-turn curves ending on the requested point", () => {
    const circle = trace("M0 5a5 5 0 1 0 10 0a5 5 0 1 0 -10 0Z");
    expect(circle.filter((c) => c.startsWith("C"))).toHaveLength(4);
    expect(circle[2]).toMatch(/ 10 5$/);
    expect(circle[4]).toMatch(/ 0 5$/);
    // A half circle of radius 5 passes 5 below its chord's middle (sweep 0, y down).
    const half = trace("M0 0A5 5 0 0 0 10 0");
    expect(half).toEqual(["M 0 0", "C 0 2.76 2.24 5 5 5", "C 7.76 5 10 2.76 10 0"]);
    // Radii too small to reach are scaled up; zero radii draw a line.
    expect(trace("M0 0A1 1 0 0 1 10 0").at(-1)).toMatch(/ 10 0$/);
    expect(trace("M0 0A0 5 0 0 1 10 0")).toEqual(["M 0 0", "L 10 0"]);
    // Flags may be written without separators.
    expect(trace("M0 0a5 5 0 1010 0").at(-1)).toMatch(/ 10 0$/);
  });

  it("continues after a close from the subpath's start", () => {
    expect(trace("M5 5L10 5ZL5 10")).toEqual(["M 5 5", "L 10 5", "Z", "M 5 5", "L 5 10"]);
  });

  it("stops at the first error, as browsers do", () => {
    expect(trace("M0 0L10 10L20")).toEqual(["M 0 0", "L 10 10"]);
    expect(trace("L10 10")).toEqual([]);
    expect(trace("M0 0X5 5")).toEqual(["M 0 0"]);
  });
});
