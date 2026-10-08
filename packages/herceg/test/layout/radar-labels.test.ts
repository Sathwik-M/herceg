import { describe, expect, it } from "vitest";
import { fitTickLabels, placeSpokeLabels } from "../../src/layout/radar-labels.ts";
import { estimateText } from "../../src/layout/text.ts";

const FONT = "12px sans-serif";
/** Between the rim and the spoke names: half a 15 px line for the rim's value, and a pixel. */
const GAP = 8.5;
const angles = (count: number) =>
  Float64Array.from({ length: count }, (_, k) => -Math.PI / 2 + (k * 2 * Math.PI) / count);

describe("placeSpokeLabels", () => {
  it("anchors labels by side and keeps the radar as large as they allow", () => {
    const bounds = { x: 0, y: 0, width: 400, height: 300 };
    const names = ["top", "right", "bottom", "left"];
    const { radius, labels } = placeSpokeLabels(names, angles(4), bounds, estimateText, FONT, 15);
    expect(labels.map(({ anchor }) => anchor)).toEqual(["middle", "start", "middle", "end"]);
    // Height limits this radar: the top label's line above the gap above the rim.
    expect(radius).toBeCloseTo(150 - GAP - 15, 6);
    const top = labels[0]!;
    expect(top.x).toBeCloseTo(200, 6);
    expect(top.y).toBeCloseTo(150 - radius - GAP - 7.5, 6);
    expect(labels[1]!.x).toBeCloseTo(200 + radius + GAP, 6);
    expect(labels[1]!.y).toBeCloseTo(150, 6);
  });

  it("shrinks the radar for long labels at the sides, down to a limit, then shortens them", () => {
    const bounds = { x: 0, y: 0, width: 300, height: 300 };
    const wide = ["a", "a much longer label than fits", "b", "another very long label"];
    const { radius, labels } = placeSpokeLabels(wide, angles(4), bounds, estimateText, FONT, 15);
    expect(radius).toBeCloseTo(148 * 0.6, 6);
    const [, right, , left] = labels;
    expect(right!.text.endsWith("…")).toBe(true);
    expect(left!.text.endsWith("…")).toBe(true);
    expect(right!.x + estimateText(right!.text, FONT)).toBeLessThanOrEqual(300);
    expect(left!.x - estimateText(left!.text, FONT)).toBeGreaterThanOrEqual(0);
  });

  it("keeps ring labels inside the room, clear of spoke names and each other", () => {
    const bounds = { x: 0, y: 0, width: 300, height: 300 };
    const { labels } = placeSpokeLabels(["a", "b", "c"], angles(3), bounds, estimateText, FONT, 15);
    const at = (text: string, x: number, y: number) => ({ text, x, y });
    const fitted = fitTickLabels(
      [at("rim", 154, 40), at("close", 154, 50), at("apart", 154, 60), at("wide", 290, 100)],
      labels,
      bounds,
      estimateText,
      FONT,
      15,
    );
    // "close" is within a line of "rim"; "wide" runs off the right edge.
    expect(fitted.map(({ text }) => text)).toEqual(["rim", "apart"]);
    // The top spoke's name sits above the rim's value.
    const top = labels[0]!;
    expect(fitTickLabels([at("rim", 154, top.y)], labels, bounds, estimateText, FONT, 15)).toEqual(
      [],
    );
  });

  it("leaves out labels that would overlap a neighbor's, or have no room", () => {
    const bounds = { x: 0, y: 0, width: 160, height: 120 };
    const names = Array.from({ length: 24 }, (_, i) => `spoke ${i}`);
    const { labels } = placeSpokeLabels(names, angles(24), bounds, estimateText, FONT, 15);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThan(24);
    expect(labels[0]!.spoke).toBe(0);
    for (const label of labels) {
      expect(label.y - 7.5).toBeGreaterThanOrEqual(0);
      expect(label.y + 7.5).toBeLessThanOrEqual(120);
    }
  });
});
