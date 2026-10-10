import { describe, expect, it } from "vitest";
import { loadSpec, SPEC_VERSION, specToSVG, validateSpec } from "../../src/from-spec.ts";
import { estimateText } from "../../src/layout/text.ts";
import { ChartModel } from "../../src/model/model.ts";
import type { ChartSpec, DendrogramSpec } from "../../src/spec/spec.ts";

const mark: DendrogramSpec = {
  type: "dendrogram",
  first: "a",
  second: "b",
  height: "h",
  leaves: ["A", "B", "C"],
};
const spec = (): ChartSpec => ({
  version: SPEC_VERSION,
  data: { linkage: { columns: { a: [0, 2], b: [1, 3], h: [1, 3] } } },
  marks: [mark],
});

describe("dendrogram spec", () => {
  it("loads at the current version without a version bump and preserves its options", () => {
    expect(SPEC_VERSION).toBe(10);
    const input = spec();
    const styled = {
      ...mark,
      data: "linkage",
      id: "tree",
      side: "right" as const,
      stroke: "#ff0000",
      strokeWidth: 2,
      label: "Rows",
    };
    input.marks = [styled];
    expect(() => validateSpec(input)).not.toThrow();
    const loaded = loadSpec(input, [], { unknown: "error" });
    expect(loaded.unknown).toEqual([]);
    expect(loaded.config.marks[0]!.spec).toEqual(styled);
    const model = new ChartModel(loaded.config);
    model.setSize(400, 200, 1);
    const scene = model.scene(estimateText);
    expect(scene.panels[0]!.marks[0]).toMatchObject({ kind: "segments", count: 6 });
    expect(specToSVG(input)).toContain('stroke="#ff0000"');
  });

  it.each([
    ["first", "missing", /first.*unknown field "missing"/],
    ["leaves", ["A", "B"], /leaves.*3 labels/],
    ["leaves", ["A", "A", "C"], /leaves\[1\].*repeats/],
    ["leaves", ["A", 5, "C"], /leaves\[1\]/],
    ["side", "diagonal", /side/],
    ["strokeWidth", -1, /strokeWidth/],
    ["axis", "right", /axis.*plot-relative/],
  ] as const)("rejects %s with %j", (field, value, error) => {
    const input = { ...spec(), marks: [{ ...mark, [field]: value }] };
    expect(() => validateSpec(input)).toThrow(error);
    expect(() => loadSpec(input as ChartSpec)).toThrow(error);
  });

  it.each([
    ["a", [-1, 2], /row 0, field "a".*whole number/],
    ["b", [1.5, 3], /row 0, field "b".*whole number/],
    ["a", [3, 2], /row 0, field "a".*earlier merge/],
    ["b", [0, 3], /row 0, field "b".*more than once/],
    ["a", [0, 0], /row 1, field "a".*more than once/],
    ["h", [1, -1], /row 1, field "h".*nonnegative/],
    ["h", [1, null], /row 1, field "h".*finite/],
    ["h", [1, Infinity], /row 1, field "h".*finite/],
    ["a", ["A", "B"], /row 0, field "a".*numbers/],
    ["h", { type: "time", values: [1, 3] }, /field "h".*numbers/],
  ] as const)("validates inline field %s", (field, values, error) => {
    const input = {
      ...spec(),
      data: { linkage: { columns: { a: [0, 2], b: [1, 3], h: [1, 3], [field]: values } } },
    };
    expect(() => validateSpec(input)).toThrow(error);
    expect(() => loadSpec(input as ChartSpec)).toThrow(error);
  });

  it("checks linkage rows after binary or derived data loads", () => {
    const input: ChartSpec = {
      ...spec(),
      data: {
        linkage: {
          columns: {
            a: { type: "number", dtype: "float64", buffer: 0 },
            b: { type: "number", dtype: "float64", buffer: 1 },
            h: { type: "number", dtype: "float64", buffer: 2 },
          },
        },
      },
    };
    expect(() => validateSpec(input)).not.toThrow();
    const buffers = [new Float64Array([0, 2]), new Float64Array([1, 3]), new Float64Array([1, 3])];
    expect(loadSpec(input, buffers).config.marks[0]!.spec.type).toBe("dendrogram");
    buffers[0]![1] = 0;
    expect(() => loadSpec(input, buffers)).toThrow(/row 1, field "a".*more than once/);
    const derived: ChartSpec = {
      ...spec(),
      data: {
        ...spec().data,
        tree: { source: "linkage", transform: [{ filter: [">=", ["field", "h"], 0] }] },
      },
      marks: [{ ...mark, data: "tree" }],
    };
    expect(loadSpec(derived).config.marks[0]!.spec.type).toBe("dendrogram");
  });

  it("refuses unknown mark types even when unknown properties are ignored", () => {
    // Readers that lack a mark reject it rather than dropping its geometry.
    const input = { ...spec(), marks: [{ ...mark, type: "unsupported-dendrogram" }] };
    for (const unknown of ["warn", "ignore", "error"] as const)
      expect(() => loadSpec(input as unknown as ChartSpec, [], { unknown })).toThrow(
        /marks\[0\]\.type/,
      );
  });

  it("requires whole-table repetition in faceted specs and loads one-leaf trees", () => {
    expect(() => validateSpec({ ...spec(), facet: { field: "group" } })).toThrow(/facet: "repeat"/);
    const single: ChartSpec = {
      version: SPEC_VERSION,
      data: { linkage: { columns: { a: [], b: [], h: [] } } },
      marks: [{ ...mark, leaves: ["A"] }],
    };
    expect(loadSpec(single).config.marks[0]!.spec.type).toBe("dendrogram");
    expect(() => specToSVG(single)).not.toThrow();
  });
});
