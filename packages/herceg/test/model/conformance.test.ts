// The cases the engine and the Python package both meet (test/fixtures):
// which field splits series, the errors a chart refuses its options with,
// and what series stand for, as the legend lists them.
import { describe, expect, it } from "vitest";
import { category } from "../../src/data/column.ts";
import { Table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { seriesOf } from "../../src/marks/mark.ts";
import { ChartModel } from "../../src/model/model.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import { chartError, errorInfo } from "../../src/spec/errors.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec, MarkSpec } from "../../src/spec/spec.ts";
import errors from "../fixtures/chart-errors.json";
import identities from "../fixtures/color-identity.json";
import inference from "../fixtures/series-inference.json";

describe("series inference", () => {
  // Two rows of each field, of its kind.
  const table = new Table(
    Object.fromEntries(
      Object.entries(inference.fields).map(([name, kind]) => [
        name,
        kind === "category" ? category(["a", "b"]) : [0, 1],
      ]),
    ),
  );
  for (const { name, mark, options, series } of inference.cases)
    it(name, () => {
      const paint = mark === "line" ? "stroke" : "fill";
      expect(seriesOf(options as never, table, paint) ?? null).toBe(series);
    });
});

describe("chart errors", () => {
  for (const { name, mark, code, path, message } of errors.cases)
    it(name, () => {
      const spec = { data: { data: { columns: errors.data } }, marks: [mark] } as ChartSpec;
      let thrown: unknown;
      try {
        const model = new ChartModel(loadSpec(spec).config, undefined, ...staticCompilers());
        model.setSize(400, 200, 1);
        model.scene(estimateText);
      } catch (error) {
        thrown = error;
      }
      const info = errorInfo(chartError(thrown, "validate"));
      expect({ code: info.code, path: info.path }).toEqual({ code, path });
      expect(info.message).toContain(message);
    });
});

describe("color identity", () => {
  for (const { name, spec, entries } of identities.cases)
    it(name, () => {
      const model = new ChartModel(
        loadSpec(spec as unknown as ChartSpec & { marks: MarkSpec[] }).config,
        undefined,
        ...staticCompilers(),
      );
      model.setSize(800, 400, 1);
      model.scene(estimateText);
      expect(model.legendEntries().map(({ key, label }) => [key, label])).toEqual(entries);
    });
});
