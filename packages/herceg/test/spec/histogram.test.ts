import { describe, expect, it } from "vitest";
import { loadSpec } from "../../src/spec/load.ts";
import { checkSpec, validateSpec } from "../../src/spec/validate.ts";

const data = { t: { columns: { v: [0, 1, 2], g: ["a", "b", "a"], w: [1, 2, 0.5] } } };
const features = [
  { option: "y", mark: { y: "v" } },
  { option: "weight", mark: { x: "v", weight: "w" } },
  { option: "frequency", mark: { x: "v", normalize: "frequency" } },
  { option: "fill", mark: { x: "v", series: "g", stack: "fill" } },
  { option: "element", mark: { x: "v", element: "poly" } },
  { option: "bins", mark: { x: "v", bins: [0, 1, 2] } },
  { option: "normalize", mark: { x: "v", normalize: "probability" } },
  { option: "commonNorm", mark: { x: "v", commonNorm: true } },
  { option: "cumulative", mark: { x: "v", cumulative: true } },
  { option: "dodge", mark: { x: "v", dodge: true } },
];

describe("histogram specs", () => {
  it.each(features)("load $option", ({ mark }) => {
    const spec = { data, marks: [{ type: "histogram", ...mark }] };
    expect(checkSpec(spec)).toEqual([]);
    validateSpec(spec);
    expect(loadSpec(spec).config.marks[0]!.spec).toMatchObject(mark);
  });

  it("reads omitted and default options", () => {
    const spec = {
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
  });

  it.each([
    { mark: {}, error: /marks\[0\]: histogram: needs x, y, or both/ },
    { mark: { x: "v", y: "v", series: "v" }, error: /histogram series: a 2D histogram/ },
    { mark: { x: "v", y: "v", stack: true }, error: /histogram stack: for bars of x or y/ },
    { mark: { x: "v", colors: "viridis" }, error: /histogram colors: colors the cells of 2D/ },
    { mark: { x: "v", bins: { x: 3 } }, error: /histogram bins: \{ x, y \} bins both axes/ },
    { mark: { x: "v", y: "v", bins: { x: 3, z: 1 } }, error: /bins\.z/ },
    {
      mark: { y: "v", axis: "right" },
      error: /histogram axis: horizontal histograms have no right/,
    },
    { mark: { x: "v", stack: true, dodge: true }, error: /histogram: dodge or stack, not both/ },
    { mark: { x: "v", normalize: "fraction" }, error: /marks\[0\]\.normalize/ },
    { mark: { x: "v", commonNorm: 1 }, error: /marks\[0\]\.commonNorm/ },
    { mark: { x: "v", cumulative: "yes" }, error: /marks\[0\]\.cumulative/ },
    { mark: { x: "v", dodge: "yes" }, error: /marks\[0\]\.dodge/ },
    {
      mark: { x: "v", stack: "full" },
      error: /marks\[0\]\.stack: expected true, false, or "fill"/,
    },
    { mark: { x: "v", stack: "fill", dodge: true }, error: /dodge or stack, not both/ },
    { mark: { x: "v", element: "line" }, error: /marks\[0\]\.element/ },
    { mark: { x: "v", dodge: true, element: "step" }, error: /histogram dodge: places bars/ },
    { mark: { x: "v", weight: 1 }, error: /marks\[0\]\.weight/ },
  ])("refuses invalid histogram form $mark", ({ mark, error }) => {
    expect(() => validateSpec({ marks: [{ type: "histogram", ...mark }] })).toThrow(error);
  });

  it.each([
    { bins: [0], error: /marks\[0\]\.bins: expected 2 to 1001 edges; received 1/ },
    { bins: [0, Number.NaN], error: /marks\[0\]\.bins\[1\].*finite/ },
    { bins: [0, Infinity], error: /finite/ },
    { bins: [1, 0], error: /bins\[1\]: expected a number above 1, the edge before; received 0/ },
    { bins: [0, 0], error: /bins\[1\]: expected a number above 0/ },
    { bins: [0, "1"], error: /finite/ },
    { bins: Array.from({ length: 1002 }, (_, i) => i), error: /2 to 1001 edges; received 1002/ },
  ])("refuses invalid edges with a RangeError ($error)", ({ bins, error }) => {
    const spec = { marks: [{ type: "histogram", x: "v", bins }] };
    expect(() => validateSpec(spec)).toThrow(RangeError);
    expect(() => validateSpec(spec)).toThrow(error);
  });

  it("keeps full precision when exact edges travel through JSON", () => {
    const bins = [0.1, 0.2, 0.1 + 2 * 0.1, 0.4];
    const spec = JSON.parse(JSON.stringify({ data, marks: [{ type: "histogram", y: "v", bins }] }));
    expect(loadSpec(spec).config.marks[0]!.spec).toMatchObject({ bins });
  });
});
