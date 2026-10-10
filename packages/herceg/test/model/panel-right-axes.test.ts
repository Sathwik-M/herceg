// Right y axes in charts with facets and subplots: every panel drawing marks
// with `axis: "right"` has one, shared or resolved apart as `resolve.yRight`
// (by default as `resolve.y`) says.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { rule } from "../../src/marks/rule.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { AxisGeometry, Panel } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ScaleResolution } from "../../src/spec/spec.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const axis = (panel: Panel, orient: AxisGeometry["orient"]) =>
  panel.axes.find((a) => a.orient === orient);

// Two regions: latency in ms on the left, requests in thousands on the right,
// the south's ten times the north's.
const traffic = table({
  t: [0, 1, 2, 0, 1, 2],
  ms: [10, 20, 30, 15, 25, 35],
  requests: [1000, 2000, 3000, 10_000, 20_000, 30_000],
  region: ["N", "N", "N", "S", "S", "S"],
});
const both = () => [
  line(traffic, { x: "t", y: "ms" }),
  line(traffic, { x: "t", y: "requests", axis: "right" }),
];

describe("right axes in facets", () => {
  it("share one right scale by default, labeled beside each row's last panel and titled once", () => {
    const { model, scene } = build({
      marks: both(),
      facet: facet("region"),
      yRight: { label: "requests" },
    });
    const [n, s] = model.panels();
    expect(n!.yRight!.domain).toEqual(s!.yRight!.domain);
    expect(n!.yRight!.domain[1]).toBeGreaterThanOrEqual(30_000);
    expect([n!.yRightGroup, s!.yRightGroup]).toEqual(["", ""]);
    // Two panels in a row: the left labels go beside the first, the right ones beside the last.
    const [left, right] = scene.panels;
    expect(axis(left!, "left")).toBeDefined();
    expect(axis(left!, "right")).toBeUndefined();
    expect(axis(right!, "left")).toBeUndefined();
    const labels = axis(right!, "right")!;
    expect(labels.ticks.length).toBeGreaterThan(0);
    expect(labels.title?.text).toBe("requests");
    // The title is at the chart's edge, outside the labels, centered on the grid.
    expect(labels.title!.x).toBeGreaterThan(right!.plot.x + right!.plot.width + 20);
    // Each panel draws its own rows' right line with the right scale.
    const ys = model.panelSeries("S").find((series) => series.label === "requests")!;
    expect(ys.length).toBe(3);
  });

  it("fit each panel's own right rows with right scales of their own, labeling every panel", () => {
    for (const resolve of [{ yRight: "independent" }, { y: "independent" }] as const) {
      const { model, scene } = build({ marks: both(), facet: facet("region"), resolve });
      const [n, s] = model.panels();
      expect(n!.yRight!.domain[1]).toBeLessThan(10_000);
      expect(s!.yRight!.domain[1]).toBeGreaterThanOrEqual(30_000);
      expect(n!.yRightGroup).not.toBe(s!.yRightGroup);
      expect(scene.panels.map((p) => axis(p, "right")?.ticks.length ?? 0)).toEqual([
        expect.any(Number),
        expect.any(Number),
      ]);
      for (const panel of scene.panels)
        expect(axis(panel, "right")!.ticks.length).toBeGreaterThan(0);
      // The gap between the columns holds the first panel's right labels.
      const [a, b] = scene.panels;
      const widest = Math.max(
        ...axis(a!, "right")!.ticks.map(({ label }) => estimateText(label, "12px sans-serif")),
      );
      expect(b!.plot.x - (a!.plot.x + a!.plot.width)).toBeGreaterThan(widest);
    }
    // Only the right side apart: the left one stays shared.
    const { model } = build({
      marks: both(),
      facet: facet("region"),
      resolve: { yRight: "independent" },
    });
    const [n, s] = model.panels();
    expect(n!.y.domain).toEqual(s!.y.domain);
    // And the right side shared while the left one is not.
    const shared = build({
      marks: both(),
      facet: facet("region"),
      resolve: { y: "independent", yRight: "shared" },
    }).model.panels();
    expect(shared[0]!.yRight!.domain).toEqual(shared[1]!.yRight!.domain);
    expect(shared[0]!.y.domain).not.toEqual(shared[1]!.y.domain);
  });

  it("share a right scale along rows or columns of a grid, with row headers beyond its labels", () => {
    const grid = table({
      t: [0, 1, 0, 1, 0, 1, 0, 1],
      v: [1, 2, 3, 4, 5, 6, 7, 8],
      w: [1, 2, 10, 20, 100, 200, 1000, 2000],
      region: ["N", "N", "N", "N", "S", "S", "S", "S"],
      product: ["a", "a", "b", "b", "a", "a", "b", "b"],
    });
    const config = (yRight: ScaleResolution): ChartConfig => ({
      marks: [line(grid, { x: "t", y: "v" }), line(grid, { x: "t", y: "w", axis: "right" })],
      facet: facet({ row: "region", column: "product" }),
      resolve: { yRight },
    });
    const rows = build(config("rows"));
    const [na, nb, sa, sb] = rows.model.panels();
    expect(na!.yRight!.domain).toEqual(nb!.yRight!.domain);
    expect(sa!.yRight!.domain).toEqual(sb!.yRight!.domain);
    expect(na!.yRight!.domain).not.toEqual(sa!.yRight!.domain);
    // Labels beside each row's last panel; the row's header beyond them.
    const panelsDrawn = rows.scene.panels;
    expect(panelsDrawn.map((p) => axis(p, "right") !== undefined)).toEqual([
      false,
      true,
      false,
      true,
    ]);
    const header = rows.scene.headers.find(({ text }) => text === "N")!;
    const labels = axis(panelsDrawn[1]!, "right")!;
    const widest = Math.max(
      ...labels.ticks.map(({ label }) => estimateText(label, "12px sans-serif")),
    );
    expect(header.x).toBeGreaterThan(labels.offset + 8 + widest);
    expect(header.x).toBeLessThan(600);
    const columns = build(config("columns")).model.panels();
    expect(columns[0]!.yRight!.domain).toEqual(columns[2]!.yRight!.domain);
    expect(columns[0]!.yRight!.domain).not.toEqual(columns[1]!.yRight!.domain);
  });

  it("refuse a y zoom over right scales of their own, and y viewports of either side apart", () => {
    expect(() =>
      build({
        marks: both(),
        facet: facet("region"),
        resolve: { yRight: "independent" },
        interaction: { zoom: "xy" },
      }),
    ).toThrow('right y scales of their own (resolve.yRight "independent") cannot zoom along y');
    // Without marks placing values on the right, there is no right scale to zoom.
    for (const extra of [[], [rule({ x: 0.5, axis: "right" })]]) {
      const { scene } = build({
        marks: [line(traffic, { x: "t", y: "ms" }), ...extra],
        facet: facet("region"),
        resolve: { yRight: "independent" },
        interaction: { zoom: "xy" },
      });
      for (const panel of scene.panels) expect(axis(panel, "right")).toBeUndefined();
    }
    const { model } = build({ marks: both(), facet: facet("region") });
    model.setYViewport({ y: [0, 20], yRight: [0, 5000] });
    model.scene(estimateText);
    expect(model.panels().map((p) => p.yRight!.domain)).toEqual([
      [0, 5000],
      [0, 5000],
    ]);
    // Giving the right side scales of its own lets go of its viewport only.
    model.update({ marks: both(), facet: facet("region"), resolve: { yRight: "independent" } });
    expect(model.yViewport).toEqual({ y: [0, 20], yRight: null });
    expect(() => model.setYViewport({ y: null, yRight: [0, 1] })).toThrow("no one viewport");
    model.setYViewport({ y: [0, 10], yRight: null });
    expect(model.yViewport.y).toEqual([0, 10]);
  });

  it("read right values in each panel's tooltips by its own right axis", () => {
    const { model } = build({
      marks: both(),
      facet: facet("region"),
      resolve: { yRight: "independent" },
    });
    const s = model.panels()[1]!;
    const inspection = model.inspect(s.x.map(1), s.yRight!.map(20_000), "nearest", "S")!;
    expect(inspection.panel).toBe("S");
    expect(inspection.points.map(({ label, text }) => [label, text])).toEqual([
      ["requests", "20,000"],
    ]);
    expect(model.yRightFormat("S")!(12_345)).toBe("12,345");
    expect(describeChart(model)).toContain("ms (left axis)");
  });
});

describe("right axes in subplots", () => {
  const metrics = table({
    t: [0, 1, 2],
    ms: [10, 20, 30],
    requests: [100, 2000, 3000],
    errors: [1, 2, 3],
  });

  it("go on the panels drawing marks on them, with each panel's own settings", () => {
    const { model, scene } = build({
      marks: [
        line(metrics, { x: "t", y: "ms", panel: "latency" }),
        line(metrics, { x: "t", y: "requests", axis: "right", panel: "latency" }),
        line(metrics, { x: "t", y: "errors", panel: "errors" }),
        rule({ x: 1, panel: "*" }),
      ],
      panels: panels([
        { id: "latency", y: { label: "ms" }, yRight: { label: "requests", type: "log" } },
        { id: "errors" },
      ]),
      yRight: { grid: false },
    });
    const [latency, errors] = model.panels();
    expect(latency!.yRight!.type).toBe("log");
    expect(errors!.yRight).toBeUndefined();
    expect(errors!.yRightGroup).toBe("");
    const [a, b] = scene.panels;
    expect(axis(a!, "right")!.title!.text).toBe("requests");
    // A subplot's right title is beside its own plot.
    expect(axis(a!, "right")!.title!.y).toBeCloseTo(a!.plot.y + a!.plot.height / 2, 6);
    expect(axis(b!, "right")).toBeUndefined();
    expect(axis(b!, "left")).toBeDefined();
  });

  it("leave the left axis out of panels drawing on the right only, their grid following it", () => {
    const { scene, model } = build({
      marks: [
        line(metrics, { x: "t", y: "ms", panel: "a" }),
        line(metrics, { x: "t", y: "requests", axis: "right", panel: "b" }),
      ],
      panels: panels([{ id: "a" }, { id: "b" }]),
    });
    const [a, b] = scene.panels;
    expect(axis(a!, "left")).toBeDefined();
    expect(axis(b!, "left")).toBeUndefined();
    expect(axis(b!, "right")!.ticks.length).toBeGreaterThan(0);
    const right = model.panels()[1]!.yRight!;
    expect(b!.grid.y.length).toBeGreaterThan(0);
    for (const y of b!.grid.y) expect(right.invert(y)).toBeGreaterThanOrEqual(0);
  });

  it("share a right scale when asked, if the panels sharing it agree on it", () => {
    const config = (yRight?: { type: "log" }): ChartConfig => ({
      marks: [
        line(metrics, { x: "t", y: "requests", axis: "right", panel: "a" }),
        line(metrics, { x: "t", y: "errors", axis: "right", panel: "b" }),
        line(metrics, { x: "t", y: "ms", panel: "c" }),
      ],
      panels: panels([{ id: "a" }, { id: "b", ...(yRight && { yRight }) }, { id: "c" }]),
      resolve: { yRight: "shared" },
    });
    const { model } = build(config());
    const [a, b, c] = model.panels();
    expect(a!.yRight!.domain).toEqual(b!.yRight!.domain);
    expect(a!.yRightGroup).toBe(b!.yRightGroup);
    expect(c!.yRight).toBeUndefined();
    expect(() => build(config({ type: "log" }))).toThrow(
      'Panel "b" shares a right y scale with others but differs',
    );
    // By default, as `resolve.y` says: here each panel's own.
    const own = build({ ...config(), resolve: {} }).model.panels();
    expect(own[0]!.yRight!.domain).not.toEqual(own[1]!.yRight!.domain);
  });

  it("fit each subplot's own log axes, on either side, to the values they can place", () => {
    const signed = table({ t: [0, 1, 2], v: [-10, 1, 10] });
    const { model } = build({
      marks: [
        line(signed, { x: "t", y: "v", panel: "a" }),
        bar(signed, { x: "t", y: "v", panel: "b" }),
        line(signed, { x: "t", y: "v", axis: "right", panel: "b" }),
      ],
      panels: panels([
        { id: "a", y: { type: "log" } },
        { id: "b", y: { type: "log" }, yRight: { type: "log" } },
      ]),
    });
    const [a, b] = model.panels();
    for (const scale of [a!.y, b!.y, b!.yRight!]) {
      expect(scale.type).toBe("log");
      expect(Math.min(...scale.domain)).toBeGreaterThan(0);
      expect(Math.max(...scale.domain)).toBeGreaterThanOrEqual(10);
    }
  });

  it("leave the left axis out beside a category one in another subplot", () => {
    const sales = table({ product: ["a", "b"], units: [1, 2] });
    const { scene, model } = build({
      marks: [
        bar(sales, { x: "units", y: "product", panel: "a" }),
        line(metrics, { x: "t", y: "requests", axis: "right", panel: "b" }),
      ],
      panels: panels([{ id: "a" }, { id: "b" }]),
      resolve: { x: "independent" },
    });
    const [a, b] = scene.panels;
    expect(axis(a!, "left")!.ticks.map(({ label }) => label)).toEqual(["a", "b"]);
    expect(axis(b!, "left")).toBeUndefined();
    expect(axis(b!, "right")!.ticks.length).toBeGreaterThan(0);
    expect(b!.grid.y.length).toBe(axis(b!, "right")!.ticks.length);
    expect(model.panels()[1]!.yRight!.domain[1]).toBeGreaterThanOrEqual(3000);
  });

  it("agree on a shared scale only among the panels that have its axis", () => {
    const times = table({ t: [0, 1, 2], at: time([0, 60_000, 120_000]), n: [1, 2, 3] });
    // A right-only panel has no left axis to disagree on, and a vertical
    // rule on the right places no y values, in either order.
    const cases: [ChartConfig["marks"], NonNullable<ChartConfig["resolve"]>][] = [
      [
        [
          line(times, { x: "t", y: "n", axis: "right", panel: "a" }),
          line(times, { x: "t", y: "at", panel: "b" }),
        ],
        { y: "shared" },
      ],
      [
        [
          rule({ x: 1, axis: "right", panel: "a" }),
          line(times, { x: "t", y: "at", axis: "right", panel: "b" }),
        ],
        { yRight: "shared" },
      ],
    ];
    for (const [marks, resolve] of cases) {
      for (const order of [
        ["a", "b"],
        ["b", "a"],
      ]) {
        const { model } = build({
          marks,
          panels: panels(order.map((id) => ({ id }))),
          resolve,
        });
        const b = model.panels().find(({ key }) => key === "b")!;
        expect((resolve.y ? b.y : b.yRight!).type).toBe("time");
      }
    }
  });

  it("refuse right settings on a panel a layout mark has to itself", () => {
    expect(() =>
      build({
        marks: [
          line(metrics, { x: "t", y: "ms", panel: "a" }),
          pie(table({ c: ["x", "y"], v: [1, 2] }), { category: "c", value: "v", panel: "b" }),
        ],
        panels: panels([{ id: "a" }, { id: "b", yRight: { label: "no" } }]),
      }),
    ).toThrow("it takes no x, y, or yRight settings");
  });

  it("keep horizontal and category marks on the left", () => {
    const sales = table({ product: ["a", "b"], units: [1, 2] });
    expect(() =>
      build({
        marks: [bar(sales, { x: "units", y: "product", axis: "right" as never, panel: "a" })],
        panels: panels([{ id: "a" }]),
      }),
    ).toThrow("placed along y cannot use the right axis");
  });
});

describe("right axes in panels from specs", () => {
  it("load resolve.yRight and panels' own yRight without a new version", () => {
    const spec = {
      version: 2 as const,
      data: {
        traffic: {
          columns: {
            t: [0, 1, 0, 1],
            ms: [1, 2, 3, 4],
            requests: [10, 20, 300, 400],
            region: ["N", "N", "S", "S"],
          },
        },
      },
      marks: [
        { type: "line" as const, data: "traffic", x: "t", y: "ms" },
        { type: "line" as const, data: "traffic", x: "t", y: "requests", axis: "right" as const },
      ],
      facet: { field: "region" },
      resolve: { yRight: "independent" as const },
      yRight: { label: "requests" },
    };
    // Every property is known: none is refused as unknown.
    const { config } = loadSpec(spec, [], { unknown: "error" });
    const { model } = build(config);
    expect(model.panels()[0]!.yRight!.domain).not.toEqual(model.panels()[1]!.yRight!.domain);
    expect(renderToSVG({ ...config, width: 600, height: 300 })).toContain(">requests</text>");
    const subplots = loadSpec(
      {
        version: 2,
        data: spec.data,
        marks: [{ ...spec.marks[1]!, panel: "a" }],
        panels: [{ id: "a", yRight: { type: "log" } }],
      },
      [],
      { unknown: "error" },
    );
    expect(build(subplots.config).model.panels()[0]!.yRight!.type).toBe("log");
  });
});
