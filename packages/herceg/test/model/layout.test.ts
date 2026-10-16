// Layout: padding, titles and legends on the chart's sides or inside a
// plot, aligned, and role styles reaching the guides that draw them.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { insideAt } from "../../src/layout/place.ts";
import { estimateText } from "../../src/layout/text.ts";
import { grid } from "../../src/layout.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { AxisGuide, Panel, Rect, Scene, TextItem } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { headersOf, legendOf, titleOf } from "../helpers/guides.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const metrics = table({
  t: time([0, 3_600_000, 7_200_000, 10_800_000]),
  a: [3, 5, 4, 6],
  b: [1, 2, 3, 2],
});
const two = [line(metrics, { x: "t", y: "a" }), line(metrics, { x: "t", y: "b" })];
const plotOf = (scene: Scene) => scene.panels[0]!.plot;
const axis = (panel: Panel, side: AxisGuide["side"]) => panel.axes.find((a) => a.side === side);
const texts = (scene: Scene) =>
  scene.guides.flatMap((g) => g.items).filter((i): i is TextItem => i.type === "text");

describe("padding", () => {
  it("is automatic when left out, as charts have always been spaced", () => {
    const { scene } = build({ marks: [line(metrics, { x: "t", y: "a" })] });
    const plot = plotOf(scene);
    // A few pixels at the top for the top y label, more at the left for the labels.
    expect(plot.y).toBe(8);
    expect(plot.x).toBeGreaterThan(8);
  });

  it("of 0 lets a sparkline without axes fill its chart", () => {
    const { scene } = build(
      {
        marks: [line(metrics, { x: "t", y: "a" })],
        x: { show: false, nice: false },
        y: { show: false, nice: false },
        padding: 0,
      },
      140,
      48,
    );
    expect(plotOf(scene)).toEqual({ x: 0, y: 0, width: 140, height: 48 });
  });

  it("is whitespace outside what guides need, on each side its own", () => {
    const sparse = build({ marks: [line(metrics, { x: "t", y: "a" })], padding: 0 }).scene;
    const roomy = build({
      marks: [line(metrics, { x: "t", y: "a" })],
      padding: { top: 10, right: 20, bottom: 30, left: 40 },
    }).scene;
    const [a, b] = [plotOf(sparse), plotOf(roomy)];
    expect(b.x - a.x).toBe(40);
    expect(b.y - a.y).toBe(10);
    expect(a.y + a.height - (b.y + b.height)).toBe(30);
    expect(600 - (b.x + b.width) - (600 - (a.x + a.width))).toBe(20);
    // The top y label still has room above the plot with no padding.
    expect(a.y).toBeGreaterThanOrEqual(6);
  });

  it("is refused when negative, from specs", () => {
    expect(() => loadSpec({ marks: [], padding: { top: -1 } }, [])).toThrow(
      "spec.padding.top: expected a number of at least 0; received -1",
    );
  });
});

describe("titles", () => {
  it("align in the chart's width, from the theme's title style or the title's own", () => {
    const at = (config: Partial<ChartConfig>) => titleOf(build({ marks: two, ...config }).scene)!;
    expect(at({ title: "Weekly" }).x).toBe(8);
    expect(at({ title: { text: "Weekly", style: { align: "center" } } }).x).toBe(300);
    expect(at({ title: "Weekly", theme: { style: { title: { align: "end" } } } }).x).toBe(592);
    const end = titleOf(
      build({ marks: two, title: "Weekly", theme: { style: { title: { align: "end" } } } }).scene,
    )!.items[0] as TextItem;
    expect(end.anchor).toBe("end");
  });

  it("go below the chart when placed there, leaving the top to the plot", () => {
    const top = build({ marks: two, title: "Weekly" }).scene;
    const bottom = build({
      marks: two,
      title: { text: "Weekly", place: { side: "bottom" } },
    }).scene;
    expect(titleOf(bottom)!.y).toBeGreaterThan(plotOf(bottom).y + plotOf(bottom).height);
    expect(plotOf(bottom).y).toBeLessThan(plotOf(top).y);
    // Below the x labels.
    const labels = axis(bottom.panels[0]!, "bottom")!;
    const lowest = Math.max(...labels.items.map((i) => (i.type === "text" ? i.y : 0)));
    expect(titleOf(bottom)!.y).toBeGreaterThan(lowest + 10);
  });

  it("of panels align in their plot's width and take their own styles", () => {
    const { scene } = build({
      marks: [
        line(metrics, { x: "t", y: "a", panel: "a" }),
        line(metrics, { x: "t", y: "b", panel: "b" }),
      ],
      panels: panels([
        { id: "a", title: { text: "A", style: { align: "center", color: "#cc0000" } } },
        { id: "b", title: "B", style: { panelTitle: { fontSize: 16 } } },
      ]),
    });
    const [a, b] = headersOf(scene);
    const plot = scene.panels[0]!.plot;
    expect(a!.x).toBe(plot.x + plot.width / 2);
    expect(a!.anchor).toBe("middle");
    expect((a!.items[0] as TextItem).paint.color).toBe("#cc0000");
    expect((b!.items[0] as TextItem).paint.size).toBe(16);
    expect((b!.items[0] as TextItem).paint.weight).toBe(600);
  });
});

describe("legends", () => {
  const legendRow = (scene: Scene) => legendOf(scene).map(({ x, y }) => [x, y]);

  it("go above the plots by default, in rows from the left", () => {
    const { scene } = build({ marks: two });
    const entries = legendOf(scene);
    expect(entries.map((e) => e.label)).toEqual(["a", "b"]);
    expect(entries[0]!.x).toBe(8);
    expect(entries[0]!.y).toBeLessThan(plotOf(scene).y);
  });

  it("center or end their rows when aligned", () => {
    const start = legendRow(build({ marks: two }).scene);
    const center = legendRow(
      build({ marks: two, legend: { place: { side: "top", align: "center" } } }).scene,
    );
    const end = legendRow(
      build({ marks: two, legend: { place: { side: "top", align: "end" } } }).scene,
    );
    const width = start[1]![0]! - start[0]![0]! + estimateText("b", "12px sans-serif");
    expect(center[0]![0]!).toBeGreaterThan(start[0]![0]!);
    expect(end[0]![0]!).toBeGreaterThan(center[0]![0]!);
    expect(end[0]![0]! + width).toBeLessThanOrEqual(592 + 20);
  });

  it("go below the plots, under the x labels, giving the top back", () => {
    const top = build({ marks: two }).scene;
    const below = build({ marks: two, legend: { place: { side: "bottom" } } }).scene;
    const plot = plotOf(below);
    expect(plot.y).toBeLessThan(plotOf(top).y);
    expect(legendOf(below)[0]!.y).toBeGreaterThan(plot.y + plot.height + 20);
    expect(legendOf(below)[0]!.y).toBeLessThan(300);
  });

  it("stand in a column beside the plots on the left or right", () => {
    const right = build({ marks: two, legend: { place: { side: "right" } } }).scene;
    const entries = legendOf(right);
    const plot = plotOf(right);
    expect(entries[0]!.x).toBe(entries[1]!.x);
    expect(entries[1]!.y).toBeGreaterThan(entries[0]!.y);
    expect(entries[0]!.x).toBeGreaterThan(plot.x + plot.width);
    const left = build({ marks: two, legend: { place: { side: "left" } } }).scene;
    expect(legendOf(left)[0]!.x).toBe(8);
    expect(plotOf(left).x).toBeGreaterThan(plotOf(right).x);
    // The plots keep the top, and keep clear of a legend beside them.
    expect(plotOf(right).width).toBeLessThan(plotOf(build({ marks: two }).scene).width);
  });

  it("go inside a plot at a corner, taking no room from it", () => {
    const plain = plotOf(build({ marks: two, legend: { place: { side: "top" } } }).scene);
    const { scene } = build({ marks: two, legend: { place: { inside: "top-right", inset: 10 } } });
    const plot = plotOf(scene);
    expect(plot.y).toBeLessThan(plain.y);
    const entries = legendOf(scene);
    expect(entries[0]!.y).toBeGreaterThan(plot.y);
    expect(entries[0]!.x).toBeGreaterThan(plot.x + plot.width / 2);
    expect(insideAt("top-right", { x: 0, y: 0, width: 100, height: 50 }, 20, 10, 8)).toEqual({
      x: 72,
      y: 8,
    });
    expect(insideAt("bottom", { x: 0, y: 0, width: 100, height: 50 }, 20, 10, 8)).toEqual({
      x: 40,
      y: 32,
    });
  });

  it("go inside a named panel's plot, or over every panel's", () => {
    const config: ChartConfig = {
      marks: [
        line(metrics, { x: "t", y: "a", panel: "p" }),
        line(metrics, { x: "t", y: "b", panel: "q" }),
      ],
      panels: panels([{ id: "p" }, { id: "q" }]),
    };
    const named = build({
      ...config,
      legend: { place: { inside: "bottom-left", panel: "q" } },
    }).scene;
    const q = named.panels[1]!.plot;
    const entry = legendOf(named)[0]!;
    expect(entry.y).toBeGreaterThan(q.y);
    expect(entry.x).toBe(q.x + 8);
    const chart = build({
      ...config,
      legend: { place: { inside: "top-left", scope: "chart" } },
    }).scene;
    expect(legendOf(chart)[0]!.y).toBeLessThan(named.panels[1]!.plot.y);
    expect(() =>
      build({ ...config, legend: { place: { inside: "top-left", panel: "z" } } }),
    ).toThrow('chart legend.place.panel: no panel "z"; name one of "p", "q"');
    // Beside one subplot (the first by default), it takes room beside that panel.
    const beside = build({
      ...config,
      legend: { place: { side: "right", scope: "panel", panel: "q" } },
    }).scene;
    const [p, besideQ] = beside.panels.map(({ plot }) => plot) as [Rect, Rect];
    const [first] = legendOf(beside);
    expect(first!.x).toBeGreaterThan(besideQ.x + besideQ.width);
    expect(first!.y).toBeGreaterThanOrEqual(besideQ.y);
    // Plots on the same column keep their edges lined up.
    expect(p.x + p.width).toBe(besideQ.x + besideQ.width);
    // A facet's sides are the chart's.
    expect(() =>
      build({
        marks: [line(table({ t: [0, 1], v: [1, 2], g: ["a", "b"] }), { x: "t", y: "v" })],
        facet: facet("g"),
        legend: { place: { side: "right", scope: "panel" } },
      }),
    ).toThrow("chart legend.place.scope: a legend on a side goes beside the whole chart");
  });

  it("show for one series when asked for by an object", () => {
    expect(legendOf(build({ marks: [two[0]!] }).scene)).toEqual([]);
    expect(
      legendOf(build({ marks: [two[0]!], legend: { place: { side: "bottom" } } }).scene),
    ).toHaveLength(1);
  });

  it("paint a layout mark's room as plots are painted, its halos on the fill", () => {
    const shares = table({ k: ["x", "y"], v: [1, 2] });
    const style = { plot: { fill: "#202020", stroke: "#999999" } };
    const alone = build({ marks: [pie(shares, { category: "k", value: "v" })], theme: { style } });
    expect(alone.scene.panels[0]!.frame).toEqual({
      fill: "#202020",
      stroke: "#999999",
      strokeWidth: 1,
    });
    const svg = renderToSVG({
      width: 600,
      height: 300,
      marks: [pie(shares, { category: "k", value: "v" })],
      theme: { style },
    });
    expect(svg).toContain('fill="#202020"');
  });

  it("place a layout mark's legend around it too", () => {
    const shares = table({ k: ["x", "y"], v: [1, 2] });
    const { scene } = build({
      marks: [pie(shares, { category: "k", value: "v" })],
      legend: { place: { side: "bottom" } },
    });
    expect(legendOf(scene)[0]!.y).toBeGreaterThan(250);
  });

  it("write their labels in the legend's own style", () => {
    const { scene } = build({
      marks: two,
      legend: { style: { legendLabel: { fontSize: 15, color: "#123456" } } },
    });
    const legend = scene.guides.find((g) => g.kind === "legend")!;
    expect(legend.kind === "legend" && legend.label.size).toBe(15);
    const label = legend.items.find((i): i is TextItem => i.type === "text")!;
    expect([label.paint.size, label.paint.color]).toEqual([15, "#123456"]);
    expect(
      renderToSVG({
        marks: two,
        width: 600,
        height: 300,
        legend: { style: { legendLabel: { color: "#123456" } } },
      }),
    ).toContain('fill="#123456">a</text>');
  });
});

describe("axis and plot styles", () => {
  it("color each axis' tick labels as its own style says, so twin axes match their series", () => {
    const { scene } = build({
      marks: [
        line(metrics, { x: "t", y: "a", stroke: "#cc0000" }),
        line(metrics, { x: "t", y: "b", axis: "right", stroke: "#0000cc" }),
      ],
      y: { style: { tickLabel: { color: "#cc0000" }, axisTitle: { fontWeight: 700 } }, title: "a" },
      yRight: { style: { tickLabel: { color: "#0000cc", fontSize: 14 } } },
    });
    const panel = scene.panels[0]!;
    const label = (a: AxisGuide) => a.items.find((i): i is TextItem => i.type === "text")!.paint;
    expect(label(axis(panel, "left")!).color).toBe("#cc0000");
    expect(label(axis(panel, "right")!)).toMatchObject({ color: "#0000cc", size: 14 });
    expect(label(axis(panel, "bottom")!).color).toBe(scene.theme.muted);
    const title = axis(panel, "left")!.items.find(
      (i): i is TextItem => i.type === "text" && i.text === "a",
    )!;
    expect(title.paint.weight).toBe(700);
  });

  it("measure each axis' labels in its own font, so larger labels get room", () => {
    const small = plotOf(build({ marks: two }).scene);
    const large = plotOf(
      build({ marks: two, y: { style: { tickLabel: { fontSize: 20 } } } }).scene,
    );
    expect(large.x).toBeGreaterThan(small.x);
  });

  it("draw grid lines and axis lines as their styles say, in SVG", () => {
    const svg = renderToSVG({
      marks: two,
      width: 600,
      height: 300,
      y: { style: { grid: { dash: "--", stroke: "#aaaaaa" } } },
      x: { style: { axisLine: { stroke: "#000000", strokeWidth: 2 } } },
    });
    expect(svg).toContain('stroke="#aaaaaa" stroke-dasharray="3.7 1.6" fill="none"');
    expect(svg).toContain('stroke="#000000" stroke-width="2" fill="none"');
  });

  it("give a plot a background under its grid lines and a border over its data", () => {
    const svg = renderToSVG({
      marks: two,
      width: 600,
      height: 300,
      theme: { style: { plot: { fill: "#fafafa", stroke: "#333333" } } },
    });
    const fill = svg.indexOf('fill="#fafafa"');
    const grid = svg.indexOf('stroke="#e8ebf0"');
    const data = svg.indexOf("clip-path=");
    const border = svg.indexOf('stroke="#333333"');
    expect(fill).toBeGreaterThan(0);
    expect(fill).toBeLessThan(grid);
    expect(border).toBeGreaterThan(data);
    const own = build({
      marks: [
        line(metrics, { x: "t", y: "a", panel: "p" }),
        line(metrics, { x: "t", y: "b", panel: "q" }),
      ],
      panels: panels([{ id: "p", style: { plot: { fill: "#eeeeee" } } }, { id: "q" }]),
    }).scene;
    expect(own.panels.map((p) => p.frame?.fill)).toEqual(["#eeeeee", undefined]);
  });

  it("take subplots' own axis styles over the chart's", () => {
    const { scene } = build({
      marks: [
        line(metrics, { x: "t", y: "a", panel: "p" }),
        line(metrics, { x: "t", y: "b", panel: "q" }),
      ],
      panels: panels([{ id: "p", y: { style: { tickLabel: { color: "#00aa00" } } } }, { id: "q" }]),
      y: { style: { tickLabel: { color: "#aa0000" } } },
    });
    const label = (i: number) =>
      axis(scene.panels[i]!, "left")!.items.find((x): x is TextItem => x.type === "text")!.paint
        .color;
    expect([label(0), label(1)]).toEqual(["#00aa00", "#aa0000"]);
  });

  it("center every chart title from the theme, across charts", () => {
    const theme = { style: { title: { align: "center" as const, fontSize: 18 } } };
    for (const marks of [two, [bar(table({ k: ["a"], v: [1] }), { x: "k", y: "v" })]]) {
      const title = titleOf(build({ marks, title: "Report", theme }).scene)!;
      expect(title.x).toBe(300);
      expect((title.items[0] as TextItem).paint.size).toBe(18);
    }
    expect(
      texts(
        build({ marks: [point(metrics, { x: "t", y: "a" })], title: "Report", theme }).scene,
      )[0]!.anchor,
    ).toBe("middle");
  });
});

describe("guide text", () => {
  it("breaks a chart's title into lines, keeping room for each", () => {
    const one = build({ marks: two, title: "Weekly" }).scene;
    const lines = build({ marks: two, title: "Weekly\nby service" }).scene;
    const items = titleOf(lines)!.items as TextItem[];
    expect(items.map((i) => i.text)).toEqual(["Weekly", "by service"]);
    const step = items[0]!.paint.lineHeight;
    expect(items[1]!.y - items[0]!.y).toBe(step);
    // The block is centered in the title's room, which grows by a line, as the plot moves down.
    expect((items[0]!.y + items[1]!.y) / 2).toBe(titleOf(one)!.y + step / 2);
    expect(plotOf(lines).y - plotOf(one).y).toBe(step);
  });

  it("draws boxes behind titles, tick labels, and legend labels, keeping room for the title's", () => {
    const box = { background: { fill: "#ffeeaa", radius: 2 }, padding: 3 };
    const { scene } = build({
      marks: two,
      title: { text: "Weekly", style: box },
      y: { style: { tickLabel: box } },
      legend: { style: { legendLabel: box } },
    });
    const title = titleOf(scene)!.items[0] as TextItem;
    // A box's edge goes where its text's would; the text moves in by the padding.
    expect(title.box).toMatchObject({ x: 8, height: title.paint.lineHeight + 6 });
    expect(title.x).toBe(11);
    const label = axis(scene.panels[0]!, "left")!.items.find(
      (i): i is TextItem => i.type === "text",
    )!;
    expect(label.box!.x + label.box!.width).toBeCloseTo(label.x + 3);
    const legend = scene.guides.find((g) => g.kind === "legend")!;
    expect(legend.items.some((i) => i.type === "text" && i.box)).toBe(true);
    // The plot moves down by the title's box (its line height and padding
    // over the title's usual room), the legend row's (padding over a line),
    // and the y labels' (half their box over half their text: 11 over 6).
    const plain = build({ marks: two, title: "Weekly" }).scene;
    const titleRoom = Math.max(16, title.paint.lineHeight) - 16 + 6;
    expect(plotOf(scene).y - plotOf(plain).y).toBe(titleRoom + 6 + 5);
    // Boxes stay inside the room kept for them.
    const legendBox = legend.items.find((i): i is TextItem => i.type === "text" && !!i.box)!.box!;
    expect(title.box!.y + title.box!.height).toBeLessThanOrEqual(legendBox.y);
    expect(legendBox.y + legendBox.height).toBeLessThanOrEqual(plotOf(scene).y);
    const top = axis(scene.panels[0]!, "left")!
      .items.filter((i): i is TextItem => i.type === "text")
      .reduce((a, b) => (a.y < b.y ? a : b));
    expect(top.box!.y).toBeGreaterThanOrEqual(legendBox.y + legendBox.height);
    const svg = renderToSVG({
      marks: two,
      width: 600,
      height: 300,
      title: { text: "Weekly", style: box },
    });
    expect(svg).toMatch(
      /<rect x="8" y="[\d.]+" width="[\d.]+" height="25" rx="2" fill="#ffeeaa"\/><text/,
    );
  });

  it("keeps boxes padded unevenly in the room kept for them, moving the text in its box", () => {
    const pad = (padding: number | object) => ({ background: { fill: "#ffeeaa" }, padding });
    const boxOf = (items: readonly { type: string }[], text: string) =>
      (items.find((i) => i.type === "text" && (i as TextItem).text === text) as TextItem).box!;
    // An x title padded below stays in the chart; a y title padded on its outer side too.
    const titled = build(
      {
        marks: two,
        x: { title: "Time", style: { axisTitle: pad({ bottom: 35 }) } },
        y: { title: "ms", style: { axisTitle: pad({ top: 20 }) } },
      },
      600,
      350,
    ).scene;
    const xTitle = boxOf(axis(titled.panels[0]!, "bottom")!.items, "Time");
    expect(xTitle.y + xTitle.height).toBeLessThanOrEqual(350);
    const yTitle = axis(titled.panels[0]!, "left")!.items.find(
      (i): i is TextItem => i.type === "text" && i.text === "ms",
    )!;
    // Turned to read upward, its box's top (padded by 20) faces the chart's left edge.
    expect(yTitle.x - yTitle.paint.lineHeight / 2 - 20).toBeGreaterThanOrEqual(0);
    // A legend padded above stays below the title's box, and above the plot.
    const legended = build({
      marks: two,
      title: { text: "Weekly", style: pad(2) },
      legend: { style: { legendLabel: pad({ top: 35 }) } },
    }).scene;
    const title = boxOf(titleOf(legended)!.items, "Weekly");
    const legend = legended.guides.find((g) => g.kind === "legend")!;
    const label = (legend.items.find((i) => i.type === "text") as TextItem).box!;
    expect(title.y + title.height).toBeLessThanOrEqual(label.y);
    expect(label.y + label.height).toBeLessThanOrEqual(plotOf(legended).y);
    // A panel's title padded below stays above its plot.
    const titledPanel = build({
      marks: [line(metrics, { x: "t", y: "a", panel: "p" })],
      panels: panels([{ id: "p", title: { text: "Load", style: pad({ bottom: 40 }) } }]),
    }).scene;
    const header = boxOf(headersOf(titledPanel)[0]!.items, "Load");
    expect(header.y + header.height).toBeLessThanOrEqual(plotOf(titledPanel).y);
  });

  it("keeps tick labels' and fitted headers' boxes in the chart", () => {
    const pad = (padding: number | object) => ({ background: { fill: "#ffeeaa" }, padding });
    const boxes = (items: readonly { type: string }[]) =>
      items.flatMap((i) =>
        i.type === "text" && (i as TextItem).box ? [(i as TextItem).box!] : [],
      );
    // x labels padded 40 on each side widen the margins to hold their boxes;
    // y labels padded 40 above lower the plot to hold the top one's.
    const { scene } = build(
      {
        marks: two,
        x: { style: { tickLabel: pad({ left: 40, right: 40 }) } },
        y: { style: { tickLabel: pad({ top: 40 }) } },
      },
      600,
      350,
    );
    const panel = scene.panels[0]!;
    for (const box of boxes(axis(panel, "bottom")!.items)) {
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(600);
    }
    for (const box of boxes(axis(panel, "left")!.items)) expect(box.y).toBeGreaterThanOrEqual(0);
    // Long panel titles are fitted to the room inside their boxes.
    const long = "A very long panel title that cannot fit its plot";
    const titled = build(
      {
        marks: [
          line(metrics, { x: "t", y: "a", panel: "p" }),
          line(metrics, { x: "t", y: "b", panel: "q" }),
        ],
        panels: panels(
          [
            { id: "p", title: { text: long, style: pad({ left: 30, right: 30 }) } },
            { id: "q", title: { text: long, style: pad({ left: 30, right: 30 }) } },
          ],
          grid({ columns: 2 }),
        ),
      },
      600,
      300,
    ).scene;
    headersOf(titled).forEach((header, i) => {
      const [box] = boxes(header.items);
      const plot = titled.panels[i]!.plot;
      expect(box!.x).toBeGreaterThanOrEqual(plot.x - 0.5);
      expect(box!.x + box!.width).toBeLessThanOrEqual(plot.x + plot.width + 0.5);
    });
  });

  it("reserve y labels' boxes for axes that show labels, below and between rows too", () => {
    const pad = (padding: object) => ({ background: { fill: "#ffeeaa" }, padding });
    const boxes = (items: readonly { type: string }[]) =>
      items.flatMap((i) =>
        i.type === "text" && (i as TextItem).box ? [(i as TextItem).box!] : [],
      );
    // A right axis no mark uses reads no style and keeps no room.
    const plain = build({ marks: two }).scene;
    const unused = {
      yRight: { style: { tickLabel: { color: "var(--unused)", ...pad({ top: 40 }) } } },
    };
    expect(plotOf(build({ marks: two, ...unused }).scene)).toEqual(plotOf(plain));
    expect(() => renderToSVG({ marks: two, width: 600, height: 300, ...unused })).not.toThrow();
    // The bottom label's box stays in the chart.
    const single = build(
      { marks: two, y: { style: { tickLabel: pad({ top: 80 }) } } },
      600,
      350,
    ).scene;
    for (const box of boxes(axis(single.panels[0]!, "left")!.items)) {
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(350);
    }
    // Stacked subplots keep their end labels' boxes apart.
    const stacked = build(
      {
        marks: [
          line(metrics, { x: "t", y: "a", panel: "p" }),
          line(metrics, { x: "t", y: "b", panel: "q" }),
        ],
        panels: panels([{ id: "p" }, { id: "q" }]),
        y: { style: { tickLabel: pad({ top: 40 }) } },
      },
      600,
      500,
    ).scene;
    const [upper, lower] = stacked.panels.map((panel) => boxes(axis(panel, "left")!.items));
    const upperBottom = Math.max(...upper!.map((b) => b.y + b.height));
    const lowerTop = Math.min(...lower!.map((b) => b.y));
    expect(lowerTop).toBeGreaterThanOrEqual(upperBottom);
  });

  it("read no styles of hidden axes, category axes and subplots' own too", () => {
    const sites = table({ site: ["Alpha", "Bravo"], gain: [3, 5] });
    const unused = { tickLabel: { color: "var(--unused)" }, axisTitle: { color: "var(--unused)" } };
    const size = { width: 600, height: 300 };
    expect(() =>
      renderToSVG({
        ...size,
        marks: [bar(sites, { x: "gain", y: "site" })],
        y: { show: false, style: unused },
      }),
    ).not.toThrow();
    expect(() =>
      renderToSVG({
        ...size,
        marks: [bar(sites, { x: "gain", y: "site", panel: "p" })],
        panels: panels([{ id: "p", y: { show: false, style: unused } }]),
      }),
    ).not.toThrow();
    // Lines, ticks, titles, and grid lines not drawn read nothing either.
    expect(() =>
      renderToSVG({
        ...size,
        marks: two,
        y: { style: { axisLine: { stroke: "var(--unused)" }, axisTitle: unused.axisTitle } },
        x: {
          grid: false,
          style: { grid: { stroke: "var(--unused)" }, axisTitle: unused.axisTitle },
        },
      }),
    ).not.toThrow();
  });

  it("put x labels below the reach of y labels' boxes", () => {
    const { scene } = build(
      {
        marks: two,
        y: {
          domain: [0, 6],
          style: { tickLabel: { background: { fill: "#ffeeaa" }, padding: { top: 40 } } },
        },
      },
      600,
      350,
    );
    const panel = scene.panels[0]!;
    const yBoxes = axis(panel, "left")!.items.flatMap((i) =>
      i.type === "text" && i.box ? [i.box] : [],
    );
    const bottom = Math.max(...yBoxes.map((box) => box.y + box.height));
    const xLabels = axis(panel, "bottom")!.items.filter((i): i is TextItem => i.type === "text");
    // Hanging labels' tops are their points less half their leading.
    for (const label of xLabels)
      expect(label.y - (label.paint.lineHeight - label.paint.size) / 2).toBeGreaterThanOrEqual(
        bottom,
      );
  });

  it("read title styles of the axes that draw titles only, and space categories by labels drawn", () => {
    const unused = { axisTitle: { color: "var(--unused)" } };
    const size = { width: 600, height: 400 };
    const two = [
      line(metrics, { x: "t", y: "a", panel: "p" }),
      line(metrics, { x: "t", y: "b", panel: "q" }),
    ];
    expect(() =>
      renderToSVG({
        ...size,
        marks: two,
        panels: panels([
          { id: "p", y: { title: "ms" } },
          { id: "q", y: { style: unused } },
        ]),
      }),
    ).not.toThrow();
    expect(() =>
      renderToSVG({
        ...size,
        marks: two,
        x: { scope: "panel" },
        panels: panels([
          { id: "p", x: { title: "Time" } },
          { id: "q", x: { style: unused } },
        ]),
      }),
    ).not.toThrow();
    // Stacked panels sharing a category x: the lower one's labels, drawn
    // large, space the categories; the upper one shows none.
    const names = Array.from({ length: 10 }, (_, i) => `Category ${i}`);
    const cats = table({ name: names, v: names.map((_, i) => i) });
    const large = { tickLabel: { fontSize: 40 } };
    const { scene } = build(
      {
        marks: [
          bar(cats, { x: "name", y: "v", panel: "p" }),
          bar(cats, { x: "name", y: "v", panel: "q" }),
        ],
        panels: panels([
          { id: "p", x: { show: false } },
          { id: "q", style: large },
        ]),
      },
      600,
      400,
    );
    const labels = axis(scene.panels[1]!, "bottom")!
      .items.filter((i): i is TextItem => i.type === "text")
      .map((label) => [label.x, estimateText(label.text, label.paint.css)] as const);
    for (let k = 1; k < labels.length; k++)
      expect(labels[k]![0] - labels[k]![1] / 2).toBeGreaterThanOrEqual(
        labels[k - 1]![0] + labels[k - 1]![1] / 2,
      );
  });

  it("put x labels in boxes, or of tall lines, below y labels' boxes, and keep stacked rows apart", () => {
    const yBox = { tickLabel: { background: { fill: "#ffeeaa" }, padding: { top: 40 } } };
    const boxes = (items: readonly { type: string }[]) =>
      items.flatMap((i) =>
        i.type === "text" && (i as TextItem).box ? [(i as TextItem).box!] : [],
      );
    const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    for (const xLabel of [
      { background: { fill: "#eeeeee" }, fontSize: 40 },
      { background: { fill: "#eeeeee" }, lineHeight: 3 },
    ]) {
      const { scene } = build(
        { marks: two, y: { domain: [0, 6], style: yBox }, x: { style: { tickLabel: xLabel } } },
        600,
        350,
      );
      const panel = scene.panels[0]!;
      for (const y of boxes(axis(panel, "left")!.items))
        for (const x of boxes(axis(panel, "bottom")!.items)) expect(overlap(x, y)).toBe(false);
    }
    const stacked = build(
      {
        marks: [
          line(metrics, { x: "t", y: "a", panel: "p" }),
          line(metrics, { x: "t", y: "b", panel: "q" }),
        ],
        panels: panels([{ id: "p" }, { id: "q" }]),
        x: { scope: "panel", style: { tickLabel: { background: { fill: "#eeeeee" } } } },
        y: { domain: [0, 6], style: yBox },
      },
      600,
      600,
    ).scene;
    const upper = boxes(axis(stacked.panels[0]!, "bottom")!.items);
    const lower = boxes(axis(stacked.panels[1]!, "left")!.items);
    for (const x of upper) for (const y of lower) expect(overlap(x, y)).toBe(false);
  });

  it("space category labels by their boxes, and boxed x labels below boxed y labels", () => {
    const boxes = (items: readonly { type: string }[]) =>
      items.flatMap((i) =>
        i.type === "text" && (i as TextItem).box ? [(i as TextItem).box!] : [],
      );
    const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
      a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    const names = Array.from({ length: 10 }, (_, i) => `Cat ${i}`);
    const cats = table({ name: names, v: names.map((_, i) => i + 1) });
    const box = { background: { fill: "#eeeeee" }, padding: { left: 30, right: 30 } };
    const spaced = build(
      { marks: [bar(cats, { x: "name", y: "v" })], x: { style: { tickLabel: box } } },
      600,
      350,
    ).scene;
    const xBoxes = boxes(axis(spaced.panels[0]!, "bottom")!.items);
    for (let k = 1; k < xBoxes.length; k++) expect(overlap(xBoxes[k - 1]!, xBoxes[k]!)).toBe(false);
    // y boxes reaching no further than their text, x boxes of tall lines.
    const filled = { fill: "#ffeeaa" };
    const { scene } = build(
      {
        marks: two,
        y: { style: { tickLabel: { background: filled, lineHeight: 1 } } },
        x: { style: { tickLabel: { background: filled, lineHeight: 2 } } },
      },
      600,
      350,
    );
    const panel = scene.panels[0]!;
    for (const y of boxes(axis(panel, "left")!.items))
      for (const x of boxes(axis(panel, "bottom")!.items)) expect(overlap(x, y)).toBe(false);
  });

  it("put x labels below y labels where either has boxes, by their own sizes", () => {
    const filled = { fill: "#ffeeaa" };
    const texts = (items: readonly { type: string }[]) =>
      items.filter((i): i is TextItem => i.type === "text");
    // Large unboxed y labels over boxed x labels of tall lines.
    const a = build(
      {
        marks: two,
        y: { domain: [0, 6], style: { tickLabel: { fontSize: 40 } } },
        x: {
          style: {
            tickLabel: { background: filled, lineHeight: 2, padding: { left: 20, right: 20 } },
          },
        },
      },
      600,
      350,
    ).scene.panels[0]!;
    const yBottom = Math.max(...texts(axis(a, "left")!.items).map((t) => t.y + t.paint.size / 2));
    for (const x of texts(axis(a, "bottom")!.items))
      expect(x.box!.y).toBeGreaterThanOrEqual(yBottom);
    // Large unboxed x labels, whose accents rise above their hanging point, under boxed y labels.
    const b = build(
      {
        marks: two,
        y: {
          domain: [0, 6],
          style: { tickLabel: { background: filled, padding: { top: 40, left: 20, right: 20 } } },
        },
        x: { style: { tickLabel: { fontSize: 40 } } },
      },
      600,
      350,
    ).scene.panels[0]!;
    const boxBottom = Math.max(
      ...texts(axis(b, "left")!.items).map((t) => t.box!.y + t.box!.height),
    );
    for (const x of texts(axis(b, "bottom")!.items))
      expect(x.y - (x.paint.lineHeight - x.paint.size) / 2).toBeGreaterThanOrEqual(boxBottom);
  });

  it("measure categories once per font, scene after scene", () => {
    const names = Array.from({ length: 1000 }, (_, i) => `Category ${i}`);
    const cats = table({ name: names, v: names.map((_, i) => i) });
    const { model } = build({
      marks: [
        bar(cats, { x: "name", y: "v", panel: "p" }),
        bar(cats, { x: "name", y: "v", panel: "q" }),
      ],
      panels: panels(
        [
          { id: "p", style: { tickLabel: { fontSize: 12 } } },
          { id: "q", style: { tickLabel: { fontSize: 14 } } },
        ],
        grid({ columns: 2 }),
      ),
    });
    let calls = 0;
    const counting = (text: string, font: string) => {
      calls++;
      return estimateText(text, font);
    };
    model.scene(counting);
    calls = 0;
    model.scene(counting);
    expect(calls).toBeLessThan(200);
  });

  it("keep each subplot's x label boxes in the chart, by that subplot's style", () => {
    const pad = { background: { fill: "#ffeeaa" }, padding: { left: 40, right: 40 } };
    const { scene } = build({
      marks: [
        line(metrics, { x: "t", y: "a", panel: "p" }),
        line(metrics, { x: "t", y: "b", panel: "q" }),
      ],
      panels: panels([{ id: "p" }, { id: "q", style: { tickLabel: pad } }], grid({ columns: 2 })),
    });
    const items = axis(scene.panels[1]!, "bottom")!.items;
    for (const item of items)
      if (item.type === "text" && item.box)
        expect(item.box.x + item.box.width).toBeLessThanOrEqual(600);
  });

  it("keep room for the text styles ask for, so large labels and titles do not meet", () => {
    const big = { fontSize: 40 };
    const { scene } = build(
      {
        marks: two,
        x: { title: "Time", style: { tickLabel: big, axisTitle: big } },
        y: { title: "ms", style: { axisTitle: big } },
        legend: { style: { legendLabel: big } },
      },
      400,
      200,
    );
    const bottom = axis(scene.panels[0]!, "bottom")!;
    const labels = bottom.items.filter(
      (i): i is TextItem => i.type === "text" && i.text !== "Time",
    );
    const title = bottom.items.find((i): i is TextItem => i.type === "text" && i.text === "Time")!;
    // Hanging labels' lines reach their size and half the leading down; the
    // title's line is centered below them.
    const { size, lineHeight } = labels[0]!.paint;
    const labelsEnd = Math.max(...labels.map((l) => l.y)) + size + (lineHeight - size) / 2;
    expect(title.y - title.paint.lineHeight / 2).toBeGreaterThanOrEqual(labelsEnd);
    expect(title.y + title.paint.lineHeight / 2).toBeLessThanOrEqual(200);
    // The y title stands clear of the left edge, a line of its own.
    const yTitle = axis(scene.panels[0]!, "left")!.items.find(
      (i): i is TextItem => i.type === "text" && i.text === "ms",
    )!;
    expect(yTitle.x - yTitle.paint.lineHeight / 2).toBeGreaterThanOrEqual(0);
    // Legend rows are as tall as their labels' lines, above the plot.
    const entries = legendOf(scene);
    expect(entries[0]!.y - 25).toBeGreaterThanOrEqual(0);
    expect(entries[0]!.y + 25).toBeLessThanOrEqual(plotOf(scene).y);
  });

  it("gives guide text halos as their styles ask, over what they are drawn on", () => {
    const { scene } = build({
      marks: [
        line(metrics, { x: "t", y: "a", panel: "p" }),
        line(metrics, { x: "t", y: "b", panel: "p" }),
      ],
      panels: panels([{ id: "p", style: { plot: { fill: "#202020" } } }]),
      theme: {
        style: { tickLabel: { halo: "auto" }, legendLabel: { halo: "auto", color: "#eeeeee" } },
      },
      legend: { place: { inside: "top-left" } },
    });
    const tick = axis(scene.panels[0]!, "left")!.items.find(
      (i): i is TextItem => i.type === "text",
    )!;
    // Tick labels beside the plot are on the chart's white background.
    expect(tick.halo).toEqual({ color: "#ffffff", width: 3, opacity: 1 });
    // A legend inside the plot is on its dark fill.
    const legend = scene.guides.find((g) => g.kind === "legend")!;
    const label = legend.items.find((i): i is TextItem => i.type === "text")!;
    expect(label.halo).toEqual({ color: "#202020", width: 3, opacity: 1 });
  });
});

describe("style colors", () => {
  it("read CSS variables in axis, title, and halo styles as the theme's are", () => {
    const options = {
      marks: two,
      width: 600,
      height: 300,
      title: { text: "Weekly", style: { color: "var(--ink, #123456)" } },
      y: { style: { tickLabel: { color: "var(--ink, #ff0000)" } } },
      theme: {
        style: { title: { halo: { color: "var(--paper, #fafafa)" } } },
      },
    };
    const svg = renderToSVG(options);
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).toContain('fill="#123456"');
    expect(svg).toContain('stroke="#fafafa"');
    expect(svg).not.toContain("var(");
    expect(() => renderToPDF(options)).not.toThrow();
    expect(() =>
      renderToSVG({ ...options, y: { style: { tickLabel: { color: "var(--ink)" } } } }),
    ).toThrow("y.style.tickLabel.color is the CSS variable var(--ink)");
  });

  it("read only the values that win the cascade, so overridden variables need no fallback", () => {
    const options = {
      marks: [
        line(metrics, { x: "t", y: "a", panel: "p" }),
        line(metrics, { x: "t", y: "b", panel: "p" }),
      ],
      width: 600,
      height: 300,
      y: { style: { tickLabel: { color: "var(--unused)", fontWeight: 600 } } },
      panels: panels([{ id: "p", style: { tickLabel: { color: "#ff0000" } } }]),
    };
    const svg = renderToSVG(options);
    expect(svg).toMatch(/font-weight="600" fill="#ff0000"/);
    // A variable that wins is still read, and named where it is set.
    expect(() =>
      renderToSVG({ ...options, panels: panels([{ id: "p", style: { tickLabel: {} } }]) }),
    ).toThrow("y.style.tickLabel.color is the CSS variable var(--unused)");
  });

  it("read named colors in static output, so guides' halos contrast with them", () => {
    const svg = renderToSVG({
      marks: two,
      width: 600,
      height: 300,
      title: { text: "Weekly", style: { color: "yellow", halo: "auto" } },
    });
    // Yellow on white is light on light: the halo is black, not white.
    expect(svg).toMatch(/fill="#ffff00"[^>]*stroke="#000000"/);
  });
});
