// Colorbars: a color scale's colors along its values beside or below the
// plots, with rounded ticks, a title, and a format; a contour's bands as
// steps; one for every panel a mark's scale colors.
import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { guideCompiler } from "../../src/guides/compile.ts";
import { colorbar } from "../../src/guides/options.ts";
import { estimateText } from "../../src/layout/text.ts";
import { contour } from "../../src/marks/contour.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { GUIDE_KIT } from "../../src/model/guides.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderSvg } from "../../src/render/svg.ts";
import {
  type ColorbarGuide,
  guidesOf,
  type RampItem,
  type RectItem,
  type Scene,
  type SegmentsItem,
  type TextItem,
} from "../../src/scene/scene.ts";

const guides = guideCompiler(GUIDE_KIT);

function build(config: ChartConfig, width = 640, height = 360) {
  const model = new ChartModel({ locale: "en-US", ...config }, undefined, guides);
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const hosts = Array.from({ length: 12 }, (_, i) => `host ${i % 4}`);
const cells = table({
  hour: Array.from({ length: 12 }, (_, i) => Math.floor(i / 4)),
  host: category(hosts),
  temp: [-8.55, -3, 0, 2, 4, 6, 7, 8.5, 9, 10, 11, 12.3],
});
const map = heatmap(cells, { x: "hour", y: "host", color: "temp", id: "heat" });
const barOf = (scene: Scene) => guidesOf(scene, "colorbar")[0]!;
const labels = (bar: ColorbarGuide) =>
  bar.items.filter((item): item is TextItem => item.type === "text").map((item) => item.text);

describe("colorbars", () => {
  it("stand beside the plot, with rounded ticks inside the domain, in place of the ramp legend", () => {
    const { scene } = build({ marks: [map], guides: [colorbar({ title: "°C" })] });
    expect(guidesOf(scene, "ramp")).toHaveLength(0);
    const bar = barOf(scene);
    const ramp = bar.items.find((item): item is RampItem => item.type === "ramp")!;
    expect(ramp.vertical).toBe(true);
    expect(ramp.height).toBeGreaterThan(ramp.width);
    const plot = scene.panels[0]!.plot;
    expect(ramp.x).toBeGreaterThan(plot.x + plot.width);
    const [title, ...ticks] = labels(bar);
    expect(title).toBe("°C");
    expect(ticks).toEqual(["-5", "0", "5", "10"]);
    // Low values at the bottom.
    const texts = bar.items.filter((item): item is TextItem => item.type === "text").slice(1);
    expect(texts[0]!.y).toBeGreaterThan(texts.at(-1)!.y);
  });

  it("take a tick count and a format, and lie under the plot", () => {
    const { scene } = build({
      marks: [map],
      guides: [colorbar({ place: { side: "bottom" }, ticks: 3, format: { number: ".1f" } })],
    });
    const bar = barOf(scene);
    const ramp = bar.items.find((item): item is RampItem => item.type === "ramp")!;
    expect(ramp.vertical).toBeUndefined();
    expect(ramp.width).toBeGreaterThan(ramp.height);
    expect(labels(bar)).toEqual(["-5.0", "0.0", "5.0", "10.0"]);
    expect(ramp.y).toBeGreaterThan(scene.panels[0]!.plot.y + scene.panels[0]!.plot.height);
  });

  it("put a diverging scale's middle color at its midpoint", () => {
    const diverging = heatmap(cells, { x: "hour", y: "host", color: "temp", colorMidpoint: 0 });
    const { scene } = build({ marks: [diverging], guides: [colorbar()] });
    const ramp = barOf(scene).items.find((item): item is RampItem => item.type === "ramp")!;
    const middle = ramp.offsets[Math.floor(ramp.stops.length / 2)]!;
    expect(middle).toBeCloseTo(8.55 / (8.55 + 12.3), 3);
  });

  it("draw a contour's bands as steps, ticked at their levels", () => {
    const n = 20;
    const x: number[] = [];
    const y: number[] = [];
    const z: number[] = [];
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        x.push(i);
        y.push(j);
        z.push(Math.hypot(i - 10, j - 10));
      }
    const field = table({ x, y, z });
    const { scene } = build({
      marks: [
        contour(field, {
          x: "x",
          y: "y",
          color: "z",
          thresholds: [0, 4, 8, 12, 16],
          variant: "bands",
        }),
      ],
      guides: [colorbar()],
    });
    const bar = barOf(scene);
    const steps = bar.items.filter((item): item is RectItem => item.type === "rect");
    expect(steps).toHaveLength(4);
    expect(new Set(steps.map((s) => s.fill)).size).toBe(4);
    expect(labels(bar)).toEqual(["0", "4", "8", "12", "16"]);
  });

  it("name the scale they show when the chart has several, and refuse what they cannot show", () => {
    const other = heatmap(cells, {
      x: "hour",
      y: "host",
      color: "temp",
      id: "other",
      colorDomain: [0, 1],
    });
    expect(() => build({ marks: [map, other], guides: [colorbar()] })).toThrow(
      'chart guides[0].scale: the chart has 2 color scales; name one, as scale: { mark: "id", channel: "color" }',
    );
    const { scene } = build({
      marks: [map, other],
      guides: [colorbar({ scale: { mark: "other", channel: "color" } })],
    });
    expect(labels(barOf(scene)).at(-1)).toBe("1.0");
    // The other ramp stays in the automatic legend.
    expect(guidesOf(scene, "ramp")).toHaveLength(1);
  });

  it("show the scale marks share, named by any of them", () => {
    const twin = heatmap(cells, { x: "hour", y: "host", color: "temp", id: "twin" });
    const { scene } = build({
      marks: [map, twin],
      guides: [colorbar({ scale: { mark: "twin", channel: "color" } })],
    });
    expect(guidesOf(scene, "colorbar")).toHaveLength(1);
    expect(guidesOf(scene, "ramp")).toHaveLength(0);
  });

  it("draw ticks as axes do: a count, pointing in, without labels, and in layers", () => {
    const counted = build({ marks: [map], guides: [colorbar({ ticks: { count: 3 } })] });
    expect(labels(barOf(counted.scene))).toEqual(["-5", "0", "5", "10"]);
    const { scene } = build({
      marks: [map],
      guides: [
        colorbar({
          tick: { direction: "in", length: 6 },
          labels: false,
          layers: [
            {
              id: "minor",
              ticks: { every: 1 },
              tick: { direction: "in", length: 2 },
              labels: false,
            },
          ],
        }),
      ],
    });
    const bar = barOf(scene);
    expect(labels(bar)).toEqual([]);
    const ramp = bar.items.find((item): item is RampItem => item.type === "ramp")!;
    const marks = bar.items.filter((item): item is SegmentsItem => item.type === "segments");
    const coords = marks.flatMap((m) => [...m.coords]);
    // Inside the bar's right edge, and one a value along it.
    for (let k = 0; k < coords.length; k += 4)
      expect(Math.min(coords[k]!, coords[k + 2]!)).toBeLessThan(ramp.x + ramp.width);
    expect(coords.length / 4).toBeGreaterThan(15);
  });

  it("keep every layer's labels at the ends inside the chart", () => {
    const { scene } = build({
      marks: [map],
      guides: [
        colorbar({
          ticks: { values: [-8.55, 12.3] },
          layers: [
            { id: "big", ticks: { values: [12.3] }, style: { tickLabel: { fontSize: 40 } } },
          ],
        }),
      ],
    });
    for (const label of barOf(scene).items.filter((item): item is TextItem => item.type === "text"))
      expect(label.y - label.paint.lineHeight / 2).toBeGreaterThanOrEqual(0);
  });

  it("keep turned labels lying under the plot inside the chart", () => {
    const { scene } = build({
      marks: [map],
      guides: [
        colorbar({
          place: { side: "bottom", align: "start" },
          format: () => "A very long label for a value",
          labels: { rotation: -45 },
        }),
      ],
    });
    for (const label of barOf(scene).items.filter((item): item is TextItem => item.type === "text"))
      if (label.angle === -45)
        expect(
          label.x - estimateText(label.text, label.paint.css) * Math.SQRT1_2,
        ).toBeGreaterThanOrEqual(0);
  });

  it("draw the labels they kept room for", () => {
    const unit = heatmap(cells, { x: "hour", y: "host", color: "temp", colorDomain: [0, 1] });
    for (const values of [
      [0, 5 / 6, 1],
      [0, 0.5, 1],
    ]) {
      const { scene } = build({
        marks: [unit],
        guides: [
          colorbar({
            length: 180,
            ticks: { values },
            format: (v) => (v > 0 && v < 1 ? "a much longer label in the middle" : "end"),
            labels: { collision: "hide" },
            style: { tickLabel: { fontSize: 20 } },
          }),
        ],
      });
      for (const label of barOf(scene).items.filter(
        (item): item is TextItem => item.type === "text",
      ))
        expect(label.x + estimateText(label.text, label.paint.css)).toBeLessThanOrEqual(640);
    }
  });

  it("keep room at their ends for labels of several lines", () => {
    const { scene } = build({
      marks: [map],
      guides: [
        colorbar({
          place: { side: "right", align: "end" },
          length: 180,
          ticks: { values: [-8.55, 12.3] },
          format: (v) => `${v}\nsecond\nthird`,
          style: { tickLabel: { fontSize: 20 } },
        }),
      ],
    });
    for (const label of barOf(scene).items.filter(
      (item): item is TextItem => item.type === "text",
    )) {
      expect(label.y - label.paint.lineHeight / 2).toBeGreaterThanOrEqual(0);
      expect(label.y + label.paint.lineHeight / 2).toBeLessThanOrEqual(360);
    }
  });

  it("are written to SVG with a gradient up the bar", () => {
    const { scene } = build({ marks: [map], guides: [colorbar()] });
    expect(renderSvg(scene, { idPrefix: "c" })).toContain('x1="0" y1="1" x2="0" y2="0"');
  });
});
