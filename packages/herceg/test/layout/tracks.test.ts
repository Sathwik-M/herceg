// Tracks along a chart's sides: requests stacked inward from each edge, in order.
import { describe, expect, it } from "vitest";
import { stackTracks } from "../../src/layout/tracks.ts";

describe("stackTracks", () => {
  it("stacks each side's requests inward, outermost first, leaving the rest to the panels", () => {
    const { tracks, edges } = stackTracks(
      [
        { key: "title", side: "top", size: 20, gap: 8 },
        { key: "legend", side: "top", size: 15, gap: 8 },
        { key: "note", side: "bottom", size: 12, gap: 4 },
        { key: "key", side: "right", size: 60, gap: 16 },
        { key: "labels", side: "left", size: 30, gap: 6 },
      ],
      { top: 6, bottom: 296, left: 8, right: 592 },
    );
    expect(Object.fromEntries(tracks)).toEqual({
      title: 6,
      legend: 34,
      note: 284,
      key: 532,
      labels: 8,
    });
    expect(edges).toEqual({ top: 57, bottom: 280, left: 44, right: 516 });
  });

  it("leaves a side without requests at its edge", () => {
    const edges = { top: 0, bottom: 100, left: 0, right: 200 };
    expect(stackTracks([], edges)).toEqual({ tracks: new Map(), edges });
  });
});
