// Contours: lines and bands of a field sampled on a grid, from rows or a matrix.
import { afterEach, describe, expect, it, vi } from "vitest";
import { fromMatrix, matrixOf } from "../../src/data/matrix.ts";
import { type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { contour } from "../../src/marks/contour.ts";
import { GridTracer } from "../../src/marks/contour-trace.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { histogram } from "../../src/marks/histogram.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { viridis } from "../../src/scale/schemes.ts";
import type { LineGeometry, PolygonGeometry, Scene } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { validateSpec } from "../../src/spec/validate.ts";

function build(config: ChartConfig, width = 600, height = 400) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const polygons = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is PolygonGeometry => m.kind === "polygons");
const lines = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is LineGeometry => m.kind === "line");

/** A cone peaking at 10 over a 21 by 21 grid of x and y from -1 to 1, as rows. */
function cone(n = 21) {
  const x: number[] = [];
  const y: number[] = [];
  const z: number[] = [];
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++) {
      const [u, v] = [(i / (n - 1)) * 2 - 1, (j / (n - 1)) * 2 - 1];
      x.push(u);
      y.push(v);
      z.push(10 * (1 - Math.min(1, Math.hypot(u, v))));
    }
  return { x, y, z };
}

afterEach(() => vi.restoreAllMocks());

describe("contours", () => {
  it("fill bands between thresholds as polygons, a series each, its regions its points", () => {
    const field = table(cone());
    const { model, scene } = build({
      marks: [
        contour(field, { x: "x", y: "y", color: "z", thresholds: [2, 5, 8], variant: "bands" }),
      ],
    });
    const series = model.series();
    expect(series.map((s) => s.label)).toEqual(["2 – 5", "5 – 8"]);
    // One annulus each.
    expect(series.map((s) => s.length)).toEqual([1, 1]);
    const drawn = polygons(scene);
    expect(drawn).toHaveLength(2);
    // An annulus: its outer ring and the next threshold's ring inside.
    expect(drawn[0]!.shapes[0]!.rings.length - 1).toBe(2);
    expect(drawn[0]!.fillOpacity).toBe(1);
    expect(model.xScale()!.domain).toEqual([-1, 1]);
    // The legend keys each band's color and range.
    expect(scene.glyphLegends).toHaveLength(1);
    expect(scene.glyphLegends[0]!.entries.map((e) => e.label.text)).toEqual(["2 – 5", "5 – 8"]);
    expect(scene.glyphLegends[0]!.title.text).toBe("z");
  });

  it("draw lines at each threshold, round ones by default", () => {
    const field = table(cone());
    const { model, scene } = build({ marks: [contour(field, { x: "x", y: "y", color: "z" })] });
    // Round values strictly inside the field's extent, 0 to 10.
    expect(model.series().map((s) => s.label)).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
      "6",
      "7",
      "8",
      "9",
    ]);
    expect(lines(scene)).toHaveLength(9);
    const one = build({
      marks: [
        contour(field, {
          x: "x",
          y: "y",
          color: "z",
          thresholds: [5],
          stroke: "#333333",
          strokeWidth: 2,
        }),
      ],
    });
    expect(lines(one.scene)[0]).toMatchObject({ stroke: "#333333", strokeWidth: 2 });
    // One color says nothing a legend would.
    expect(one.scene.glyphLegends).toHaveLength(0);
  });

  it("read a matrix table as it is, without a value of x and y per row", () => {
    const n = 21;
    const xs = Float64Array.from({ length: n }, (_, i) => (i / (n - 1)) * 2 - 1);
    const z = Float64Array.from(cone(n).z);
    const matrix = fromMatrix({ x: xs, y: xs, z }, { x: "x", y: "y" });
    const before = matrix.byteLength;
    const options = {
      x: "x",
      y: "y",
      color: "z",
      thresholds: [2, 5, 8],
      variant: "bands",
    } as const;
    const fromRows = build({ marks: [contour(table(cone(n)), options)] });
    const fromGrid = build({ marks: [contour(matrix, options)] });
    expect(polygons(fromGrid.scene).map((p) => Array.from(p.shapes[0]!.coords))).toEqual(
      polygons(fromRows.scene).map((p) => Array.from(p.shapes[0]!.coords)),
    );
    // The coordinates are still the matrix's: no column per row was made.
    expect(matrix.byteLength).toBe(before);
    expect(before).toBe((n + n + n * n) * 8);
    // Replacing values keeps the matrix, copying only the values it borrowed;
    // appending rows makes it a table like any other.
    matrix.set("z", 0, 1);
    expect(matrixOf(matrix as unknown as Table)).toBeDefined();
    expect(matrix.byteLength).toBe(before);
    const grown = fromMatrix({ x: [0, 1], y: [0, 1], z: [1, 2, 3, 4] }, { x: "x", y: "y" });
    grown.append({ x: [2], y: [2], z: [5] });
    expect(matrixOf(grown as unknown as Table)).toBeUndefined();
    // A heatmap of the same matrix reads rows, which makes them.
    build({ marks: [heatmap(matrix, { x: "x", y: "y", color: "z" })] });
    expect(matrix.byteLength).toBe(3 * n * n * 8);
    expect(Array.from(matrix.numbers("y").subarray(n - 1, n + 1))).toEqual([-1, -0.9]);
  });

  it("follow the pointer: a band region under it, or the nearest line within a few pixels", () => {
    const field = table(cone());
    const bands = build({
      marks: [
        contour(field, { x: "x", y: "y", color: "z", thresholds: [2, 5, 8], variant: "bands" }),
      ],
    });
    const [px, py] = [bands.model.xScale()!.map(0.2), bands.model.yScale()!.map(0.3)];
    const inspection = bands.model.inspect(px, py)!;
    expect(inspection.points[0]).toMatchObject({
      label: "z",
      text: "5 – 8",
      px,
      py,
      row: undefined,
    });
    expect(inspection.label).toBe(bands.model.inspect(px, py)!.label);
    // Outside every band (above the last threshold, at the peak): nothing.
    const peak = bands.model.inspect(bands.model.xScale()!.map(0), bands.model.yScale()!.map(0));
    expect(peak).toBeUndefined();
    const levels = build({
      marks: [contour(field, { x: "x", y: "y", color: "z", thresholds: [5] })],
    });
    const x = levels.model.xScale()!;
    const y = levels.model.yScale()!;
    // The line at 5 runs near radius 0.5.
    const near = levels.model.inspect(x.map(0.5) + 2, y.map(0))!;
    expect(near.points[0]!.text).toBe("5");
    expect(Math.abs(near.points[0]!.px - x.map(0.5))).toBeLessThan(2);
    expect(levels.model.inspect(x.map(0.5) + 40, y.map(0))).toBeUndefined();
  });

  it("let the keyboard read bands and lines in order, region by region", () => {
    const field = table(cone());
    const { model } = build({
      marks: [
        contour(field, { x: "x", y: "y", color: "z", thresholds: [2, 5, 8], variant: "bands" }),
      ],
    });
    const stops = model.keyboardStops(model.panels()[0]!.key);
    expect(stops.map((s) => s.label)).toEqual(["2 – 5", "5 – 8"]);
    const point = model.inspectPosition(stops[0]!.key, 0)!.points[0]!;
    expect(point.text).toBe("2 – 5");
    // Its marker sits in the band: between radius 0.2 and 0.8 of the cone.
    const r = Math.hypot(model.xScale()!.invert(point.px), model.yScale()!.invert(point.py));
    expect(r).toBeGreaterThan(0.2);
    expect(r).toBeLessThan(0.8);
  });

  it("describe each band's regions and each level's lines", () => {
    const { model } = build({
      marks: [
        contour(table(cone()), {
          x: "x",
          y: "y",
          color: "z",
          thresholds: [2, 5, 8],
          variant: "bands",
          label: "height",
        }),
      ],
    });
    expect(describeChart(model)).toContain("height 2 – 5: 1 region, x from");
  });

  it("leave holes where grid points have no value, and refuse rows that are not a grid", () => {
    const { x, y, z } = cone();
    z[10 * 21 + 10] = Number.NaN;
    const { model } = build({
      marks: [
        contour(table({ x, y, z }), {
          x: "x",
          y: "y",
          color: "z",
          thresholds: [0, 9.9],
          variant: "bands",
        }),
      ],
    });
    // The band holds the field less the cells around the missing peak: a ring with a hole.
    const point = model.inspect(model.xScale()!.map(0), model.yScale()!.map(0));
    expect(point).toBeUndefined();
    const scattered = table({
      x: [0, 1, 2, 3, 4, 5],
      y: [5, 3, 1, 4, 0, 2],
      z: [1, 2, 3, 4, 5, 6],
    });
    const refused = /contour: the rows give values at 6 \(16\.7%\) of the 6 by 6 grid points/;
    expect(() => build({ marks: [contour(scattered, { x: "x", y: "y", color: "z" })] })).toThrow(
      refused,
    );
    // Rows repeating the same few points are no more of a grid.
    const repeated = table({
      x: [...scattered.numbers("x"), ...scattered.numbers("x")],
      y: [...scattered.numbers("y"), ...scattered.numbers("y")],
      z: [...scattered.numbers("z"), ...scattered.numbers("z")],
    });
    expect(() => build({ marks: [contour(repeated, { x: "x", y: "y", color: "z" })] })).toThrow(
      refused,
    );
  });

  it("count a band's pieces apart where the rings of its thresholds share the grid's ends", () => {
    // The low corners are the lowest band's, apart: two regions, not one. The
    // saddle (0.6) joins the high corners at 0.3, not at 0.7: one middle
    // band across the cell, and two high corners.
    const corners = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [0.2, 1, 1, 0.2] });
    const { model } = build({
      marks: [
        contour(corners, {
          x: "x",
          y: "y",
          color: "z",
          thresholds: [0, 0.3, 0.7, 1.1],
          variant: "bands",
        }),
      ],
    });
    expect(model.series().map((s) => s.length)).toEqual([2, 1, 2]);
  });

  it("make round thresholds where they can, and even ones where doubles cannot hold them", () => {
    const levels = (z: number[], variant: "lines" | "bands") =>
      build({
        marks: [
          contour(table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z }), {
            x: "x",
            y: "y",
            color: "z",
            variant,
          }),
        ],
      })
        .model.series()
        .map((s) => s.label);
    // A span past the largest doubles: thresholds spread evenly between its ends.
    const wide = levels([-1e308, 1e308, -1e308, 1e308], "bands");
    expect(wide).toHaveLength(10);
    expect(wide.some((label) => label.includes("NaN"))).toBe(false);
    expect(levels([-1e308, 1e308, -1e308, 1e308], "lines")).toHaveLength(10);
    // One line asked for, where no round value falls inside: the middle.
    const one = build({
      marks: [
        contour(table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [0, 1, 0, 1] }), {
          x: "x",
          y: "y",
          color: "z",
          thresholds: 1,
        }),
      ],
    }).model.series();
    expect(one.map((s) => [s.label, s.length])).toEqual([["0.5", 1]]);
    // One value: bands around it, however large.
    expect(levels([1e20, 1e20, 1e20, 1e20], "bands").length).toBeGreaterThan(0);
    const max = Number.MAX_VALUE;
    expect(levels([max, max, max, max], "bands").length).toBeGreaterThan(0);
  });

  it("leave out bands the field passes over, where the rings of both thresholds are one", () => {
    // A field above both thresholds everywhere: the band has no region, and draws nothing.
    const flat = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [5, 5, 5, 5] });
    const above = build({
      marks: [contour(flat, { x: "x", y: "y", color: "z", thresholds: [1, 2], variant: "bands" })],
    });
    expect(above.model.series().map((s) => s.length)).toEqual([0]);
    expect(polygons(above.scene)).toHaveLength(0);
    expect(above.model.keyboardStops(above.model.panels()[0]!.key)).toHaveLength(0);
    // A hole in the field above the top threshold is no region of the band below it.
    const { x, y, z } = cone();
    z[10 * 21 + 10] = Number.NaN;
    const holed = build({
      marks: [
        contour(table({ x, y, z }), {
          x: "x",
          y: "y",
          color: "z",
          thresholds: [2, 5, 8],
          variant: "bands",
        }),
      ],
    });
    expect(holed.model.series().map((s) => s.length)).toEqual([1, 1]);
  });

  it("anchor each band region where the pointer finds it, by the grid's ends and in thin bands", () => {
    // A ramp along x, every band reaching the grid's ends; one band a ten-thousandth wide.
    const ramp = { x: [] as number[], y: [] as number[], z: [] as number[] };
    for (let j = 0; j < 5; j++)
      for (let i = 0; i < 5; i++) {
        ramp.x.push(i / 4);
        ramp.y.push(j / 4);
        ramp.z.push(i / 4);
      }
    // A cone with holes, regions bounded by them and by the grid's ends.
    const holed = cone();
    for (const k of [10 * 21 + 10, 3 * 21 + 17, 18 * 21 + 2]) holed.z[k] = Number.NaN;
    const fields = [
      { field: ramp, thresholds: [0, 0.5, 0.5001, 1] },
      // One cell, a band two ten-millionths wide.
      {
        field: { x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [0, 1, 0, 1] },
        thresholds: [0.4, 0.4000002, 1],
      },
      { field: holed, thresholds: [0, 1, 3, 6, 9, 10] },
      // A band in one corner only, by the grid's ends, under round thresholds.
      { field: { x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [0.9, 0.9, 0.9, 0.2] }, thresholds: 10 },
    ];
    for (const { field, thresholds } of fields) {
      const { model } = build({
        marks: [
          contour(table(field), { x: "x", y: "y", color: "z", thresholds, variant: "bands" }),
        ],
      });
      const stops = model.keyboardStops(model.panels()[0]!.key);
      expect(stops.length).toBeGreaterThan(0);
      for (const series of model.series())
        for (let position = 0; position < series.length; position++) {
          const point = model.inspectPosition(series.key, position)!.points[0]!;
          const found = model.inspect(point.px, point.py)!.points[0]!;
          expect([found.text, found.px, found.py]).toEqual([point.text, point.px, point.py]);
        }
    }
  });

  it("project what they traced again as the view zooms and colors change, without tracing", () => {
    const field = table(cone());
    const config: ChartConfig = {
      marks: [
        contour(field, { x: "x", y: "y", color: "z", thresholds: [2, 5, 8], variant: "bands" }),
      ],
    };
    const { model } = build(config);
    const rings = vi.spyOn(GridTracer.prototype, "rings");
    model.setViewport([-0.5, 0.5]);
    const zoomed = model.scene(estimateText);
    model.update({ ...config, locale: "en-US", timeZone: "UTC", theme: "dark" });
    model.scene(estimateText);
    expect(rings).not.toHaveBeenCalled();
    expect(polygons(zoomed)).toHaveLength(2);
    // Rings wholly out of view are left out: none here, the annuli cross the view.
    field.set("z", 0, 0.5);
    model.scene(estimateText);
    expect(rings).toHaveBeenCalled();
  });

  it("split by facets, each panel its own grid at the thresholds of all", () => {
    const one = cone(11);
    const data = table({
      x: [...one.x, ...one.x],
      y: [...one.y, ...one.y],
      z: [...one.z, ...one.z.map((v) => v / 2)],
      half: [...one.x.map(() => "full"), ...one.x.map(() => "half")],
    });
    const { model } = build({
      marks: [contour(data, { x: "x", y: "y", color: "z", thresholds: [2, 6], variant: "bands" })],
      facet: facet("half"),
    });
    const counts = model.panels().map(({ key }) => model.panelSeries(key).map((s) => s.length));
    // The half-height cone reaches 5: its band of 2 to 6 is a disc, the full one's an annulus.
    expect(counts).toEqual([[1], [1]]);
  });

  it("load from specs, matrices included, and draw in static SVG", () => {
    const n = 11;
    const xs = Array.from({ length: n }, (_, i) => (i / (n - 1)) * 2 - 1);
    const spec = {
      data: {
        field: { columns: { x: xs, y: xs, z: cone(n).z }, matrix: { x: "x", y: "y" } },
      },
      marks: [
        {
          type: "contour",
          x: "x",
          y: "y",
          color: "z",
          thresholds: 4,
          variant: "bands",
          colors: "viridis",
        },
      ],
    } as const;
    expect(() => validateSpec(spec)).not.toThrow();
    const loaded = loadSpec(spec as never);
    expect(matrixOf(loaded.tables.get("field")!)).toMatchObject({ x: "x", y: "y" });
    const svg = renderToSVG({ ...loaded.config, width: 300, height: 200 });
    expect(svg).toContain('fill-rule="evenodd"');
    // Pages of one PDF, with a 2D histogram's image after the contours' vectors.
    const pairs = table({ x: [0, 1, 2, 3], y: [3, 2, 1, 0] });
    const pdf = new TextDecoder("latin1").decode(
      renderToPDF([
        { ...loaded.config, width: 300, height: 200 },
        { marks: [histogram(pairs, { x: "x", y: "y", bins: 2 })], width: 300, height: 200 },
      ]),
    );
    expect(pdf.match(/\/Type \/Page\b/g)).toHaveLength(2);
    expect(pdf).toContain("/Subtype /Image");
    expect(() =>
      validateSpec({
        ...spec,
        data: { field: { ...spec.data.field, matrix: { x: "x", y: "w" } } },
      }),
    ).toThrow(/spec\.data\.field\.matrix\.y: expected a column of the table/);
    expect(() =>
      validateSpec({ ...spec, marks: [{ ...spec.marks[0], thresholds: [3, 2] }] }),
    ).toThrow(/marks\[0\]\.thresholds\[1\]: expected a value above 3/);
  });

  it("refuse what they cannot draw", () => {
    const field = table(cone(5)) as unknown as Table;
    expect(() =>
      contour(field, { x: "x", y: "y", color: "z", variant: "bands", thresholds: [1] }),
    ).toThrow(/contour thresholds: expected 2 to 1000 values, a band between each two; received 1/);
    expect(() => contour(field, { x: "x", y: "y", color: "z", thresholds: [2, 2] })).toThrow(
      /contour thresholds\[1\]: expected a value above 2, the one before; received 2/,
    );
    expect(() =>
      contour(field, { x: "x", y: "y", color: "z", variant: "bands", stroke: "#000000" }),
    ).toThrow(/contour stroke: draws lines; bands take colors and fillOpacity/);
    expect(() => contour(field, { x: "x", y: "y", color: "z", fillOpacity: 0.5 })).toThrow(
      /contour fillOpacity: fills bands; lines take stroke and strokeWidth/,
    );
    // Specs are refused as the marks are, before loading.
    const spec = (mark: Record<string, unknown>) => ({
      data: { t: { columns: { x: [0, 1], y: [0, 1], z: [1, 2] } } },
      marks: [{ type: "contour", data: "t", x: "x", y: "y", color: "z", ...mark }],
    });
    for (const [mark, message] of [
      [{ thresholds: [] }, /marks\[0\]: contour thresholds: expected 1 to 1000 values; received 0/],
      [
        { thresholds: [1], variant: "bands" },
        /marks\[0\]: contour thresholds: expected 2 to 1000 values, a band between each two/,
      ],
      [
        { thresholds: 2000 },
        /marks\[0\]: contour thresholds: expected a whole number from 1 to 1000/,
      ],
      [{ strokeWidth: 2, variant: "bands" }, /marks\[0\]: contour strokeWidth: draws lines/],
    ] as const)
      expect(() => validateSpec(spec(mark))).toThrow(message);
    const log = new ChartModel({
      marks: [contour(field, { x: "x", y: "y", color: "z" })],
      y: { type: "log" },
    });
    log.setSize(300, 200, 1);
    expect(() => log.scene(estimateText)).toThrow(/contour y: cannot go on a log y axis yet/);
    const names = table({ x: ["a", "b"], y: [0, 1], z: [1, 2] });
    // @ts-expect-error contours place grid points on number and time axes
    expect(() => contour(names, { x: "x", y: "y", color: "z" })).toThrow(
      /contour x: field "x" holds category values; expected number or time/,
    );
  });

  it("color by the field's values on the ramp, as a heatmap of the field would", () => {
    const { scene } = build({
      marks: [
        contour(table(cone()), {
          x: "x",
          y: "y",
          color: "z",
          thresholds: [0, 5, 10],
          variant: "bands",
          colors: viridis,
          colorDomain: [0, 10],
        }),
      ],
    });
    // Each band at its middle value: 2.5 and 7.5 of 0 to 10.
    const [low, high] = polygons(scene).map((p) => p.colors[0]);
    expect(low).not.toBe(high);
    expect(scene.glyphLegends[0]!.entries.map((e) => e.fill)).toEqual([low, high]);
  });
});
