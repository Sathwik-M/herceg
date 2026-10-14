// Axes placed beside a plot through the guide contract: an x axis below it
// with its line and tick marks on pixel centers and labels hanging under
// them, y axes beside it with labels only, and titles turned to read along
// the side.
import { describe, expect, it } from "vitest";
import { axisGuide, axisItems } from "../../src/model/axis-guide.ts";
import type { AxisPlacement, SegmentsItem, TextItem } from "../../src/scene/scene.ts";
import { LIGHT } from "../../src/theme.ts";

type AxisSide = AxisPlacement["side"];

const { style } = LIGHT;
const paints = {
  line: style.axisLine,
  tick: style.tick,
  label: style.tickLabel,
  title: style.axisTitle,
};
const placement = (side: AxisSide, edge: number): AxisPlacement => ({
  side,
  edge,
  start: 40,
  end: 240,
  tickLength: 5,
  gap: 8,
  surface: "#ffffff",
  paints,
});
const ticks = [
  { position: 40, label: "0" },
  { position: 140.4, label: "5" },
];
const parts = (side: AxisSide, edge: number, title?: { text: string; x: number; y: number }) => {
  const items = axisItems(placement(side, edge), ticks, title);
  return {
    lines: items.filter((i): i is SegmentsItem => i.type === "segments"),
    texts: items.filter((i): i is TextItem => i.type === "text"),
  };
};

describe("axisItems", () => {
  it("draws a bottom axis' ticks down and labels hanging below them", () => {
    const { lines, texts } = parts("bottom", 210);
    expect(lines[0]!.coords).toEqual([
      40, 210.5, 240, 210.5, 40.5, 210.5, 40.5, 215.5, 140.5, 210.5, 140.5, 215.5,
    ]);
    expect(texts.map((t) => [t.text, t.x, t.y, t.anchor, t.baseline])).toEqual([
      ["0", 40, 218.5, "middle", "hanging"],
      ["5", 140.4, 218.5, "middle", "hanging"],
    ]);
  });

  it("draws left and right axes' labels ending and starting beside the plot, without lines", () => {
    const left = parts("left", 40);
    expect(left.lines).toEqual([]);
    expect(left.texts.map((t) => [t.x, t.y, t.anchor, t.baseline])[0]).toEqual([
      32,
      40,
      "end",
      "middle",
    ]);
    const right = parts("right", 240);
    expect(right.lines).toEqual([]);
    expect(right.texts.map((t) => [t.x, t.anchor])[1]).toEqual([248, "start"]);
  });

  it("turns titles to read up the left side and down the right one", () => {
    const title = { text: "ms", x: 10, y: 140 };
    const angle = (side: AxisSide) =>
      parts(side, 40, title).texts.find((t) => t.text === "ms")!.angle;
    expect([angle("left"), angle("right"), angle("bottom")]).toEqual([-90, 90, 0]);
  });

  it("strokes the line and ticks apart when they look different", () => {
    const thick = { ...style.tick, strokeWidth: 2 };
    const items = axisItems(
      { ...placement("bottom", 210), paints: { ...paints, tick: thick } },
      ticks,
    );
    const lines = items.filter((i): i is SegmentsItem => i.type === "segments");
    expect(lines.map((l) => [l.coords.length, l.paint.strokeWidth])).toEqual([
      [4, 1],
      [8, 2],
    ]);
  });

  it("keeps the placement and ticks on the guide, so transitions can place new ticks the same way", () => {
    const guide = axisGuide("x|0", "x", placement("bottom", 210), ticks, undefined);
    expect(guide).toMatchObject({
      kind: "axis",
      key: "x|0",
      scale: "x",
      side: "bottom",
      edge: 210,
      ticks,
    });
    expect(guide.items).toEqual(axisItems(placement("bottom", 210), ticks));
  });
});
