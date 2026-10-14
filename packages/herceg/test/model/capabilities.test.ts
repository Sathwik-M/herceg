// Capability contract: change packages/herceg/README.md's "What each mark
// supports" table and its notes together with these tests.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { fromGeoJSON } from "../../src/data/geojson.ts";
import { RowSet } from "../../src/data/row-set.ts";
import { rowView } from "../../src/data/row-view.ts";
import { selectionStore, selectRows } from "../../src/data/selection.ts";
import { type Table, table } from "../../src/data/table.ts";
import { fieldReader } from "../../src/dom/tooltip-content.ts";
import { plan, sidesOf, snapshot } from "../../src/dom/value-transition.ts";
import { estimateText } from "../../src/layout/text.ts";
import { Polyline } from "../../src/lod/polyline.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxen } from "../../src/marks/boxen.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { candlestick } from "../../src/marks/candlestick.ts";
import { contour } from "../../src/marks/contour.ts";
import { monotonePolyline } from "../../src/marks/curve.ts";
import { custom } from "../../src/marks/custom.ts";
import { dendrogram } from "../../src/marks/dendrogram.ts";
import { errorBar } from "../../src/marks/errorbar.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { geoshape } from "../../src/marks/geoshape.ts";
import { graph } from "../../src/marks/graph.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { tablesOf } from "../../src/marks/layout-mark.ts";
import { line } from "../../src/marks/line.ts";
import { line3d } from "../../src/marks/line3d.ts";
import type { ChartMark } from "../../src/marks/mark.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { point3d } from "../../src/marks/point3d.ts";
import { radar } from "../../src/marks/radar.ts";
import { region } from "../../src/marks/region.ts";
import { rug } from "../../src/marks/rug.ts";
import { rule } from "../../src/marks/rule.ts";
import { sankey } from "../../src/marks/sankey.ts";
import { sunburst } from "../../src/marks/sunburst.ts";
import { surface } from "../../src/marks/surface.ts";
import { text } from "../../src/marks/text.ts";
import { treemap } from "../../src/marks/treemap.ts";
import { violin } from "../../src/marks/violin.ts";
import { planAxis } from "../../src/model/axis.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { rangeNavigator } from "../../src/model/navigator.ts";
import { panels } from "../../src/model/panels.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import { brushedRows } from "../../src/model/selected-rows.ts";
import { renderToPDF } from "../../src/pdf.ts";
import type {
  Geometry,
  Panel,
  RectGeometry,
  SegmentGeometry,
  TextGeometry,
} from "../../src/scene/scene.ts";

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(600, 400, 1);
  return { model, scene: model.scene(estimateText) };
}

it("capabilities: a navigator describes the shared x window of facet panels", () => {
  const data = table({ x: [0, 1, 2, 3], y: [2, 4, 3, 1], group: ["N", "S", "N", "S"] });
  const { model } = build({
    marks: [line(data, { x: "x", y: "y" })],
    facet: facet("group"),
    navigator: rangeNavigator(),
  });
  model.setViewport([1, 2]);
  model.scene(estimateText);
  expect(describeChart(model)).toContain(
    "A range navigator shows the whole x range, with 1 to 2 in view; it controls every panel's x range.",
  );
});

const samples = table({
  x: [0, 1, 2, 3, 4, 5],
  y: [2, 4, 3, 20, 40, 30],
  low: [1, 3, 2, 10, 30, 20],
  high: [3, 5, 4, 30, 50, 40],
  category: ["a", "b", "c", "a", "b", "c"],
  group: ["N", "N", "N", "S", "S", "S"],
  note: ["one", "two", "three", "four", "five", "six"],
});
/** A field sampled on a grid per group, each group's grid apart. */
const field = table({
  x: [0, 1, 2, 0, 1, 2, 0, 1, 2, 4, 5, 6, 4, 5, 6, 4, 5, 6],
  y: [0, 0, 0, 1, 1, 1, 2, 2, 2, 10, 10, 10, 11, 11, 11, 12, 12, 12],
  z: [0, 1, 0, 1, 3, 1, 0, 1, 0, 0, 1, 0, 1, 3, 1, 0, 1, 0],
  group: ["N", "N", "N", "N", "N", "N", "N", "N", "N", "S", "S", "S", "S", "S", "S", "S", "S", "S"],
});
type Placement = { panel?: string; facet?: "repeat"; axis?: "right" };
type MarkCase = {
  name: string;
  make: (placement?: Placement) => ChartMark;
  /** The table the mark reads, when not `samples`. */
  table?: Table;
  kind: Geometry["kind"];
  /** Layout marks that draw in facet panels and subplots. */
  panels?: true;
  repeats?: true;
  reading?: "summary";
  noLegend?: true;
  turns?: true;
  animates?: true;
  /** Layout marks `interaction.zoom` navigates: a map's plane, or drilling into a tree. */
  navigates?: "plane" | "drill";
  /** Layout marks whose charts select their rows, and draw them highlighted. */
  selects?: true;
  /** Layout marks whose items `interaction.drag` moves. */
  drags?: true;
  /** Layers of a map, which share a map with the other layers of its chart or panel. */
  layer?: true;
};

// These cases have axes; annotations of constants repeat in every panel.
const cartesian: MarkCase[] = [
  {
    name: "line",
    make: (p) => line(samples, { x: "x", y: "y", series: "group", ...p }),
    kind: "line",
    animates: true,
  },
  {
    name: "area",
    make: (p) => area(samples, { x: "x", y: "y", series: "group", ...p }),
    kind: "area",
    animates: true,
  },
  {
    name: "line along y",
    // Placements may ask for the right axis, which lines along y refuse.
    make: (p) => line(samples, { x: "y", y: "x", series: "group", orient: "y", ...(p as object) }),
    kind: "line",
  },
  {
    name: "area over categories",
    make: (p) => area(samples, { x: "category", y: "y", series: "group", dodge: true, ...p }),
    kind: "area",
    animates: true,
  },
  ...(["fill", "center", "wiggle"] as const).map(
    (stack): MarkCase => ({
      name: `area stack ${stack}`,
      make: (p) => area(samples, { x: "x", y: "y", series: "group", stack, ...p }),
      kind: "area",
      animates: true,
    }),
  ),
  {
    name: "bar fill",
    make: (p) => bar(samples, { x: "x", y: "y", series: "group", stack: "fill", ...p }),
    kind: "rect",
  },
  {
    name: "bar",
    make: (p) => bar(samples, { x: "x", y: "y", series: "group", ...p }),
    kind: "rect",
    animates: true,
  },
  {
    name: "point",
    make: (p) => point(samples, { x: "x", y: "y", series: "group", ...p }),
    kind: "point",
    animates: true,
  },
  {
    name: "point swarm",
    make: (p) => point(samples, { x: "category", y: "y", series: "group", swarm: true, ...p }),
    kind: "point",
    animates: true,
  },
  {
    name: "histogram",
    make: (p) => histogram(samples, { x: "y", bins: 3, series: "group", ...p }),
    kind: "rect",
  },
  {
    name: "boxplot",
    make: (p) => boxplot(samples, { x: "category", y: "y", series: "group", ...p }),
    kind: "rect",
  },
  {
    name: "boxen",
    make: (p) => boxen(samples, { x: "category", y: "y", series: "group", ...p }),
    kind: "rect",
  },
  {
    name: "violin",
    make: (p) => violin(samples, { x: "group", y: "y", series: "group", ...p }),
    kind: "area",
  },
  {
    name: "rug",
    make: (p) => rug(samples, { x: "x", series: "group", ...p }),
    kind: "segments",
  },
  {
    name: "errorbar",
    make: (p) => errorBar(samples, { x: "x", y1: "low", y2: "high", series: "group", ...p }),
    kind: "segments",
  },
  {
    name: "candlestick",
    make: (p) =>
      candlestick(samples, { x: "x", open: "low", high: "high", low: "low", close: "y", ...p }),
    kind: "segments",
  },
  {
    name: "heatmap",
    make: (p) => heatmap(samples, { x: "x", y: "category", color: "y", ...p }),
    kind: "raster",
    noLegend: true,
  },
  {
    name: "histogram 2d",
    make: (p) => histogram(samples, { x: "x", y: "y", bins: 2, ...(p as object) }),
    kind: "raster",
    noLegend: true,
  },
  {
    name: "contour",
    make: (p) =>
      contour(field, {
        x: "x",
        y: "y",
        color: "z",
        thresholds: [0.5, 2],
        variant: "bands",
        ...(p as object),
      }),
    kind: "polygons",
    noLegend: true,
    table: field as unknown as Table,
  },
  {
    name: "rule",
    make: (p) => rule({ x: 1, label: "Contract rule", ...p }),
    kind: "rule",
    repeats: true,
    reading: "summary",
    noLegend: true,
    animates: true,
  },
  {
    name: "region",
    make: (p) => region({ x1: 0, x2: 2, y1: 1, y2: 3, label: "Contract region", ...p }),
    kind: "rect",
    repeats: true,
    reading: "summary",
    noLegend: true,
  },
  {
    name: "text",
    make: (p) => text({ x: 1, y: 2, label: "Contract text", ...p }),
    kind: "text",
    repeats: true,
    reading: "summary",
    noLegend: true,
  },
  {
    name: "custom",
    make: (p) =>
      custom(samples, {
        x: "x",
        y: "y",
        series: "group",
        ...p,
        draw({ series, x, y, circle }) {
          for (const s of series) {
            for (let i = 0; i < s.length; i++) {
              const row = s.rows?.[i] ?? i;
              circle(x(s.x[row]!), y(s.y[row]!), 3, { fill: s.color });
            }
          }
        },
      }),
    kind: "shapes",
  },
];

const links = table({
  source: ["a", "b", "a"],
  target: ["b", "c", "c"],
  value: [3, 2, 4],
  group: ["N", "N", "S"],
});
const nodes = table({ node: ["a", "b", "c"], group: ["N", "S", "S"] });
const world = fromGeoJSON({
  type: "FeatureCollection",
  features: [0, 20].map((x) => ({
    type: "Feature" as const,
    properties: { group: x === 0 ? "N" : "S" },
    geometry: {
      type: "Polygon" as const,
      coordinates: [
        [
          [x, 0],
          [x + 10, 0],
          [x + 10, 10],
          [x, 10],
          [x, 0],
        ],
      ],
    },
  })),
});
const grid = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [1, 2, 3, 4] });
const spatial = table({
  x: [0, 1, 2, 3],
  y: [1, 3, 2, 4],
  z: [2, 4, 1, 3],
  group: ["N", "N", "S", "S"],
});

// These marks lay out their own geometry: in a chart of their own, or (those
// with `panels`) in each facet panel or in one subplot. `interaction.zoom`
// turns 3D cameras, pans and zooms maps' and networks' planes, and drills
// into trees; maps and networks take lassos, networks `interaction.drag`,
// and maps, trees, and networks row selections, in panels too.
const layouts: MarkCase[] = [
  {
    name: "pie",
    make: (p) => pie(samples, { category: "category", value: "y", labels: false, ...p }),
    kind: "arc",
    panels: true,
    animates: true,
  },
  {
    name: "treemap",
    make: (p) => treemap(samples, { path: ["group", "category"], value: "y", ...p }),
    kind: "rect",
    panels: true,
    navigates: "drill",
    selects: true,
  },
  {
    name: "sunburst",
    make: (p) => sunburst(samples, { path: ["group", "category"], value: "y", ...p }),
    kind: "arc",
    panels: true,
    navigates: "drill",
    selects: true,
  },
  { name: "gauge", make: (p) => gauge(samples, { value: "y", ...p }), kind: "arc", panels: true },
  {
    name: "funnel",
    make: (p) => funnel(samples, { category: "category", value: "y", ...p }),
    kind: "shapes",
    panels: true,
  },
  {
    name: "radar",
    make: (p) => radar(samples, { category: "category", value: "y", series: "group", ...p }),
    kind: "shapes",
    panels: true,
  },
  {
    name: "sankey",
    make: (p) => sankey(links, { source: "source", target: "target", value: "value", ...p }),
    kind: "rect",
    panels: true,
  },
  {
    name: "graph",
    make: (p) =>
      graph(links, {
        source: "source",
        target: "target",
        nodes,
        node: "node",
        color: "group",
        ...(p?.panel !== undefined && { panel: p.panel }),
      }),
    kind: "point",
    panels: true,
    selects: true,
    drags: true,
    navigates: "plane",
  },
  {
    name: "geoshape",
    make: (p) => geoshape(world, { color: "group", ...p }),
    kind: "polygons",
    panels: true,
    navigates: "plane",
    selects: true,
    layer: true,
  },
  {
    name: "geopoint",
    make: (p) => geopoint(samples, { longitude: "x", latitude: "y", series: "group", ...p }),
    kind: "point",
    panels: true,
    navigates: "plane",
    selects: true,
    layer: true,
  },
  {
    name: "point3d",
    make: () => point3d(spatial, { x: "x", y: "y", z: "z", series: "group" }),
    kind: "faces",
    turns: true,
  },
  {
    name: "line3d",
    make: () => line3d(spatial, { x: "x", y: "y", z: "z", series: "group" }),
    kind: "faces",
    turns: true,
  },
  {
    name: "surface",
    make: () => surface(grid, { x: "x", y: "y", z: "z" }),
    kind: "faces",
    turns: true,
  },
];
const all = [...cartesian, ...layouts];
const annotations = cartesian.filter((c) => c.reading === "summary");
const subplot = panels([{ id: "a" }, { id: "b" }]);
// Layout marks in panels, and those that have charts to themselves (3D).
const paneled = layouts.filter((c) => c.panels);
const alone = layouts.filter((c) => !c.panels);
/** A line in subplot "a" beside a layout mark in subplot "b". */
const besideLine = (c: MarkCase, extra: Partial<ChartConfig> = {}): ChartConfig => ({
  marks: [line(samples, { x: "x", y: "y", panel: "a" }), c.make({ panel: "b" })],
  panels: subplot,
  ...extra,
});

function expectGeometry(panel: Panel, kind: Geometry["kind"]) {
  expect(panel.marks.some((m) => m.kind === kind && (m.draw.guide || m.draw.size(m) > 0))).toBe(
    true,
  );
}

/** The family of controls a chart's layout marks ask for. */
const kindOf = (model: ChartModel) => model.items?.asked()[0]?.kind;

function itemKeys(model: ChartModel, panel?: string): string[] {
  const keys: string[] = [];
  let key = model.stepItem(undefined, 1, panel);
  while (key !== undefined && !keys.includes(key)) {
    keys.push(key);
    key = model.stepItem(key, 1, panel);
  }
  return keys;
}

function facetConfig(c: MarkCase, extra: Partial<ChartConfig> = {}): ChartConfig {
  // With resolve.yRight, the mark under test is on the right axis.
  const right = extra.resolve?.yRight ? { axis: "right" as const } : {};
  return {
    marks: [...(c.repeats ? [line(samples, { x: "x", y: "y" })] : []), c.make(right)],
    facet: facet("group"),
    ...extra,
  };
}

describe("capabilities: facets", () => {
  it.each(cartesian)("$name draws its geometry in both facet panels", (c) => {
    const { scene, model } = build(facetConfig(c));
    expect(scene.panels.map((p) => p.key)).toEqual(["N", "S"]);
    for (const panel of scene.panels) expectGeometry(panel, c.kind);
    if (!c.repeats && !["histogram", "boxplot", "boxen", "violin"].includes(c.name)) {
      // Source series really split: at most three of the six rows per panel.
      for (const panel of scene.panels) {
        expect(model.panelSeries(panel.key).every((s) => s.length <= 3)).toBe(true);
      }
    }
  });

  it.each(paneled)("$name draws each facet panel's rows in it, without axes", (c) => {
    const { scene, model } = build({ marks: [c.make()], facet: facet("group") });
    expect(scene.panels.map((p) => p.key)).toEqual(["N", "S"]);
    for (const panel of scene.panels) {
      expectGeometry(panel, c.kind);
      expect(panel.axes).toEqual([]);
      // What a panel draws is its own rows', read in it.
      const [key] = itemKeys(model, panel.key);
      expect(model.inspectItem(key!, panel.key)!.panel).toBe(panel.key);
    }
    expect(model.panels()).toEqual([]);
    expect(model.allPanels().map(({ key, items }) => [key, items])).toEqual([
      ["N", true],
      ["S", true],
    ]);
    expect(describeChart(model)).toMatch(/^Panels by group: N, S\. N: .+ S: /);
  });

  it.each(alone)("$name refuses facets", (c) => {
    expect(() => build({ marks: [c.make()], facet: facet("group") })).toThrow(
      ": no facets or panels yet; draw it in a chart of its own",
    );
  });

  it.each(paneled)("$name has each facet panel to itself, splitting its rows", (c) => {
    expect(() =>
      build({ marks: [c.make(), line(samples, { x: "x", y: "y" })], facet: facet("group") }),
    ).toThrow("has each facet panel to itself");
    if (!c.layer)
      expect(() => build({ marks: [c.make(), c.make()], facet: facet("group") })).toThrow(
        "has each facet panel to itself",
      );
  });

  it.each(paneled.filter((c) => c.layer))(
    "$name shares each facet panel's map with other layers, which may repeat",
    (c) => {
      const base = geoshape(world, { facet: "repeat" });
      const { model, scene } = build({ marks: [base, c.make()], facet: facet("group") });
      for (const panel of scene.panels) expectGeometry(panel, c.kind);
      // The base map's two regions are in both panels, the layer's own rows in one.
      expect(itemKeys(model, "N").filter((key) => key.startsWith("[0,"))).toHaveLength(2);
      expect(() => build({ marks: [c.make({ facet: "repeat" })], facet: facet("group") })).toThrow(
        "every layer of the map repeats",
      );
    },
  );

  it("points split tables, but a row view needs an explicit repeat", () => {
    const view = rowView(samples, {});
    expect(() =>
      build({ marks: [point(view, { x: "x", y: "y" })], facet: facet("group") }),
    ).toThrow('point facet: a row view cannot split into facets yet; give it facet: "repeat"');
    const { model, scene } = build({
      marks: [line(samples, { x: "x", y: "y" }), point(view, { x: "x", y: "y", facet: "repeat" })],
      facet: facet("group"),
    });
    for (const panel of scene.panels) {
      expectGeometry(panel, "point");
      expect(model.panelSeries(panel.key).at(-1)!.length).toBe(6);
    }
  });

  const boundAnnotations = [
    {
      name: "rule",
      make: (p?: Placement) => rule(samples, { x: "x", textField: "note", ...p }),
      kind: "rule",
    },
    {
      name: "region",
      make: (p?: Placement) => region(samples, { y1: "low", y2: "high", textField: "note", ...p }),
      kind: "rect",
    },
    {
      name: "text",
      make: (p?: Placement) => text(samples, { x: "x", y: "y", textField: "note", ...p }),
      kind: "text",
    },
  ] satisfies MarkCase[];
  it.each(boundAnnotations)("$name over a table splits its rows, or repeats them", (c) => {
    // Each panel draws its own three rows' items, or with a repeat all six.
    const count = (panel: Panel) =>
      panel.marks.reduce((n, m) => {
        if (m.kind !== c.kind) return n;
        return n + (m.kind === "rule" ? 1 : (m as RectGeometry | TextGeometry).count);
      }, 0);
    const split = build({
      marks: [line(samples, { x: "x", y: "y" }), c.make()],
      facet: facet("group"),
    });
    const whole = build({
      marks: [line(samples, { x: "x", y: "y" }), c.make({ facet: "repeat" })],
      facet: facet("group"),
    });
    for (const [i, panel] of split.scene.panels.entries()) {
      expectGeometry(panel, c.kind);
      expectGeometry(whole.scene.panels[i]!, c.kind);
      expect(count(panel)).toBe(3);
      expect(count(whole.scene.panels[i]!)).toBe(6);
      // Read in the summary, after the panel's name, and when the keyboard arrives there.
      expect(split.model.annotationSummaries(panel.key)).toHaveLength(1);
      expect(whole.model.annotationSummaries(panel.key)).toEqual([]);
    }
    expect(describeChart(split.model)).toMatch(/N: \w+: one /);
  });

  it("custom marks without series must repeat", () => {
    const make = (placement?: Placement) =>
      custom(samples, {
        x: "x",
        y: "y",
        series: false,
        ...placement,
        draw({ x, y, circle }) {
          circle(x(1), y(2), 3);
        },
      });
    expect(() => build({ marks: [make()], facet: facet("group") })).toThrow(
      'custom facet: without series, it cannot split into panels; give it facet: "repeat"',
    );
    const { scene } = build({
      marks: [line(samples, { x: "x", y: "y" }), make({ facet: "repeat" })],
      facet: facet("group"),
    });
    for (const panel of scene.panels) expectGeometry(panel, "shapes");
  });
});

describe("capabilities: subplots", () => {
  it.each(cartesian)("$name draws in its named subplot", (c) => {
    const { scene } = build({
      marks: [c.make({ panel: "a" })],
      panels: subplot,
      resolve: { x: "independent" },
    });
    expect(scene.panels.map((p) => p.key)).toEqual(["a", "b"]);
    expectGeometry(scene.panels[0]!, c.kind);
    expect(scene.panels[1]!.marks).toEqual([]);
  });

  it.each(paneled)("$name fills its named subplot beside a line", (c) => {
    const { scene, model } = build(besideLine(c));
    const [a, b] = scene.panels;
    expectGeometry(a!, "line");
    expect(a!.axes.length).toBeGreaterThan(0);
    expectGeometry(b!, c.kind);
    expect(b!.axes).toEqual([]);
    expect(model.panels().map(({ key }) => key)).toEqual(["a"]);
    const [key] = itemKeys(model, "b");
    expect(model.inspectItem(key!, "b")!.points[0]!.mark).toBe(1);
  });

  it.each(alone)("$name refuses subplots", (c) => {
    expect(() => build({ marks: [c.make()], panels: subplot })).toThrow(
      ": no facets or panels yet; draw it in a chart of its own",
    );
  });

  it.each(paneled)("$name has its subplot to itself", (c) => {
    // A map's layers are one mark.
    const type = c.layer ? "map" : c.name;
    expect(() => build({ marks: [c.make()], panels: subplot })).toThrow(
      "panel: expected the id of the panel it draws in",
    );
    expect(() => build({ marks: [c.make({ panel: "*" })], panels: subplot })).toThrow(
      "panel: expected the id of the panel it draws in",
    );
    if (c.layer)
      build({ marks: [c.make({ panel: "b" }), c.make({ panel: "b" })], panels: subplot });
    else
      expect(() =>
        build({ marks: [c.make({ panel: "b" }), c.make({ panel: "b" })], panels: subplot }),
      ).toThrow(`${c.name} panel: a ${c.name} mark has panel "b" too`);
    expect(() =>
      build({
        marks: [c.make({ panel: "b" }), line(samples, { x: "x", y: "y", panel: "b" })],
        panels: subplot,
      }),
    ).toThrow(`line panel: a ${type} mark has panel "b" to itself`);
    expect(() =>
      build({
        marks: [c.make({ panel: "b" }), rule({ x: 1, panel: "*" })],
        panels: subplot,
      }),
    ).toThrow('rule panel: "*" would draw in panel "b"');
  });
});

describe("capabilities: per-panel scales", () => {
  it.each(cartesian)("$name accepts independent facet scales", (c) => {
    const { model, scene } = build(
      facetConfig(c, { resolve: { x: "independent", y: "independent" } }),
    );
    for (const panel of scene.panels) expectGeometry(panel, c.kind);
    expect(new Set(model.panels().map((p) => p.xGroup)).size).toBe(2);
    expect(new Set(model.panels().map((p) => p.yGroup)).size).toBe(2);
    if (!c.repeats) {
      const [a, b] = model.panels();
      // Heatmap cells are along x, over categories along y.
      const axis = ["histogram", "rug", "heatmap", "area stack fill", "bar fill"].includes(c.name)
        ? "x"
        : "y";
      expect(a![axis].domain).not.toEqual(b![axis].domain);
    }
  });

  it.each(paneled)("$name's panel has no scales of its own; the others' may differ", (c) => {
    const resolve = { x: "independent", y: "independent" } as const;
    const { scene } = build(besideLine(c, { resolve }));
    expectGeometry(scene.panels[1]!, c.kind);
    expect(() =>
      build(
        besideLine(c, {
          resolve,
          panels: panels([
            { id: "a", y: { domain: [0, 10] } },
            { id: "b", y: { domain: [0, 1] } },
          ]),
        }),
      ),
    ).toThrow(`panels[1]: the ${c.layer ? "map" : c.name} mark it draws has no axes`);
  });

  it.each(alone)("$name refuses panels with their own scales", (c) => {
    expect(() =>
      build({
        marks: [c.make()],
        panels: panels([
          { id: "a", y: { domain: [0, 10] } },
          { id: "b", y: { domain: [0, 100] } },
        ]),
        resolve: { x: "independent", y: "independent" },
      }),
    ).toThrow(": no facets or panels yet");
  });

  const financial = [
    {
      name: "errorbar",
      make: (p?: Placement) => errorBar(samples, { x: "category", y1: "low", y2: "high", ...p }),
    },
    {
      name: "candlestick",
      make: (p?: Placement) =>
        candlestick(samples, {
          x: "category",
          open: "low",
          high: "high",
          low: "low",
          close: "y",
          ...p,
        }),
    },
  ];
  it.each(financial)("$name resolves its categories per panel, as its value scales", (c) => {
    const config = { marks: [c.make()], facet: facet("group") };
    const { model } = build({ ...config, resolve: { x: "shared", y: "independent" } });
    const [a, b] = model.panels();
    expect(a!.x.type).toBe("band");
    expect(a!.x.domain).toEqual(b!.x.domain);
    expect(a!.y.domain).not.toEqual(b!.y.domain);
    // The categories here are a, b, c in both panels: resolved apart, each holds its own.
    const own = build({ ...config, resolve: { x: "independent" } });
    for (const panel of own.scene.panels) expectGeometry(panel, "segments");
    expect(own.model.panels().map(({ x }) => x.categories)).toEqual([
      ["a", "b", "c"],
      ["a", "b", "c"],
    ]);
    const stacked = build({
      marks: [c.make({ panel: "*" })],
      panels: subplot,
      resolve: { x: "independent" },
    });
    for (const panel of stacked.scene.panels) expectGeometry(panel, "segments");
  });
});

describe("capabilities: right axis", () => {
  // Marks placing values along y; heatmaps, 2D histograms, and contours place cells
  // and regions (and take no axis),
  // and a rule at an x and a rug of x values have no y value to place.
  const valued = cartesian.filter(
    (c) => !["heatmap", "histogram 2d", "contour", "rule", "rug", "line along y"].includes(c.name),
  );
  const rightOf = (panel: Panel) => panel.axes.find((a) => a.orient === "right");

  it.each(valued)("$name draws on a right axis in every facet panel and in its subplot", (c) => {
    const faceted = build(facetConfig(c, { resolve: { yRight: "independent" } }));
    for (const [i, panel] of faceted.scene.panels.entries()) {
      expectGeometry(panel, c.kind);
      expect(rightOf(panel)).toBeDefined();
      expect(faceted.model.panels()[i]!.yRight).toBeDefined();
    }
    const stacked = build({
      marks: [c.make({ panel: "a", axis: "right" }), c.make({ panel: "b" })],
      panels: subplot,
    });
    expect(rightOf(stacked.scene.panels[0]!)).toBeDefined();
    expect(rightOf(stacked.scene.panels[1]!)).toBeUndefined();
    for (const panel of stacked.scene.panels) expectGeometry(panel, c.kind);
  });

  it("refuses it to marks placed along y", () => {
    const sideways = bar(samples, { x: "y", y: "category", axis: "right" as never });
    expect(() => build({ marks: [sideways], facet: facet("group") })).toThrow(
      "bar axis: marks along y cannot use the right axis",
    );
    const profile = line(samples, { x: "y", y: "x", orient: "y", axis: "right" as never });
    expect(() => build({ marks: [profile], facet: facet("group") })).toThrow(
      "line axis: marks along y cannot use the right axis",
    );
  });
});

describe("capabilities: zoom and pan", () => {
  it.each(cartesian)("$name moves a continuous axis with its viewport", (c) => {
    const { model, scene } = build({ marks: [c.make()], interaction: { zoom: "xy" } });
    const alongY = model.xScale()!.type === "band";
    const orient = alongY ? "left" : "bottom";
    const before = scene.panels[0]!.axes.find((a) => a.orient === orient)!.ticks;
    if (alongY) model.setYViewport({ y: [2, 6], yRight: null });
    else model.setViewport([0.5, 1.5]);
    const next = model.scene(estimateText);
    const scale = alongY ? model.yScale()! : model.xScale()!;
    expect(scale.domain).toEqual(alongY ? [2, 6] : [0.5, 1.5]);
    expect(next.panels[0]!.axes.find((a) => a.orient === orient)!.ticks).not.toEqual(before);
  });

  it.each([
    { name: "bar", make: bar },
    { name: "point", make: point },
  ])("$name ignores a viewport on its categorical axis", (c) => {
    const { model, scene } = build({
      marks: [c.make(samples, { x: "category", y: "y" })],
      interaction: { zoom: "x" },
    });
    expect(model.xScale()!.type).toBe("band");
    model.setViewport([0.5, 1.5]);
    expect(model.scene(estimateText).panels[0]!.axes).toEqual(scene.panels[0]!.axes);
  });

  it("heatmaps zoom number and time axes, and ignore viewports on banded ones", () => {
    for (const x of [[0, 1, 2], time([0, 1, 2])]) {
      const cells = table({ x, y: [0, 1, 2], value: [1, 2, 3] });
      const zoomed = build({
        marks: [heatmap(cells, { x: "x", y: "y", color: "value" })],
        interaction: { zoom: "xy" },
      });
      const type = Array.isArray(x) ? "linear" : "time";
      expect([zoomed.model.xScale()!.type, zoomed.model.yScale()!.type]).toEqual([type, "linear"]);
      zoomed.model.setViewport([0.5, 1.5]);
      zoomed.model.setYViewport({ y: [0.5, 1.5], yRight: null });
      zoomed.model.scene(estimateText);
      expect(zoomed.model.xScale()!.domain).toEqual([0.5, 1.5]);
      expect(zoomed.model.yScale()!.domain).toEqual([0.5, 1.5]);
      const { model, scene } = build({
        marks: [heatmap(cells, { x: "x", y: "y", color: "value", xBanded: true, yBanded: true })],
        interaction: { zoom: "xy" },
      });
      expect([model.xScale()!.type, model.yScale()!.type]).toEqual(["band", "band"]);
      model.setViewport([0.5, 1.5]);
      model.setYViewport({ y: [0.5, 1.5], yRight: null });
      expect(model.scene(estimateText).panels[0]!.axes).toEqual(scene.panels[0]!.axes);
    }
  });

  it.each(layouts.filter((c) => !c.turns && !c.navigates))("$name refuses zoom", (c) => {
    expect(() => build({ marks: [c.make()], interaction: { zoom: true } })).toThrow(
      `${c.name} zoom: no axes to zoom; drop interaction.zoom`,
    );
  });

  it.each(layouts.filter((c) => c.navigates === "plane"))(
    "$name pans and zooms its plane, both ways only",
    (c) => {
      for (const zoom of [true, "xy"] as const) {
        const { model } = build({ marks: [c.make()], interaction: { zoom } });
        expect(kindOf(model)).toBe(c.drags ? "drag" : "map");
        const { x, y } = model.items!.result()!.plane!;
        const key = model.stepItem(undefined, 1)!;
        const before = model.inspectItem(key)!.points[0]!;
        // Half the plane's ranges, about their middles: everything twice as far from the middle.
        const half = (d: readonly [number, number]) =>
          [d[0] + (d[1] - d[0]) / 4, d[1] - (d[1] - d[0]) / 4] as const;
        model.items!.setView({ x: half(x.domain), y: half(y.domain) }, undefined);
        model.scene(estimateText);
        expect(model.items!.result()!.plane!.zoom).toBeCloseTo(2, 6);
        const after = model.inspectItem(key)?.points[0];
        if (after) expect([after.px, after.py]).not.toEqual([before.px, before.py]);
      }
      expect(() => build({ marks: [c.make()], interaction: { zoom: "x" } })).toThrow(
        `${c.name} zoom: expected interaction.zoom true or "xy"; received "x"`,
      );
    },
  );

  it.each(layouts.filter((c) => c.navigates === "drill"))(
    "$name drills into a node with zoom, alone, and refuses zoom along an axis",
    (c) => {
      const { model } = build({ marks: [c.make()], interaction: { zoom: true } });
      expect(kindOf(model)).toBe("drill");
      expect(model.items!.setDrillRoot(["N"])!.key).toBe('[0,"N"]');
      model.scene(estimateText);
      const keys = itemKeys(model);
      expect(keys.every((key) => key.startsWith('[0,"N"'))).toBe(true);
      expect(() => build({ marks: [c.make()], interaction: { zoom: "x" } })).toThrow(
        `${c.name} zoom: expected interaction.zoom true; received "x"`,
      );
    },
  );

  it.each(paneled.filter((c) => c.navigates))(
    "$name navigates every facet panel at once, and each subplot alone",
    (c) => {
      const zoom = { interaction: { zoom: true } } as const;
      const faceted = build({ marks: [c.make()], facet: facet("group"), ...zoom }).model;
      const two = build({
        marks: [c.make({ panel: "a" }), c.make({ panel: "b" })],
        panels: subplot,
        ...zoom,
      }).model;
      expect(kindOf(faceted)).toBe(kindOf(two));
      if (c.navigates === "drill") {
        const N = '[0,"N"]';
        expect(faceted.items!.setDrillRoot(["N"])).toEqual({
          key: N,
          path: [{ key: N, label: "N" }],
        });
        faceted.scene(estimateText);
        // Panel S has nothing under N, but shows where it is.
        expect(itemKeys(faceted, "N").every((key) => key.startsWith('[0,"N"'))).toBe(true);
        expect(itemKeys(faceted, "S")).toEqual([]);
        expect(faceted.items!.result("S")!.drill!.key).toBe(N);
        expect(() => two.items!.setDrillRoot(["N"])).toThrow("setDrillRoot: panel is required");
        expect(two.items!.setDrillRoot(["N"], "b")!.panels).toEqual(["b"]);
        two.scene(estimateText);
        expect(two.items!.drillRoot("a")!.key).toBeNull();
        expect(itemKeys(two, "b").every((key) => key.startsWith('[1,"N"'))).toBe(true);
      } else {
        const half = (d: readonly [number, number]) =>
          [d[0] + (d[1] - d[0]) / 4, d[1] - (d[1] - d[0]) / 4] as const;
        const { x, y } = faceted.items!.result("N")!.plane!;
        faceted.items!.setView({ x: half(x.domain), y: half(y.domain) }, "S");
        faceted.scene(estimateText);
        for (const panel of ["N", "S"])
          expect(faceted.items!.result(panel)!.plane!.zoom).toBeCloseTo(2, 6);
        expect(() => two.items!.setView([0, 1], undefined)).toThrow(
          "setViewport: panel is required",
        );
        const b = two.items!.result("b")!.plane!;
        two.items!.setView({ x: half(b.x.domain), y: half(b.y.domain) }, "b");
        two.scene(estimateText);
        expect(two.items!.result("a")!.plane!.zoom).toBe(1);
        expect(two.items!.result("b")!.plane!.zoom).toBeCloseTo(2, 6);
      }
      expect(() =>
        build({ marks: [c.make()], facet: facet("group"), interaction: { zoom: "x" } }),
      ).toThrow(`${c.name} zoom: expected interaction.zoom true`);
    },
  );

  it.each(paneled.filter((c) => !c.navigates))(
    "$name panels refuse zoom unless a panel has axes",
    (c) => {
      const interaction = { zoom: "x" } as const;
      expect(() => build({ marks: [c.make()], facet: facet("group"), interaction })).toThrow(
        `${c.name} zoom: no axes to zoom`,
      );
      expect(() =>
        build({ marks: [c.make({ panel: "a" })], panels: panels([{ id: "a" }]), interaction }),
      ).toThrow(`${c.name} zoom: no axes to zoom`);
      const { model } = build(besideLine(c, { interaction }));
      model.setViewport([1, 2], "a");
      model.scene(estimateText);
      expect(model.panels()[0]!.x.domain).toEqual([1, 2]);
    },
  );

  it.each(layouts.filter((c) => c.turns))("$name turns and magnifies its camera", (c) => {
    const { model, scene } = build({
      marks: [c.make()],
      interaction: { zoom: true, rotate: true },
    });
    const before = model.camera!;
    expect(model.setCamera({ azimuth: before.azimuth + 30, zoom: before.zoom * 1.2 })).toBe(true);
    expect(model.camera!.azimuth).toBeCloseTo(before.azimuth + 30);
    expect(model.camera!.zoom).toBeCloseTo(before.zoom * 1.2);
    expect(model.scene(estimateText).panels[0]!.marks).not.toEqual(scene.panels[0]!.marks);
  });

  it.each(cartesian)("$name subplots accept x navigation and refuse y navigation", (c) => {
    const config = {
      marks: [c.make({ panel: "*" })],
      panels: subplot,
      resolve: { y: "shared" },
    } satisfies ChartConfig;
    const { scene } = build({ ...config, interaction: { zoom: "x" } });
    for (const panel of scene.panels) expectGeometry(panel, c.kind);
    expect(() => build({ ...config, interaction: { zoom: "xy" } })).toThrow(
      "zoom and brush along x only",
    );
  });

  it.each(cartesian)("$name facets cannot zoom y when y scales differ", (c) => {
    expect(() =>
      build(facetConfig(c, { resolve: { y: "independent" }, interaction: { zoom: "y" } })),
    ).toThrow("cannot zoom along y yet");
    const { scene } = build(
      facetConfig(c, { resolve: { y: "independent" }, interaction: { zoom: "x" } }),
    );
    for (const panel of scene.panels) expectGeometry(panel, c.kind);
  });
});

describe("capabilities: brushes", () => {
  // Gesture handling and range-to-row membership belong to the browser/application.
  it.each(cartesian)("$name accepts brush configuration", (c) => {
    for (const brush of ["x", "y", "xy", "lasso"] as const) {
      const { scene } = build({ marks: [c.make()], interaction: { brush } });
      expectGeometry(scene.panels[0]!, c.kind);
    }
  });

  it.each(layouts)("$name refuses brushes but plane lassos", (c) => {
    expect(() => build({ marks: [c.make()], interaction: { brush: "x" } })).toThrow(
      c.navigates === "plane"
        ? `${c.name} brush: expected interaction.brush "lasso"; received "x"`
        : `${c.name} brush: no axes to brush; drop interaction.brush`,
    );
    if (c.navigates === "plane") build({ marks: [c.make()], interaction: { brush: "lasso" } });
  });

  it.each(layouts)("$name takes interaction.drag only if it moves items", (c) => {
    const config = { marks: [c.make()], interaction: { drag: true } };
    if (c.drags) expect(kindOf(build(config).model)).toBe("drag");
    else expect(() => build(config)).toThrow(`${c.name} drag: no nodes to drag`);
  });

  it.each(paneled)("$name beside a line accepts an x brush for the line's panel", (c) => {
    const { scene } = build(besideLine(c, { interaction: { brush: "x" } }));
    expectGeometry(scene.panels[1]!, c.kind);
    expect(() =>
      build({ marks: [c.make()], facet: facet("group"), interaction: { brush: "x" } }),
    ).toThrow(
      c.navigates === "plane"
        ? `${c.name} brush: expected interaction.brush "lasso"`
        : `${c.name} brush: no axes to brush`,
    );
  });

  it.each(paneled.filter((c) => c.navigates === "plane"))(
    "$name takes a lasso in facet panels and in subplots without axes",
    (c) => {
      const interaction = { brush: "lasso" } as const;
      build({ marks: [c.make()], facet: facet("group"), interaction });
      build({
        marks: [c.make({ panel: "a" }), c.make({ panel: "b" })],
        panels: subplot,
        interaction,
      });
      expect(() => build(besideLine(c, { interaction }))).toThrow("zoom and brush along x only");
    },
  );

  it.each(cartesian)("$name subplots accept x brushes and refuse other brushes", (c) => {
    const config = {
      marks: [c.make({ panel: "*" })],
      panels: subplot,
      resolve: { y: "shared" },
    } satisfies ChartConfig;
    const { scene } = build({ ...config, interaction: { brush: "x" } });
    for (const panel of scene.panels) expectGeometry(panel, c.kind);
    for (const brush of ["y", "xy", "lasso"] as const) {
      expect(() => build({ ...config, interaction: { brush } })).toThrow(
        "zoom and brush along x only",
      );
    }
  });

  it("independent categorical y facets allow only x brushes", () => {
    const config = {
      marks: [point(samples, { x: "x", y: "category" })],
      facet: facet("group"),
      resolve: { y: "independent" },
    } satisfies ChartConfig;
    expectGeometry(build({ ...config, interaction: { brush: "x" } }).scene.panels[0]!, "point");
    for (const brush of ["y", "xy", "lasso"] as const) {
      expect(() => build({ ...config, interaction: { brush } })).toThrow(
        "panels with y categories of their own brush along x only",
      );
    }
  });
});

describe("capabilities: synced selection", () => {
  // Acceptance pins the model precondition for browser range/outline sync.
  it.each(cartesian)(
    "$name accepts a sync group, also with shared facet and subplot categories",
    (c) => {
      const interaction = { sync: "capability-contract" };
      expectGeometry(build({ marks: [c.make()], interaction }).scene.panels[0]!, c.kind);
      const faceted = build(facetConfig(c, { interaction }));
      for (const panel of faceted.scene.panels) expectGeometry(panel, c.kind);
      const stacked = build({
        marks: [c.make({ panel: "*" })],
        panels: subplot,
        resolve: { y: "shared" },
        interaction,
      });
      for (const panel of stacked.scene.panels) expectGeometry(panel, c.kind);
    },
  );

  it.each(layouts)("$name refuses synced selection", (c) => {
    expect(() =>
      build({ marks: [c.make()], interaction: { sync: "capability-contract" } }),
    ).toThrow(`${c.name} sync: no axes to sync; drop interaction.sync`);
  });

  it.each(paneled)("$name beside a line accepts a sync group for the line's panel", (c) => {
    const interaction = { sync: "capability-contract" };
    expectGeometry(build(besideLine(c, { interaction })).scene.panels[1]!, c.kind);
    expect(() => build({ marks: [c.make()], facet: facet("group"), interaction })).toThrow(
      `${c.name} sync: no axes to sync`,
    );
  });

  it.each(
    cartesian.filter((c) =>
      ["bar", "point", "boxplot", "boxen", "violin", "heatmap"].includes(c.name),
    ),
  )("$name refuses sync when panel categories are independent", (c) => {
    const mark =
      c.name === "bar"
        ? bar(samples, { x: "category", y: "y" })
        : c.name === "point"
          ? point(samples, { x: "category", y: "y" })
          : c.make();
    const axis = c.name === "heatmap" ? "y" : "x";
    expect(() =>
      build({
        marks: [mark],
        facet: facet("group"),
        resolve: { [axis]: "independent" },
        interaction: { sync: "capability-contract" },
      }),
    ).toThrow("categories of their own");
  });
});

describe("capabilities: row selection", () => {
  // Which marks' rows gestures select (model/selected-rows.ts), and which
  // marks draw a channel's rows highlighted (model/highlight.ts).
  const selects = new Set(
    ["line", "area", "bar", "point", "errorbar", "candlestick", "heatmap"].concat([
      "area stack fill",
      "area stack center",
      "area stack wiggle",
      "bar fill",
      "line along y",
      "area over categories",
      "point swarm",
      "histogram",
      "histogram 2d",
      "boxplot",
      "boxen",
      "violin",
      "rug",
    ]),
  );
  const highlights = new Set([
    "area stack fill",
    "area stack center",
    "area stack wiggle",
    "bar fill",
    "line",
    "area",
    "line along y",
    "area over categories",
    "bar",
    "point",
    "point swarm",
  ]);

  /** A chart of a case bound to a store of `samples`, as a mounted chart binds it. */
  function bound(c: MarkCase) {
    const store = selectionStore(c.table ?? (samples as unknown as Table));
    const marks = c.repeats ? [line(samples, { x: "x", y: "y" }), c.make()] : [c.make()];
    const selection = rowSelection({ store, channel: "c" });
    const { model } = build({ marks, rowSelection: selection });
    const chart = { selection: null, select() {}, render() {}, root: new EventTarget() as never };
    const live = { textContent: null };
    selection.mount(
      undefined,
      model,
      chart,
      { emit() {} },
      () => {},
      () => null,
      live,
    );
    return { model, store };
  }

  /** The SVG of the case's own geometry. */
  function drawn(model: ChartModel, c: MarkCase): string[] {
    const scene = model.scene(estimateText);
    const context = { theme: scene.theme, encodeRaster: undefined };
    return scene.panels[0]!.marks.filter((m) => !c.repeats || m.kind === c.kind).map((m) =>
      m.draw.svg(m, context),
    );
  }

  it.each(cartesian)("$name takes part as documented", (c) => {
    const { model, store } = bound(c);
    const brush = { x: [0, 2] as const, y: null, lasso: null };
    // Annotations and custom marks select no rows; the others do.
    const rows = brushedRows(model, c.table ?? (samples as unknown as Table), brush, null);
    expect(rows !== undefined).toBe(selects.has(c.name) || c.repeats === true);
    const plain = drawn(model, c);
    store.set("c", selectRows(new RowSet(c.table ?? (samples as unknown as Table)).add(0)));
    const lit = drawn(model, c);
    expect(lit.join("") !== plain.join("")).toBe(highlights.has(c.name));
  });

  it.each(layouts.filter((c) => !c.selects))("$name refuses a row selection", (c) => {
    const store = selectionStore(tablesOf(c.make())[0]!);
    expect(() =>
      build({ marks: [c.make()], rowSelection: rowSelection({ store, channel: "c" }) }),
    ).toThrow("cannot select rows yet");
  });

  it.each(layouts.filter((c) => c.selects))(
    "$name selects the rows its items stand for, and highlights them",
    (c) => {
      const mark = c.make();
      const table = tablesOf(mark)[0]!;
      const store = selectionStore(table);
      const selection = rowSelection({ store, channel: "c" });
      const { model } = build({ marks: [mark], rowSelection: selection });
      const chart = { selection: null, select() {}, render() {}, root: new EventTarget() as never };
      selection.mount(
        undefined,
        model,
        chart,
        { emit() {} },
        () => {},
        () => null,
        {
          textContent: null,
        },
      );
      // Some item stands for rows of the table.
      const keys = itemKeys(model);
      const rows = keys
        .map((key) => model.items!.result()!.rowsOf?.(key, table))
        .find((found) => found && found.length > 0);
      expect(rows).toBeDefined();
      const plain = model.scene(estimateText).panels[0]!.marks.map((m) => m.key);
      store.set("c", selectRows(new RowSet(table).add(rows![0]!)));
      const lit = model.scene(estimateText).panels[0]!.marks.map((m) => m.key);
      expect(lit.some((key) => key.endsWith("-dimmed"))).toBe(true);
      expect(plain.some((key) => key.endsWith("-dimmed"))).toBe(false);
    },
  );

  it.each(paneled.filter((c) => c.selects))(
    "$name selects a facet panel's rows its items stand for there, and highlights them",
    (c) => {
      const mark = c.make();
      const table = tablesOf(mark)[0]!;
      const store = selectionStore(table);
      const selection = rowSelection({ store, channel: "c" });
      const { model } = build({ marks: [mark], facet: facet("group"), rowSelection: selection });
      const chart = { selection: null, select() {}, render() {}, root: new EventTarget() as never };
      selection.mount(
        undefined,
        model,
        chart,
        { emit() {} },
        () => {},
        () => null,
        {
          textContent: null,
        },
      );
      const found = (panel: string) =>
        itemKeys(model, panel)
          .map((key) => model.items!.result(panel)!.rowsOf?.(key, table))
          .find((rows) => rows && rows.length > 0);
      const [n, s] = [found("N"), found("S")];
      expect(n).toBeDefined();
      // The rows an item of one panel stands for are none of another's (a node's of the nodes table aside).
      if (c.name !== "graph")
        expect(Array.from(n!).some((row) => Array.from(s ?? []).includes(row))).toBe(false);
      store.set("c", selectRows(new RowSet(table).add(n![0]!)));
      const lit = model
        .scene(estimateText)
        .panels.flatMap((panel) => panel.marks.map((m) => m.key));
      expect(lit.some((key) => key.endsWith("-dimmed"))).toBe(true);
    },
  );

  it.each(paneled)(
    "$name in a panel of its own takes a row selection beside a line as it does alone",
    (c) => {
      const store = selectionStore(samples);
      const rows = rowSelection({ store, channel: "c" });
      if (c.selects) build(besideLine(c, { rowSelection: rows }));
      else
        expect(() => build(besideLine(c, { rowSelection: rows }))).toThrow(
          "cannot select rows yet",
        );
    },
  );
});

describe("capabilities: legend toggle", () => {
  it.each(cartesian.filter((c) => !c.noLegend))("$name hides a series through its legend", (c) => {
    const { model, scene } = build({ marks: [c.make()], legend: true });
    const [entry] = scene.legend;
    expect(entry).toBeDefined();
    const before = scene.panels[0]!.marks.reduce((n, m) => n + m.draw.size(m), 0);
    model.hidden.add(entry!.key);
    const next = model.scene(estimateText);
    expect(next.legend.find((e) => e.key === entry!.key)!.hidden).toBe(true);
    expect(next.panels[0]!.marks.reduce((n, m) => n + m.draw.size(m), 0)).toBeLessThan(before);
    expect(model.keyboardStops("").some((s) => s.key === entry!.key)).toBe(false);
  });

  it.each(cartesian.filter((c) => c.noLegend))("$name has no series toggle", (c) => {
    const { scene } = build({ marks: [c.make()], legend: true });
    expect(scene.legend).toEqual([]);
    expectGeometry(scene.panels[0]!, c.kind);
    if (c.name === "heatmap") expect(scene.colorLegends).toHaveLength(1);
  });

  // Gauges, funnels, and Sankey diagrams have no legend; a surface's is its color scale.
  const noToggle = new Set(["gauge", "funnel", "sankey", "surface"]);

  it.each(layouts.filter((c) => noToggle.has(c.name)))("$name has no series toggle", (c) => {
    const { scene } = build({ marks: [c.make()], legend: true });
    expect(scene.legend).toEqual([]);
    if (c.name === "surface") expect(scene.colorLegends).toHaveLength(1);
  });

  it.each(layouts.filter((c) => !noToggle.has(c.name)))(
    "$name offers the documented legend toggle",
    (c) => {
      const { model, scene } = build({ marks: [c.make()], legend: true });
      expect(scene.legend.length).toBeGreaterThan(0);
      const entry = scene.legend[0]!;
      const before = itemKeys(model);
      const colors = before.map((key) => model.inspectItem(key)!.points[0]!.color);
      model.hidden.add(entry.key);
      const next = model.scene(estimateText);
      expect(next.legend.find((e) => e.key === entry.key)!.hidden).toBe(true);
      if (c.name === "geoshape") {
        // Categorical map regions gray out while their shape remains.
        expect(itemKeys(model)).toEqual(before);
        expect(before.map((key) => model.inspectItem(key)!.points[0]!.color)).not.toEqual(colors);
      } else {
        expect(itemKeys(model).length).toBeLessThan(before.length);
      }
    },
  );

  it.each(paneled.filter((c) => !noToggle.has(c.name)))(
    "$name toggles an item in every facet panel at once",
    (c) => {
      const { model, scene } = build({ marks: [c.make()], facet: facet("group"), legend: true });
      // One legend, its entries each once, for every panel.
      const keys = scene.legend.map(({ key }) => key);
      expect(new Set(keys).size).toBe(keys.length);
      const entry = scene.legend.at(-1)!;
      const before = ["N", "S"].map((panel) => itemKeys(model, panel));
      const colors = ["N", "S"].map(
        (panel) =>
          model.inspectItem(before[["N", "S"].indexOf(panel)]![0]!, panel)!.points[0]!.color,
      );
      model.hidden.add(entry.key);
      model.scene(estimateText);
      const after = ["N", "S"].map((panel) => itemKeys(model, panel));
      // Categorical map regions gray out while their shape remains.
      if (c.name === "geoshape") expect(after).toEqual(before);
      else expect(after.flat().length).toBeLessThan(before.flat().length);
      for (const keys of after) expect(keys).not.toContain(entry.key);
      // Items keep the colors of their keys, whichever panel draws them.
      expect(colors.every((color) => color.startsWith("#"))).toBe(true);
    },
  );

  it("graph toggles groups and has no toggle without a group field", () => {
    const ungrouped = graph(links, { source: "source", target: "target" });
    const { scene } = build({ marks: [ungrouped], legend: true });
    expect(scene.legend).toEqual([]);
    expectGeometry(scene.panels[0]!, "point");
  });

  it("custom marks without series have no toggle", () => {
    const { scene } = build({
      marks: [
        custom(samples, {
          x: "x",
          y: "y",
          series: false,
          draw({ circle, x, y }) {
            circle(x(1), y(2), 3);
          },
        }),
      ],
      legend: true,
    });
    expect(scene.legend).toEqual([]);
    expectGeometry(scene.panels[0]!, "shapes");
  });
});

describe("capabilities: tooltip and keyboard reading", () => {
  it.each(cartesian.filter((c) => !c.reading))(
    "$name has an inspectable keyboard stop and pointer item",
    (c) => {
      const { model } = build({ marks: [c.make()] });
      const [stop] = model.keyboardStops("");
      expect(stop).toBeDefined();
      const inspection = model.inspectPosition(stop!.key, 0)!;
      expect(inspection).toBeDefined();
      const [item] = inspection.points;
      expect(item!.text.length).toBeGreaterThan(0);
      expect(model.inspect(item!.px, item!.py)?.points.length).toBeGreaterThan(0);
    },
  );

  it.each(annotations)("$name is read in the summary without individual stops", (c) => {
    const { model } = build({ marks: [c.make()] });
    expect(model.keyboardStops("")).toEqual([]);
    expect(model.inspectPosition("missing", 0)).toBeUndefined();
    expect(model.inspect(model.xScale()!.map(1), model.yScale()!.map(2))).toBeUndefined();
    expect(describeChart(model)).toContain(`Contract ${c.name}`);
  });

  it.each(layouts)("$name exposes an item in keyboard order and inspection", (c) => {
    const { model } = build({ marks: [c.make()] });
    const key = model.stepItem(undefined, 1);
    expect(key).toBeDefined();
    const inspection = model.inspectItem(key!)!;
    expect(inspection).toBeDefined();
    expect(inspection.points[0]!.text.length).toBeGreaterThan(0);
  });

  it.each(paneled)("$name reads each panel's items, the pointer finding its panel's", (c) => {
    const { model } = build({ marks: [c.make()], facet: facet("group") });
    for (const panel of ["N", "S"]) {
      const key = model.stepItem(undefined, 1, panel)!;
      const item = model.inspectItem(key, panel)!;
      expect(item.panel).toBe(panel);
      const { px, py } = item.points[0]!;
      expect(model.inspect(px, py)?.panel).toBe(panel);
      expect(model.layoutSummary(panel)!.length).toBeGreaterThan(0);
    }
  });

  it.each([
    { name: "boxplot", make: boxplot },
    { name: "boxen", make: boxen },
    { name: "violin", make: violin },
  ])("$name skips nonpositive medians on log axes", (c) => {
    const signed = table({
      group: ["negative", "negative", "positive", "positive"],
      value: [-4, -2, 2, 4],
    });
    const { model } = build({
      marks: [c.make(signed, { x: "group", y: "value" })],
      y: { type: "log" },
    });
    const [series] = model.keyboardStops("");
    expect(series).toBeDefined();
    expect(model.inspectPosition(series!.key, 0)).toBeUndefined();
    expect(model.inspectPosition(series!.key, 1)!.points[0]!.text).toContain("median 3");
  });

  it("custom shapes without series are summarized but cannot be inspected", () => {
    const { model } = build({
      marks: [
        custom(samples, {
          x: "x",
          y: "y",
          series: false,
          description: "Contract custom shapes",
          draw({ circle, x, y }) {
            circle(x(1), y(2), 3);
          },
        }),
      ],
    });
    expect(model.keyboardStops("")).toEqual([]);
    expect(model.inspect(model.xScale()!.map(1), model.yScale()!.map(2))).toBeUndefined();
    expect(describeChart(model)).toBe("Contract custom shapes");
  });
});

describe("capabilities: tooltip fields", () => {
  const fields = { fields: ["note"] } as const;
  // Marks whose points are rows; those that summarize rows take no fields.
  const rows: { name: string; make: () => ChartMark; items?: true }[] = [
    { name: "line", make: () => line(samples, { x: "x", y: "y", tooltip: fields }) },
    { name: "area", make: () => area(samples, { x: "x", y: "y", tooltip: fields }) },
    { name: "bar", make: () => bar(samples, { x: "x", y: "y", tooltip: fields }) },
    { name: "point", make: () => point(samples, { x: "x", y: "y", tooltip: fields }) },
    { name: "rug", make: () => rug(samples, { x: "x", tooltip: fields }) },
    {
      name: "errorbar",
      make: () => errorBar(samples, { x: "x", y1: "low", y2: "high", tooltip: fields }),
    },
    {
      name: "candlestick",
      make: () =>
        candlestick(samples, {
          x: "x",
          open: "low",
          high: "high",
          low: "low",
          close: "y",
          tooltip: fields,
        }),
    },
    {
      name: "heatmap",
      make: () => heatmap(samples, { x: "x", y: "category", color: "y", tooltip: fields }),
    },
    {
      name: "custom",
      make: () => custom(samples, { x: "x", y: "y", tooltip: fields, draw() {} }),
    },
    {
      name: "geoshape",
      make: () => geoshape(world, { tooltip: { fields: ["group"] } }),
      items: true,
    },
    {
      name: "geopoint",
      make: () => geopoint(samples, { longitude: "x", latitude: "y", tooltip: fields }),
      items: true,
    },
    {
      name: "point3d",
      make: () => point3d(spatial, { x: "x", y: "y", z: "z", tooltip: { fields: ["group"] } }),
      items: true,
    },
    {
      name: "line3d",
      make: () => line3d(spatial, { x: "x", y: "y", z: "z", tooltip: { fields: ["group"] } }),
      items: true,
    },
  ];

  it.each(rows)("$name shows fields of the row its point is", (c) => {
    const model = new ChartModel({ locale: "en-US", timeZone: "UTC", marks: [c.make()] });
    // As a chart does once it has loaded what reads them.
    model.fields = fieldReader;
    model.setSize(600, 400, 1);
    model.scene(estimateText);
    const point = c.items
      ? model.inspectItem(model.stepItem(undefined, 1)!)!.points[0]!
      : model.inspectPosition(model.keyboardStops("")[0]!.key, 0)!.points[0]!;
    const [field] = point.fields!;
    expect(field!.text.length).toBeGreaterThan(0);
    expect(field!.field).toBe(c.items && c.name !== "geopoint" ? "group" : "note");
  });
});

describe("capabilities: value animation preconditions", () => {
  // Pure snapshots/plans, as in test/dom/value-transition.test.ts; no frame
  // scheduler, timers, reduced-motion media queries, or browser gestures.
  const builders = { planAxis, Polyline, monotonePolyline };
  it.each(all)("$name provides only its documented movable geometry", (c) => {
    const { scene, model } = build({ marks: [c.make()], animation: { values: true } });
    expectGeometry(scene.panels[0]!, c.kind);
    expect(snapshot(scene, model.panels()[0], 0) !== undefined).toBe(c.animates === true);
  });

  const traces = [
    { name: "line", make: line },
    { name: "area", make: area },
  ];
  it.each(traces)("$name animates retained rows and refuses changed x positions", (c) => {
    const values = table({ x: [0, 1, 2], y: [2, 3, 4] });
    const { model, scene } = build({
      marks: [c.make(values, { x: "x", y: "y" })],
      x: { domain: [0, 3] },
      y: { domain: [0, 10] },
      animation: { values: true },
    });
    const shown = snapshot(scene, model.panels()[0], 0)!;
    values.setColumn("y", [4, 5, 6]);
    expect(
      plan(
        shown,
        model.scene(estimateText),
        model.panels()[0],
        200,
        builders,
        sidesOf(model.config),
      ),
    ).toBeDefined();
    values.setColumn("x", [0, 1.5, 2]);
    expect(
      plan(
        shown,
        model.scene(estimateText),
        model.panels()[0],
        200,
        builders,
        sidesOf(model.config),
      ),
    ).toBeUndefined();
  });

  it("bars animate plain values, but stacked and labeled bars do not", () => {
    for (const options of [{}, { stack: true }, { labels: true }]) {
      const { model, scene } = build({
        marks: [bar(samples, { x: "category", y: "y", series: "group", ...options })],
        animation: { values: true },
      });
      expect(snapshot(scene, model.panels()[0], 0) !== undefined).toBe(
        !("stack" in options || "labels" in options),
      );
    }
  });

  it("bars on a log value axis draw without an animation snapshot", () => {
    const { model, scene } = build({
      marks: [bar(samples, { x: "category", y: "y" })],
      y: { type: "log" },
      animation: { values: true },
    });
    expectGeometry(scene.panels[0]!, "rect");
    expect(snapshot(scene, model.panels()[0], 0)).toBeUndefined();
  });

  it.each(["input", "value"] as const)(
    "pie slices sorted by %s animate only if retained slices keep their order",
    (sort) => {
      const values = table({ category: ["a", "b"], value: [3, 1] });
      const { model, scene } = build({
        marks: [pie(values, { category: "category", value: "value", labels: false, sort })],
        animation: { values: true },
      });
      const shown = snapshot(scene, model.panels()[0], 0)!;
      expect(shown.pie).toBeDefined();
      values.setColumn("value", [1, 3]);
      const tween = plan(
        shown,
        model.scene(estimateText),
        model.panels()[0],
        200,
        builders,
        sidesOf(model.config),
      );
      expect(tween?.pie !== undefined).toBe(sort === "input");
    },
  );

  it.each([false, true])("points across reset require an explicit key (keyed: %s)", (keyed) => {
    const values = table({ x: [0, 1], y: [2, 3], id: ["a", "b"] });
    const { model, scene } = build({
      marks: [point(values, { x: "x", y: "y", ...(keyed ? { animationKey: "id" as const } : {}) })],
      x: { domain: [0, 2] },
      y: { domain: [0, 10] },
      animation: { values: true },
    });
    const shown = snapshot(scene, model.panels()[0], 0)!;
    values.reset({ x: [0, 1], y: [4, 5], id: ["a", "b"] });
    const tween = plan(
      shown,
      model.scene(estimateText),
      model.panels()[0],
      200,
      builders,
      sidesOf(model.config),
    );
    expect((tween?.points.length ?? 0) > 0).toBe(keyed);
  });

  it.each(cartesian.filter((c) => c.animates))(
    "$name does not provide a multi-panel animation snapshot",
    (c) => {
      const { scene, model } = build(facetConfig(c, { animation: { values: true } }));
      expect(scene.panels).toHaveLength(2);
      expect(snapshot(scene, model.panels()[0], 0)).toBeUndefined();
    },
  );

  it("pies in panels show changed values at once, even in a facet of one panel", () => {
    const one = table({ category: ["a", "b"], value: [3, 1], group: ["N", "N"] });
    const { scene, model } = build({
      marks: [pie(one, { category: "category", value: "value", labels: false })],
      facet: facet("group"),
      animation: { values: true },
    });
    expect(scene.panels).toHaveLength(1);
    expect(snapshot(scene, model.panels()[0], 0)?.pie).toBeUndefined();
  });
});

// Dendrograms band their leaves, with heights fixed to plot pixels. Their
// facet repetition requires a categorical companion to supply facet values.
describe("capabilities: dendrogram", () => {
  const tree = table({ first: [0, 2], second: [1, 3], height: [1, 2] });
  const make = (p: Placement = {}) =>
    dendrogram(tree, {
      first: "first",
      second: "second",
      height: "height",
      leaves: ["a", "b", "c"],
      label: "Contract dendrogram",
      ...p,
    });
  it("repeats in facets, resolves panel categories, and draws named subplots", () => {
    expect(() => build({ marks: [make()], facet: facet("group") })).toThrow('facet: "repeat"');
    const faceted = build({
      marks: [
        heatmap(samples, { x: "category", y: "group", color: "y" }),
        make({ facet: "repeat" }),
      ],
      facet: facet("group"),
      resolve: { x: "independent", y: "independent" },
    });
    for (const panel of faceted.scene.panels) expectGeometry(panel, "segments");
    const subplots = build({
      marks: [make({ panel: "a" })],
      panels: subplot,
      resolve: { x: "independent", y: "independent" },
    });
    expectGeometry(subplots.scene.panels[0]!, "segments");
    expect(subplots.scene.panels[1]!.marks).toEqual([]);
  });
  it("keeps heights during zoom, accepts range selections, and has summary-only reading", () => {
    const { model, scene } = build({
      marks: [make()],
      legend: true,
      interaction: { zoom: "xy", brush: "x", sync: "dendrogram-contract" },
      animation: { values: true },
      x: { show: false },
      y: { show: false },
    });
    const geometry = scene.panels[0]!.marks[0] as SegmentGeometry;
    const before = Array.from(geometry.coords.subarray(0, geometry.count * 4));
    model.setViewport([10, 20]);
    model.setYViewport({ y: [10, 20], yRight: null });
    const next = model.scene(estimateText).panels[0]!.marks[0] as typeof geometry;
    expect(Array.from(next.coords.subarray(0, next.count * 4))).toEqual(before);
    expect(scene.legend).toEqual([]);
    expect(model.keyboardStops("")).toEqual([]);
    expect(model.inspect(100, 100)).toBeUndefined();
    expect(describeChart(model)).toContain(
      "Contract dendrogram: 3 leaves, 2 merges. Merge heights 1 to 2.",
    );
    expect(snapshot(scene, model.panels()[0], 0)).toBeUndefined();
  });
  it("refuses synced selection on panel categories resolved apart", () => {
    expect(() =>
      build({
        marks: [make({ panel: "a" })],
        panels: subplot,
        resolve: { x: "independent" },
        interaction: { sync: "dendrogram-contract" },
      }),
    ).toThrow("categories of their own");
  });
});

it("capabilities: every built-in mark exports as a PDF document page", () => {
  const cases = [...cartesian, ...layouts];
  const bytes = renderToPDF(
    cases.map(({ make }) => ({ width: 600, height: 400, marks: [make()] })),
  );
  const pdf = new TextDecoder("latin1").decode(bytes);
  expect(pdf).toContain(`/Count ${cases.length}`);
  expect(pdf.match(/\/S \/Figure\b/g)).toHaveLength(cases.length);
});

describe("category-colored bars", () => {
  it.each([false, true])(
    "use full bands with labels and category legends (horizontal: %s)",
    (horizontal) => {
      const data = table({ category: ["A", "B", "C"], value: [10, 20, 30] });
      const mark = bar(data, {
        ...(horizontal ? { x: "value", y: "category" } : { x: "category", y: "value" }),
        series: "category",
        labels: true,
      });
      const { model, scene } = build({ marks: [mark] });
      const band = (horizontal ? model.yScale() : model.xScale())!;
      const panel = scene.panels[0]!;
      const rects = panel.marks.filter((g): g is RectGeometry => g.kind === "rect");
      const labels = panel.marks.filter((g): g is TextGeometry => g.kind === "text");
      expect(rects).toHaveLength(3);
      expect(labels.flatMap((g) => g.labels)).toEqual(["10", "20", "30"]);
      expect(new Set(rects.map((g) => g.fill)).size).toBe(3);
      rects.forEach((g, i) => {
        const offset = horizontal ? 1 : 0;
        expect(g.rects[offset + 2]).toBeCloseTo(band.bandwidth!, 3);
        expect(g.rects[offset]! + g.rects[offset + 2]! / 2).toBeCloseTo(band.map(i), 3);
        const s = model.series()[i]!;
        expect(model.inspectPosition(s.key, 0)!.points[0]!.label).toBe(s.label);
      });
      expect(scene.legend.map((entry) => entry.label)).toEqual(["A", "B", "C"]);
      expect(scene.legend.map((entry) => ("color" in entry ? entry.color : undefined))).toEqual(
        rects.map((g) => g.fill),
      );
      model.hidden.add(model.series()[1]!.key);
      const remaining = model
        .scene(estimateText)
        .panels[0]!.marks.filter((g): g is RectGeometry => g.kind === "rect");
      expect(remaining).toHaveLength(2);
      for (const g of remaining)
        expect(g.rects[horizontal ? 3 : 2]).toBeCloseTo(band.bandwidth!, 3);
    },
  );
});
