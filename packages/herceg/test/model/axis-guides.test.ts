// Axes the chart's guides list: on other sides, with tick layers, tick
// marks, lines, and labels turned or kept apart.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { guideCompiler } from "../../src/guides/compile.ts";
import { axis } from "../../src/guides/options.ts";
import { estimateText } from "../../src/layout/text.ts";
import { grid } from "../../src/layout.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { facet } from "../../src/model/facet.ts";
import { GUIDE_KIT } from "../../src/model/guides.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderSvg } from "../../src/render/svg.ts";
import type { AxisGuide, Scene, SegmentsItem, TextItem } from "../../src/scene/scene.ts";

const guides = guideCompiler(GUIDE_KIT);
const HOUR = 3_600_000;
const start = Date.UTC(2026, 8, 28);
const week = table({
  t: time(Array.from({ length: 49 }, (_, i) => start + i * HOUR)),
  v: Array.from({ length: 49 }, (_, i) => 50 + 40 * Math.sin(i / 5)),
});

function build(config: ChartConfig, width = 800, height = 320) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config }, undefined, guides);
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const marks = [line(week, { x: "t", y: "v" })];
const axesOf = (scene: Scene) => scene.panels[0]!.axes;
const sideOf = (scene: Scene, side: AxisGuide["side"]) =>
  axesOf(scene).find((a) => a.side === side);
const texts = (guide: AxisGuide | undefined) =>
  (guide?.items ?? []).filter((item): item is TextItem => item.type === "text");
const segments = (guide: AxisGuide | undefined) =>
  (guide?.items ?? []).filter((item): item is SegmentsItem => item.type === "segments");

describe("listed axes on the default side", () => {
  it("draw as the automatic axes when they ask for nothing more", () => {
    const plain = build({ marks });
    const listed = build({ marks, guides: [axis({ scale: "x" }), axis({ scale: "y" })] });
    expect(renderSvg(listed.scene, { idPrefix: "a" })).toBe(
      renderSvg(plain.scene, { idPrefix: "a" }),
    );
  });

  it("take the short form's settings, and give theirs to the scale's axis", () => {
    const { scene } = build({
      marks,
      x: { title: "Time" },
      guides: [axis({ scale: "x", format: { time: "%H" } })],
    });
    const bottom = sideOf(scene, "bottom")!;
    expect(bottom.title?.text).toBe("Time");
    expect(bottom.ticks[0]!.label).toMatch(/^\d\d$/);
  });

  it("hide the automatic axis of a scale whose axes are all elsewhere", () => {
    const { scene } = build({ marks, guides: [axis({ scale: "x", place: { side: "top" } })] });
    expect(sideOf(scene, "bottom")).toBeUndefined();
    expect(sideOf(scene, "top")).toBeDefined();
    // Grid lines stay with the scale.
    expect(scene.panels[0]!.grid.y.length).toBeGreaterThan(0);
  });
});

describe("axes on other sides", () => {
  it("put an x axis above the plot, in room taken from it", () => {
    const plain = build({ marks });
    const { scene } = build({
      marks,
      guides: [axis({ scale: "x" }), axis({ scale: "x", place: { side: "top" }, title: "Hours" })],
    });
    const plot = scene.panels[0]!.plot;
    expect(plot.y).toBeGreaterThan(plain.scene.panels[0]!.plot.y + 10);
    const top = sideOf(scene, "top")!;
    expect(top.edge).toBe(plot.y);
    for (const label of texts(top)) expect(label.y).toBeLessThan(plot.y);
    expect(texts(top).at(-1)!.text).toBe("Hours");
  });

  it("put the y scale's labels on the right too", () => {
    const plain = build({ marks });
    const { scene } = build({
      marks,
      guides: [axis({ scale: "y" }), axis({ scale: "y", place: { side: "right" } })],
    });
    const plot = scene.panels[0]!.plot;
    const right = sideOf(scene, "right")!;
    expect(right.scale).toBe("y");
    expect(texts(right).map((t) => t.text)).toEqual(
      sideOf(scene, "left")!.ticks.map((t) => t.label),
    );
    for (const label of texts(right)) expect(label.x).toBeGreaterThan(plot.x + plot.width);
    expect(plot.width).toBeLessThan(plain.scene.panels[0]!.plot.width);
  });

  it("move the only y axis to the right", () => {
    const { scene } = build({ marks, guides: [axis({ scale: "y", place: { side: "right" } })] });
    expect(sideOf(scene, "left")).toBeUndefined();
    const right = sideOf(scene, "right")!;
    expect(texts(right).length).toBeGreaterThan(2);
    const plot = scene.panels[0]!.plot;
    for (const label of texts(right)) expect(label.x).toBeGreaterThan(plot.x + plot.width);
  });

  it("draw the grid of a scale whose axes are all elsewhere as the first of them says", () => {
    const data = table({ x: [0, 1], v: [0, 10] });
    const moved = (grid: boolean) =>
      build({
        marks: [line(data, { x: "x", y: "v" })],
        y: { nice: false },
        guides: [axis({ scale: "y", place: { side: "right" }, ticks: { values: [2, 8] }, grid })],
      }).scene.panels[0]!;
    expect(moved(false).grid.y).toEqual([]);
    const lines = moved(true);
    expect(lines.grid.y).toHaveLength(2);
    expect(texts(lines.axes.find((a) => a.side === "right")).map((t) => t.text)).toEqual([
      "2",
      "8",
    ]);
    // Planned once: the axis' ticks are the grid's, whatever its format leaves out.
    const unit = build({
      marks: [line(table({ x: [0, 1], v: [0, 1] }), { x: "x", y: "v" })],
      y: { nice: false },
      guides: [
        axis({
          scale: "y",
          place: { side: "right" },
          ticks: 5,
          format: { maximumFractionDigits: 0 },
          grid: true,
        }),
      ],
    }).scene.panels[0]!;
    const right = unit.axes.find((a) => a.side === "right")!;
    expect(unit.grid.y).toEqual(right.ticks.map((t) => t.position));
    // Moved, it leaves out repeated labels as its layers do.
    expect(right.ticks.map((t) => t.label)).toEqual(["0", "1"]);
  });

  it("take subplots' own titles to the side an axis moves to", () => {
    const { scene } = build(
      {
        panels: panels(
          [
            { id: "a", y: { title: "First" } },
            { id: "b", y: { title: "Second" } },
          ],
          grid({ columns: 1 }),
        ),
        marks: ["a", "b"].map((panel) => line(week, { x: "t", y: "v", panel })),
        guides: [axis({ scale: "y", place: { side: "right" } })],
      },
      640,
      480,
    );
    const titles = scene.panels.map(
      (panel) => texts(panel.axes.find((a) => a.side === "right")).at(-1)!.text,
    );
    expect(titles).toEqual(["First", "Second"]);
  });

  it("leave out of a moved axis the subplots that hide it", () => {
    const { scene } = build(
      {
        panels: panels([{ id: "a", y: { show: false } }, { id: "b" }], grid({ columns: 1 })),
        marks: ["a", "b"].map((panel) => line(week, { x: "t", y: "v", panel })),
        guides: [axis({ scale: "y", place: { side: "right" } })],
      },
      640,
      480,
    );
    expect(scene.panels.map((panel) => panel.axes.some((a) => a.side === "right"))).toEqual([
      false,
      true,
    ]);
  });

  it("refuse a subplot showing an axis moved elsewhere on its default side", () => {
    expect(() =>
      build({
        panels: panels([{ id: "a", x: { show: true } }, { id: "b" }], grid({ columns: 2 })),
        marks: ["a", "b"].map((panel) => line(week, { x: "t", y: "v", panel })),
        guides: [axis({ scale: "x", place: { side: "top" } })],
      }),
    ).toThrow(
      "chart panels[0].x.show: the guides list x's axes elsewhere, which hides its axis on the bottom; drop show, or list an axis on the bottom",
    );
  });

  it("draw a moved axis in each subplot's own styles", () => {
    const { scene } = build(
      {
        panels: panels(
          [
            { id: "a", y: { style: { tickLabel: { color: "#cc0000" } } } },
            { id: "b", y: { style: { tickLabel: { color: "#00cc00" } } } },
          ],
          grid({ columns: 1 }),
        ),
        marks: ["a", "b"].map((panel) => line(week, { x: "t", y: "v", panel })),
        y: { style: { tickLabel: { color: "#0000cc" } } },
        guides: [axis({ scale: "y", place: { side: "right" } })],
      },
      640,
      480,
    );
    const colors = scene.panels.map(
      (panel) => texts(panel.axes.find((a) => a.side === "right"))[0]!.paint.color,
    );
    expect(colors).toEqual(["#cc0000", "#00cc00"]);
  });

  it("keep turned labels of a reversed axis apart", () => {
    const data = table({ x: [0, 10], v: [0, 1] });
    const { scene } = build({
      marks: [line(data, { x: "x", y: "v" })],
      x: { domain: [10, 0] },
      guides: [
        axis({
          scale: "x",
          place: { side: "top" },
          ticks: { values: [4, 5] },
          format: (v) => (v === 4 ? "a" : "a much longer label for five"),
          labels: { rotation: -5, collision: "hide" },
        }),
      ],
    });
    expect(texts(sideOf(scene, "top")).length).toBe(1);
  });

  it("take the scale's title to the side an axis moves to", () => {
    const { scene } = build({
      marks,
      y: { title: "Value" },
      x: { title: "Time" },
      guides: [
        axis({ scale: "y", place: { side: "right" } }),
        axis({ scale: "x", place: { side: "top" } }),
      ],
    });
    expect(texts(sideOf(scene, "right")).at(-1)!.text).toBe("Value");
    expect(texts(sideOf(scene, "top")).at(-1)!.text).toBe("Time");
    expect(sideOf(scene, "left")).toBeUndefined();
    expect(sideOf(scene, "bottom")).toBeUndefined();
  });

  it("keep a scale's axis hidden where its short form hides it", () => {
    for (const place of [undefined, { side: "right" as const }]) {
      const { scene } = build({
        marks,
        y: { show: false },
        guides: [axis({ scale: "y", ...(place && { place }) })],
      });
      expect(sideOf(scene, "left")).toBeUndefined();
      expect(sideOf(scene, "right")).toBeUndefined();
    }
  });

  it("leave out axes elsewhere that are not shown, and their room", () => {
    const plain = build({ marks });
    const { scene } = build({
      marks,
      guides: [axis({ scale: "x" }), axis({ scale: "x", place: { side: "top" }, show: false })],
    });
    expect(sideOf(scene, "top")).toBeUndefined();
    expect(scene.panels[0]!.plot).toEqual(plain.scene.panels[0]!.plot);
  });

  it("put a y axis on the right beside each subplot with a y scale of its own, or a row's last", () => {
    const right = (y?: ChartConfig["y"]) =>
      build({
        panels: panels([{ id: "a" }, { id: "b" }], grid({ columns: 2 })),
        marks: ["a", "b"].map((panel) => line(week, { x: "t", y: "v", panel })),
        guides: [axis({ scale: "y", place: { side: "right" } })],
        ...(y && { y }),
      }).scene.panels.map((panel) => panel.axes.some((a) => a.side === "right"));
    expect(right()).toEqual([true, true]);
    expect(right({ scope: "row" })).toEqual([false, true]);
    // Facet rows put it beside their last panel only, so they must share y.
    expect(() =>
      build({
        marks: [
          line(table({ t: [0, 1, 0, 1], v: [1, 2, 3, 4], g: ["a", "a", "b", "b"] }), {
            x: "t",
            y: "v",
          }),
        ],
        facet: facet("g", { columns: 2 }),
        y: { scope: "panel" },
        guides: [axis({ scale: "y", place: { side: "right" } })],
      }),
    ).toThrow(
      'chart guides[0].place.side: a y axis on the right stands beside each row\'s last panel, so the panels of a row must share y; give y scope "row" or "chart", repeat "all" for one beside every panel, or keep the axis on the left',
    );
  });

  it("refuse sides an axis cannot take", () => {
    expect(() => build({ marks, guides: [axis({ scale: "x", place: { side: "left" } })] })).toThrow(
      'chart guides[0].place.side: x axes go on the "top" or the "bottom"; received "left"',
    );
    expect(() => build({ marks, guides: [axis({ scale: "x" }), axis({ scale: "x" })] })).toThrow(
      'chart guides[1].place.side: scale x has an axis on the bottom already; give this one "top"',
    );
    expect(() =>
      build({
        marks: [...marks, line(week, { x: "t", y: "v", axis: "right" })],
        guides: [axis({ scale: "y", place: { side: "right" } })],
      }),
    ).toThrow(/marks with axis: "right" put yRight's axis on the right/);
  });
});

describe("tick layers", () => {
  it("draw a row of day boundaries under hourly labels", () => {
    const plain = build({ marks, x: { ticks: { every: "6 hours" }, format: { time: "%H:%M" } } });
    const { scene } = build({
      marks,
      x: { ticks: { every: "6 hours" }, format: { time: "%H:%M" } },
      guides: [
        axis({
          scale: "x",
          layers: [
            {
              id: "day",
              ticks: { every: "day" },
              format: { time: "%b %-d" },
              tick: { length: 12 },
              labels: { row: 1 },
            },
          ],
        }),
      ],
    });
    const bottom = sideOf(scene, "bottom")!;
    const labels = texts(bottom);
    const hours = labels.filter((t) => /:/.test(t.text));
    const days = labels.filter((t) => /^Sep/.test(t.text));
    expect(days.map((t) => t.text)).toEqual(["Sep 28", "Sep 29", "Sep 30"]);
    expect(days[0]!.y).toBeGreaterThan(hours[0]!.y + 8);
    // The plot gives the second row its room.
    expect(scene.panels[0]!.plot.height).toBeLessThan(plain.scene.panels[0]!.plot.height);
    // Day ticks reach further than hourly ones, drawn once where both fall.
    const coords = segments(bottom).flatMap((s) => [...s.coords]);
    const lengths = new Map<number, number>();
    for (let k = 0; k + 3 < coords.length; k += 4)
      if (coords[k] === coords[k + 2]) lengths.set(coords[k]!, coords[k + 3]! - coords[k + 1]!);
    expect(Math.max(...lengths.values())).toBe(12);
    expect(Math.min(...lengths.values())).toBe(5);
  });

  it("let a layer of higher priority label a row where labels would meet", () => {
    const { scene } = build({
      marks,
      x: { ticks: { every: "6 hours" }, format: { time: "%H:%M" } },
      guides: [
        axis({
          scale: "x",
          layers: [
            {
              id: "day",
              ticks: { every: "day" },
              format: { time: "%b %-d" },
              labels: { priority: 1 },
            },
          ],
        }),
      ],
    });
    const labels = texts(sideOf(scene, "bottom")).map((t) => t.text);
    // At midnight the date, not the hour.
    expect(labels).toContain("Sep 29");
    expect(labels.filter((label) => label === "00:00")).toHaveLength(0);
    expect(labels).toContain("06:00");
  });

  it("plan a layer about its own count of ticks", () => {
    const data = table({ x: [0, 100], v: [0, 1] });
    const { model } = build({
      marks: [line(data, { x: "x", y: "v" })],
      guides: [axis({ scale: "x", ticks: 2, layers: [{ id: "minor", ticks: 20, labels: false }] })],
    });
    expect(model.panels()[0]!.plans.x.ticks).toEqual([0, 50, 100]);
    const bottom = sideOf(model.scene(estimateText), "bottom")!;
    const marked = new Set(segments(bottom).flatMap((s) => s.coords.filter((_, k) => k % 4 === 0)));
    expect(marked.size).toBeGreaterThan(15);
  });

  it("draw a layer's labels in its own style: halo and box too", () => {
    const { scene } = build({
      marks,
      guides: [
        axis({
          scale: "x",
          layers: [
            {
              id: "day",
              ticks: { every: "day" },
              format: { time: "%b %-d" },
              labels: { row: 1 },
              style: {
                tickLabel: {
                  color: "#aa0000",
                  halo: { color: "#ffffff", width: 2 },
                  background: { fill: "#eeeeee" },
                  padding: 2,
                },
              },
            },
          ],
        }),
      ],
    });
    // The automatic labels write the day at midnight too; the layer's are in the row below.
    const day = texts(sideOf(scene, "bottom"))
      .filter((t) => t.text === "Sep 29")
      .sort((a, b) => b.y - a.y)[0]!;
    expect(day.paint.color).toBe("#aa0000");
    expect(day.halo).toMatchObject({ color: "#ffffff", width: 2 });
    expect(day.box).toBeDefined();
  });

  it("keep room on y for layers' labels wider than the axis' own", () => {
    const plain = build({ marks });
    const { scene } = build({
      marks,
      guides: [
        axis({
          scale: "y",
          layers: [{ id: "mid", ticks: { values: [50] }, format: { number: ".4f" } }],
        }),
      ],
    });
    const left = sideOf(scene, "left")!;
    const mid = texts(left).find((t) => t.text === "50.0000")!;
    const width = estimateText(mid.text, mid.paint.css);
    // Labels end at the axis' gap; the widest starts inside the chart.
    expect(mid.x - width).toBeGreaterThanOrEqual(0);
    expect(scene.panels[0]!.plot.x).toBeGreaterThan(plain.scene.panels[0]!.plot.x);
  });

  it("draw minor ticks without labels", () => {
    const { scene } = build({
      marks,
      guides: [axis({ scale: "y", layers: [{ id: "minor", ticks: { every: 5 }, labels: false }] })],
    });
    const left = sideOf(scene, "left")!;
    expect(segments(left).length).toBeGreaterThan(0);
    expect(texts(left).length).toBe(left.ticks.length);
  });
});

describe("tick marks and lines", () => {
  it("point tick marks into the plot", () => {
    const { scene } = build({
      marks,
      guides: [axis({ scale: "x", tick: { direction: "in", length: 6 } })],
    });
    const bottom = sideOf(scene, "bottom")!;
    const edge = Math.round(bottom.edge) + 0.5;
    const coords = [...segments(bottom)[0]!.coords];
    // After the axis line, each tick runs from 6 pixels up to the line.
    expect(coords[5]).toBe(edge - 6);
    expect(coords[7]).toBe(edge);
  });

  it("draw a y axis' line when asked, in its own style", () => {
    const { scene } = build({
      marks,
      y: { style: { axisLine: { stroke: "#246" }, tickLabel: { color: "#246" } } },
      guides: [axis({ scale: "y", line: true })],
    });
    const left = sideOf(scene, "left")!;
    const [stroke] = segments(left);
    expect(stroke!.paint.stroke).toBe("#246");
    expect(stroke!.coords[0]).toBe(stroke!.coords[2]);
    expect(texts(left)[0]!.paint.color).toBe("#246");
  });
});

describe("tick labels", () => {
  const names = table({
    name: ["Northern Hemisphere", "Southern Hemisphere", "Equatorial Belt", "Polar Regions"],
    v: [3, 5, 2, 4],
  });

  it("turn labels and keep room for them", () => {
    const plain = build({ marks: [bar(names, { x: "name", y: "v" })] }, 300);
    const { scene } = build(
      {
        marks: [bar(names, { x: "name", y: "v" })],
        guides: [axis({ scale: "x", labels: { rotation: -45 } })],
      },
      300,
    );
    const labels = texts(sideOf(scene, "bottom"));
    expect(labels.length).toBe(4);
    for (const label of labels) {
      expect(label.angle).toBe(-45);
      expect(label.anchor).toBe("end");
    }
    expect(scene.panels[0]!.plot.height).toBeLessThan(plain.scene.panels[0]!.plot.height - 20);
  });

  it("choose the first rotation at which labels fit", () => {
    const { scene } = build(
      {
        marks: [bar(names, { x: "name", y: "v" })],
        guides: [axis({ scale: "x", labels: { rotation: { candidates: [0, -30, -90] } } })],
      },
      300,
    );
    expect(texts(sideOf(scene, "bottom"))[0]!.angle).not.toBe(0);
  });

  it("keep room for labels turned in each panel's own width", () => {
    // Labels that fit flat in a third of the chart, not in a panel's plot.
    const regions = table({
      name: ["Northwest", "Northeast", "Southwest", "Southeast"],
      v: [3, 5, 2, 4],
    });
    const ids = ["a", "b", "c"];
    const { scene } = build(
      {
        panels: panels(
          ids.map((id) => ({ id })),
          grid({ columns: 3 }),
        ),
        marks: ids.map((panel) => bar(regions, { x: "name", y: "v", panel })),
        guides: [axis({ scale: "x", labels: { rotation: { candidates: [0, -90] } } })],
      },
      780,
      300,
    );
    for (const panel of scene.panels)
      for (const label of texts(panel.axes.find((a) => a.side === "bottom"))) {
        expect(label.angle).toBe(-90);
        // Turned a quarter, a label ends at its tick and runs down from it.
        expect(label.y + estimateText(label.text, label.paint.css)).toBeLessThanOrEqual(300);
      }
  });

  it("keep room for turned labels as zooming lengthens them", () => {
    const data = table({ x: [0, 1000], v: [0, 1] });
    const { model } = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        x: { format: { number: ",.4f" } },
        guides: [axis({ scale: "x", labels: { rotation: { candidates: [0, -90] } } })],
      },
      650,
      320,
    );
    for (const view of [
      [0, 1000],
      [0, 10],
      [100, 100.5],
      [5000, 905000],
    ] as const) {
      model.setViewport([view[0], view[1]]);
      const scene = model.scene(estimateText);
      for (const label of texts(sideOf(scene, "bottom")))
        if (label.angle === -90)
          expect(label.y + estimateText(label.text, label.paint.css)).toBeLessThanOrEqual(320);
    }
  });

  it("turn labels above the plot away from it", () => {
    const { scene } = build(
      {
        marks: [bar(names, { x: "name", y: "v" })],
        guides: [axis({ scale: "x", place: { side: "top" }, labels: { rotation: -90 } })],
      },
      300,
      400,
    );
    const plot = scene.panels[0]!.plot;
    for (const label of texts(sideOf(scene, "top"))) {
      expect(label.anchor).toBe("start");
      // Turned a quarter and starting at its tick, a label runs up from it.
      expect(label.y).toBeLessThanOrEqual(plot.y);
      expect(label.y - estimateText(label.text, label.paint.css)).toBeGreaterThanOrEqual(0);
    }
  });

  it("stagger the labels they keep, every other one a lane further out", () => {
    const data = table({ x: [0, 100], v: [0, 1] });
    const { scene } = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        guides: [
          axis({
            scale: "x",
            ticks: { every: 1 },
            format: { number: ".1f" },
            labels: { collision: "stagger" },
          }),
        ],
      },
      400,
    );
    const shown = texts(sideOf(scene, "bottom")).sort((a, b) => a.x - b.x);
    expect(shown.length).toBeGreaterThan(4);
    for (let k = 1; k < shown.length; k++) expect(shown[k]!.y).not.toBe(shown[k - 1]!.y);
  });

  it("measure and align a title above the plot in its own style", () => {
    const { scene } = build({
      marks,
      guides: [
        axis({ scale: "x" }),
        axis({
          scale: "x",
          place: { side: "top" },
          title: "Hours",
          style: { axisTitle: { fontSize: 40, align: "start" } },
        }),
      ],
    });
    const top = sideOf(scene, "top")!;
    const title = texts(top).at(-1)!;
    expect(title.text).toBe("Hours");
    expect(title.anchor).toBe("start");
    expect(title.x).toBe(scene.panels[0]!.plot.x);
    // The whole title clears the labels, which clear the plot.
    const lowestLabel = Math.min(
      ...texts(top)
        .slice(0, -1)
        .map((t) => t.y),
    );
    expect(title.y + title.paint.lineHeight / 2).toBeLessThanOrEqual(lowestLabel);
    expect(title.y - title.paint.lineHeight / 2).toBeGreaterThanOrEqual(0);
  });

  it("keep labels on y one above the other unless their lines meet", () => {
    const data = table({ x: [0, 1], v: [0, 100] });
    const { scene } = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        y: { title: "Load" },
        guides: [
          axis({
            scale: "y",
            ticks: { every: 10 },
            format: { number: ",.3f" },
            labels: { collision: "hide" },
          }),
        ],
      },
      400,
      400,
    );
    const left = sideOf(scene, "left")!;
    // Eleven wide labels about 30 pixels apart all fit one above the other.
    expect(left.ticks.filter((t) => t.label).length).toBe(11);
  });

  it("keep room for turned labels' boxes, padding and all", () => {
    const data = table({ x: [0, 1], v: [0, 1] });
    for (const side of ["bottom", "top"] as const) {
      const { scene } = build(
        {
          marks: [line(data, { x: "x", y: "v" })],
          guides: [
            axis({
              scale: "x",
              place: { side },
              format: () => "X",
              labels: { rotation: -45 },
              style: {
                tickLabel: { background: { fill: "#eeeeee" }, padding: { left: 10, right: 10 } },
              },
            }),
          ],
        },
        640,
        320,
      );
      for (const label of texts(sideOf(scene, side))) {
        // The box's corners, turned about the text's point as renderers turn them.
        const { x, y, width, height } = label.box!;
        const turn = (label.angle * Math.PI) / 180;
        const ys = [x, x + width].flatMap((cx) =>
          [y, y + height].map(
            (cy) => label.y + (cx - label.x) * Math.sin(turn) + (cy - label.y) * Math.cos(turn),
          ),
        );
        expect(Math.max(...ys)).toBeLessThanOrEqual(320);
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("keep labels above the plot inside the chart's sides, and their boxes off the plot", () => {
    const data = table({ x: [0, 10], v: [0, 1] });
    const turnedAbove = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        guides: [
          axis({
            scale: "x",
            place: { side: "top" },
            ticks: { values: [0, 10] },
            format: () => "A very long label for a value",
            labels: { rotation: -45 },
          }),
        ],
      },
      640,
    ).scene;
    for (const label of texts(sideOf(turnedAbove, "top"))) {
      const reach = estimateText(label.text, label.paint.css) * Math.SQRT1_2;
      expect(label.x + reach).toBeLessThanOrEqual(640);
    }
    const boxed = build({
      marks: [line(data, { x: "x", y: "v" })],
      guides: [
        axis({ scale: "x" }),
        axis({
          scale: "x",
          place: { side: "top" },
          style: {
            tickLabel: { background: { fill: "#eeeeee" }, padding: { top: 20, bottom: 20 } },
          },
        }),
      ],
    }).scene;
    const plot = boxed.panels[0]!.plot;
    for (const label of texts(sideOf(boxed, "top")))
      expect(label.box!.y + label.box!.height).toBeLessThanOrEqual(plot.y);
  });

  it("keep each panel's turned labels inside the chart, whatever the panel above draws", () => {
    const data = table({ x: [0, 10], v: [0, 1] });
    const long = () => "A very long label for a value";
    for (const config of [
      {
        panels: panels([{ id: "a" }, { id: "b" }], grid({ columns: 1 })),
        marks: ["a", "b"].map((panel) => line(data, { x: "x", y: "v", panel })),
        guides: [
          axis({ scale: "x", ticks: { values: [0, 10] }, format: long, labels: { rotation: -45 } }),
        ],
      },
      {
        marks: [line(data, { x: "x", y: "v" })],
        guides: [
          axis({
            scale: "x",
            ticks: { values: [] },
            layers: [
              { id: "ends", ticks: { values: [0, 10] }, format: long, labels: { rotation: -45 } },
            ],
          }),
        ],
      },
    ] as ChartConfig[]) {
      const { scene } = build(config, 640, 400);
      for (const panel of scene.panels)
        for (const label of texts(panel.axes.find((a) => a.side === "bottom")))
          expect(
            label.x - estimateText(label.text, label.paint.css) * Math.SQRT1_2,
          ).toBeGreaterThanOrEqual(0);
    }
  });

  it("put wrapped labels above the plot as a block", () => {
    const data = table({ x: [0, 2], v: [0, 1] });
    const { scene } = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        guides: [
          axis({
            scale: "x",
            place: { side: "top" },
            ticks: { values: [0, 1, 2] },
            format: (v) => `${v} one two three four five`,
            labels: { collision: "wrap" },
          }),
        ],
      },
      300,
    );
    const plot = scene.panels[0]!.plot;
    const lines = texts(sideOf(scene, "top"));
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines)
      expect(line.y + line.paint.lineHeight / 2).toBeLessThanOrEqual(plot.y);
  });

  it("keep y labels apart where the chart's edges move them", () => {
    const data = table({ x: [0, 1], v: [0, 1] });
    const { scene } = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        y: { nice: false },
        guides: [
          axis({
            scale: "y",
            layers: [
              {
                id: "big",
                ticks: { values: [0.6, 1] },
                labels: { collision: "hide" },
                style: { tickLabel: { fontSize: 80 } },
              },
            ],
          }),
        ],
      },
      640,
      320,
    );
    const big = texts(sideOf(scene, "left")).filter((t) => t.paint.size === 80);
    for (let k = 1; k < big.length; k++)
      expect(Math.abs(big[k]!.y - big[k - 1]!.y)).toBeGreaterThanOrEqual(big[k]!.paint.lineHeight);
  });

  it("keep labels of several lines along y apart and inside the chart", () => {
    const data = table({ x: [0, 1], v: [0, 1] });
    const { scene } = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        y: { nice: false },
        guides: [
          axis({
            scale: "y",
            ticks: { values: [0, 0.12, 1] },
            format: (v) => `${v}\nsecond\nthird`,
            labels: { collision: "hide" },
            style: { tickLabel: { fontSize: 20 } },
          }),
        ],
      },
      640,
      320,
    );
    const lines = texts(sideOf(scene, "left"));
    const height = lines[0]!.paint.lineHeight;
    for (const line of lines) {
      expect(line.y - height / 2).toBeGreaterThanOrEqual(0);
      expect(line.y + height / 2).toBeLessThanOrEqual(320);
    }
    // Two blocks of three lines, not three overlapping ones.
    expect(lines).toHaveLength(6);
    // Blocks of different heights meet by both halves.
    const mixed = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        y: { nice: false },
        guides: [
          axis({
            scale: "y",
            ticks: { values: [0.5, 0.62] },
            format: (v) => (v === 0.5 ? "one" : "one\ntwo\nthree"),
            labels: { collision: "hide" },
            style: { tickLabel: { fontSize: 20 } },
          }),
        ],
      },
      640,
      320,
    ).scene;
    expect(texts(sideOf(mixed, "left")).length).toBeLessThan(4);
  });

  it("write labels that may turn on one line", () => {
    const data = table({ x: [0, 1], v: [0, 1] });
    const { scene } = build({
      marks: [line(data, { x: "x", y: "v" })],
      guides: [axis({ scale: "x", format: (v) => `${v}\none`, labels: { rotation: -45 } })],
    });
    for (const label of texts(sideOf(scene, "bottom"))) expect(label.text).not.toContain("\n");
    expect(texts(sideOf(scene, "bottom"))[0]!.text).toMatch(/ one$/);
  });

  it("refuse turns beyond a quarter", () => {
    expect(() =>
      build({ marks, guides: [axis({ scale: "x", labels: { rotation: 270 } })] }),
    ).toThrow(
      "chart guides[0].labels.rotation: 270 degrees is beyond a quarter turn; give degrees from -90 (reading up) to 90 (reading down)",
    );
  });

  it("refuse wrapping turned labels", () => {
    expect(() =>
      build({
        marks,
        guides: [axis({ scale: "x", labels: { collision: "wrap", rotation: -45 } })],
      }),
    ).toThrow(
      'chart guides[0].labels.collision: "wrap" breaks labels that lie flat; drop rotation, or keep turned labels apart with "hide" or "stagger"',
    );
  });

  it("keep a layer's taller labels at the plot's ends inside the chart", () => {
    const data = table({ x: [0, 1], v: [0, 1] });
    const { scene } = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        guides: [
          axis({
            scale: "y",
            layers: [
              { id: "ends", ticks: { values: [0, 1] }, style: { tickLabel: { fontSize: 80 } } },
            ],
          }),
        ],
      },
      640,
      320,
    );
    for (const label of texts(sideOf(scene, "left"))) {
      const half = label.paint.lineHeight / 2;
      expect(label.y - half).toBeGreaterThanOrEqual(0);
      expect(label.y + half).toBeLessThanOrEqual(320);
    }
  });

  it("choose a turn by the labels drawn, not the blank ticks between them", () => {
    const data = table({ x: [0, 4], v: [0, 1] });
    const { scene } = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        guides: [
          axis({
            scale: "x",
            ticks: { values: [0, 1, 2, 3, 4] },
            format: (v) => (v % 2 ? "" : "A rather long label for the tick, and longer"),
            labels: { rotation: { candidates: [0, -90] } },
          }),
        ],
      },
      400,
    );
    expect(texts(sideOf(scene, "bottom")).every((t) => t.angle === -90)).toBe(true);
  });

  it("keep a label of lower priority out from under one of another size", () => {
    const { scene } = build({
      marks,
      x: { ticks: { every: "6 hours" }, format: { time: "%H:%M" } },
      guides: [
        axis({
          scale: "x",
          style: { tickLabel: { fontSize: 48 } },
          layers: [
            {
              id: "day",
              ticks: { every: "day" },
              format: { time: "%d" },
              labels: { priority: 1 },
              style: { tickLabel: { fontSize: 10 } },
            },
          ],
        }),
      ],
    });
    const labels = texts(sideOf(scene, "bottom"));
    const days = labels.filter((t) => t.paint.size === 10);
    const hours = labels.filter((t) => t.paint.size === 48);
    expect(days.length).toBeGreaterThan(0);
    // No hour label's box meets a day's.
    for (const day of days)
      for (const hour of hours) {
        const half = estimateText(hour.text, hour.paint.css) / 2;
        expect(Math.abs(hour.x - day.x)).toBeGreaterThan(half);
      }
  });

  it("keep labels' boxes apart, padding and all", () => {
    const data = table({ x: [0, 1], v: [0, 100] });
    const { scene } = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        guides: [
          axis({
            scale: "y",
            ticks: { every: 10 },
            labels: { collision: "hide" },
            style: { tickLabel: { background: { fill: "#eeeeee" }, padding: 10 } },
          }),
        ],
      },
      400,
      400,
    );
    const kept = sideOf(scene, "left")!.ticks.filter((t) => t.label);
    const tall = texts(sideOf(scene, "left"))[0]!.paint.lineHeight + 20;
    for (let k = 1; k < kept.length; k++)
      expect(Math.abs(kept[k]!.position - kept[k - 1]!.position)).toBeGreaterThanOrEqual(tall);
  });

  it("hide labels that would overlap, every n-th kept", () => {
    const data = table({ x: [0, 100], v: [0, 1] });
    const { scene } = build(
      {
        marks: [line(data, { x: "x", y: "v" })],
        guides: [axis({ scale: "x", ticks: { every: 1 }, labels: { collision: "hide" } })],
      },
      400,
    );
    const bottom = sideOf(scene, "bottom")!;
    const shown = bottom.ticks.filter((t) => t.label);
    expect(shown.length).toBeLessThan(bottom.ticks.length / 2);
    expect(shown.length).toBeGreaterThan(2);
  });
});
