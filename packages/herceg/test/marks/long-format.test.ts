// Min/max indexes of long-format series: lines and areas split by a series
// field draw, through their groups' indexes and the reduction through rows,
// exactly what the same series as whole columns draw.
import { afterEach, describe, expect, it, vi } from "vitest";
import { category } from "../../src/data/column.ts";
import { type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { RowsIndex } from "../../src/lod/rows-index.ts";
import { area } from "../../src/marks/area.ts";
import { line } from "../../src/marks/line.ts";
import { facet } from "../../src/model/facet.ts";
import { ChartModel } from "../../src/model/model.ts";
import type { AreaGeometry, LineGeometry } from "../../src/scene/scene.ts";

function seeded(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const NAMES = ["a", "b", "c"];

/** Rows of three interleaved series, the first twice as likely; x ascends. */
function rows(from: number, count: number, next: () => number) {
  const x = Float64Array.from({ length: count }, (_, i) => from + i);
  return {
    x,
    // Values in quarters, so some tie, and an occasional gap.
    y: Float64Array.from(x, (v) =>
      next() < 0.0005 ? Number.NaN : Math.round((Math.sin(v / 5000) * 40 + next() * 9) * 4) / 4,
    ),
    kind: Array.from({ length: count }, () => NAMES[Math.max(0, Math.floor(next() * 4) - 1)]!),
  };
}

type Kind = "line" | "area";

function chart(data: Table, kind: Kind, width: number) {
  const options = { x: "x", y: "y", series: "kind" } as never;
  // No axes: labels would size the margins, which a streaming chart keeps.
  const model = new ChartModel({
    marks: [kind === "line" ? line(data, options) : area(data, options)],
    x: { axis: false },
    y: { axis: false },
    locale: "en-US",
  });
  model.setSize(width, 300, 1);
  return model;
}

/**
 * Each series' name, y extent in view, and path, by name (the order of
 * series follows the field's dictionary, which differs in a copy).
 */
function drawn(model: ChartModel) {
  const scene = model.scene(estimateText);
  const [x0, x1] = model.xScale()!.domain;
  const paths = scene.panels[0]!.marks.map((geometry) => {
    const path =
      geometry.kind === "line" ? (geometry as LineGeometry).path : (geometry as AreaGeometry).upper;
    const series = model.series().find((s) => s.key === geometry.key)!;
    return [
      series.label,
      model.markOf(series)!.yExtent([series], x0, x1, false),
      [...path.starts],
      Array.from(path.coords.subarray(0, path.count * 2)),
    ] as const;
  });
  return paths.sort(([a], [b]) => (a < b ? -1 : 1));
}

/**
 * What a chart of the same series as whole columns draws on its first
 * scene: a mark per series over a table of a copy of its rows, which reads
 * no index and no rows.
 */
function reference(data: Table, kind: Kind, width: number, viewport: [number, number] | null) {
  const { codes, dictionary } = data.categories("kind");
  const x = data.numbers("x");
  const y = data.numbers("y");
  const marks = dictionary.flatMap((name, code) => {
    const rows = Array.from(codes.keys()).filter((row) => codes[row] === code);
    if (rows.length === 0) return [];
    const columns = table({
      x: Float64Array.from(rows, (row) => x[row]!),
      y: Float64Array.from(rows, (row) => y[row]!),
    });
    const options = { x: "x", y: "y", label: name } as const;
    return [kind === "line" ? line(columns, options) : area(columns, options)];
  });
  const model = new ChartModel({
    marks,
    x: { axis: false },
    y: { axis: false },
    locale: "en-US",
  });
  model.setSize(width, 300, 1);
  model.setViewport(viewport);
  return drawn(model);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("long-format indexes", () => {
  for (const kind of ["line", "area"] as const) {
    it(`let ${kind}s draw what whole columns draw, through zooms, streams, and changes`, async () => {
      const next = seeded(kind === "line" ? 3 : 5);
      const n = 300_000;
      const data = table(
        { x: new Float64Array(0), y: new Float64Array(0), kind: category([]) },
        { maxRows: n },
      );
      data.append(rows(0, n, next));
      // About 100,000 rows a series over 300 or 40 pixel columns: dense
      // enough for index queries, of blocks of every size.
      const widths = [300, 40];
      const models = widths.map((width) => chart(data as unknown as Table, kind, width));
      for (const model of models) model.scene(estimateText);
      await vi.dynamicImportSettled();
      const queries = vi.spyOn(RowsIndex.prototype, "query");
      let viewport: [number, number] | null = null;
      let end = n;
      const expectReference = () => {
        models.forEach((model, i) => {
          const width = widths[i]!;
          expect(drawn(model)).toEqual(reference(data as unknown as Table, kind, width, viewport));
        });
      };
      const append = (count: number) => {
        data.append(rows(end, count, next));
        end += count;
      };
      expectReference();
      expectReference();
      for (const view of [[100_000, 200_000], [150_000, 150_500], null] as const) {
        viewport = view && [view[0], view[1]];
        for (const model of models) model.setViewport(viewport);
        expectReference();
      }
      // Appends past the window drop rows from the front of every series.
      for (const count of [1, 63, 64, 65, 5_000, 70_000]) {
        append(count);
        expectReference();
      }
      expect(queries.mock.calls.length).toBeGreaterThan(300);
      // A change in place groups the rows again, with new indexes.
      data.set("y", 10, -100);
      expectReference();
      append(1_000);
      expectReference();
      data.reset(rows(0, 200_000, next) as never);
      end = 200_000;
      expectReference();
      append(2_000);
      expectReference();
    });
  }

  it("are only built for charts redrawing data that stays in place", async () => {
    const next = seeded(9);
    const data = table({ x: new Float64Array(0), y: new Float64Array(0), kind: category([]) });
    data.append(rows(0, 100_000, next));
    const model = chart(data as unknown as Table, "line", 400);
    model.scene(estimateText);
    await vi.dynamicImportSettled();
    const build = vi.spyOn(RowsIndex.prototype, "update");
    // A value set before every draw groups the rows again each time.
    for (let frame = 0; frame < 4; frame++) {
      data.set("y", frame, frame);
      model.scene(estimateText);
    }
    expect(build).not.toHaveBeenCalled();
    model.scene(estimateText);
    expect(build).toHaveBeenCalled();
    const [series] = model.series();
    expect(series!.stream!.hasMinMaxIndex("y")).toBe(true);
  });

  it("group an unchanged table through the grouping once it loads, and later charts at once", async () => {
    // Modules afresh, so the grouping has not loaded yet.
    vi.resetModules();
    const { table } = await import("../../src/data/table.ts");
    const { line } = await import("../../src/marks/line.ts");
    const { ChartModel } = await import("../../src/model/model.ts");
    const next = seeded(11);
    const data = table(rows(0, 60_000, next));
    const chart = () => {
      const model = new ChartModel({
        marks: [line(data, { x: "x", y: "y", series: "kind" })],
        locale: "en-US",
      });
      model.setSize(400, 300, 1);
      model.scene(estimateText);
      return model;
    };
    const first = chart();
    // Until it loads, rows are grouped afresh, and have no stream.
    expect(first.series().every((s) => s.stream === undefined)).toBe(true);
    await vi.dynamicImportSettled();
    first.scene(estimateText);
    expect(first.series().every((s) => s.stream !== undefined)).toBe(true);
    expect(
      chart()
        .series()
        .every((s) => s.stream !== undefined),
    ).toBe(true);
  });

  it("refuse reads of an index through rows read before the table changed", async () => {
    const next = seeded(13);
    const data = table({ x: new Float64Array(0), y: new Float64Array(0), kind: category([]) });
    data.append(rows(0, 60_000, next));
    const model = chart(data as unknown as Table, "line", 400);
    model.scene(estimateText);
    await vi.dynamicImportSettled();
    model.scene(estimateText);
    const [series] = model.series();
    const index = series!.stream!.minMaxIndex("y");
    const out = { low: -1, high: -1, gap: false };
    expect(index.query(series!.y, 0, index.length, out).low).toBeGreaterThanOrEqual(0);
    data.append(rows(60_000, 10, next));
    expect(() => index.query(series!.y, 0, index.length, out)).toThrow(/before the table changed/);
    expect(() => series!.stream!.minMaxIndex("x")).toThrow(/before the table changed/);
  });

  it("leave the rows of facet panels, which are subsets, without an index", async () => {
    const next = seeded(17);
    const data = table(rows(0, 60_000, next));
    const model = new ChartModel({
      marks: [line(data as unknown as Table, { x: "x", y: "y", series: "kind" } as never)],
      facet: facet("kind"),
      locale: "en-US",
    });
    model.setSize(600, 400, 1);
    model.scene(estimateText);
    await vi.dynamicImportSettled();
    model.scene(estimateText);
    expect(model.series().every((s) => s.stream !== undefined)).toBe(true);
    const panels = model.panels();
    expect(panels.length).toBe(NAMES.length);
    for (const { key } of panels)
      expect(model.panelSeries(key).every((s) => s.stream === undefined)).toBe(true);
  });
});
