import { describe, expect, it } from "vitest";
import { encodedCategory, time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { loadSpec, specToSVG } from "../../src/from-spec.ts";
import { line } from "../../src/marks/line.ts";
import { rule } from "../../src/marks/rule.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";

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
      /dictionary must be an array of strings/,
    );
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
    // Valid edge cases the TypeScript API produces still load.
    expect(check({ marks: [{ type: "rule", y: 1, strokeWidth: 0 }] })).not.toThrow();
    expect(check({ x: { type: "time", format: { hour: "2-digit" } }, marks: [] })).not.toThrow();
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
    expect(config.marks.map((mark) => mark.table?.name)).toEqual([
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
    expect(() => loadSpec({ version: 2 as 1, marks: [] })).toThrow(/Unsupported spec version 2/);
    expect(() => table({ c: encodedCategory(new Int32Array([2]), ["a"]) })).toThrow(
      /Column "c": Category code 2 at row 0 is outside the dictionary/,
    );
    expect(() => loadSpec({ data: { t: { columns: { a: [1, 2], b: [1] } } }, marks: [] })).toThrow(
      /Table "t": Column "b" has 1 rows, expected 2/,
    );
  });
});
