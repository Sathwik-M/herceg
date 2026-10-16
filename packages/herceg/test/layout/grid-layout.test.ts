// Layouts of grids: compiling the tree, sizing its tracks, and the scopes
// that group panels' scales by the cells they are in.
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { axis } from "../../src/guides/options.ts";
import { compileLayout, linedUp, scopeGroups } from "../../src/layout/compile.ts";
import { type AxisNeeds, isShort, solveAxis } from "../../src/layout/grid.ts";
import { normalizeLayout } from "../../src/layout/options.ts";
import { estimateText } from "../../src/layout/text.ts";
import { cell, columns, grid, inset, mosaic, panel, rows } from "../../src/layout.ts";
import { line } from "../../src/marks/line.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import type { LayoutSpec } from "../../src/spec/spec.ts";

/** A compiled layout of `layout`, whose panels are those it names. */
function compiled(layout: Parameters<typeof normalizeLayout>[1]) {
  const normal = normalizeLayout([], layout);
  return compileLayout(
    normal.layout,
    normal.list.map(({ id }) => id),
  );
}

const none = (count: number): AxisNeeds => ({
  before: new Float64Array(count),
  after: new Float64Array(count),
  least: 10,
});

/** Each panel's plot along an axis, as [start, end] pairs by panel id. */
function plots(
  layout: ReturnType<typeof compiled>,
  axis: "x" | "y",
  length: number,
  needs?: AxisNeeds,
) {
  const solved = solveAxis(layout, axis, 0, length, needs ?? none(layout.order.length));
  if (isShort(solved)) throw new Error(`short by ${solved.needed}`);
  return Object.fromEntries(
    layout.order.map((id, i) => [id, [solved.plot[2 * i]!, solved.plot[2 * i + 1]!]]),
  );
}

describe("grid layouts", () => {
  it("hold cells spanning tracks without making their tracks' minimums of them", () => {
    const spans = compiled(
      grid({ columns: [1, 1, 1], rows: [1, 1], gap: 0 }, [
        cell({ row: 0, column: 0, columnSpan: 2 }, panel("a")),
        cell({ row: 1, column: 1, columnSpan: 2 }, panel("b")),
      ]),
    );
    const needs = { ...none(2), least: 48 };
    // Equal columns hold both where they can.
    expect(plots(spans, "x", 90, needs)).toEqual({ a: [0, 60], b: [30, 90] });
    // And the middle column alone can hold both: 48 px are enough.
    expect(isShort(solveAxis(spans, "x", 0, 48, needs))).toBe(false);
    const tight = plots(spans, "x", 60, needs);
    expect(tight.a![1]! - tight.a![0]!).toBeGreaterThanOrEqual(47.5);
    expect(tight.b![1]! - tight.b![0]!).toBeGreaterThanOrEqual(47.5);
    // Whatever the weights: a light middle column takes what both need.
    const uneven = compiled(
      grid({ columns: [100, 1, 100], rows: [1, 1], gap: 0 }, [
        cell({ row: 0, column: 0, columnSpan: 2 }, panel("a")),
        cell({ row: 1, column: 1, columnSpan: 2 }, panel("b")),
      ]),
    );
    const held = plots(uneven, "x", 60, needs);
    expect(held.a![1]! - held.a![0]!).toBeGreaterThanOrEqual(47.5);
    expect(held.b![1]! - held.b![0]!).toBeGreaterThanOrEqual(47.5);
  });

  it("keep neighbors' x labels apart, however small the gap between them", () => {
    const data = table({ t: [0, 10], v: [1, 2] });
    for (const gap of [0, 4, 12]) {
      const model = new ChartModel({
        locale: "en-US",
        timeZone: "UTC",
        marks: ["a", "b"].map((panel) => line(data, { x: "t", y: "v", panel })),
        y: { show: false },
        x: { domain: [0, 10] },
        panels: panels(columns([1, 1], [panel("a"), panel("b")], { gap })),
      });
      model.setSize(600, 300, 1);
      const scene = model.scene(estimateText);
      const ends = scene.panels.map(({ axes }) => {
        const x = axes.find(({ scale }) => scale === "x")!;
        const { css } = x.paints.label;
        const [first, last] = [x.ticks[0]!, x.ticks.at(-1)!];
        return [
          first.position - estimateText(first.label, css) / 2,
          last.position + estimateText(last.label, css) / 2,
        ] as const;
      });
      // The left panel's last label ends before the right one's first begins.
      expect(ends[0]![1], `gap ${gap}`).toBeLessThanOrEqual(ends[1]![0] + 0.5);
    }
  });

  it("share what is left by weight, keeping fixed tracks and minimums", () => {
    const weighted = compiled(columns([2, 1], [panel("a"), panel("b")], { gap: 0 }));
    expect(plots(weighted, "x", 300)).toEqual({ a: [0, 200], b: [200, 300] });
    const fixed = compiled(
      columns([{ px: 100 }, 1, 1], [panel("a"), panel("b"), panel("c")], { gap: 0 }),
    );
    expect(plots(fixed, "x", 300)).toEqual({ a: [0, 100], b: [100, 200], c: [200, 300] });
    // Tracks under their least take it, and the others share what is left.
    const minima = compiled(
      columns(
        [1, { weight: 1, min: 60 }, { weight: 1, min: 40 }],
        [panel("a"), panel("b"), panel("c")],
        {
          gap: 0,
        },
      ),
    );
    expect(plots(minima, "x", 150)).toEqual({ a: [0, 45], b: [45, 105], c: [105, 150] });
    // A minimum holds a track where its weight would give it less.
    const least = compiled(
      columns([{ weight: 1, min: 120 }, 9], [panel("a"), panel("b")], { gap: 0 }),
    );
    expect(plots(least, "x", 300).a).toEqual([0, 120]);
    // Gaps go between tracks.
    const gapped = compiled(rows([1, 1], [panel("a"), panel("b")], { gap: 20 }));
    expect(plots(gapped, "y", 220)).toEqual({ a: [0, 100], b: [120, 220] });
  });

  it("line up plots across a track: each takes the most room any cell beside it needs", () => {
    const layout = compiled(columns([1, 1], [panel("a"), panel("b")], { gap: 0 }));
    // b's title and axis take 30 px above its plot: a's plot starts there too.
    const needs: AxisNeeds = {
      before: Float64Array.from([0, 30]),
      after: Float64Array.from([10, 0]),
      least: 10,
    };
    const y = compiled(columns([1, 1], [panel("a"), panel("b")], { gap: 0 }));
    expect(plots(y, "y", 200, needs)).toEqual({ a: [30, 190], b: [30, 190] });
    expect(layout.order).toEqual(["a", "b"]);
  });

  it("span tracks, and their gaps, with spanning cells; nest grids, and leave cells empty", () => {
    const spans = compiled(
      grid({ rows: [1, 1], columns: [1, 1], gap: 10 }, [
        cell({ row: 0, column: 0 }, panel("a")),
        cell({ row: 1, column: 0 }, panel("b")),
        cell({ row: 0, column: 1, rowSpan: 2 }, panel("c")),
      ]),
    );
    const y = plots(spans, "y", 210);
    expect(y).toEqual({ a: [0, 100], b: [110, 210], c: [0, 210] });
    // A nested grid's panels take the room of its cell; an empty cell keeps its track.
    const nested = compiled(
      grid({ rows: [1], columns: [1, 1, 1], gap: 0 }, [
        cell({ row: 0, column: 0 }, rows([1, 1], [panel("a"), panel("b")], { gap: 0 })),
        cell({ row: 0, column: 2 }, panel("c")),
      ]),
    );
    expect(plots(nested, "x", 300)).toEqual({ a: [0, 100], b: [0, 100], c: [200, 300] });
    expect(plots(nested, "y", 200)).toEqual({ a: [0, 100], b: [100, 200], c: [0, 200] });
  });

  it("say how much room they need when they do not fit", () => {
    const layout = compiled(columns([1, 1, 1], [panel("a"), panel("b"), panel("c")], { gap: 12 }));
    const solved = solveAxis(layout, "x", 0, 40, none(3));
    expect(isShort(solved) && solved.needed).toBe(3 * 10 + 2 * 12);
  });

  it("refuse cells that overlap, panels placed twice or nowhere, and indexes past the tracks", () => {
    const ids = ["a", "b"];
    const refused =
      (spec: LayoutSpec, list = ids) =>
      () =>
        compileLayout(spec, list);
    expect(
      refused({
        type: "grid",
        columns: [1, 1],
        cells: [
          { row: 0, column: 0, columnSpan: 2, content: { type: "panel", panel: "a" } },
          { row: 0, column: 1, content: { type: "panel", panel: "b" } },
        ],
      }),
    ).toThrow(
      "layout.cells[1]: overlaps cell 0; cells of a grid cannot overlap; use an inset to draw a panel over another",
    );
    expect(
      refused({
        type: "grid",
        columns: [1, 1],
        cells: [
          { row: 0, column: 0, content: { type: "panel", panel: "a" } },
          { row: 0, column: 1, content: { type: "panel", panel: "a" } },
        ],
      }),
    ).toThrow(/layout.cells\[1\].content.panel: panel "a" is placed twice/);
    expect(refused({ type: "panel", panel: "a" })).toThrow(
      'layout: panel "b" is placed nowhere; place it in a cell or as an inset, or drop it from panels',
    );
    expect(
      refused(
        {
          type: "grid",
          columns: [1],
          cells: [{ row: 0, column: 3, content: { type: "panel", panel: "a" } }],
        },
        ["a"],
      ),
    ).toThrow(/layout.cells\[0\].column/);
    expect(refused({ type: "panel", panel: "z" }, ["a"])).toThrow(
      'layout.panel: no panel "z"; name one of "a"',
    );
  });

  it("refuse mosaics that are not rectangles, ragged, or of other track counts", () => {
    expect(() =>
      mosaic([
        ["a", "b"],
        ["b", "a"],
      ]),
    ).toThrow(
      'mosaic: panel "a" occupies a region that is not a rectangle; give each panel a rectangle of cells',
    );
    expect(() => mosaic([["a", "b"], ["c"]])).toThrow(
      "mosaic[1]: expected 2 cells, as the first row has; received 1",
    );
    expect(() => mosaic([["a", "b"]], { columns: [1] })).toThrow(
      "mosaic columns: expected 2, one per column; received 1",
    );
    // A repeated id spans its rectangle; null leaves a cell empty.
    const layout = compiled(
      mosaic(
        [
          ["a", "c"],
          ["b", "c"],
          [null, "c"],
        ],
        { gap: 0 },
      ),
    );
    expect(plots(layout, "y", 300)).toEqual({ a: [0, 100], b: [100, 200], c: [0, 300] });
  });

  it("group panels' scales by panel, chart, the grid's rows or columns, a named grid's, or a list", () => {
    const layout = compiled(
      grid({ id: "outer", rows: [1, 1], columns: [1, 1] }, [
        cell({ row: 0, column: 0 }, panel("a")),
        cell({ row: 0, column: 1 }, panel("b")),
        cell({ row: 1, column: 0 }, panel("c")),
        cell({ row: 1, column: 1 }, panel({ id: "d" }, [inset("e")])),
      ]),
    );
    const at = (scope: Parameters<typeof scopeGroups>[1]) => scopeGroups(layout, scope, "x.scope");
    expect(layout.order).toEqual(["a", "b", "c", "d", "e"]);
    expect(at("panel")).toEqual([0, 1, 2, 3, 4]);
    // The chart's scale leaves insets their own.
    expect(at("chart")).toEqual([0, 0, 0, 0, 1]);
    expect(at("row")).toEqual([0, 0, 1, 1, 2]);
    expect(at("column")).toEqual([0, 1, 0, 1, 2]);
    expect(at({ layout: "outer", by: "column" })).toEqual(at("column"));
    expect(at({ panels: ["a", "e"] })).toEqual([0, 1, 2, 3, 0]);
    expect(() => at({ panels: ["z"] })).toThrow('x.scope.panels[0]: no panel "z"');
    // Panels in a column line up along x, those in a row along y.
    expect(linedUp(layout, 0, 2, "x")).not.toBe(0);
    expect(linedUp(layout, 0, 1, "x")).toBe(0);
    // A grid of fixed tracks need not fill its cell: its panels line up with nothing across it.
    const fixed = compiled(rows(2, [columns([{ px: 150 }], [panel("a")]), panel("b")]));
    expect(linedUp(fixed, 0, 1, "x")).toBe(0);
    const flexible = compiled(rows(2, [columns([1], [panel("a")]), panel("b")]));
    expect(linedUp(flexible, 0, 1, "x")).toBe(1);
  });
});

describe("reading order", () => {
  it("reads a grid's cells by row, then column, whatever order they are listed in", () => {
    const layout = compiled(
      grid({ rows: [1, 1], columns: [1, 1] }, [
        cell({ row: 1, column: 1 }, panel("d")),
        cell({ row: 1, column: 0 }, panel("c")),
        cell({ row: 0, column: 1 }, panel("b")),
        cell({ row: 0, column: 0 }, panel("a")),
      ]),
    );
    expect(layout.order).toEqual(["a", "b", "c", "d"]);
    // The first grid in reading order takes the panels a layout leaves to fill.
    const filled = compileLayout(
      {
        type: "grid",
        rows: [1, 1],
        columns: [1],
        cells: [
          { row: 1, column: 0, content: { type: "grid", columns: [1] } },
          { row: 0, column: 0, content: { type: "grid", columns: [1, 1] } },
        ],
      },
      ["a", "b", "c", "d"],
    );
    expect(scopeGroups(filled, "row", "x.scope")).toEqual([0, 0, 1, 1]);
  });
});

describe("charts of grid layouts", () => {
  const data = table({ t: [0, 1, 2, 3], v: [3, 5, 4, 6] });
  const build = (config: ChartConfig, width = 600, height = 400) => {
    const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
    model.setSize(width, height, 1);
    return { model, scene: () => model.scene(estimateText) };
  };
  const two = (layout: Parameters<typeof panels>[0]) => ({
    marks: [line(data, { x: "t", y: "v", panel: "a" }), line(data, { x: "t", y: "v", panel: "b" })],
    panels: panels(layout as never),
  });

  it("lay out each chart given one configuration as if it were alone", () => {
    const shared = panels(columns([1, 1], [panel("a"), panel("b")]));
    const wide = table({ t: [0, 1, 2, 3], v: [3e9, 5e9, 4e9, 6e9] });
    const chart = (rows: typeof data) =>
      build({
        marks: [
          line(rows, { x: "t", y: "v", panel: "a" }),
          line(rows, { x: "t", y: "v", panel: "b" }),
        ],
        panels: shared,
      });
    const narrow = chart(data);
    const before = narrow.scene().panels[0]!.plot.x;
    // Another chart's wider labels leave this one's margins as they were.
    chart(wide).scene();
    expect(narrow.scene().panels[0]!.plot.x).toBe(before);
  });

  it("refuse a size too small for their panels, and draw again once it is larger", () => {
    const chart = build(two(columns([1, 1], [panel("a"), panel("b")])), 120, 400);
    expect(() => chart.scene()).toThrow(
      /layout: needs at least \d+ px of width for its panels' plots, titles, and axes, and has \d+ px; make the chart wider/,
    );
    chart.model.setSize(600, 400, 1);
    expect(chart.scene().panels).toHaveLength(2);
  });

  it("label the outer panels of a column sharing x, or every one with repeat", () => {
    const stacked = rows([1, 1], [panel("a"), panel("b")]);
    const labeled = (config: ChartConfig) =>
      build(config)
        .scene()
        .panels.map((p) => p.axes.some((a) => a.side === "bottom"));
    expect(labeled({ ...two(stacked), x: { scope: "chart" } })).toEqual([false, true]);
    expect(labeled({ ...two(stacked), x: { scope: "chart", repeat: "all" } })).toEqual([
      true,
      true,
    ]);
    // Scales of their own label each panel.
    expect(labeled(two(stacked))).toEqual([true, true]);
    // A panel of a fixed width over a wider one keeps its labels.
    const fixed = rows(2, [columns([{ px: 150 }], [panel("a")]), panel("b")]);
    expect(labeled({ ...two(fixed), x: { scope: "chart" } })).toEqual([true, true]);
    // An axis the guides list repeats as the scale's own setting would.
    const model = new ChartModel(
      {
        locale: "en-US",
        timeZone: "UTC",
        ...two(stacked),
        x: { scope: "chart" },
        guides: [axis({ scale: "x", repeat: "all" })],
      },
      undefined,
      ...staticCompilers(),
    );
    model.setSize(600, 400, 1);
    expect(
      model.scene(estimateText).panels.map((p) => p.axes.some((a) => a.side === "bottom")),
    ).toEqual([true, true]);
    // Facet panels sharing x repeat its labels under every row, and y beside every column.
    const regions = table({
      t: [0, 1, 0, 1, 0, 1, 0, 1],
      v: [1, 2, 3, 4, 5, 6, 7, 8],
      g: ["a", "a", "b", "b", "c", "c", "d", "d"],
    });
    const faceted = build(
      {
        marks: [line(regions, { x: "t", y: "v" })],
        facet: facet("g", { columns: 2 }),
        x: { repeat: "all" },
        y: { repeat: "all" },
      },
      600,
      400,
    ).scene();
    expect(
      faceted.panels.map((p) => [
        p.axes.some((a) => a.side === "bottom"),
        p.axes.some((a) => a.side === "left"),
      ]),
    ).toEqual([
      [true, true],
      [true, true],
      [true, true],
      [true, true],
    ]);
  });

  it("draw an axis above the plots where its own repeat says, keeping room for it over each", () => {
    const stacked = rows([1, 1], [panel("a"), panel("b")]);
    const regions = table({
      t: [0, 1, 0, 1, 0, 1, 0, 1],
      v: [1, 2, 3, 4, 5, 6, 7, 8],
      g: ["a", "a", "b", "b", "c", "c", "d", "d"],
    });
    for (const config of [
      { ...two(stacked), x: { scope: "chart" } },
      { marks: [line(regions, { x: "t", y: "v" })], facet: facet({ row: "g" }) },
    ] as ChartConfig[]) {
      const sides = (top?: "all") => {
        const model = new ChartModel(
          {
            locale: "en-US",
            timeZone: "UTC",
            ...config,
            guides: [
              axis({ scale: "x", repeat: "outer" }),
              axis({ scale: "x", place: { side: "top" }, ...(top && { repeat: top }) }),
            ],
          },
          undefined,
          ...staticCompilers(),
        );
        model.setSize(600, 400, 1);
        const scene = model.scene(estimateText);
        return scene.panels.map((p) => ({
          plot: p.plot,
          top: p.axes.find((a) => a.side === "top"),
          bottom: p.axes.some((a) => a.side === "bottom"),
        }));
      };
      // Outer, as the axis on the bottom: above the first panel only.
      const outer = sides();
      expect(outer.map(({ top }) => !!top)).toEqual(outer.map((_, i) => i === 0));
      expect(outer.at(-1)!.bottom).toBe(true);
      const all = sides("all");
      expect(all.map(({ top }) => !!top)).toEqual(all.map(() => true));
      const [first, second] = all;
      // The second panel's labels above it stay clear of the first's plot.
      const labels = second!.top!.items.flatMap((item) => (item.type === "text" ? [item.y] : []));
      expect(labels.length).toBeGreaterThan(0);
      expect(Math.min(...labels) - 8).toBeGreaterThan(first!.plot.y + first!.plot.height);
    }
  });

  it("draw a listed axis wherever panels show it, the automatic one hidden or not", () => {
    const sides = (config: ChartConfig) => {
      const model = new ChartModel(
        { locale: "en-US", timeZone: "UTC", ...config },
        undefined,
        ...staticCompilers(),
      );
      model.setSize(600, 400, 1);
      return model.scene(estimateText).panels.map((p) => p.axes.map((a) => a.side).sort());
    };
    // Only an axis above: the panels have no automatic one below, and draw it above.
    expect(
      sides({
        ...two(rows([1, 1], [panel("a"), panel("b")])),
        guides: [axis({ scale: "x", place: { side: "top" } })],
      }).map((s) => s.includes("top")),
    ).toEqual([true, true]);
    // Shared y across a row whose last panel hides it: the right axis goes beside the other.
    expect(
      sides({
        ...two(columns([1, 1], [panel("a"), panel({ id: "b", y: { show: false } })])),
        y: { scope: "row" },
        guides: [axis({ scale: "y", place: { side: "right" } })],
      }).map((s) => s.includes("right")),
    ).toEqual([true, false]);
  });

  it("draw a y axis on the right of every panel with repeat, keeping room for it between them", () => {
    const regions = table({
      t: [0, 1, 0, 1],
      v: [1000, 2000, 3000, 4000],
      g: ["a", "a", "b", "b"],
    });
    for (const config of [
      { ...two(columns([1, 1], [panel("a"), panel("b")])), y: { scope: "chart" } },
      { marks: [line(regions, { x: "t", y: "v" })], facet: facet({ column: "g" }) },
    ] as ChartConfig[]) {
      const model = new ChartModel(
        {
          locale: "en-US",
          timeZone: "UTC",
          ...config,
          guides: [axis({ scale: "y", place: { side: "right" }, repeat: "all" })],
        },
        undefined,
        ...staticCompilers(),
      );
      model.setSize(600, 400, 1);
      const [first, second] = model.scene(estimateText).panels;
      const right = first!.axes.find((a) => a.side === "right")!;
      expect(second!.axes.some((a) => a.side === "right")).toBe(true);
      // The first panel's labels on its right end before the second's plot.
      const ends = right.items.flatMap((item) => (item.type === "text" ? [item.x] : []));
      expect(ends.length).toBeGreaterThan(0);
      expect(Math.max(...ends) + 20).toBeLessThan(second!.plot.x);
    }
  });
});
