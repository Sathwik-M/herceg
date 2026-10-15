// Inspected points name their mark, their series, and the row of the mark's
// table they are, so applications can act on the record under the pointer.
import { describe, expect, it } from "vitest";
import { col } from "../../src/data/expr.ts";
import { type FeatureCollection, fromGeoJSON } from "../../src/data/geojson.ts";
import { rowView } from "../../src/data/row-view.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { custom } from "../../src/marks/custom.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { geoshape } from "../../src/marks/geoshape.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { radar } from "../../src/marks/radar.ts";
import { rule } from "../../src/marks/rule.ts";
import { treemap } from "../../src/marks/treemap.ts";
import { violin } from "../../src/marks/violin.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel, type Inspection } from "../../src/model/model.ts";
import { positionOf } from "../helpers/keyboard.ts";

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(600, 300, 1);
  model.scene(estimateText);
  return model;
}

/** What identifies each point of an inspection. */
const identities = (inspection: Inspection | undefined) =>
  inspection?.points.map(({ mark, markId, key, label, row }) => ({
    mark,
    markId,
    key,
    label,
    row,
  }));

/** The key of the series labeled `label`. */
const keyOf = (model: ChartModel, label: string) =>
  model.series().find((s) => s.label === label)!.key;

describe("inspected points", () => {
  const data = table({ t: [0, 1, 1, 2], a: [1, 2, 2, 3], b: [5, 6, 7, 8] });

  it("name the mark, its id, the series, and the row of lines and areas", () => {
    const model = build({
      marks: [
        rule({ y: 4 }),
        line(data, { x: "t", y: "a", id: "latency" }),
        area(data, { x: "t", y1: "a", y2: "b" }),
      ],
    });
    const at = model.xScale()!.map(2);
    expect(identities(model.inspect(at, 150))).toEqual([
      { mark: 1, markId: "latency", key: '["latency","a"]', label: "a", row: 3 },
      { mark: 2, markId: undefined, key: '[2,"a–b"]', label: "a–b", row: 3 },
    ]);
    // Rows at the same coordinates stay apart: the keyboard reaches each.
    expect(identities(positionOf(model, '["latency","a"]', 2))![0]!.row).toBe(2);
    expect(identities(positionOf(model, '["latency","a"]', 1))![0]!.row).toBe(1);
  });

  it("give table rows for series split by a field, stacks, and horizontal bars", () => {
    const sales = table({
      region: ["N", "S", "N", "S"],
      kind: ["a", "a", "b", "b"],
      units: [1, 2, 3, 4],
    });
    const stacked = build({
      marks: [bar(sales, { x: "region", y: "units", series: "kind", stack: true })],
    });
    const b = keyOf(stacked, "b");
    // Series b's points are rows 2 and 3.
    expect(positionOf(stacked, b, 1)!.points.find((p) => p.key === b)!.row).toBe(3);
    const horizontal = build({ marks: [bar(sales, { x: "units", y: "region", series: "kind" })] });
    const a = keyOf(horizontal, "a");
    expect(positionOf(horizontal, a, 1)!.points.find((p) => p.key === a)!.row).toBe(1);
  });

  it("give points' rows, in the panel's part of the table with facets", () => {
    const spots = table({ x: [0, 1, 0, 1], y: [0, 1, 0, 1], f: ["A", "A", "B", "B"] });
    const model = build({ marks: [point(spots, { x: "x", y: "y" })], facet: facet("f") });
    const [, second] = model.panels();
    const inspection = model.inspect(second!.x.map(1), second!.y.map(1));
    expect(inspection).toMatchObject({ panel: "B" });
    expect(identities(inspection)).toEqual([
      { mark: 0, markId: undefined, key: '[0,"y"]', label: "y", row: 3 },
    ]);
  });

  it("give the table's row for points over a row view", () => {
    const requests = table({ ms: [120, 340, 90, 410], size: [1, 2, 3, 4] });
    const slow = rowView(requests, { filter: col("ms").gt(200) });
    const model = build({ marks: [point(slow, { x: "size", y: "ms" })] });
    const at = model.inspect(model.xScale()!.map(4), model.yScale()!.map(410));
    // The view's second row is the table's fourth.
    expect(identities(at)![0]!.row).toBe(3);
  });

  it("tell apart two uses of one mark", () => {
    const shared = line(data, { x: "t", y: "a" });
    const model = build({ marks: [shared, shared] });
    const marks = model.inspect(model.xScale()!.map(2), 150)!.points.map((p) => p.mark);
    expect(marks).toEqual([0, 1]);
  });

  it("give a heatmap cell's row: the last of the rows in that cell", () => {
    const cells = table({ x: ["a", "b", "a"], y: ["p", "p", "p"], v: [1, 2, 3] });
    const model = build({ marks: [heatmap(cells, { x: "x", y: "y", color: "v" })] });
    const inspection = model.inspect(model.xScale()!.map(0), model.yScale()!.map(0));
    expect(identities(inspection)).toEqual([
      { mark: 0, markId: undefined, key: '[0,"cells"]', label: "p", row: 2 },
    ]);
  });

  it("give custom marks' rows", () => {
    const model = build({
      marks: [custom(data, { x: "t", y: "b", draw: () => {} })],
    });
    expect(identities(model.inspect(model.xScale()!.map(1), 150))![0]!.row).toBe(1);
  });

  it("give no row for points that summarize rows", () => {
    const values = table({ g: ["a", "a", "b", "b"], v: [1, 2, 3, 4] });
    for (const mark of [
      histogram(values, { x: "v", bins: 2 }),
      boxplot(values, { x: "g", y: "v" }),
      violin(values, { x: "g", y: "v" }),
    ]) {
      const model = build({ marks: [mark] });
      const [s] = model.series();
      expect(identities(positionOf(model, s!.key, 0))![0]!.row).toBeUndefined();
    }
  });
});

describe("inspected items", () => {
  it("give no row for pie slices and tree nodes, which sum rows", () => {
    const shares = table({ kind: ["a", "b", "a"], n: [1, 2, 3] });
    const slices = build({ marks: [pie(shares, { category: "kind", value: "n", id: "share" })] });
    expect(identities(slices.inspectItem(JSON.stringify(["share", "a"])))).toEqual([
      { mark: 0, markId: "share", key: '["share","a"]', label: "a", row: undefined },
    ]);
    const tree = build({ marks: [treemap(shares, { path: ["kind"], value: "n" })] });
    const key = tree.stepItem(undefined, 1)!;
    expect(identities(tree.inspectItem(key))![0]!.row).toBeUndefined();
  });

  it("give the row of a gauge's value: the last finite one", () => {
    const cpu = table({ cpu: [40, 55, Number.NaN] });
    const model = build({ marks: [gauge(cpu, { value: "cpu" })] });
    expect(identities(model.inspectItem(model.stepItem(undefined, 1)!))![0]!.row).toBe(1);
    const empty = build({ marks: [gauge(table({ cpu: [Number.NaN] }), { value: "cpu" })] });
    expect(identities(empty.inspectItem(empty.stepItem(undefined, 1)!))![0]!.row).toBeUndefined();
  });

  it("give the row each radar point's value comes from", () => {
    const scores = table({
      player: ["Ana", "Ana", "Ana", "Ana", "Bo", "Bo", "Bo"],
      skill: ["speed", "power", "range", "speed", "speed", "power", "range"],
      score: [5, 6, 4, 8, 4, 9, 2],
    });
    const model = build({
      marks: [radar(scores, { category: "skill", value: "score", series: "player" })],
    });
    const row = (player: string, skill: string) =>
      model.inspectItem(JSON.stringify([0, player, skill]))!.points[0]!.row;
    // A later row replaces an earlier one's value, and so names the point.
    expect([row("Ana", "speed"), row("Ana", "power"), row("Bo", "range")]).toEqual([3, 1, 6]);
    const wide = table({ name: ["Ana", "Ana"], speed: [1, 8], power: [2, 6], range: [3, 4] });
    const fields = build({
      marks: [radar(wide, { fields: ["speed", "power", "range"], series: "name" })],
    });
    expect(fields.inspectItem(JSON.stringify([0, "Ana", "power"]))!.points[0]!.row).toBe(1);
  });

  it("name the layer of a map's items, with its id, and their rows", () => {
    const square = (x: number) => [
      [x, 0],
      [x + 10, 0],
      [x + 10, 10],
      [x, 10],
      [x, 0],
    ];
    const world: FeatureCollection = {
      type: "FeatureCollection",
      features: [0, 20].map((x, i) => ({
        type: "Feature" as const,
        properties: { name: `R${i}` },
        geometry: { type: "Polygon", coordinates: [square(x)] },
      })),
    };
    const cities = table({ lon: [5, 25], lat: [5, 5], city: ["P", "Q"] });
    const model = build({
      projection: "equirectangular",
      marks: [
        geoshape(fromGeoJSON(world), { labelField: "name" }),
        geopoint(cities, { longitude: "lon", latitude: "lat", labelField: "city", id: "cities" }),
      ],
    });
    expect(identities(model.inspectItem(JSON.stringify(["cities", 1])))).toEqual([
      { mark: 1, markId: "cities", key: '["cities",1]', label: "Q", row: 1 },
    ]);
    expect(identities(model.inspectItem(JSON.stringify([0, 1])))).toEqual([
      { mark: 0, markId: undefined, key: "[0,1]", label: "R1", row: 1 },
    ]);
    // The pointer finds the same.
    const { px, py } = model.inspectItem(JSON.stringify(["cities", 1]))!.points[0]!;
    expect(identities(model.inspect(px, py))![0]!.mark).toBe(1);
  });
});
