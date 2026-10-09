// Scenes drawn while a change of view plays.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { line } from "../../src/marks/line.ts";
import { ChartModel } from "../../src/model/model.ts";

const data = table({ t: [0, 1, 2, 3], v: [1, 2, 3, 4] });

function model(width: number) {
  const chart = new ChartModel({ marks: [line(data, { x: "t", y: "v" })], locale: "en-US" });
  chart.setSize(width, 300, 1);
  chart.scene(estimateText);
  return chart;
}

describe("transition domains", () => {
  it("draw as given, without rounding, and leave the viewports alone", () => {
    const chart = model(600);
    chart.setTransitionDomains({ x: [0.5, 2.5], y: [1.25, 3.75], yRight: null });
    chart.scene(estimateText);
    const [panel] = chart.panels();
    expect(panel!.x.domain).toEqual([0.5, 2.5]);
    expect(panel!.y.domain).toEqual([1.25, 3.75]);
    expect(chart.viewport).toBeNull();
    expect(chart.yViewport).toEqual({ y: null, yRight: null });
  });

  it("keep no margins from passing tick labels, even across a resize", () => {
    const chart = model(600);
    // Wide labels pass while the view moves, and the chart is resized meanwhile.
    chart.setTransitionDomains({ x: [0, 3], y: [0, 123_456_789], yRight: null });
    chart.scene(estimateText);
    chart.setSize(500, 300, 1);
    chart.scene(estimateText);
    chart.setTransitionDomains(null);
    chart.scene(estimateText);
    expect(chart.panels()[0]!.plot).toEqual(model(500).panels()[0]!.plot);
  });
});
