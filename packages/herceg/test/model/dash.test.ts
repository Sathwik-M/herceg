import { expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { custom } from "../../src/marks/custom.ts";
import { line } from "../../src/marks/line.ts";
import type { ChartMark } from "../../src/marks/mark.ts";
import { rule } from "../../src/marks/rule.ts";
import { ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type {
  LineGeometry,
  PathShape,
  RuleGeometry,
  ShapesGeometry,
} from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec, Dash } from "../../src/spec/spec.ts";
import { validateSpec } from "../../src/spec/validate.ts";

const data = table({ x: [0, 1], y: [1, 2] }, { name: "data" });
const styles = [
  ["-", []],
  ["--", [7.4, 3.2]],
  [":", [2, 3.3]],
  ["-.", [12.8, 3.2, 2, 3.2]],
] as const;

function build(marks: readonly ChartMark[], lineWidth = 2) {
  const model = new ChartModel({ marks, theme: { lineWidth } });
  model.setSize(400, 200, 1);
  return model.scene(estimateText).panels[0]!.marks;
}

it.each(styles)("dash %s stays in specs and scales at geometry construction", (dash, expected) => {
  const marks = [line(data, { x: "x", y: "y", dash }), rule({ y: 1, dash, strokeWidth: 2 })];
  const spec: ChartSpec = {
    data: { data: { columns: { x: [0, 1], y: [1, 2] } } },
    marks: marks.map((mark) => mark.spec),
  };
  validateSpec(spec);
  const loaded = loadSpec(JSON.parse(JSON.stringify(spec))).config.marks;
  for (const source of [marks, loaded]) {
    for (const mark of source) expect(mark.spec).toMatchObject({ dash });
    const geometry = build(source) as (LineGeometry | RuleGeometry)[];
    expect(geometry.map((mark) => mark.dash)).toEqual([expected, expected]);
    const svg = renderToSVG({ marks: source, width: 400, height: 200 });
    if (expected.length) expect(svg).toContain(`stroke-dasharray="${expected.join(" ")}"`);
    else expect(svg).not.toContain("stroke-dasharray");
  }
});

it.each(styles)("custom shape dash %s uses the shape's width", (dash, expected) => {
  const mark = custom({
    draw({ line: segment, circle, rect, path }) {
      const style = { dash, stroke: "red", strokeWidth: 2 };
      segment(0, 0, 10, 10, style);
      circle(10, 10, 4, style);
      rect(0, 0, 10, 10, style);
      path("M0 0L10 10", style);
    },
  });
  const shapes = (build([mark])[0] as ShapesGeometry).shapes as PathShape[];
  expect(shapes).toHaveLength(4);
  expect(shapes.map((shape) => shape.dash)).toEqual(Array(4).fill(expected));
});

it("resolves strings with the current theme, while pixel arrays stay unscaled and copied", () => {
  const mark = line(data, { x: "x", y: "y", dash: "--" });
  const themed = (build([mark], 3)[0] as LineGeometry).dash!;
  expect(themed[0]).toBeCloseTo(11.1);
  expect(themed[1]).toBeCloseTo(4.8);
  expect((build([mark], 1)[0] as LineGeometry).dash).toEqual([3.7, 1.6]);
  const dash = [4, 2];
  const numeric = [
    line(data, { x: "x", y: "y", dash, strokeWidth: 3 }),
    rule({ y: 1, dash, strokeWidth: 3 }),
  ];
  dash.push(8);
  expect((build(numeric) as (LineGeometry | RuleGeometry)[]).map((mark) => mark.dash)).toEqual([
    [4, 2],
    [4, 2],
  ]);
  expect((build([rule({ y: 1 })])[0] as RuleGeometry).dash).toEqual([4, 4]);
});

it.each(["", "none", "dashed", "__proto__", "constructor"])(
  "refuses dash %j with all accepted strings on each surface",
  (value) => {
    const dash = value as Dash;
    const accepted = /-.*--.*:.*-\./;
    for (const make of [
      () => build([line(data, { x: "x", y: "y", dash })]),
      () => build([rule({ y: 1, dash })]),
      () =>
        build([
          custom({
            draw({ path }) {
              path("M0 0L1 1", { dash });
            },
          }),
        ]),
    ])
      expect(make).toThrow(accepted);
    for (const mark of [
      { type: "line", x: "x", y: "y", dash },
      { type: "rule", y: 1, dash },
    ]) {
      expect(() => validateSpec({ marks: [mark] })).toThrow(accepted);
    }
  },
);
