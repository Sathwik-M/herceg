// Tooltip fields: data of the row a tooltip is at that marks do not plot,
// in inspections (and so tooltips, hover events, and announcements).
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { type FeatureCollection, fromGeoJSON } from "../../src/data/geojson.ts";
import { table } from "../../src/data/table.ts";
import { describeInspection } from "../../src/dom/tooltip.ts";
import { fieldReader } from "../../src/dom/tooltip-content.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { geoshape } from "../../src/marks/geoshape.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { validateSpec } from "../../src/spec/validate.ts";

function build(config: ChartConfig) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  // As a chart does once it has loaded what reads the fields.
  model.fields = fieldReader;
  model.setSize(600, 300, 1);
  model.scene(estimateText);
  return model;
}

const DAY = 86_400_000;
const start = Date.UTC(2026, 0, 19);
const latency = () =>
  table({
    time: time([start, start + DAY, start + 2 * DAY]),
    p99: [210, 304, 250],
    requests: [9_800, 12_480, 11_020],
    host: ["a", "b", "a"],
    deployed: time([start - DAY / 2, null, start]),
  });

/** What the points of an inspection at x show of their rows. */
function fieldsAt(model: ChartModel, x: number, y = 150) {
  return model.inspect(model.xScale()!.map(x), y)!.points.map((p) => p.fields);
}

describe("tooltip fields", () => {
  it("show fields of the row under the values, formatted by kind or as asked", () => {
    const model = build({
      marks: [
        line(latency(), {
          x: "time",
          y: "p99",
          tooltip: {
            fields: [
              { field: "requests", label: "Requests" },
              { field: "requests", label: "Thousands", format: { notation: "compact" } },
              "host",
              "deployed",
              { field: "deployed", label: "Day", format: { weekday: "long" } },
            ],
          },
        }),
      ],
      x: { format: { weekday: "short", month: "short", day: "numeric" } },
    });
    const inspection = model.inspect(model.xScale()!.map(start + DAY), 150)!;
    expect(inspection.label).toBe("Tue, Jan 20");
    expect(inspection.points[0]!.text).toBe("304");
    expect(inspection.points[0]!.fields).toEqual([
      { field: "requests", label: "Requests", kind: "number", value: 12_480, text: "12,480" },
      { field: "requests", label: "Thousands", kind: "number", value: 12_480, text: "12K" },
      { field: "host", label: "host", kind: "category", value: "b", text: "b" },
      // A missing value, and times as the x axis writes them.
      { field: "deployed", label: "deployed", kind: "time", value: null, text: "–" },
      { field: "deployed", label: "Day", kind: "time", value: null, text: "–" },
    ]);
    expect(fieldsAt(model, start)[0]!.slice(3)).toEqual([
      {
        field: "deployed",
        label: "deployed",
        kind: "time",
        value: start - DAY / 2,
        text: "Sun, Jan 18",
      },
      { field: "deployed", label: "Day", kind: "time", value: start - DAY / 2, text: "Sunday" },
    ]);
    // The keyboard reads them as the tooltip shows them.
    expect(describeInspection(inspection)).toBe(
      "Tue, Jan 20. p99: 304, Requests: 12,480, Thousands: 12K, host: b, deployed: –, Day: –",
    );
  });

  it("write values with the axes' tooltip formats, leaving tick labels as they are", () => {
    const model = build({
      marks: [line(latency(), { x: "time", y: "p99" })],
      x: { tooltipFormat: { weekday: "short", month: "short", day: "numeric" } },
      y: { tooltipFormat: { style: "unit", unit: "millisecond" } },
    });
    const inspection = model.inspect(model.xScale()!.map(start + DAY), 150)!;
    expect([inspection.label, inspection.points[0]!.text]).toEqual(["Tue, Jan 20", "304 ms"]);
    const ticks = model.panels()[0]!.plans;
    expect(ticks.x.labels).toContain("Jan 20");
    expect(ticks.y.labels.every((label) => /^\d+$/.test(label))).toBe(true);
    // The chart's formatValue writes values as tooltips do.
    expect(model.formatsOf(undefined).y(250)).toBe("250 ms");
  });

  it("show each series its own row's fields at a shared x, and none for marks without", () => {
    const data = table({
      t: [0, 0, 1, 1],
      v: [1, 2, 3, 4],
      host: ["a", "b", "a", "b"],
      n: [10, 20, 30, 40],
    });
    const model = build({
      marks: [
        line(data, { x: "t", y: "v", series: "host", tooltip: { fields: ["n"] } }),
        line(data, { x: "t", y: "n", id: "plain" }),
      ],
    });
    expect(fieldsAt(model, 1)).toEqual([
      [{ field: "n", label: "n", kind: "number", value: 30, text: "30" }],
      [{ field: "n", label: "n", kind: "number", value: 40, text: "40" }],
      undefined,
    ]);
  });

  it("read times as dates and times without a time x axis", () => {
    const sizes = table({ k: ["a", "b"], v: [1, 2], at: time(["2026-01-21T09:30:00Z", null]) });
    const model = build({ marks: [bar(sizes, { x: "k", y: "v", tooltip: { fields: ["at"] } })] });
    expect(fieldsAt(model, 0)[0]).toEqual([
      {
        field: "at",
        label: "at",
        kind: "time",
        value: Date.UTC(2026, 0, 21, 9, 30),
        text: "Jan 21, 2026, 9:30 AM",
      },
    ]);
  });

  it("write times no date holds as missing", () => {
    const odd = table({ t: [0, 1], v: [1, 2], at: time([Number.POSITIVE_INFINITY, 9e15]) });
    const model = build({ marks: [line(odd, { x: "t", y: "v", tooltip: { fields: ["at"] } })] });
    expect(fieldsAt(model, 0)[0]![0]!.text).toBe("–");
    expect(fieldsAt(model, 1)[0]![0]!.text).toBe("–");
  });

  it("follow the rows as a table streams, and the panel's rows with facets", () => {
    const data = table(
      { t: [0, 1, 2], v: [1, 2, 3], n: [10, 20, 30], region: ["N", "S", "N"] },
      { maxRows: 3 },
    );
    const mark = point(data, { x: "t", y: "v", tooltip: { fields: ["n"] } });
    const model = build({ marks: [mark] });
    data.append({ t: [3], v: [4], n: [40], region: ["S"] });
    model.scene(estimateText);
    const at = model.inspect(model.xScale()!.map(3), model.yScale()!.map(4))!;
    expect([at.points[0]!.row, at.points[0]!.fields![0]!.value]).toEqual([2, 40]);
    const faceted = build({ marks: [mark], facet: facet("region") });
    const south = faceted.panels().find(({ key }) => key === "S")!;
    const there = faceted.inspect(south.x.map(3), south.y.map(4))!;
    expect([there.panel, there.points[0]!.fields![0]!.value]).toEqual(["S", 40]);
  });

  it("show a heatmap cell's row", () => {
    const cells = table({ x: ["a", "b"], y: ["p", "p"], v: [1, 2], note: ["low", "high"] });
    const model = build({
      marks: [heatmap(cells, { x: "x", y: "y", color: "v", tooltip: { fields: ["note"] } })],
    });
    const panel = model.panels()[0]!;
    const inspection = model.inspect(panel.x.map(1), panel.y.map(0))!;
    expect(inspection.points[0]!.fields).toEqual([
      { field: "note", label: "note", kind: "category", value: "high", text: "high" },
    ]);
  });

  it("show fields of map regions' and points' rows", () => {
    const world: FeatureCollection = {
      type: "FeatureCollection",
      features: [0, 20].map((x, i) => ({
        type: "Feature" as const,
        properties: { name: `R${i}`, people: (i + 1) * 1000 },
        geometry: {
          type: "Polygon",
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
    };
    const cities = table({ lon: [5, 25], lat: [5, 5], city: ["P", "Q"], rank: [2, 1] });
    const model = build({
      projection: "equirectangular",
      marks: [
        geoshape(fromGeoJSON(world), { labelField: "name", tooltip: { fields: ["people"] } }),
        geopoint(cities, {
          longitude: "lon",
          latitude: "lat",
          labelField: "city",
          id: "cities",
          tooltip: { fields: [{ field: "rank", label: "Rank" }] },
        }),
      ],
    });
    expect(model.inspectItem(JSON.stringify([0, 1]))!.points[0]!.fields).toEqual([
      { field: "people", label: "people", kind: "number", value: 2000, text: "2,000" },
    ]);
    expect(model.inspectItem(JSON.stringify(["cities", 0]))!.points[0]!.fields).toEqual([
      { field: "rank", label: "Rank", kind: "number", value: 2, text: "2" },
    ]);
  });

  it("refuse fields the table does not have, or that hold shapes", () => {
    const data = latency();
    expect(() =>
      line(data, { x: "time", y: "p99", tooltip: { fields: ["requests", "reqeusts" as never] } }),
    ).toThrow(
      'line tooltip.fields[1]: no field "reqeusts"; the table has "time", "p99", "requests", "host", "deployed"',
    );
    const shapes = fromGeoJSON({ type: "FeatureCollection", features: [] });
    expect(() => geoshape(shapes, { tooltip: { fields: ["geometry" as never] } })).toThrow(
      /^geoshape tooltip.fields\[0\]: field "geometry" holds geometry values; expected number or time or category/,
    );
  });

  it("are read only once the chart has what reads them", () => {
    const model = new ChartModel({
      marks: [line(latency(), { x: "time", y: "p99", tooltip: { fields: ["requests"] } })],
    });
    model.setSize(600, 300, 1);
    model.scene(estimateText);
    expect(fieldsAt(model, start)).toEqual([undefined]);
  });

  it("come from specs, which are checked", () => {
    const spec = (tooltip: unknown): ChartSpec =>
      ({
        data: {
          d: {
            columns: {
              t: { type: "time", values: ["2026-01-19", "2026-01-20"] },
              v: [1, 2],
              n: [5, 6],
            },
          },
        },
        marks: [{ type: "line", x: "t", y: "v", tooltip }],
      }) as ChartSpec;
    const { config } = loadSpec(spec({ fields: [{ field: "n", label: "Count" }] }));
    const model = build(config);
    expect(fieldsAt(model, Date.UTC(2026, 0, 20))[0]).toEqual([
      { field: "n", label: "Count", kind: "number", value: 6, text: "6" },
    ]);
    expect(() => validateSpec(spec({ fields: "n" }))).toThrow(
      'marks[0].tooltip.fields: expected an array of fields; received "n"',
    );
    expect(() => validateSpec(spec({ fields: [{ label: "Count" }] }))).toThrow(
      "marks[0].tooltip.fields[0].field: required",
    );
    expect(() => validateSpec(spec({ fields: [{ field: "n", lable: "Count" }] }))).toThrow(
      /marks\[0\]\.tooltip\.fields\[0\]\.lable: not a property/,
    );
    expect(() => loadSpec(spec({ fields: ["m"] }))).toThrow(/tooltip.fields\[0\]: no field "m"/);
  });
});
