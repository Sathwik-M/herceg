import { describe, expect, it } from "vitest";
import { bestTurn, layoutCircular } from "../../src/layout/circular.ts";
import { LINK_DISTANCE } from "../../src/layout/force.ts";

const point = (positions: Float64Array, i: number) => [positions[i * 2]!, positions[i * 2 + 1]!];

describe("layoutCircular", () => {
  it("puts nodes clockwise from the top, a link length apart", () => {
    const positions = layoutCircular(Int32Array.of(2, 0, 1, 3));
    const radius = (4 * LINK_DISTANCE) / (2 * Math.PI);
    // Node 2 first, at the top (y grows downwards); then clockwise.
    expect(point(positions, 2)[0]).toBeCloseTo(0);
    expect(point(positions, 2)[1]).toBeCloseTo(-radius);
    expect(point(positions, 0)[0]).toBeCloseTo(radius);
    expect(point(positions, 1)[1]).toBeCloseTo(radius);
    expect(point(positions, 3)[0]).toBeCloseTo(-radius);
    expect(layoutCircular(Int32Array.of(0))).toEqual(new Float64Array(2));
  });

  it("leaves a slot between groups, less where groups are many", () => {
    const group = Int32Array.of(0, 0, 0, 0, 1, 1, 1, 1);
    const positions = layoutCircular(Int32Array.of(0, 1, 2, 3, 4, 5, 6, 7), group);
    const angle = (i: number) => Math.atan2(positions[i * 2 + 1]!, positions[i * 2]!);
    const step = (a: number, b: number) => (angle(b) - angle(a) + 4 * Math.PI) % (2 * Math.PI);
    // Within a group one slot, between groups two.
    expect(step(3, 4) / step(0, 1)).toBeCloseTo(2);
    // Four nodes in two groups: half a slot between them.
    const few = layoutCircular(Int32Array.of(0, 1, 2, 3), Int32Array.of(0, 0, 1, 1));
    const turn = (i: number) => Math.atan2(few[i * 2 + 1]!, few[i * 2]!);
    expect((turn(2) - turn(1) + 4 * Math.PI) % (2 * Math.PI)).toBeCloseTo(
      (1.5 * (turn(1) - turn(0) + 4 * Math.PI)) % (2 * Math.PI),
    );
    // Twenty groups of one: gaps take a fifth of the circle at most.
    const many = layoutCircular(
      Int32Array.from({ length: 20 }, (_, i) => i),
      Int32Array.from({ length: 20 }, (_, i) => i),
    );
    const radius = Math.hypot(many[0]!, many[1]!);
    expect(radius).toBeCloseTo((25 * LINK_DISTANCE) / (2 * Math.PI));
  });

  it("finds the turn that moves nodes least", () => {
    const before = layoutCircular(Int32Array.of(0, 1, 2, 3, 4, 5), undefined, 0.4);
    const after = layoutCircular(Int32Array.of(0, 1, 2, 3, 4, 5));
    expect(bestTurn(before, after)).toBeCloseTo(0.4);
    // Nodes without a place before count for nothing.
    before[0] = before[1] = Number.NaN;
    expect(bestTurn(before, after)).toBeCloseTo(0.4);
    expect(bestTurn(new Float64Array(4).fill(Number.NaN), new Float64Array(4))).toBe(0);
  });
});
