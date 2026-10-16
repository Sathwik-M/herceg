// Panels' legends: what a panel draws, hidden and shown there, beside the
// chart's legend, which the visibility kept on the model keeps in step.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { axis, legend } from "../../src/guides/options.ts";
import { estimateText } from "../../src/layout/text.ts";
import { columns, inset, panel, rows } from "../../src/layout.ts";
import { bar } from "../../src/marks/bar.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { facet } from "../../src/model/facet.ts";
import type { AxisInspection } from "../../src/model/inspect.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import { NO_PAGE } from "../../src/render/fallbacks.ts";
import {
  guidesOf,
  type LegendGuide,
  type LegendItem,
  type LineGeometry,
  type PointGeometry,
  type RectGeometry,
  type Scene,
} from "../../src/scene/scene.ts";
import type { SidePlace } from "../../src/spec/place.ts";

function model(config: ChartConfig, width = 800, height = 500) {
  const built = new ChartModel(
    { locale: "en-US", timeZone: "UTC", ...config },
    NO_PAGE,
    ...staticCompilers(),
  );
  built.setSize(width, height, 1);
  return built;
}

const data = table({
  t: [0, 1, 2, 0, 1, 2, 0, 1, 2],
  p99: [120, 180, 150, 90, 110, 130, 60, 70, 65],
  errors: [3, 5, 2, 1, 4, 2, 0, 1, 1],
  region: ["eu", "eu", "eu", "us", "us", "us", "ap", "ap", "ap"],
});
// The rows of one table, so that a region has one identity in both panels.
const marks = [
  line(data, { x: "t", y: "p99", color: "region", panel: "latency" }),
  line(data, { x: "t", y: "errors", color: "region", panel: "errors" }),
];
const layout = panels(columns([2, 1], [panel({ id: "latency" }), panel({ id: "errors" })]));
const legends = (scene: Scene) => guidesOf(scene, "legend") as LegendGuide[];
const labels = (guide: LegendGuide | undefined) => guide?.entries.map(({ label }) => label);
/** The series an entry hides and shows, as the legend's buttons do. */
const targets = (entry: LegendItem) => [entry.targets ?? entry.key].flat();
const strokes = (scene: Scene, key: string) =>
  scene.panels
    .find((p) => p.key === key)!
    .marks.filter((m): m is LineGeometry => m.kind === "line")
    .map(({ stroke }) => stroke);

describe("panel legends", () => {
  it("list what their panel draws, above it, and the chart's legend what they leave out", () => {
    const chart = model({ marks, panels: layout, guides: [legend({ panel: "errors" })] });
    const scene = chart.scene(estimateText);
    const [own, rest] = [
      legends(scene).find((g) => g.panel === "errors"),
      legends(scene).find((g) => g.panel === undefined),
    ];
    expect(labels(own)).toEqual(["eu", "us", "ap"]);
    // What a panel without a legend draws stays the chart's: all three, in latency.
    expect(labels(rest)).toEqual(["eu", "us", "ap"]);
    // With a legend in every panel, the chart needs none of its own.
    const both = model({
      marks,
      panels: layout,
      guides: [legend({ panel: "errors" }), legend({ panel: "latency" })],
    }).scene(estimateText);
    expect(legends(both).map((g) => [g.panel, labels(g)])).toEqual([
      ["errors", ["eu", "us", "ap"]],
      ["latency", ["eu", "us", "ap"]],
    ]);
    const errors = scene.panels.find((p) => p.key === "errors")!.plot;
    expect(own!.entries[0]!.y).toBeLessThan(errors.y);
    expect(own!.entries[0]!.x).toBeGreaterThanOrEqual(errors.x - 1);
    // Asked for, the chart's legend lists everything again.
    const forced = model({
      marks,
      panels: layout,
      guides: [legend({ panel: "errors" })],
      legend: true,
    }).scene(estimateText);
    expect(labels(legends(forced).find((g) => g.panel === undefined))).toEqual(["eu", "us", "ap"]);
  });

  it("go along their panel's side as their place aligns them, offset from it", () => {
    const sceneOf = (place: SidePlace) =>
      model({ marks, panels: layout, guides: [legend({ panel: "errors", place })] }).scene(
        estimateText,
      );
    const plain = sceneOf({ side: "top" });
    const moved = sceneOf({ side: "top", align: "end", offset: 30 });
    const plotOf = (scene: Scene) => scene.panels.find((p) => p.key === "errors")!.plot;
    const xsOf = (scene: Scene) =>
      legends(scene)
        .find((g) => g.panel === "errors")!
        .entries.map(({ x }) => x);
    // At the end of the plot's width, and 30 px further up, which the plot gives room for.
    expect(Math.min(...xsOf(moved))).toBeGreaterThan(Math.min(...xsOf(plain)) + 20);
    expect(plotOf(moved).y - plotOf(plain).y).toBeCloseTo(30, 0);
  });

  it("draw their swatches as the marks of their panel look", () => {
    const scene = model({
      marks: [
        line(data, { x: "t", y: "p99", color: "region", panel: "latency", dash: "--" }),
        bar(data, { x: "t", y: "errors", color: "region", panel: "errors" }),
      ],
      panels: layout,
      guides: [legend({ panel: "errors", swatches: "mark" })],
    }).scene(estimateText);
    const own = legends(scene).find((g) => g.panel === "errors")!;
    // Boxes of the bars only, without the other panel's dashed lines.
    const kinds = new Set(
      own.entries.flatMap(({ sample }) => sample!.items.map(({ type }) => type)),
    );
    expect([...kinds]).toEqual(["rect"]);
  });

  it("beside their panel, make its plot at least as tall as they are, or refuse a chart too short", () => {
    const many = table({
      t: Array.from({ length: 16 }, (_, i) => i % 2),
      v: Array.from({ length: 16 }, (_, i) => i),
      s: Array.from({ length: 16 }, (_, i) => `series ${Math.floor(i / 2)}`),
    });
    const config = (height: number) =>
      model(
        {
          marks: [
            line(many, { x: "t", y: "v", color: "s", panel: "latency" }),
            line(many, { x: "t", y: "v", color: "s", panel: "errors" }),
          ],
          panels: panels(rows([1, 1], [panel("latency"), panel("errors")])),
          guides: [
            legend({ panel: "latency", place: { side: "right" } }),
            legend({ panel: "errors", place: { side: "right" } }),
          ],
        },
        800,
        height,
      );
    const scene = config(600).scene(estimateText);
    for (const key of ["latency", "errors"]) {
      const plot = scene.panels.find((p) => p.key === key)!.plot;
      const ys = legends(scene)
        .find((g) => g.panel === key)!
        .entries.map(({ y }) => y);
      expect(Math.max(...ys)).toBeLessThanOrEqual(plot.y + plot.height + 1);
    }
    expect(() => config(200).scene(estimateText)).toThrow(
      /layout: needs at least \d+ px of height/,
    );
  });

  it("wrap anew at a new size, as a chart made at that size does", () => {
    const many = table({
      t: Array.from({ length: 16 }, (_, i) => i % 2),
      v: Array.from({ length: 16 }, (_, i) => i),
      s: Array.from({ length: 16 }, (_, i) => `series ${Math.floor(i / 2)}`),
    });
    const config: ChartConfig = {
      marks: [
        line(many, { x: "t", y: "v", color: "s", panel: "latency" }),
        line(many, { x: "t", y: "v", color: "s", panel: "errors" }),
      ],
      panels: layout,
      guides: [legend({ panel: "latency" }), legend({ panel: "errors" })],
    };
    const plots = (scene: Scene) => scene.panels.map(({ plot }) => plot);
    const resized = model(config, 450, 700);
    resized.scene(estimateText);
    resized.setSize(1200, 140, 1);
    expect(plots(resized.scene(estimateText))).toEqual(
      plots(model(config, 1200, 140).scene(estimateText)),
    );
    // Shorter only, with y labels narrower in shorter plots, which are wider then.
    const narrow = table({
      t: Array.from({ length: 16 }, (_, i) => i % 2),
      v: Array.from({ length: 16 }, (_, i) => i * 0.02),
      s: Array.from({ length: 16 }, (_, i) => `xxxxxx${Math.floor(i / 2)}`),
    });
    const tall: ChartConfig = {
      marks: [
        line(narrow, { x: "t", y: "v", color: "s", panel: "latency" }),
        line(narrow, { x: "t", y: "v", color: "s", panel: "errors" }),
      ],
      panels: panels(columns([1, 1], [panel("latency"), panel("errors")])),
      guides: [legend({ panel: "latency" }), legend({ panel: "errors" })],
    };
    const shorter = model(tall, 380, 700);
    shorter.scene(estimateText);
    shorter.setSize(380, 180, 1);
    expect(plots(shorter.scene(estimateText))).toEqual(
      plots(model(tall, 380, 180).scene(estimateText)),
    );
    // Laid out again for the legends and for the guides' axes (wrapped
    // labels), the second scene is the first's.
    const words = table({
      k: Array.from({ length: 32 }, (_, i) => `word word ${i % 4}`),
      v: Array.from({ length: 32 }, (_, i) => i),
      s: Array.from({ length: 32 }, (_, i) => `series ${Math.floor(i / 4)}`),
    });
    const labeled = model(
      {
        marks: [
          bar(words, { x: "k", y: "v", color: "s", panel: "latency" }),
          bar(words, { x: "k", y: "v", color: "s", panel: "errors" }),
        ],
        panels: panels(columns([1, 1], [panel("latency"), panel("errors")])),
        guides: [
          legend({ panel: "latency" }),
          legend({ panel: "errors" }),
          axis({ scale: "x", labels: { collision: "wrap" } }),
        ],
      },
      400,
      700,
    );
    expect(plots(labeled.scene(estimateText))).toEqual(plots(labeled.scene(estimateText)));
  });

  it("wrap anew after an update, as a chart made with it does, and the same scene after scene", () => {
    const seriesOf = (count: number, scale: number) =>
      table({
        t: Array.from({ length: 2 * count }, (_, i) => i % 2),
        v: Array.from({ length: 2 * count }, (_, i) => i * scale),
        s: Array.from({ length: 2 * count }, (_, i) => `series ${Math.floor(i / 2)}`),
      });
    const equal = panels(columns([1, 1], [panel("latency"), panel("errors")]));
    const configOf = (rows: ReturnType<typeof seriesOf>): ChartConfig => ({
      marks: [
        line(rows, { x: "t", y: "v", color: "s", panel: "latency" }),
        line(rows, { x: "t", y: "v", color: "s", panel: "errors" }),
      ],
      panels: equal,
      guides: [legend({ panel: "latency" }), legend({ panel: "errors" })],
    });
    const plots = (scene: Scene) => scene.panels.map(({ plot }) => plot);
    const updated = model(configOf(seriesOf(2, 1_000_000)), 450, 180);
    updated.scene(estimateText);
    updated.update({ locale: "en-US", timeZone: "UTC", ...configOf(seriesOf(8, 0.01)) });
    expect(plots(updated.scene(estimateText))).toEqual(
      plots(model(configOf(seriesOf(8, 0.01)), 450, 180).scene(estimateText)),
    );
    // Labels much wider for some heights than others: the scene settles.
    const cycling = model(
      {
        ...configOf(seriesOf(11, 1 / 21)),
        y: {
          format: (value: number) =>
            Math.abs(value / 0.2 - Math.round(value / 0.2)) < 1e-9 ? "x" : "nineteen characters",
        },
      },
      708,
      264,
    );
    expect(plots(cycling.scene(estimateText))).toEqual(plots(cycling.scene(estimateText)));
  });

  it("wrap at their panel's width", () => {
    const many = table({
      t: Array.from({ length: 16 }, (_, i) => i % 2),
      v: Array.from({ length: 16 }, (_, i) => i),
      s: Array.from({ length: 16 }, (_, i) => `series ${Math.floor(i / 2)}`),
    });
    const scene = model({
      marks: [
        line(many, { x: "t", y: "v", color: "s", panel: "latency" }),
        line(many, { x: "t", y: "v", color: "s", panel: "errors" }),
      ],
      panels: layout,
      guides: [legend({ panel: "latency" }), legend({ panel: "errors" })],
    }).scene(estimateText);
    const [first, second] = ["latency", "errors"].map((key) => ({
      plot: scene.panels.find((p) => p.key === key)!.plot,
      xs: legends(scene)
        .find((g) => g.panel === key)!
        .items.flatMap((item) =>
          item.type === "text" ? [item.x + estimateText(item.text, item.paint.css)] : [],
        ),
    }));
    // Each legend's rows end before the next panel, and inside the chart.
    expect(Math.max(...first!.xs)).toBeLessThan(second!.plot.x);
    expect(Math.max(...second!.xs)).toBeLessThanOrEqual(800);
    // Long y labels in the first panel, and a legend over an inset of 300 px.
    const wide = table({
      t: Array.from({ length: 16 }, (_, i) => i % 2),
      v: Array.from({ length: 16 }, (_, i) => 1_000_000 * i),
      s: Array.from({ length: 16 }, (_, i) => `series ${Math.floor(i / 2)}`),
    });
    const nested = model({
      marks: [
        line(wide, { x: "t", y: "v", color: "s", panel: "latency" }),
        line(many, { x: "t", y: "v", color: "s", panel: "errors" }),
        line(many, { x: "t", y: "v", color: "s", panel: "zoom" }),
      ],
      panels: panels(
        columns(
          [1, 1],
          [
            panel("latency"),
            panel("errors", [inset("zoom", { width: { px: 300 }, height: { fraction: 0.8 } })]),
          ],
        ),
      ),
      guides: [legend({ panel: "latency" }), legend({ panel: "zoom" })],
    }).scene(estimateText);
    const ends = (key: string) =>
      Math.max(
        ...legends(nested)
          .find((g) => g.panel === key)!
          .items.flatMap((item) =>
            item.type === "text" ? [item.x + estimateText(item.text, item.paint.css)] : [],
          ),
      );
    const plotOf = (key: string) => nested.panels.find((p) => p.key === key)!.plot;
    expect(ends("latency")).toBeLessThan(plotOf("errors").x);
    expect(ends("zoom")).toBeLessThanOrEqual(plotOf("zoom").x + plotOf("zoom").width + 1);
  });

  it("go above the axes listed above their panel", () => {
    const chart = new ChartModel(
      {
        locale: "en-US",
        timeZone: "UTC",
        marks,
        panels: panels(columns([1, 1], [panel("latency"), panel("errors")])),
        guides: [legend({ panel: "errors" }), axis({ scale: "x", place: { side: "top" } })],
      },
      NO_PAGE,
      ...staticCompilers(),
    );
    chart.setSize(800, 500, 1);
    const scene = chart.scene(estimateText);
    const errors = scene.panels.find((p) => p.key === "errors")!;
    const top = errors.axes.find((a) => a.side === "top")!;
    const labelsAt = top.items.flatMap((item) => (item.type === "text" ? [item.y] : []));
    const own = legends(scene).find((g) => g.panel === "errors")!;
    // The legend's lowest entry is above the axis' highest label.
    expect(Math.max(...own.entries.map(({ y }) => y)) + 6).toBeLessThan(Math.min(...labelsAt) - 4);
  });

  it("go beyond their panel's y title on its side", () => {
    for (const side of ["left", "right"] as const) {
      const scene = model({
        marks: [
          line(data, { x: "t", y: "p99", color: "region", panel: "latency", axis: side }),
          line(data, { x: "t", y: "errors", color: "region", panel: "errors" }),
        ],
        panels: panels(
          columns(
            [1, 1],
            [
              panel({ id: "latency", [side === "left" ? "y" : "yRight"]: { title: "ms" } }),
              panel("errors"),
            ],
          ),
        ),
        guides: [legend({ panel: "latency", place: { side } })],
      }).scene(estimateText);
      const title = scene.panels
        .find((p) => p.key === "latency")!
        .axes.find((a) => a.side === side)!.title!;
      const own = legends(scene).find((g) => g.panel === "latency")!;
      // The legend's swatches and labels are further from the plot than the title's line.
      const spans = own.items.flatMap((item) =>
        item.type === "text"
          ? [[item.x, item.x + estimateText(item.text, item.paint.css)]]
          : item.type === "rect"
            ? [[item.x, item.x + item.width]]
            : [],
      );
      expect(spans.length).toBeGreaterThan(0);
      if (side === "left")
        expect(Math.max(...spans.map(([, to]) => to!))).toBeLessThan(title.x - 6);
      else expect(Math.min(...spans.map(([from]) => from!))).toBeGreaterThan(title.x + 6);
    }
  });

  it("refuse a panel the chart does not have, and a chart without subplots", () => {
    expect(() =>
      model({ marks, panels: layout, guides: [legend({ panel: "traffic" })] }).scene(estimateText),
    ).toThrow('guides[0].panel: no panel "traffic"; name one of "latency", "errors"');
    expect(() =>
      model({
        marks: [line(data, { x: "t", y: "p99", color: "region" })],
        guides: [legend({ panel: "x" })],
      }).scene(estimateText),
    ).toThrow(
      "guides[0].panel: lists a subplot's marks, and the chart has no subplots; drop panel",
    );
  });

  it("hide a series in their panel only, which the chart's legend shows as mixed", () => {
    const chart = model({
      marks,
      panels: layout,
      guides: [legend({ panel: "errors" }), legend({})],
    });
    const before = chart.scene(estimateText);
    const colors = { latency: strokes(before, "latency"), errors: strokes(before, "errors") };
    expect(colors.latency).toHaveLength(3);
    // Hidden in errors, eu is still drawn in latency.
    const own = legends(before).find((g) => g.panel === "errors")!;
    expect(labels(own)).toEqual(["eu", "us", "ap"]);
    const [hiding] = own.entries;
    chart.hidden.panels.set("errors", new Map(targets(hiding!).map((key) => [key, true])));
    const after = chart.scene(estimateText);
    expect(strokes(after, "latency")).toEqual(colors.latency);
    // The other series keeps its color.
    expect(strokes(after, "errors")).toEqual(colors.errors.slice(1));
    const shown = legends(after).find((g) => g.panel === "errors")!;
    expect(shown.entries.map(({ hidden }) => hidden)).toEqual([true, false, false]);
    const chartWide = legends(after).find((g) => g.panel === undefined)!;
    const eu = chartWide.entries.find(({ label }) => label === "eu")!;
    expect([eu.hidden, eu.mixed]).toEqual([false, true]);
    // Static output fades it halfway, as the live legend does.
    const opacities = chartWide.items.map((item) => ("opacity" in item ? item.opacity : 1));
    expect(opacities.slice(0, 2)).toEqual([0.7, 0.7]);
    expect(opacities.slice(2)).not.toContain(0.7);
  });

  it("leave marks of every panel to the chart's visibility, their stacks whole", () => {
    const chart = model({
      marks: [
        line(data, { x: "t", y: "p99", color: "region", panel: "latency" }),
        bar(data, { x: "t", y: "errors", color: "region", stack: true, panel: "*" }),
      ],
      panels: layout,
      guides: [legend({ panel: "latency" })],
    });
    const before = chart.scene(estimateText);
    const bars = (scene: Scene) =>
      scene.panels
        .find((p) => p.key === "latency")!
        .marks.filter((m): m is RectGeometry => m.kind === "rect")
        .map(({ key, count }) => [key, count]);
    const was = bars(before);
    const [eu] = legends(before).find((g) => g.panel === "latency")!.entries;
    // Hidden by the panel's legend (its series there), or by the region's key, as getLegend gives it.
    for (const keys of [targets(eu!), [eu!.key]]) {
      chart.hidden.panels.set("latency", new Map(keys.map((key) => [key, true])));
      const after = chart.scene(estimateText);
      // The line's eu goes in latency; the bars of every panel keep every series' bars.
      expect(strokes(after, "latency")).toHaveLength(2);
      expect(bars(after)).toEqual(was);
      // And the tooltip finds them as drawn: every series' bars, and the line's others.
      const plot = after.panels.find((p) => p.key === "latency")!.plot;
      const inspection = chart.inspect(
        plot.x + plot.width / 2,
        plot.y + plot.height / 2,
        "nearest-x",
        "latency",
      ) as AxisInspection;
      const marksOf = (mark: number) =>
        inspection.points.filter((point) => point.mark === mark).map(({ label }) => label);
      expect(marksOf(1)).toEqual(["eu", "us", "ap"]);
      expect(marksOf(0)).toEqual(["us", "ap"]);
    }
  });

  it("keep a stack whole of what a panel hides by its entry, through updates of other options", () => {
    const rows = table({ t: [0, 0], v: [3, 2], k: ["first", "second"] });
    const config: ChartConfig = {
      marks: [
        bar(rows, { x: "t", y: "v", color: "k", stack: true, panel: "latency" }),
        line(data, { x: "t", y: "errors", panel: "errors" }),
      ],
      panels: layout,
    };
    const chart = model(config);
    const before = chart.scene(estimateText);
    const [first] = legends(before)[0]!.entries;
    chart.hidden.panels.set("latency", new Map([[first!.key, true]]));
    const domain = () =>
      chart
        .panels()
        .find(({ key }) => key === "latency")!
        .y.domain.map((v) => Math.round(v));
    chart.scene(estimateText);
    const hiddenDomain = domain();
    expect(hiddenDomain[1]).toBeLessThan(3);
    // An update that changes nothing drawn joins the series again and stacks them as hidden.
    chart.update({ locale: "en-US", timeZone: "UTC", ...config, description: "Requests" });
    chart.scene(estimateText);
    expect(domain()).toEqual(hiddenDomain);
  });

  it("hide in a panel by the entry's key, as getLegend gives it, and show the chart's entry by every panel", () => {
    const chart = model({ marks, panels: layout, legend: true });
    const before = chart.scene(estimateText);
    const eu = legends(before)[0]!.entries.find(({ label }) => label === "eu")!;
    const series = chart.series().filter((s) => (s.entry ?? s.key) === eu.key);
    // Without panels' legends, a panel's own visibility still shows on the chart's entry.
    chart.hidden.panels.set("errors", new Map([[eu.key, true]]));
    for (const s of series) expect(chart.hidden.hiddenIn(s.key, "errors")).toBe(true);
    const mixed = legends(chart.scene(estimateText))[0]!.entries.find(
      ({ label }) => label === "eu",
    )!;
    expect([mixed.hidden, !!mixed.mixed]).toEqual([false, true]);
    // Hidden in every panel, it is hidden.
    chart.hidden.panels.set("latency", new Map([[eu.key, true]]));
    const gone = legends(chart.scene(estimateText))[0]!.entries.find(
      ({ label }) => label === "eu",
    )!;
    expect([gone.hidden, !!gone.mixed]).toEqual([true, false]);
  });

  it("leave to the chart's legend what a panel's legend does not list, ramps of other panels included", () => {
    const other = table({ t: [0, 1, 2], v: [1, 2, 3], kind: ["x", "y", "x"] });
    const shades = table({ t: [0, 1, 2], v: [1, 2, 3], heat: [0.1, 0.5, 0.9] });
    const config: ChartConfig = {
      marks: [
        line(data, { x: "t", y: "p99", color: "region", panel: "latency", id: "regions" }),
        line(other, { x: "t", y: "v", color: "kind", panel: "latency", id: "kinds" }),
        point(shades, { x: "t", y: "v", color: "heat", panel: "errors" }),
      ],
      panels: layout,
      guides: [legend({ panel: "latency", scales: [{ mark: "regions", channel: "series" }] })],
    };
    const scene = model(config).scene(estimateText);
    const own = legends(scene).find((g) => g.panel === "latency")!;
    expect(labels(own)).toEqual(["eu", "us", "ap"]);
    // The kinds are drawn in latency but listed by no legend there: the chart's lists them,
    // with the points of errors, which has no legend.
    expect(labels(legends(scene).find((g) => g.panel === undefined))).toEqual(["x", "y", "v"]);
    // The errors panel's ramp is not latency's.
    const ramps = guidesOf(scene, "ramp");
    expect(ramps.every((ramp) => !own.items.includes(ramp.items[0]!))).toBe(true);
  });

  it("leave what a panel's legend names to the chart's legend in the panels without one", () => {
    const named = [
      line(data, { x: "t", y: "p99", color: "region", panel: "latency", id: "p99" }),
      line(data, { x: "t", y: "errors", color: "region", panel: "errors", id: "errors" }),
    ];
    const scene = model({
      marks: named,
      panels: layout,
      guides: [legend({ panel: "latency", scales: [{ mark: "p99", channel: "series" }] })],
    }).scene(estimateText);
    // Errors draws the regions too, and no legend there lists them.
    expect(labels(legends(scene).find((g) => g.panel === undefined))).toEqual(["eu", "us", "ap"]);
    // Two legends of one panel cover what either lists.
    const both = model({
      marks: named,
      panels: layout,
      guides: [
        legend({ panel: "errors" }),
        legend({ panel: "latency" }),
        legend({ panel: "latency", scales: [] }),
      ],
    }).scene(estimateText);
    expect(legends(both).find((g) => g.panel === undefined)).toBeUndefined();
  });

  it("show a map's color ramp in its panel's legend, with the chart's legend off", () => {
    const places = table({ lon: [0, 10, 20], lat: [0, 5, 10], heat: [1, 2, 3] });
    for (const chartLegend of [undefined, false]) {
      const scene = model({
        marks: [
          line(data, { x: "t", y: "p99", color: "region", panel: "latency" }),
          geopoint(places, { longitude: "lon", latitude: "lat", color: "heat", panel: "map" }),
        ],
        panels: panels(columns([1, 1], [panel("latency"), panel("map")])),
        guides: [legend({ panel: "map" })],
        ...(chartLegend === false && { legend: false }),
      }).scene(estimateText);
      // One ramp, the map's legend's: the chart's leaves it to that one.
      expect(guidesOf(scene, "ramp")).toHaveLength(1);
      const map = scene.panels.find((p) => p.key === "map")!.plot;
      const xs = guidesOf(scene, "ramp")[0]!.items.flatMap((item) =>
        "x" in item && typeof item.x === "number" ? [item.x] : [],
      );
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(map.x - 1);
    }
  });

  it("tell a pie's panel from the marks of other panels, unnamed as they are", () => {
    const shares = table({ k: ["a", "b"], n: [3, 1] });
    const sized = table({ t: [0, 1, 2], v: [1, 2, 3], n: [1, 5, 9] });
    const scene = model({
      marks: [
        pie(shares, { category: "k", value: "n", panel: "share" }),
        point(sized, { x: "t", y: "v", size: "n", panel: "points" }),
      ],
      panels: panels(columns([1, 1], [panel("share"), panel("points")])),
      guides: [legend({ panel: "share" })],
    }).scene(estimateText);
    // The pie's legend lists its slices; the points' size key is the chart's legend's alone.
    expect(labels(legends(scene).find((g) => g.panel === "share"))).toEqual(["a", "b"]);
    expect(guidesOf(scene, "key")).toHaveLength(1);
    // Whatever the points' id is.
    for (const id of ["layout 0", "-1"]) {
      const named = model({
        marks: [
          pie(shares, { category: "k", value: "n", panel: "share" }),
          point(sized, { x: "t", y: "v", size: "n", panel: "points", id }),
        ],
        panels: panels(columns([1, 1], [panel("share"), panel("points")])),
        guides: [legend({ panel: "share" })],
      }).scene(estimateText);
      expect(guidesOf(named, "key")).toHaveLength(1);
    }
  });

  it("show a legend's own entries hidden where every series they name is", () => {
    // Also of a mark the derived entries leave out.
    for (const [where, quiet] of [
      ["errors", false],
      [undefined, false],
      [undefined, true],
    ] as const) {
      const chart = model({
        marks: [
          line(data, { x: "t", y: "p99", color: "region", panel: "latency", id: "p99" }),
          line(data, {
            x: "t",
            y: "errors",
            color: "region",
            panel: "errors",
            id: "errors",
            ...(quiet && { legend: false }),
          }),
        ],
        panels: layout,
        guides: [
          legend({
            ...(where && { panel: where }),
            entries: [{ key: "all", label: "Errors", targets: [{ mark: "errors" }] }],
          }),
        ],
      });
      const entry = (scene: Scene) =>
        legends(scene)
          .find((g) => g.panel === where)!
          .entries.find((e) => e.key === "all")!;
      const shown = entry(chart.scene(estimateText));
      expect(shown.hidden).toBe(false);
      // Hidden in errors, the only panel drawing them.
      chart.hidden.panels.set("errors", new Map(targets(shown).map((key) => [key, true])));
      expect(entry(chart.scene(estimateText)).hidden).toBe(true);
    }
  });

  it("show derived entries hidden by what a legend's own entries hid, series by series", () => {
    const chart = model({
      marks: [
        line(data, { x: "t", y: "p99", color: "region", panel: "latency", id: "p99" }),
        line(data, { x: "t", y: "errors", color: "region", panel: "errors", id: "errors" }),
      ],
      panels: layout,
      guides: [
        legend({ panel: "errors" }),
        legend({
          panel: "errors",
          entries: [{ key: "all", label: "Errors", targets: [{ mark: "errors" }] }],
        }),
        legend({}),
      ],
    });
    const before = legends(chart.scene(estimateText));
    const custom = before.find((g) => g.entries.some(({ key }) => key === "all"))!;
    // The custom entry toggles the mark's series by their own keys.
    const all = custom.entries.find(({ key }) => key === "all")!;
    chart.hidden.panels.set("errors", new Map(targets(all).map((key) => [key, true])));
    const after = legends(chart.scene(estimateText));
    const derived = after.find(
      (g) => g.panel === "errors" && !g.entries.some(({ key }) => key === "all"),
    )!;
    expect(derived.entries.map(({ hidden }) => hidden)).toEqual([true, true, true]);
    // Each derived entry still toggles what its series stand for.
    expect(
      derived.entries.every((entry) => targets(entry).every((key) => key.startsWith("{"))),
    ).toBe(true);
    const chartWide = after.find((g) => g.panel === undefined)!;
    expect(chartWide.entries.map(({ mixed }) => !!mixed)).toEqual([true, true, true]);
  });

  it("leave to the chart's legend what a panel's own entries do not toggle", () => {
    const own = (targets: string[]) =>
      model({
        marks: [
          line(data, { x: "t", y: "p99", color: "region", panel: "latency", id: "q" }),
          line(data, { x: "t", y: "errors", panel: "latency", id: "r" }),
        ],
        panels: layout,
        guides: [
          legend({
            panel: "latency",
            entries: [
              { key: "own", label: "Own", targets: targets.map((mark) => ({ mark })) },
              { key: "note", label: "Note" },
            ],
          }),
        ],
      });
    const chartLegend = (targets: string[]) =>
      labels(legends(own(targets).scene(estimateText)).find((g) => g.panel === undefined));
    // Targeting q, it covers q's regions there; r stays the chart's.
    expect(chartLegend(["q"])).toEqual(["errors"]);
    // Targeting nothing, an entry that explains covers nothing.
    expect(chartLegend([])).toEqual(["eu", "us", "ap", "errors"]);
    expect(chartLegend(["q", "r"])).toBeUndefined();
  });

  it("refuse own entries of a panel's legend toggling marks it does not draw alone", () => {
    for (const [panel, message] of [
      ["*", 'mark "m" is drawn in every panel, which follows the chart\'s legend only'],
      ["errors", 'mark "m" is drawn in panel "errors", and this legend toggles panel "latency"\'s'],
    ] as const)
      expect(() =>
        model({
          marks: [
            line(data, { x: "t", y: "p99", color: "region", panel: "latency" }),
            line(data, { x: "t", y: "errors", panel, id: "m" }),
          ],
          panels: layout,
          guides: [
            legend({
              panel: "latency",
              entries: [{ key: "m", label: "M", targets: [{ mark: "m" }] }],
            }),
          ],
        }).scene(estimateText),
      ).toThrow(`chart guides[0].entries[0].targets[0].mark: ${message}`);
  });

  it("group bars and dodged points by what their panel draws", () => {
    const summary = table({
      day: ["thu", "thu", "thu", "fri", "fri", "fri"],
      sex: ["f", "m", "x", "f", "m", "x"],
      mean: [2, 3, 4, 5, 6, 7],
    });
    const chart = model({
      marks: [
        bar(summary, { x: "day", y: "mean", series: "sex", panel: "latency" }),
        point(summary, { x: "day", y: "mean", series: "sex", dodge: true, panel: "latency" }),
        bar(summary, { x: "day", y: "mean", series: "sex", panel: "errors" }),
      ],
      panels: layout,
    });
    const [f] = legends(chart.scene(estimateText))[0]!.entries;
    // Hidden in the chart, shown again in latency.
    chart.hidden.add(f!.key);
    chart.hidden.panels.set("latency", new Map([[f!.key, false]]));
    const scene = chart.scene(estimateText);
    const of = <G>(key: string, kind: string) =>
      scene.panels.find((p) => p.key === key)!.marks.filter((m) => m.kind === kind) as G[];
    const centers = (bars: RectGeometry) => bars.rects[0]! + bars.rects[2]! / 2;
    const latency = of<RectGeometry>("latency", "rect").map(centers);
    expect(new Set(latency).size).toBe(3);
    const points = of<PointGeometry>("latency", "point").map(({ coords }) => coords[0]!);
    expect(points.map(Math.round)).toEqual(latency.map(Math.round));
    // Two groups in errors, where it stays hidden.
    expect(new Set(of<RectGeometry>("errors", "rect").map(centers)).size).toBe(2);
  });

  it("let a chart-wide change clear what panels set of it", () => {
    const set = panels(columns([1, 1], [panel({ id: "latency" }), panel({ id: "errors" })]));
    const chart = model({ marks, panels: set });
    const hidden = chart.hidden;
    hidden.panels.set(
      "errors",
      new Map([
        ["eu", true],
        ["us", false],
      ]),
    );
    // Shown in errors, and hidden everywhere else.
    const local = set.visibility(hidden, ["us"], false, "latency");
    expect(local.get("latency")).toEqual(new Map([["us", true]]));
    expect(local.get("errors")).toEqual(hidden.panels.get("errors"));
    // A change for the whole chart lets go of the panels' settings of it.
    const wide = set.visibility(hidden, ["eu"], true, undefined);
    expect(wide.get("errors")).toEqual(new Map([["us", false]]));
    expect(
      set.overrides(
        new Map([
          [
            "errors",
            new Map([
              ["eu", true],
              ["us", false],
            ]),
          ],
        ]),
      ),
    ).toEqual({
      panels: { errors: { hidden: ["eu"], shown: ["us"] } },
    });
    expect(() => set.visibility(hidden, ["eu"], true, "traffic")).toThrow(
      'setVisibility panel: no panel "traffic"',
    );
  });

  it("keep each series' color in every facet panel when one is hidden", () => {
    const chart = model({
      marks: [line(data, { x: "t", y: "p99", series: "region" })],
      facet: facet("region"),
    });
    // Each panel's lines by series, with their colors.
    const colorsOf = (scene: Scene) =>
      scene.panels.map((p) =>
        Object.fromEntries(
          p.marks.filter((m): m is LineGeometry => m.kind === "line").map((m) => [m.key, m.stroke]),
        ),
      );
    const before = chart.scene(estimateText);
    const was = colorsOf(before);
    const eu = legends(before)[0]!.entries.find(({ label }) => label === "eu")!;
    for (const key of targets(eu)) chart.hidden.add(key);
    const now = colorsOf(chart.scene(estimateText));
    for (const [i, colors] of now.entries()) {
      const { '[0,"eu"]': hidden, ...kept } = was[i]!;
      expect(hidden).toBeDefined();
      expect(colors).toEqual(kept);
    }
  });
});
