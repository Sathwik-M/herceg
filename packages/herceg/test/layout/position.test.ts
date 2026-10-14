// Coordinates on screen: values on named scales, shares of frames, pixels,
// and offsets, mixed per axis.
import { describe, expect, it } from "vitest";
import { coordinateAt, type PositionContext, positionAt } from "../../src/layout/position.ts";

const context: PositionContext = {
  plot: { x: 40, y: 10, width: 200, height: 100 },
  chart: { x: 0, y: 0, width: 300, height: 150 },
  scales: { x: "x", y: "yRight" },
  // x: 0..10 over the plot's width; yRight: 0..1 up its height; "site": two bands.
  at: (scale, value) =>
    scale === "x"
      ? 40 + (value as number) * 20
      : scale === "yRight"
        ? 110 - (value as number) * 100
        : scale === "site"
          ? { a: 90, b: 190 }[value as string]
          : undefined,
  field: (name) => ({ load: 0.25, site: "b" })[name],
};

describe("coordinateAt", () => {
  it("places values on the axis' own scale, or on the scale named", () => {
    expect(coordinateAt({ data: 5 }, "x", context)).toBe(140);
    expect(coordinateAt({ data: 0.5 }, "y", context)).toBe(60);
    expect(coordinateAt({ data: "a", scale: "site" }, "x", context)).toBe(90);
    expect(coordinateAt({ data: "z", scale: "site" }, "x", context)).toBeUndefined();
  });

  it("reads fields of the row being placed", () => {
    expect(coordinateAt({ field: "load" }, "y", context)).toBe(85);
    expect(coordinateAt({ field: "site", scale: "site" }, "x", context)).toBe(190);
    expect(coordinateAt({ field: "missing" }, "x", context)).toBeUndefined();
    const { field: _, ...rowless } = context;
    expect(coordinateAt({ field: "load" }, "y", rowless)).toBeUndefined();
  });

  it("measures fractions up from a frame's bottom, pixels down from its top", () => {
    expect(coordinateAt({ fraction: 0 }, "x", context)).toBe(40);
    expect(coordinateAt({ fraction: 1 }, "y", context)).toBe(10);
    expect(coordinateAt({ fraction: 0.25 }, "y", context)).toBe(85);
    expect(coordinateAt({ px: 12 }, "y", context)).toBe(22);
    expect(coordinateAt({ fraction: 0.5, frame: "chart" }, "x", context)).toBe(150);
    expect(coordinateAt({ px: 12, frame: "chart" }, "y", context)).toBe(12);
  });

  it("moves the result by its offset in pixels, right and down", () => {
    expect(coordinateAt({ data: 5, offset: -6 }, "x", context)).toBe(134);
    expect(coordinateAt({ fraction: 1, offset: 4 }, "y", context)).toBe(14);
  });
});

describe("positionAt", () => {
  it("mixes kinds per axis: a data y at a share of the plot's width", () => {
    expect(positionAt({ x: { fraction: 0.02 }, y: { data: 0.5, offset: -6 } }, context)).toEqual({
      x: 44,
      y: 54,
    });
    expect(
      positionAt({ x: { data: "z", scale: "site" }, y: { data: 1 } }, context),
    ).toBeUndefined();
  });
});
