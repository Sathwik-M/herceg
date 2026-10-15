// Specs' scales, guides, tick forms, and formats: what is refused, and where.
import { describe, expect, it } from "vitest";
import type { ChartSpec } from "../../src/spec/spec.ts";
import { checkSpec, validateSpec } from "../../src/spec/validate.ts";

const marks: ChartSpec["marks"] = [{ type: "line", x: "t", y: "v" }];
const valid = (spec: Partial<ChartSpec>) => () => validateSpec({ marks, ...spec });

describe("tick forms", () => {
  it("takes a count, every, and values", () => {
    expect(valid({ y: { ticks: 5 } })).not.toThrow();
    expect(valid({ y: { ticks: { count: 5 } } })).not.toThrow();
    expect(valid({ y: { ticks: { every: 10, anchor: 5 } } })).not.toThrow();
    expect(valid({ x: { type: "time", ticks: { every: "6 hours" } } })).not.toThrow();
    expect(
      valid({ x: { type: "time", ticks: { every: { unit: "day", step: 2 } } } }),
    ).not.toThrow();
    expect(valid({ x: { ticks: { every: { milliseconds: 60_000 }, anchor: 0 } } })).not.toThrow();
    expect(valid({ y: { ticks: { values: [15, 95] } } })).not.toThrow();
  });

  it("refuses functions, which a spec cannot hold", () => {
    const spec = { marks, y: { ticks: () => [1] } } as unknown as ChartSpec;
    expect(() => validateSpec(spec)).toThrow(
      "spec.y.ticks: a function cannot be in a spec; give a count, { every }, or { values }",
    );
    const format = { marks, y: { format: () => "" } } as unknown as ChartSpec;
    expect(() => validateSpec(format)).toThrow(/^spec\.y\.format: a function cannot be in a spec/);
  });

  it("refuses intervals the axis cannot take", () => {
    expect(valid({ x: { type: "time", ticks: { every: 5 } } })).toThrow(
      /^spec\.x\.ticks\.every: expected a time interval on a time axis/,
    );
    expect(valid({ y: { type: "log", ticks: { every: 10 } } })).toThrow(
      /a log axis, which has no even steps/,
    );
    expect(valid({ y: { type: "linear", ticks: { every: "day" } } })).toThrow(
      /^spec\.y\.ticks\.every: expected a number on a linear axis/,
    );
    expect(valid({ x: { ticks: { every: "fortnight" } } })).toThrow(
      /^spec\.x\.ticks\.every: "fortnight" is not a time interval/,
    );
    expect(valid({ x: { ticks: { every: "day", anchor: 1 } } })).toThrow(
      /^spec\.x\.ticks\.anchor: expected no anchor with a calendar interval/,
    );
  });

  it("refuses mixed forms as unknown properties", () => {
    const spec = { marks, y: { ticks: { count: 5, every: 2 } } } as unknown as ChartSpec;
    expect(checkSpec(spec)).toEqual(["spec.y.ticks.every"]);
  });
});

describe("format patterns", () => {
  it("takes number and time patterns, checked as they are written", () => {
    expect(valid({ y: { format: { number: ",.2f" } } })).not.toThrow();
    expect(valid({ x: { type: "time", format: { time: "%b %-d" } } })).not.toThrow();
    expect(valid({ y: { format: { number: ",.2q" } } })).toThrow(
      /^spec\.y\.format\.number: ",\.2q" is not a number pattern herceg reads/,
    );
    expect(valid({ x: { type: "time", format: { time: "%Q" } } })).toThrow(
      /^spec\.x\.format\.time: "%Q" at character 1/,
    );
  });

  it("refuses a pattern for the other kind of axis, and mixed forms", () => {
    expect(valid({ x: { type: "time", format: { number: ".1f" } } })).toThrow(
      /^spec\.x\.format\.number: expected \{ time: "\.\.\." \}/,
    );
    const mixed = { marks, y: { format: { number: ".1f", maximumFractionDigits: 1 } } };
    expect(checkSpec(mixed as unknown as ChartSpec)).toEqual([
      "spec.y.format.maximumFractionDigits",
    ]);
  });
});

describe("scales and guides", () => {
  it("take the position scales x, y, and yRight", () => {
    expect(valid({ scales: { y: { domain: [0, 100], scope: "panel" } } })).not.toThrow();
    const other = { marks, scales: { temperature: { domain: [0, 1] } } } as unknown as ChartSpec;
    expect(checkSpec(other)).toEqual(["spec.scales.temperature"]);
  });

  it("check each guide by its type, and its ids", () => {
    expect(
      valid({
        guides: [
          { type: "axis", scale: "x", place: { side: "top" }, ticks: { every: "day" } },
          {
            type: "axis",
            scale: "y",
            tick: { direction: "in", length: 4 },
            labels: { rotation: { candidates: [0, 45] }, collision: "hide" },
            layers: [{ id: "minor", ticks: { every: 5 }, labels: false }],
          },
          { type: "legend", columns: 3, place: { side: "bottom" } },
          { type: "colorbar", scale: { mark: "heat", channel: "color" }, ticks: 5 },
        ],
      }),
    ).not.toThrow();
    expect(valid({ guides: [{ type: "axis", scale: "x", place: { side: "left" } }] })).toThrow(
      'spec.guides[0].place.side: expected "top" or "bottom" for an x axis; received "left"',
    );
    expect(valid({ guides: [{ type: "axis", scale: "y", layers: [{ id: "major" }] }] })).toThrow(
      /^spec\.guides\[0\]\.layers\[0\]\.id: expected a name other than "major"/,
    );
    expect(
      valid({
        guides: [
          { type: "legend", id: "a" },
          { type: "legend", id: "a" },
        ],
      }),
    ).toThrow('spec.guides[1].id: expected an id no other guide has; received "a"');
    expect(
      valid({
        guides: [
          { type: "colorbar", scale: { mark: "heat", channel: "color", panel: "a" } as never },
        ],
      }),
    ).toThrow(/^spec\.guides\[0\]\.scale\.panel: /);
    expect(
      valid({
        guides: [{ type: "axis", scale: "x", labels: { rotation: { candidates: [0, 180] } } }],
      }),
    ).toThrow(
      /^spec\.guides\[0\]\.labels\.rotation\.candidates\[1\]: expected degrees from -90 to 90/,
    );
    expect(valid({ guides: [{ type: "legend", columns: 2, rows: 2 }] })).toThrow(
      /^spec\.guides\[0\]\.rows: expected columns or rows, not both/,
    );
    const unknown = { marks, guides: [{ type: "ruler" }] } as unknown as ChartSpec;
    expect(() => validateSpec(unknown)).toThrow(
      'spec.guides[0].type: expected "axis", "legend", or "colorbar"; received "ruler"',
    );
  });

  it("check custom legend entries and their swatches", () => {
    expect(
      valid({
        legend: {
          entries: [
            { key: "band", label: "Maintenance", swatch: { type: "rect", fill: "#eee" } },
            { key: "avg", label: "Average", sample: { mark: "avg" }, targets: [{ mark: "avg" }] },
          ],
        },
      }),
    ).not.toThrow();
    expect(
      valid({
        legend: {
          entries: [{ key: "a", label: "A", swatch: { type: "star", fill: "red" } as never }],
        },
      }),
    ).toThrow(
      /^spec\.legend\.entries\[0\]\.swatch\.type: expected "line", "rect", "circle", or "composite"/,
    );
  });

  it("take legend: false on the marks legends show", () => {
    expect(() =>
      validateSpec({ marks: [{ type: "line", x: "t", y: "v", legend: false }] }),
    ).not.toThrow();
    expect(() =>
      validateSpec({ marks: [{ type: "line", x: "t", y: "v", legend: true as never }] }),
    ).toThrow(/^marks\[0\]\.legend: expected false, which leaves the mark out of the legends/);
  });
});
