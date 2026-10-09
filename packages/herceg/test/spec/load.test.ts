import { describe, expect, it, vi } from "vitest";
import { encodedCategory, time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { loadSpec, SPEC_VERSION, specToSVG, validateSpec } from "../../src/from-spec.ts";
import { estimateText } from "../../src/layout/text.ts";
import { tablesOf } from "../../src/marks/layout-mark.ts";
import { line } from "../../src/marks/line.ts";
import { point3d } from "../../src/marks/point3d.ts";
import { rule } from "../../src/marks/rule.ts";
import { surface } from "../../src/marks/surface.ts";
import { ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { viridis } from "../../src/scale/schemes.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { checkSpec } from "../../src/spec/validate.ts";

const start = Date.UTC(2026, 0, 1);

describe("loadSpec", () => {
  it("builds tables from inline, time, binary, and dictionary columns", () => {
    const values = new Float64Array([1.5, Number.NaN, 3]);
    const counts = new Int16Array([7, 8, 9]);
    const codes = new Int32Array([1, -1, 0]);
    const { tables } = loadSpec(
      {
        data: {
          metrics: {
            columns: {
              plain: [1, null, 3],
              names: ["a", null, "b"],
              iso: { type: "time", values: ["2026-01-01T00:00:00Z", null, start + 1000] },
              value: { type: "number", dtype: "float64", buffer: 0 },
              count: { type: "number", dtype: "int16", buffer: 1 },
              at: { type: "time", dtype: "float64", buffer: 2 },
              host: { type: "category", codes: 3, dictionary: ["db", "web"] },
              zone: { type: "category", codes: [0, 0, -1], dictionary: ["eu"] },
            },
          },
        },
        marks: [],
      },
      [values, counts.buffer, new Float64Array([start, start + 1, start + 2]), codes],
    );
    const metrics = tables.get("metrics")!;
    expect(Array.from(metrics.numbers("plain"))).toEqual([1, Number.NaN, 3]);
    expect(metrics.value("names", 1)).toBeNull();
    expect(metrics.kind("iso")).toBe("time");
    expect(Array.from(metrics.numbers("iso"))).toEqual([start, Number.NaN, start + 1000]);
    // Binary columns are views of the delivered buffers, not copies.
    expect(metrics.numbers("value").buffer).toBe(values.buffer);
    expect(Array.from(metrics.numbers("value"))).toEqual([1.5, Number.NaN, 3]);
    expect(Array.from(metrics.numbers("count"))).toEqual([7, 8, 9]);
    expect(metrics.kind("at")).toBe("time");
    expect([0, 1, 2].map((row) => metrics.value("host", row))).toEqual(["web", null, "db"]);
    expect([0, 1, 2].map((row) => metrics.value("zone", row))).toEqual(["eu", "eu", null]);
  });

  it("copies binary columns only when their bytes are misaligned", () => {
    const bytes = new Uint8Array(17);
    new Float64Array(bytes.buffer, 0, 2).set([4, 5]);
    // A view starting at an odd byte offset cannot back a Float64Array.
    const shifted = new Uint8Array(17);
    shifted.set(bytes.subarray(0, 16), 1);
    const { tables } = loadSpec(
      {
        data: { t: { columns: { v: { type: "number", dtype: "float64", buffer: 0 } } } },
        marks: [],
      },
      [shifted.subarray(1, 17)],
    );
    expect(Array.from(tables.get("t")!.numbers("v"))).toEqual([4, 5]);
  });

  it("renders the same SVG as the TypeScript API", () => {
    const x = new Float64Array([start, start + 60_000, start + 120_000]);
    const y = new Float64Array([3, 1, 2]);
    const spec: ChartSpec = {
      width: 400,
      height: 200,
      title: "Latency",
      locale: "en-US",
      timeZone: "UTC",
      data: {
        metrics: {
          columns: {
            time: { type: "time", dtype: "float64", buffer: 0 },
            p99: { type: "number", dtype: "float64", buffer: 1 },
          },
        },
      },
      marks: [
        { type: "line", data: "metrics", x: "time", y: "p99" },
        { type: "rule", y: 2 },
      ],
      y: { label: "ms" },
    };
    const metrics = table({ time: time(x), p99: y }, { name: "metrics" });
    const direct = renderToSVG({
      width: 400,
      height: 200,
      title: "Latency",
      locale: "en-US",
      timeZone: "UTC",
      marks: [line(metrics, { x: "time", y: "p99" }), rule({ y: 2 })],
      y: { label: "ms" },
      idPrefix: "chart",
    });
    const viaSpec = specToSVG(spec, [x, y]).replace(/herceg-svg-\d+/g, "chart");
    expect(viaSpec).toBe(direct);
  });

  it("never writes to borrowed category codes", () => {
    const dictionary = Array.from({ length: 70 }, (_, i) => `c${i}`);
    const codes = Int32Array.from([68, 69]);
    const shared = loadSpec(
      {
        data: {
          a: { columns: { c: { type: "category", codes: 0, dictionary } } },
          b: { columns: { c: { type: "category", codes: 0, dictionary } } },
        },
        marks: [],
      },
      [codes],
    ).tables;
    // Dropping a row compacts the 70-entry dictionary of table a.
    shared.get("a")!.dropFirst(1);
    expect(Array.from(codes)).toEqual([68, 69]);
    expect(shared.get("a")!.value("c", 0)).toBe("c69");
    expect(shared.get("b")!.value("c", 0)).toBe("c68");
  });

  it("rejects malformed columns instead of guessing", () => {
    const load = (column: unknown) =>
      loadSpec({ data: { t: { columns: { c: column as never } } }, marks: [] });
    expect(() => load([1, true])).toThrow(/row 1 holds true/);
    expect(() => load(["a", 1])).toThrow(/mixes numbers into a column of strings/);
    expect(() => load({ type: "category", codes: [0.5], dictionary: ["a"] })).toThrow(
      /row 0 holds code 0.5/,
    );
    expect(() => load({ type: "category", codes: [null], dictionary: ["a"] })).toThrow(
      /row 0 holds code null/,
    );
    expect(() => load({ type: "category", codes: [0], dictionary: [123] })).toThrow(
      /columns\.c\.dictionary\[0\]: expected a string/,
    );
    expect(() => load({ type: "time", values: 42 })).toThrow(
      /columns\.c\.values: expected an array/,
    );
    expect(() => load({ type: "text", values: [] })).toThrow(/columns\.c\.type: expected "number"/);
    expect(() => load({ type: "time", values: ["nope"] })).toThrow(/"nope", not a time/);
    expect(() => load({ type: "number", dtype: "float64", buffer: -1 })).toThrow(/buffer index/);
  });

  it("checks options with the path of the bad property", () => {
    const check = (spec: unknown) => () => loadSpec(spec as ChartSpec);
    expect(check({ width: "bad", marks: [] })).toThrow(/spec\.width: expected a positive number/);
    expect(check({ marks: [{ type: "rule", y: true }] })).toThrow(
      /marks\[0\]\.y: expected a finite number or a field name/,
    );
    expect(check({ marks: [{ type: "text", x: 1, y: 2, anchor: "left", label: "a" }] })).toThrow(
      /marks\[0\]\.anchor: expected "start" or "middle" or "end"/,
    );
    expect(check({ marks: [null] })).toThrow(/marks\[0\]: expected an object, got null/);
    expect(check({ x: { type: "polar" }, marks: [] })).toThrow(/spec\.x\.type: expected "linear"/);
    expect(
      check({
        data: { t: { columns: { v: [1] } } },
        marks: [{ type: "line", x: "v", y: "v", strokeWidth: -1 }],
      }),
    ).toThrow(/marks\[0\]\.strokeWidth/);
    expect(check({ marks: [{ type: "chord" }] })).toThrow(/marks\[0\]\.type/);
    expect(check({ marks: [{ type: "constructor" }] })).toThrow(/marks\[0\]\.type/);
    expect(check({ y: { format: { maximumFractionDigits: -1 } }, marks: [] })).toThrow(
      /spec\.y\.format: /,
    );
    expect(
      check({
        data: { t: { columns: { v: [1], name: ["a"] } } },
        marks: [{ type: "bar", x: [], y: "name" }],
      }),
    ).toThrow(/marks\[0\]\.x: expected at least one field name/);
    expect(check({ tooltip: { mode: "nearest-z" }, marks: [] })).toThrow(/spec\.tooltip\.mode/);
    expect(
      check({
        data: { t: { columns: { c: ["a"], v: [1] } } },
        marks: [{ type: "bar", x: "c", y: "v", labels: { maximumFractionDigits: -1 } }],
      }),
    ).toThrow(/marks\[0\]\.labels: /);
    expect(check({ interaction: { brush: "z" }, marks: [] })).toThrow(
      /spec\.interaction\.brush: expected "x" or "y" or "xy" or "lasso"/,
    );
    expect(check({ interaction: { zoom: "z" }, marks: [] })).toThrow(/spec\.interaction\.zoom/);
    expect(check({ animation: { values: "yes" }, marks: [] })).toThrow(
      /spec\.animation\.values: expected true or false/,
    );
    expect(check({ animation: { duration: 300, values: true }, marks: [] })).not.toThrow();
    // Valid edge cases the TypeScript API produces still load.
    expect(check({ marks: [{ type: "rule", y: 1, strokeWidth: 0 }] })).not.toThrow();
    expect(check({ x: { type: "time", format: { hour: "2-digit" } }, marks: [] })).not.toThrow();
  });

  it("reports properties it does not know, as asked", () => {
    // Misspellings, as JSON from elsewhere has them.
    const json = {
      version: 2,
      data: { t: { columns: { x: [0, 1], y: [1, 2] } } },
      marks: [{ type: "line", x: "x", y: "y", strokeWidht: 3 }],
      theme: { fontSize: 12, fontsize: 12 },
      y: { label: "ms", lable: "ms" },
    };
    const spec = json as ChartSpec;
    const paths = ["marks[0].strokeWidht", "spec.y.lable", "spec.theme.fontsize"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(loadSpec(spec).unknown.sort()).toEqual([...paths].sort());
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0]![0]).toContain("marks[0].strokeWidht");
      warn.mockClear();
      expect(loadSpec(spec, [], { unknown: "ignore" }).unknown).toHaveLength(3);
      expect(warn).not.toHaveBeenCalled();
      expect(() => loadSpec(spec, [], { unknown: "error" })).toThrow(/not a property/);
      // Known properties only: nothing to report.
      expect(loadSpec({ ...spec, marks: [], theme: "dark", y: {} }).unknown).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("reports unknown properties of columns, formats, and transforms", () => {
    const quiet = { unknown: "ignore" } as const;
    const buffer = new Float64Array([1, 2]).buffer;
    const json = {
      version: 2,
      data: {
        t: {
          columns: {
            a: { type: "time", values: [1, 2], vaues: [2] },
            b: { type: "number", dtype: "float64", buffer: 0 },
          },
        },
        sorted: { source: "t", transform: [{ sort: "a", ordr: "descending" }] },
      },
      marks: [],
      x: { format: { maximumFractionDigts: 2 } },
    };
    expect(loadSpec(json as ChartSpec, [buffer], quiet).unknown.sort()).toEqual([
      "spec.data.sorted.transform[0].ordr",
      "spec.data.t.columns.a.vaues",
      "spec.x.format.maximumFractionDigts",
    ]);
    expect(() => loadSpec(json as ChartSpec, [buffer], { unknown: "error" })).toThrow(
      /not a property/,
    );
    // Options formatters read, whichever formatter an untyped axis turns out to need.
    for (const format of [
      { numberingSystem: "arab" },
      { timeZone: "UTC" },
      { roundingIncrement: 5 },
    ])
      expect(loadSpec({ marks: [], x: { format } }, [], { unknown: "error" }).unknown).toEqual([]);
    expect(
      loadSpec({ marks: [], x: { type: "linear", format: { hour: "2-digit" } } }, [], quiet)
        .unknown,
    ).toEqual(["spec.x.format.hour"]);
  });

  it("keeps the properties an outer check found when a check runs inside it", () => {
    const spec = {
      marks: [],
      theme: { fontsize: 12 },
      get title() {
        validateSpec({ marks: [] });
        return "outer";
      },
    };
    expect(loadSpec(spec as ChartSpec, [], { unknown: "ignore" }).unknown).toEqual([
      "spec.theme.fontsize",
    ]);
  });

  it("checks specs of unknown shape, and names the version it writes", () => {
    const parsed: unknown = JSON.parse('{"version": 2, "marks": []}');
    validateSpec(parsed);
    expect(loadSpec(parsed).config.marks).toEqual([]);
    expect(() => validateSpec({ marks: 1 })).toThrow(/spec\.marks/);
    expect(() => validateSpec({ version: "banana", marks: [] })).toThrow(
      /Unsupported spec version/,
    );
    // The forms a mark's type allows, as the TypeScript types describe them.
    expect(() => validateSpec({ marks: [{ type: "area", x: "x" }] })).toThrow(
      /marks\[0\]: An area needs y, or y1 and y2/,
    );
    expect(() => validateSpec({ marks: [{ type: "rule" }] })).toThrow(/exactly one of x or y/);
    expect(SPEC_VERSION).toBe(3);
    // An omitted version is 1, which has no panels.
    expect(() => loadSpec({ marks: [], panels: [{ id: "a" }] })).toThrow(/"version": 2/);
  });

  it("refuses marks mixing forms rather than dropping options", () => {
    const check = (mark: object) => () =>
      loadSpec({
        data: { t: { columns: { x: [0, 1], a: [1, 2], b: [2, 3], g: ["p", "q"] } } },
        marks: [mark],
      } as ChartSpec);
    expect(check({ type: "area", x: "x", y1: "a", y2: "b", stack: true })).toThrow(/not both/);
    expect(check({ type: "area", x: "x", y1: "a", y2: "b", series: "g" })).toThrow(/not both/);
    expect(check({ type: "errorbar", x: "x", y1: "a", y2: "b", x1: "a" })).toThrow(
      /cannot also take x1/,
    );
    expect(check({ type: "treemap", path: ["g"], node: "g", parent: "g" })).toThrow(/not both/);
    expect(check({ type: "sunburst", path: ["g"], node: "g", parent: "g" })).toThrow(/not both/);
  });

  it("draws horizontal bars from a category y", () => {
    const svg = specToSVG(
      {
        data: { sales: { columns: { region: ["N", "S"], q1: [1, 2], q2: [3, 4] } } },
        marks: [{ type: "bar", x: ["q1", "q2"], y: "region", stack: true }],
        tooltip: { mode: "nearest-y" },
        width: 400,
        height: 200,
      },
      [],
    );
    expect(svg.match(/<path d="M[^"]*Z" fill/g)).toHaveLength(2);
  });

  it("loads annotations from constants and from table fields", () => {
    const { config } = loadSpec({
      data: {
        metrics: {
          columns: { t: { type: "time", values: [start, start + 3_600_000] }, v: [1, 2] },
        },
        deploys: {
          columns: { at: { type: "time", values: [start + 1_800_000] }, version: ["v2"] },
        },
      },
      marks: [
        { type: "line", data: "metrics", x: "t", y: "v" },
        { type: "rule", data: "deploys", x: "at", text: "version" },
        { type: "rule", y: 1.5, label: "limit" },
        { type: "region", x1: start, x2: start + 600_000, label: "warmup" },
        { type: "text", data: "metrics", x: "t", y: "v", text: "v", dy: -8 },
      ],
    });
    // Constant annotations read no table, even when the spec has several.
    expect(config.marks.map((mark) => tablesOf(mark)[0]?.name)).toEqual([
      "metrics",
      "deploys",
      undefined,
      undefined,
      "metrics",
    ]);
    const svg = specToSVG({
      data: { d: { columns: { x: [0, 10], y: [0, 10] } } },
      marks: [
        { type: "region", y1: 2, y2: 4, label: "band" },
        { type: "line", x: "x", y: "y" },
        { type: "text", x: 5, y: 5, label: "mid" },
      ],
    });
    expect(svg).toContain(">band</text>");
    expect(svg).toContain(">mid</text>");
    expect(() =>
      loadSpec({
        data: { a: { columns: { x: [1] } }, b: { columns: { x: [1] } } },
        marks: [{ type: "rule", x: "x" }],
      }),
    ).toThrow(/Mark 0 \(rule\): set `data`/);
  });

  it("keeps fields named like object internals", () => {
    // Specs arrive as JSON, where "__proto__" is an ordinary key.
    const spec = JSON.parse('{"data":{"t":{"columns":{"__proto__":[1],"x":[2]}}},"marks":[]}');
    expect(loadSpec(spec).tables.get("t")!.fields()).toEqual(["__proto__", "x"]);
  });

  it("names the table, column, or mark in errors", () => {
    expect(() =>
      loadSpec({
        data: { t: { columns: { v: { type: "number", dtype: "float64", buffer: 2 } } } },
        marks: [],
      }),
    ).toThrow(/Column "v" of table "t": Buffer 2 is missing/);
    expect(() =>
      loadSpec({ data: { t: { columns: { v: [1] } } }, marks: [{ type: "line", x: "v", y: "w" }] }),
    ).toThrow(/Mark 0 \(line\)/);
    expect(() =>
      loadSpec({
        data: { a: { columns: {} }, b: { columns: {} } },
        marks: [{ type: "line", x: "x", y: "y" }],
      }),
    ).toThrow(/set `data` to one of "a", "b"/);
    expect(() => loadSpec({ version: 4 as 1, marks: [] })).toThrow(/Unsupported spec version 4/);
    expect(() => table({ c: encodedCategory(new Int32Array([2]), ["a"]) })).toThrow(
      /Column "c": Category code 2 at row 0 is outside the dictionary/,
    );
    expect(() => loadSpec({ data: { t: { columns: { a: [1, 2], b: [1] } } }, marks: [] })).toThrow(
      /Table "t": Column "b" has 1 rows, expected 2/,
    );
  });
});

describe("maps in specs", () => {
  const square = (x: number) => [x, 0, x + 1, 0, x + 1, 1, x, 1];
  const geometryColumn = {
    type: "geometry" as const,
    coordinates: 0,
    ringOffsets: 1,
    polygonOffsets: [0, 1, 2],
    geometryOffsets: [0, 1, 2],
    codes: [1, -1, 0],
  };
  const buffers = [Float64Array.from([...square(0), ...square(5)]), Int32Array.from([0, 4, 8])];

  it("loads geometry columns from buffers and arrays, with codes", () => {
    const { tables } = loadSpec(
      {
        data: { regions: { columns: { name: ["b", "none", "a"], shape: geometryColumn } } },
        marks: [],
      },
      buffers,
    );
    const regions = tables.get("regions")!;
    expect(regions.kind("shape")).toBe("geometry");
    const { codes, set } = regions.geometries("shape");
    expect(Array.from(codes)).toEqual([1, -1, 0]);
    // Aligned buffers are used in place.
    expect(set.coordinates.buffer).toBe(buffers[0]!.buffer);
    expect(Array.from(set.polygonOffsets)).toEqual([0, 1, 2]);
  });

  it("refuses geometry columns with bad arrays, naming the column", () => {
    const load = (column: object) => () =>
      loadSpec({ data: { regions: { columns: { shape: column as never } } }, marks: [] }, buffers);
    expect(load({ ...geometryColumn, ringOffsets: [0, 4.5, 8] })).toThrow(
      /Column "shape" of table "regions": ringOffsets\[1\] holds 4.5, not an int32/,
    );
    expect(load({ ...geometryColumn, coordinates: 7 })).toThrow(/Buffer 7 is missing/);
    expect(
      load({ ...geometryColumn, coordinates: [...square(0), 5, 0, 6, 0, 6, 1, 5, 100] }),
    ).toThrow(/WGS 84/);
    expect(load({ ...geometryColumn, codes: [0, 2, 0] })).toThrow(/code 2 at row 1/);
  });

  it("draws geoshape and geopoint marks with the spec's projection", () => {
    const spec: ChartSpec = {
      width: 300,
      height: 200,
      projection: { type: "mercator", centralMeridian: 10, fit: "data" },
      data: {
        regions: { columns: { name: ["b", "none", "a"], shape: geometryColumn } },
        places: { columns: { lon: [0.5], lat: [0.5] } },
      },
      marks: [
        { type: "geoshape", data: "regions", name: "name", color: "name" },
        { type: "geopoint", data: "places", longitude: "lon", latitude: "lat", r: 3 },
      ],
    };
    const svg = specToSVG(spec, buffers);
    expect(svg.match(/fill-rule="evenodd"/g)).toHaveLength(2);
    expect(svg).toContain('stroke-width="1"');
  });

  it("checks projections and geo marks", () => {
    const base = {
      marks: [{ type: "geopoint", longitude: "x", latitude: "y" }],
      data: { t: { columns: { x: [0], y: [0] } } },
    };
    const fails = (change: object) => () => loadSpec({ ...base, ...change } as ChartSpec);
    expect(fails({ projection: "robinson" })).toThrow(/spec.projection: expected "equal-earth"/);
    expect(fails({ projection: { type: "conic-equal-area", parallels: [10, 100] } })).toThrow(
      /spec.projection.parallels/,
    );
    expect(
      fails({
        projection: {
          type: "mercator",
          fit: [
            [0, 10],
            [5, 5],
          ],
        },
      }),
    ).toThrow(/a north above the south/);
    expect(fails({ projection: { centralMeridian: 3 } })).toThrow(/spec.projection.type: required/);
    expect(
      fails({
        projection: {
          type: "mercator",
          fit: [
            [1e20, 0],
            [1e20 + 1, 10],
          ],
        },
      }),
    ).toThrow(/spec.projection.fit\[0\]: expected \[longitude, latitude\]/);
    expect(
      fails({
        projection: {
          type: "mercator",
          fit: [
            [180, 0],
            [180, 10],
          ],
        },
      }),
    ).toThrow(/an east apart from the west/);
    expect(fails({ marks: [{ type: "geopoint", longitude: "x" }] })).toThrow(
      /marks\[0\].latitude: required/,
    );
    expect(fails({ marks: [{ type: "geoshape", strokeWidth: -1 }] })).toThrow(
      /marks\[0\].strokeWidth/,
    );
    expect(fails({ projection: "mercator", marks: [{ type: "line", x: "x", y: "y" }] })).toThrow(
      /projection needs geoshape or geopoint marks/,
    );
  });
});

describe("3D charts in specs", () => {
  const data = {
    grid: { columns: { x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [1, 2, 3, 4] } },
    points: { columns: { x: [0.5], y: [0.5], z: [3], kind: ["a"] } },
  };
  const marks: ChartSpec["marks"] = [
    { type: "surface", data: "grid", x: "x", y: "y", z: "z", colors: "viridis", wireframe: true },
    { type: "point3d", data: "points", x: "x", y: "y", z: "z", series: "kind", r: 4 },
  ];

  it("draw the same SVG as the TypeScript API, from the spec's camera", () => {
    const spec: ChartSpec = {
      width: 400,
      height: 300,
      data,
      marks,
      camera: { azimuth: 30, elevation: 40 },
      z: { label: "Height" },
      boxAspect: [2, 1, 1],
      interaction: { zoom: true, rotate: false },
    };
    const svg = specToSVG(spec, [], { measureText: estimateText });
    expect(svg).toContain(">Height</text>");
    const grid = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [1, 2, 3, 4] });
    const points = table({ x: [0.5], y: [0.5], z: [3], kind: ["a"] });
    const same = renderToSVG({
      width: 400,
      height: 300,
      marks: [
        surface(grid, { x: "x", y: "y", z: "z", colors: viridis, wireframe: true }),
        point3d(points, { x: "x", y: "y", z: "z", series: "kind", r: 4 }),
      ],
      camera: { azimuth: 30, elevation: 40 },
      z: { label: "Height" },
      boxAspect: [2, 1, 1],
      interaction: { zoom: true, rotate: false },
    });
    // Output differs only in element ids.
    const ids = (text: string) => text.replace(/herceg-svg-\d+/g, "id");
    expect(ids(svg)).toBe(ids(same));
    const model = new ChartModel(loadSpec(spec).config);
    expect(model.camera).toEqual({ azimuth: 30, elevation: 40, zoom: 1, perspective: false });
    expect(checkSpec(spec)).toEqual([]);
  });

  it("check cameras, box aspects, and 3D marks", () => {
    const fails = (change: object) => () => loadSpec({ data, marks, ...change } as ChartSpec);
    expect(fails({ camera: { elevation: 120 } })).toThrow(
      /spec.camera.elevation: expected degrees from -90 to 90/,
    );
    expect(fails({ camera: { zoom: 20 } })).toThrow(/spec.camera.zoom/);
    expect(fails({ boxAspect: [1, 0, 1] })).toThrow(
      /spec.boxAspect: expected three positive numbers/,
    );
    expect(fails({ marks: [{ type: "point3d", data: "points", x: "x", y: "y" }] })).toThrow(
      /marks\[0\].z: required/,
    );
    expect(
      fails({ marks: [{ type: "line", data: "points", x: "x", y: "y" }], camera: {} }),
    ).toThrow(/spec.camera: expected a spec with point3d or surface marks/);
    expect(checkSpec({ data, marks, camera: { azimuth: 1, roll: 3 } } as ChartSpec)).toEqual([
      "spec.camera.roll",
    ]);
  });
});
