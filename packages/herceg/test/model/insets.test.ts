// Insets: panels drawn over another panel's plot, with scales of their own.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { type Table, table } from "../../src/data/table.ts";
import { axis } from "../../src/guides/options.ts";
import { estimateText } from "../../src/layout/text.ts";
import { columns, inset, panel } from "../../src/layout.ts";
import { bar } from "../../src/marks/bar.ts";
import { graph } from "../../src/marks/graph.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { rule } from "../../src/marks/rule.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { brushedRows } from "../../src/model/selected-rows.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import { NO_PAGE } from "../../src/render/fallbacks.ts";
import { renderSvg } from "../../src/render/svg.ts";
import { gridStrokes } from "../../src/scene/grid.ts";
import type { Panel, Rect, Scene, TextItem } from "../../src/scene/scene.ts";

function build(config: ChartConfig, width = 800, height = 600) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const data = table({
  t: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  v: [3, 5, 4, 8, 6, 7, 9, 4, 5, 6],
  k: ["a", "b", "a", "b", "a", "b", "a", "b", "a", "b"],
});
const marks = [
  line(data, { x: "t", y: "v", panel: "main" }),
  line(data, { x: "t", y: "v", panel: "zoom" }),
];
const zoomed = (options: Parameters<typeof inset>[1] = {}) =>
  panels(
    panel({ id: "main", title: "Main" }, [inset({ id: "zoom", x: { domain: [2, 4] } }, options)]),
  );
const byKey = (panels: readonly Panel[]) => Object.fromEntries(panels.map((p) => [p.key, p]));
const inside = (inner: Rect, outer: Rect) =>
  inner.x >= outer.x &&
  inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width + 1e-9 &&
  inner.y + inner.height <= outer.y + outer.height + 1e-9;

describe("insets", () => {
  it("go over the parent's plot at its top right, 35% of it by default, in their box", () => {
    const { scene } = build({ marks, panels: zoomed() });
    const { main, zoom } = byKey(scene.panels);
    expect(scene.panels.map((p) => p.key)).toEqual(["main", "zoom"]);
    const box = zoom!.cover!;
    expect(inside(box, main!.plot)).toBe(true);
    // 8 px in from the parent plot's top right corner.
    expect(main!.plot.x + main!.plot.width - (box.x + box.width)).toBeCloseTo(8, 5);
    expect(box.y - main!.plot.y).toBeCloseTo(8, 5);
    expect(box.width).toBeCloseTo(main!.plot.width * 0.35, 5);
    expect(box.height).toBeCloseTo(main!.plot.height * 0.35, 5);
    // Its plot, titles, and axes are inside its box.
    expect(inside(zoom!.plot, box)).toBe(true);
  });

  it("take sizes in pixels or fractions, and places at positions with anchors", () => {
    const { scene } = build({
      marks,
      panels: zoomed({
        place: { at: { x: { fraction: 0 }, y: { fraction: 0 } }, anchor: "bottom-left" },
        width: { px: 300 },
        height: { fraction: 0.5 },
      }),
    });
    const { main, zoom } = byKey(scene.panels);
    const box = zoom!.cover!;
    expect(box.width).toBeCloseTo(300, 5);
    expect(box.height).toBeCloseTo(main!.plot.height * 0.5, 5);
    // Its bottom left corner at the plot's bottom left (fractional y counts from the bottom).
    expect(box.x).toBeCloseTo(main!.plot.x, 5);
    expect(box.y + box.height).toBeCloseTo(main!.plot.y + main!.plot.height, 5);
  });

  it("place at pixels or fractions of the chart, whatever its title and legend take", () => {
    const { scene } = build({
      marks,
      title: "Latency",
      panels: zoomed({
        place: {
          at: { x: { px: 100, frame: "chart" }, y: { fraction: 0.8, frame: "chart" } },
          anchor: "top-left",
        },
        width: { px: 200 },
        height: { px: 120 },
      }),
    });
    const box = byKey(scene.panels).zoom!.cover!;
    // Fractions along y count up from the chart's bottom (600 px tall).
    expect([box.x, box.y]).toEqual([100, 120]);
  });

  it("leave their parent drawing only around their boxes", () => {
    const { scene } = build({ marks, panels: zoomed() });
    const { main, zoom } = byKey(scene.panels);
    const visible = main!.visible!;
    expect(visible.length).toBeGreaterThan(0);
    const area = visible.reduce((sum, r) => sum + r.width * r.height, 0);
    const box = zoom!.cover!;
    expect(area).toBeCloseTo(main!.plot.width * main!.plot.height - box.width * box.height, 3);
    // Base panels draw first, then each inset over them.
    expect(scene.layers!.map((layer) => layer.map((p) => p.key))).toEqual([["main"], ["zoom"]]);
  });

  it("stay inside their parent's plot, refusing places outside it", () => {
    // Insets draw over their parent's data only; its axes, titles, and
    // legends, and other panels, stay clear of them.
    for (const place of [
      { at: { x: { fraction: 0.95 }, y: { fraction: 0.5 } }, anchor: "center" as const },
      { at: { x: { px: 0, frame: "chart" as const }, y: { px: 0, frame: "chart" as const } } },
    ])
      expect(() =>
        build({
          marks: [...marks, line(data, { x: "t", y: "v", panel: "next" })],
          panels: panels(
            columns(
              [1, 1],
              [
                panel("main", [inset({ id: "zoom" }, { place, width: { fraction: 0.6 } })]),
                panel("next"),
              ],
            ),
          ),
        }),
      ).toThrow(
        /inset "zoom" reaches outside its parent's plot (across|down); place it inside the plot, or make it smaller/,
      );
    // A box may end at the plot's edge, and not a fraction of a pixel past it.
    const ending = (offset: number) => () =>
      build({
        marks,
        panels: zoomed({
          place: { at: { x: { fraction: 1, offset }, y: { fraction: 1 } }, anchor: "top-right" },
        }),
      });
    expect(ending(0)).not.toThrow();
    expect(ending(0.4)).toThrow("reaches outside its parent's plot across");
    // The error names where the inset is.
    let path: string | undefined;
    try {
      build({
        marks,
        panels: zoomed({ place: { at: { x: { fraction: 1 }, y: { fraction: 1 } } } }),
      });
    } catch (error) {
      path = (error as { path?: string }).path;
    }
    expect(path).toBe("layout.insets[0]");
    // Places of numbers that are not finite are refused where they are.
    expect(() =>
      build({ marks, panels: zoomed({ place: { at: { x: { px: Number.NaN }, y: { px: 0 } } } }) }),
    ).toThrow("layout.insets[0].place.at.x.px: expected a finite number; received NaN");
    expect(() =>
      build({
        marks,
        panels: zoomed({ place: { inside: "top-left", inset: Number.POSITIVE_INFINITY } }),
      }),
    ).toThrow("layout.insets[0].place.inset: expected pixels of at least 0; received Infinity");
  });

  it("cover their parent's annotations as they cover its data", () => {
    const { scene } = build({
      marks: [...marks, rule({ y: 5, label: "target", panel: "main", stroke: "#ff0000" })],
      panels: zoomed(),
    });
    const main = byKey(scene.panels).main!;
    const at = scene.panels.indexOf(main);
    // Drawn beyond its plot's cut, the rule keeps out of the inset's box.
    const svg = renderSvg(scene);
    expect(svg).toContain(`-keep-${at}"><path clip-rule="evenodd"`);
    expect(svg).toMatch(new RegExp(`<g clip-path="url\\(#[^)]*-keep-${at}\\)">[^]*#ff0000`));
  });

  it("keep apart from one another, but for one inside the other", () => {
    const three = [...marks, line(data, { x: "t", y: "v", panel: "other" })];
    const overlapping = () =>
      build({
        marks: three,
        panels: panels(
          panel("main", [
            inset("zoom", { place: { inside: "top-left" }, width: { fraction: 0.5 } }),
            inset("other", { place: { inside: "top-left", inset: 40 }, width: { fraction: 0.5 } }),
          ]),
        ),
      });
    expect(overlapping).toThrow(
      'layout.insets[1]: inset "other" overlaps inset "zoom"; place them apart, or one inside the other',
    );
    // Boxes side by side may touch, and not overlap by a fraction of a pixel.
    const beside = (second: number) => () =>
      build({
        marks: three,
        panels: panels(
          panel("main", [
            inset("zoom", { place: { at: { x: { px: 10 }, y: { px: 10 } } }, width: { px: 200 } }),
            inset("other", {
              place: { at: { x: { px: second }, y: { px: 10 } } },
              width: { px: 200 },
            }),
          ]),
        ),
      });
    expect(beside(210)).not.toThrow();
    expect(beside(209.6)).toThrow('inset "other" overlaps inset "zoom"');
    // Nested, one is inside the other.
    expect(() =>
      build({
        marks: three,
        panels: panels(
          panel("main", [
            inset("zoom", {
              width: { fraction: 0.6 },
              height: { fraction: 0.6 },
              insets: [inset("other", { width: { fraction: 0.4 }, height: { fraction: 0.5 } })],
            }),
          ]),
        ),
      }),
    ).not.toThrow();
  });

  it("keep their axes' labels inside their boxes, whatever their size, direction, and neighbors", () => {
    const wide = table({ t: [0, 1000], v: [0, 1000] });
    const boxed = (scene: Scene) => {
      for (const { key, cover, axes } of scene.panels.filter((p) => p.cover)) {
        const box = cover!;
        for (const { scale, ticks, paints } of axes) {
          const { css, size } = paints.label;
          expect(ticks.length, key).toBeGreaterThan(1);
          for (const { position, label } of ticks) {
            // x labels centered on their ticks across, y labels down.
            const half = scale === "x" ? estimateText(label, css) / 2 : size / 2;
            const [lo, hi] =
              scale === "x" ? [box.x, box.x + box.width] : [box.y, box.y + box.height];
            expect(position - half, `${key} ${scale} ${label}`).toBeGreaterThanOrEqual(lo - 0.5);
            expect(position + half, `${key} ${scale} ${label}`).toBeLessThanOrEqual(hi + 0.5);
          }
        }
      }
    };
    // With the static compilers, which write labels by functions.
    const on = (
      insets: ReturnType<typeof inset>[],
      width = 800,
      guides: ChartConfig["guides"] = [],
    ) => {
      const model = new ChartModel(
        {
          locale: "en-US",
          timeZone: "UTC",
          guides,
          marks: [
            "main",
            ...insets.map(({ panel }) => (typeof panel === "string" ? panel : panel.id!)),
          ].map((panel) => line(wide, { x: "t", y: "v", panel })),
          panels: panels(panel("main", insets)),
        },
        NO_PAGE,
        ...staticCompilers(),
      );
      model.setSize(width, 600, 1);
      return model.scene(estimateText);
    };
    // Side by side, 2 px apart.
    const at = (px: number) =>
      inset(`at-${px}`, {
        place: { at: { x: { px }, y: { px: 10 } } },
        width: { px: 200 },
        height: { px: 160 },
      });
    boxed(on([at(10), at(212)]));
    // Large y labels over small x labels.
    const box = { width: { px: 350 }, height: { px: 250 } };
    boxed(on([inset({ id: "big", y: { style: { tickLabel: { fontSize: 60 } } } }, box)]));
    // A layer of larger labels the guides list, as drawn.
    const layer = {
      id: "ends",
      ticks: { values: [0, 1000] },
      style: { tickLabel: { fontSize: 60 } },
    };
    const layered = on(
      [inset({ id: "layered", x: { show: false } }, { width: { px: 250 }, height: { px: 200 } })],
      800,
      [axis({ scale: "y", layers: [layer] })],
    );
    // Every line of text drawn, down: its box, or its glyphs about its middle.
    const drawnIn = (scene: Scene, key: string) => {
      const { cover, axes } = byKey(scene.panels)[key]!;
      const texts = axes
        .flatMap(({ items }) => items)
        .filter((item): item is TextItem => item.type === "text" && item.angle === 0);
      for (const { y, paint, text, box } of texts) {
        const [top, bottom] = box
          ? [box.y, box.y + box.height]
          : [y - paint.size / 2, y + paint.size / 2];
        expect(top, `${key} ${text}`).toBeGreaterThanOrEqual(cover!.y - 0.5);
        expect(bottom, `${key} ${text}`).toBeLessThanOrEqual(cover!.y + cover!.height + 0.5);
      }
      return texts;
    };
    expect(drawnIn(layered, "layered").some(({ paint }) => paint.size === 60)).toBe(true);
    // The guides' y axis on the right only, its labels of several lines
    // (a line each), the same from one scene to the next.
    const day = 86_400_000;
    const dates = table({ t: time([0, 30 * day]), v: time([0, 400 * day]) });
    const lines = {
      id: "lines",
      ticks: { values: [0, 400 * day] },
      format: { time: "%d\n%b\n%Y" },
      style: { tickLabel: { fontSize: 24 } },
    };
    const rightOf = (height: number) => {
      const model = new ChartModel(
        {
          locale: "en-US",
          timeZone: "UTC",
          guides: [axis({ scale: "y", place: { side: "right" }, layers: [lines] })],
          marks: ["main", "right"].map((panel) => line(dates, { x: "t", y: "v", panel })),
          panels: panels(
            panel("main", [
              inset(
                { id: "right", x: { show: false } },
                { width: { px: 350 }, height: { px: height } },
              ),
            ]),
          ),
        },
        NO_PAGE,
        ...staticCompilers(),
      );
      model.setSize(800, 600, 1);
      return model;
    };
    const right = rightOf(200);
    const first = right.scene(estimateText);
    expect(drawnIn(first, "right").filter(({ paint }) => paint.size === 24).length).toBe(6);
    const again = right.scene(estimateText);
    expect(byKey(again.panels).right!.plot).toEqual(byKey(first.panels).right!.plot);
    // A label taller than the box is refused, as a layout that does not fit.
    let refused: { code?: string; phase?: string; path?: string; message: string } | undefined;
    try {
      rightOf(80).scene(estimateText);
    } catch (error) {
      refused = error as typeof refused;
    }
    expect(refused).toMatchObject({
      code: "layout-failed",
      phase: "layout",
      path: "chart guides[0].layers[0]",
    });
    expect(refused!.message).toMatch(
      /^chart guides\[0\]\.layers\[0\]: a label 9\d px tall does not fit the \d+ px down it stays inside; make the chart or inset taller/,
    );
    // Default labels are a line each, a line break a space, their boxes too.
    const boxedLines = { fontSize: 24, background: { fill: "#eeeeee" }, padding: 4 };
    const defaults = new ChartModel(
      {
        locale: "en-US",
        timeZone: "UTC",
        marks: ["main", "plain"].map((panel) => line(dates, { x: "t", y: "v", panel })),
        panels: panels(
          panel("main", [
            inset(
              {
                id: "plain",
                x: { format: { time: "%d\n%b" }, style: { tickLabel: boxedLines } },
                y: { format: { time: "%d\n%b\n%Y" }, style: { tickLabel: boxedLines } },
              },
              { width: { px: 350 }, height: { px: 160 } },
            ),
          ]),
        ),
      },
      NO_PAGE,
      ...staticCompilers(),
    );
    defaults.setSize(800, 600, 1);
    const plain = drawnIn(defaults.scene(estimateText), "plain");
    expect(plain.filter(({ box }) => box).length).toBeGreaterThan(2);
    expect(plain.every(({ text }) => !text.includes("\n"))).toBe(true);
    // Layers that label nothing take no room.
    const none = {
      id: "none",
      ticks: { values: [5000, 6000] },
      style: { tickLabel: { fontSize: 60 } },
    };
    expect(() =>
      on(
        [inset({ id: "small", x: { show: false } }, { width: { px: 200 }, height: { px: 80 } })],
        800,
        [axis({ scale: "y", layers: [none] })],
      ),
    ).not.toThrow();
    // x running down, the first label on the right.
    const reversed = { id: "down", x: { domain: [1000, 0] as const }, y: { show: false } };
    boxed(on([inset(reversed, { width: { px: 200 } })]));
    // Labels reaching further than a quarter of the chart.
    const long = {
      id: "long",
      x: { format: { minimumFractionDigits: 9 }, style: { tickLabel: { fontSize: 40 } } },
      y: { show: false },
    };
    // A label inside reaching further than the first and last, which are
    // empty, in either direction.
    for (const domain of [
      [0, 10],
      [10, 0],
    ] as const) {
      const uneven = {
        id: "uneven",
        x: {
          domain,
          ticks: { values: [0, 1, 10] },
          format: (value: number) => (value === 1 ? "W".repeat(12) : ""),
        },
        y: { show: false },
      };
      boxed(on([inset(uneven, { width: { px: 250 } })]));
    }
    boxed(
      on(
        [
          inset(long, {
            place: { inside: "top-left" },
            width: { fraction: 0.95 },
            height: { px: 200 },
          }),
        ],
        600,
      ),
    );
  });

  it("leave the chart's own view and selection to the panels sharing x, wherever they come", () => {
    const kinds = table({ k: ["a", "b", "c"], v: [1, 2, 3] });
    const { model } = build({
      marks: [
        pie(kinds, { category: "k", value: "v", panel: "share" }),
        line(kinds, { x: "v", y: "v", panel: "detail" }),
        bar(kinds, { x: "k", y: "v", panel: "bars" }),
      ],
      x: { scope: "chart" },
      panels: panels(columns([1, 1], [panel("share", [inset("detail")]), panel("bars")])),
    });
    // The inset, with an x of its own, comes first of the panels with axes.
    expect(model.panels().map(({ key }) => key)).toEqual(["detail", "bars"]);
    expect(model.chartPanel()?.key).toBe("bars");
  });

  it("leave out of a lasso's rows what they cover of their parent", () => {
    const spread = table({
      x: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
      y: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    });
    const { model } = build({
      marks: [
        point(spread, { x: "x", y: "y", panel: "main" }),
        line(data, { x: "t", y: "v", panel: "zoom" }),
      ],
      panels: zoomed({ width: { fraction: 0.5 }, height: { fraction: 0.5 } }),
    });
    const main = model.panels().find(({ key }) => key === "main")!;
    const box = model.panels().find(({ key }) => key === "zoom")!.cover!;
    const covered = (row: number) => {
      const [px, py] = [main.x.map(row), main.y.map(row)];
      return px >= box.x && px <= box.x + box.width && py >= box.y && py <= box.y + box.height;
    };
    const all = [
      [-1, -1],
      [10, -1],
      [10, 10],
      [-1, 10],
    ] as const;
    const owner = { x: main.xGroup, panels: ["main"] };
    const rows = brushedRows(
      model,
      spread as unknown as Table,
      { x: null, y: null, lasso: all },
      owner,
    );
    const selected = rows?.kind === "rows" ? Array.from(rows.rows.positions()) : [];
    const expected = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].filter((row) => !covered(row));
    expect(expected.length).toBeLessThan(10);
    expect(selected).toEqual(expected);
  });

  it("leave out of a network's lassoed rows the nodes they cover", () => {
    const names = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const links = table({ from: names, to: names.map((_, i) => names[(i + 1) % 12]!) });
    const nodes = table({ name: names });
    const { model } = build({
      marks: [
        graph(links, { source: "from", target: "to", nodes, node: "name", panel: "net" }),
        line(data, { x: "t", y: "v", panel: "zoom" }),
      ],
      panels: panels(
        panel("net", [inset("zoom", { width: { fraction: 0.5 }, height: { fraction: 0.5 } })]),
      ),
    });
    const net = model.allPanels().find(({ key }) => key === "net")!.plot;
    const plane = model.items!.result("net")!.plane!;
    const corner = (px: number, py: number) => [plane.x.invert(px), plane.y.invert(py)] as const;
    const all = [
      corner(net.x, net.y),
      corner(net.x + net.width, net.y),
      corner(net.x + net.width, net.y + net.height),
      corner(net.x, net.y + net.height),
    ];
    const selection = brushedRows(
      model,
      nodes as unknown as Table,
      { x: null, y: null, lasso: all },
      { x: "", panels: ["net"], plane: true },
    );
    const rows = selection?.kind === "rows" ? Array.from(selection.rows.positions()) : [];
    // Nodes under the box are not drawn, and not selected.
    const shown = names.filter((name) => {
      const at = model.inspectItem(JSON.stringify([0, name]), "net")!.points[0]!;
      return !model.coveredAt("net", at.px, at.py);
    });
    expect(shown.length).toBeLessThan(12);
    expect(rows).toEqual(names.flatMap((name, i) => (shown.includes(name) ? [i] : [])));
  });

  it("have categories and scale types of their own where the chart's scales are one", () => {
    const kinds = table({ k: ["a", "b", "c", "d"], v: [1, 2, 3, 4], t: [0, 1, 2, 3] });
    const parent = table({ k: ["a", "b"], v: [1, 2], t: [0, 1] });
    const inner = table({ k: ["c", "d"], v: [3, 4], t: [2, 3] });
    const { model } = build({
      marks: [
        bar(parent, { x: "k", y: "v", panel: "main" }),
        bar(inner, { x: "k", y: "v", panel: "zoom" }),
      ],
      panels: zoomed(),
      x: { scope: "chart" },
    });
    const [main, zoom] = model.panels();
    expect([main!.x.domain[1] - main!.x.domain[0], zoom!.x.domain[1] - zoom!.x.domain[0]]).toEqual([
      2, 2,
    ]);
    // Numbers along y in the parent, categories in the inset.
    expect(() =>
      build({
        marks: [
          line(kinds, { x: "t", y: "v", panel: "main" }),
          point(kinds, { x: "t", y: "k", panel: "zoom" }),
        ],
        panels: zoomed(),
        y: { scope: "chart" },
      }),
    ).not.toThrow();
  });

  it("keep no room for labels they do not show", () => {
    // The parent's large y labels are its own.
    const { scene } = build({
      marks,
      panels: panels(
        panel({ id: "main", y: { style: { tickLabel: { fontSize: 100 } } } }, [
          inset(
            { id: "zoom", x: { show: false }, y: { show: false } },
            { width: { px: 200 }, height: { px: 100 } },
          ),
        ]),
      ),
    });
    const { zoom } = byKey(scene.panels);
    expect(zoom!.plot.height).toBeCloseTo(zoom!.cover!.height, 5);
  });

  it("cut their parent's grid lines and plot background, seen through a transparent inset", () => {
    // The box's top on a grid line of the parent's (at 6 of 0 to 10).
    const { scene } = build({
      marks,
      y: { domain: [0, 10] },
      panels: zoomed({
        place: { at: { x: { fraction: 0.5 }, y: { fraction: 0.6 } }, anchor: "top-left" },
        width: { fraction: 0.4 },
        height: { fraction: 0.3 },
      }),
      theme: {
        tokens: { background: "transparent" },
        style: { plot: { fill: "#eeeeee" }, grid: { strokeWidth: 10 } },
      },
    });
    const { main, zoom } = byKey(scene.panels);
    const box = zoom!.cover!;
    // Every stroke of the parent's grid, 10 px wide, misses the inset's box.
    const crosses = (lo: number, hi: number, from: number, to: number) =>
      Math.min(hi, to) - Math.max(lo, from) > 0.01;
    let segments = 0;
    for (const { coords, paint } of gridStrokes([main!], scene.theme))
      for (let i = 0; i < coords.length; i += 4) {
        const [x0, y0, x1, y1] = coords.slice(i, i + 4) as [number, number, number, number];
        const half = paint.strokeWidth / 2;
        segments++;
        const across = x0 !== x1;
        const meets = across
          ? crosses(y0 - half, y0 + half, box.y, box.y + box.height) &&
            crosses(x0, x1, box.x, box.x + box.width)
          : crosses(x0 - half, x0 + half, box.x, box.x + box.width) &&
            crosses(y0, y1, box.y, box.y + box.height);
        expect(meets).toBe(false);
      }
    expect(segments).toBeGreaterThan(0);
    // At half a device pixel to a CSS pixel, a one-pixel line snaps further
    // and a canvas strokes it two CSS pixels wide.
    const zoomedOut = new ChartModel({
      locale: "en-US",
      timeZone: "UTC",
      marks,
      y: { domain: [0, 10] },
      panels: zoomed({
        place: { at: { x: { fraction: 0.5 }, y: { fraction: 0.5968 } }, anchor: "top-left" },
        width: { fraction: 0.4 },
        height: { fraction: 0.3 },
      }),
    });
    zoomedOut.setSize(800, 600, 0.5);
    const small = zoomedOut.scene(estimateText);
    const inner = byKey(small.panels).zoom!.cover!;
    for (const { coords } of gridStrokes([byKey(small.panels).main!], small.theme, 0.5))
      for (let i = 0; i < coords.length; i += 4) {
        const [x0, y0, x1] = coords.slice(i, i + 3) as [number, number, number];
        if (x0 === x1) continue;
        expect(
          crosses(y0 - 1, y0 + 1, inner.y, inner.y + inner.height) &&
            crosses(x0, x1, inner.x, inner.x + inner.width),
        ).toBe(false);
      }
    // Lines at the plot's edges, far from the box, stay.
    const edges = build({
      marks,
      x: { domain: [0, 9], grid: true },
      panels: zoomed({ width: { fraction: 0.3 }, height: { fraction: 0.3 } }),
    }).scene.panels.find((p) => p.key === "main")!;
    const atEdges = edges.grid.x.flatMap((x, i) =>
      Math.abs(x - edges.plot.x) < 1 || Math.abs(x - edges.plot.x - edges.plot.width) < 1
        ? [edges.grid.xSpans![i]!]
        : [],
    );
    expect(atEdges.length).toBeGreaterThan(0);
    for (const spans of atEdges) expect(spans.length).toBeGreaterThan(0);
    // So does its plot's background, a rectangle for each part left visible.
    const fills = renderSvg(scene).match(/fill="#eeeeee"/g)?.length ?? 0;
    expect(fills).toBe(main!.visible!.length + 1);
  });

  it("cover their parent's plot for the pointer while the chart has them", () => {
    const { model, scene } = build({ marks, panels: zoomed() });
    const box = byKey(scene.panels).zoom!.cover!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    expect(model.coveredAt("main", x, y)).toBe(true);
    expect(model.coveredAt("zoom", x, y)).toBe(false);
    // Without subplots, nothing is covered; what the layout placed goes with it.
    model.update({ locale: "en-US", timeZone: "UTC", marks: [line(data, { x: "t", y: "v" })] });
    model.scene(estimateText);
    expect(model.coveredAt("main", x, y)).toBe(false);
  });

  it("have x scales of their own, also where the chart's x is one scale", () => {
    for (const x of [undefined, { scope: "chart" as const }]) {
      const { model } = build({ marks, panels: zoomed(), ...(x && { x }) });
      const [main, zoom] = model.panels();
      expect(zoom!.x.domain).toEqual([2, 4]);
      expect(main!.x.domain[0]).toBeLessThanOrEqual(0);
      expect(main!.xGroup).not.toBe(zoom!.xGroup);
    }
    // The chart's x keeps its name, so a view without a panel zooms it and not the inset.
    const { model } = build({ marks, panels: zoomed(), x: { scope: "chart" } });
    expect(model.sharesX).toBe(true);
    const [main, zoom] = model.panels();
    expect(main!.xGroup).toBe("");
    expect(zoom!.xGroup).not.toBe("");
  });

  it("draw an indicator of their ranges on the parent, with connectors", () => {
    const { scene } = build({ marks, panels: zoomed({ indicator: true }) });
    const { main } = byKey(scene.panels);
    // Over the parent's data: a box around the inset's ranges and two lines to its corners.
    expect(main!.marks.map((mark) => mark.kind)).toEqual(["line", "shapes"]);
    const box = renderSvg(scene).match(/<path d="(M[^"]*Z)(M[^"]*)"[^>]*stroke="([^"]+)"/);
    expect(box?.[2]?.match(/M/g)?.length).toBe(2);
    // None for ranges the parent does not show, on either side; one for a part shown.
    const kinds = (domain: readonly [number, number]) =>
      byKey(
        build({
          marks,
          panels: panels(
            panel("main", [inset({ id: "zoom", x: { domain } }, { indicator: true })]),
          ),
        }).scene.panels,
      ).main!.marks.map((mark) => mark.kind);
    expect(kinds([-200, -100])).toEqual(["line"]);
    expect(kinds([100, 200])).toEqual(["line"]);
    expect(kinds([-5, 3])).toEqual(["line", "shapes"]);
  });

  it("refuse an indicator between axes that do not share coordinates", () => {
    const shares = table({ k: ["a", "b"], n: [1, 2] });
    expect(() =>
      build({
        marks: [
          line(data, { x: "t", y: "v", panel: "main" }),
          pie(shares, { category: "k", value: "n", panel: "zoom" }),
        ],
        panels: panels(
          [{ id: "main" }, { id: "zoom" }],
          panel("main", [inset("zoom", { indicator: true })]),
        ),
      }),
    ).toThrow(
      /layout.insets\[0\].indicator: parent and inset must use compatible continuous x and y coordinates/,
    );
  });

  it("refuse a box too small for their titles and axes, saying how to fix it", () => {
    expect(() =>
      build({ marks, panels: zoomed({ width: { px: 40 }, height: { px: 30 } }) }),
    ).toThrow(
      /layout.insets\[0\]: inset "zoom" needs \d+ px down for its plot, title, and axes, and has 30 px; make it larger or hide its axes/,
    );
  });

  it("are named for people as insets of their parents, and read after them", () => {
    const { model } = build({ marks, panels: zoomed() });
    expect(model.allPanels().map(({ label }) => label)).toEqual(["Main", "zoom, inset of Main"]);
    expect(describeChart(model)).toContain("Panels: Main, zoom, inset of Main.");
  });

  it("cover the panels drawn before them under the pointer, in the order they are drawn", () => {
    const { model, scene } = build({ marks, panels: zoomed() });
    const { main, zoom } = byKey(scene.panels);
    const center = (r: Rect) => [r.x + r.width / 2, r.y + r.height / 2] as const;
    expect(model.coveredAt("main", ...center(zoom!.plot))).toBe(true);
    expect(model.coveredAt("zoom", ...center(zoom!.plot))).toBe(false);
    // Over the inset's box outside its plot, too.
    const box = zoom!.cover!;
    expect(model.coveredAt("main", box.x + 1, box.y + box.height - 1)).toBe(true);
    expect(model.coveredAt("main", main!.plot.x + 4, main!.plot.y + main!.plot.height - 4)).toBe(
      false,
    );
  });

  it("go in panels of cells, and are drawn in every renderer's output", () => {
    const layout = columns([2, 1], [panel("main", [inset("zoom")]), panel("side")]);
    const { scene } = build({
      marks: [...marks, line(data, { x: "t", y: "v", panel: "side" })],
      panels: panels(
        [{ id: "main" }, { id: "zoom", x: { domain: [2, 4] } }, { id: "side" }],
        layout,
      ),
    });
    expect(scene.panels.map((p) => p.key)).toEqual(["main", "zoom", "side"]);
    const svg = renderSvg(scene);
    // Each panel's data in its own clip, and what the parent draws beyond
    // it in another; the inset's box covers what is under it.
    expect(svg.match(/<clipPath/g)?.length).toBe(4);
  });
});
