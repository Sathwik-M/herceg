import { describe, expect, it } from "vitest";
import { loadSpec } from "../../src/spec/load.ts";
import { checkSpec, validateSpec } from "../../src/spec/validate.ts";

const data = { t: { columns: { v: [0, 1, 2], g: ["a", "b", "a"] } } };
const features = [
  { option: "y", mark: { y: "v" } },
  { option: "bins", mark: { x: "v", bins: [0, 1, 2] } },
  { option: "normalize", mark: { x: "v", normalize: "probability" } },
  { option: "commonNorm", mark: { x: "v", commonNorm: true } },
  { option: "cumulative", mark: { x: "v", cumulative: true } },
  { option: "dodge", mark: { x: "v", dodge: true } },
];

describe("histogram specs", () => {
  it.each(features)(
    "requires version 10 at $option, including version 9 readers",
    ({ option, mark }) => {
      for (const version of [undefined, 1, 2, 3, 4, 5, 6, 7, 8, 9])
        expect(() =>
          validateSpec({ version, data, marks: [{ type: "histogram", ...mark }] }),
        ).toThrow(`marks[0].${option}: expected a spec with "version": 10 or later`);
      const spec = { version: 10, data, marks: [{ type: "histogram", ...mark }] };
      expect(checkSpec(spec)).toEqual([]);
      validateSpec(spec);
      expect(loadSpec(spec).config.marks[0]!.spec).toMatchObject(mark);
    },
  );

  it("reads omitted/default options at all older supported versions, including 6", () => {
    for (const version of [undefined, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
      const spec = {
        version,
        data,
        marks: [
          {
            type: "histogram",
            x: "v",
            normalize: "percent",
            bins: { step: 1 },
            commonNorm: false,
            cumulative: false,
            dodge: false,
          },
        ],
      };
      expect(checkSpec(spec)).toEqual([]);
      validateSpec(spec);
      expect(() => loadSpec(spec)).not.toThrow();
    }
  });

  it.each([
    { mark: {}, error: /exactly one field/ },
    { mark: { x: "v", y: "v" }, error: /exactly one field/ },
    { mark: { y: "v", axis: "right" }, error: /horizontal histogram cannot use the right axis/ },
    { mark: { x: "v", stack: true, dodge: true }, error: /cannot dodge and stack/ },
    { mark: { x: "v", normalize: "fraction" }, error: /marks\[0\]\.normalize/ },
    { mark: { x: "v", commonNorm: 1 }, error: /marks\[0\]\.commonNorm/ },
    { mark: { x: "v", cumulative: "yes" }, error: /marks\[0\]\.cumulative/ },
    { mark: { x: "v", dodge: "yes" }, error: /marks\[0\]\.dodge/ },
  ])("refuses invalid histogram form $mark", ({ mark, error }) => {
    expect(() => validateSpec({ version: 10, marks: [{ type: "histogram", ...mark }] })).toThrow(
      error,
    );
  });

  it.each([
    { bins: [0], error: /at least 2 and at most 1001/ },
    { bins: [0, Number.NaN], error: /marks\[0\]\.bins\[1\].*finite/ },
    { bins: [0, Infinity], error: /finite/ },
    { bins: [1, 0], error: /strictly increasing/ },
    { bins: [0, 0], error: /strictly increasing/ },
    { bins: [0, "1"], error: /finite/ },
    { bins: Array.from({ length: 1002 }, (_, i) => i), error: /at most 1001/ },
  ])("refuses invalid edges with a RangeError ($error)", ({ bins, error }) => {
    const spec = { version: 10, marks: [{ type: "histogram", x: "v", bins }] };
    expect(() => validateSpec(spec)).toThrow(RangeError);
    expect(() => validateSpec(spec)).toThrow(error);
  });

  it("keeps full precision when exact edges travel through JSON", () => {
    const bins = [0.1, 0.2, 0.1 + 2 * 0.1, 0.4];
    const spec = JSON.parse(
      JSON.stringify({ version: 10, data, marks: [{ type: "histogram", y: "v", bins }] }),
    );
    expect(loadSpec(spec).config.marks[0]!.spec).toMatchObject({ bins });
  });
});
