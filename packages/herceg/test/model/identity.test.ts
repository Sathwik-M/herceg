// What series stand for (model/identity.ts): series and slices standing for
// one value of one field of one table, or for one value field, share a
// color, a legend entry, visibility, and dodged places, in every mark and
// panel; unrelated tables keep apart unless a named scale joins them.
import { describe, expect, it } from "vitest";
import { derive } from "../../src/data/derive.ts";
import { col } from "../../src/data/expr.ts";
import { type Table, table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { grid } from "../../src/layout.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { errorBar } from "../../src/marks/errorbar.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { identityKey, keyPrefix } from "../../src/model/identity.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { panels } from "../../src/model/panels.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import type {
  AreaGeometry,
  LineGeometry,
  RectGeometry,
  Scene,
  SegmentGeometry,
} from "../../src/scene/scene.ts";
import type { ChartError } from "../../src/spec/errors.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { legendOf } from "../helpers/guides.ts";

function build(config: ChartConfig) {
  const model = new ChartModel(
    { locale: "en-US", timeZone: "UTC", ...config },
    undefined,
    ...staticCompilers(),
  );
  model.setSize(600, 300, 1);
  return model;
}

const kinds = <G>(scene: Scene, kind: string, panel = 0) =>
  scene.panels[panel]!.marks.filter((m) => m.kind === kind) as G[];

// A summary per category and sex: an estimate and its interval.
const summary = table(
  {
    day: ["thu", "thu", "fri", "fri"],
    sex: ["f", "m", "f", "m"],
    mean: [2, 3, 4, 5],
    low: [1, 2, 3, 4],
    high: [3, 4, 5, 6],
  },
  { name: "summary" },
);
const bars = () => bar(summary, { x: "day", y: "mean", series: "sex" });
const intervals = () => errorBar(summary, { x: "day", y1: "low", y2: "high", series: "sex" });
const sex = (value: string) => identityKey({ table: "summary", field: "sex" }, value);

describe("identity", () => {
  it("gives series of one field's value one color and one legend entry across marks", () => {
    const model = build({ marks: [bars(), intervals()] });
    const scene = model.scene(estimateText);
    const [f, m] = kinds<RectGeometry>(scene, "rect");
    const [fBars, mBars] = kinds<SegmentGeometry>(scene, "segments");
    expect(fBars!.stroke).toBe(f!.fill);
    expect(mBars!.stroke).toBe(m!.fill);
    expect(f!.fill).not.toBe(m!.fill);
    const entries = model.legendEntries();
    expect(entries.map(({ label }) => label)).toEqual(["f", "m"]);
    expect(entries.map(({ key }) => key)).toEqual([sex("f"), sex("m")]);
    expect(entries[0]!.key).toBe('{"table":"summary","field":"sex","value":"f"}');
    expect(legendOf(scene).map(({ label }) => label)).toEqual(["f", "m"]);
    // Inspection still reads each mark's own series.
    const panel = scene.panels[0]!;
    const inspection = model.inspect(model.xScale()!.map(0), panel.plot.y + 5)!;
    expect(inspection.points.map(({ label }) => label)).toEqual(["f", "m", "f", "m"]);
  });

  it("keeps unrelated tables that share a field's name apart, unless a named scale joins them", () => {
    const other = table({
      day: ["thu", "thu", "fri", "fri"],
      sex: ["f", "m", "f", "m"],
      low: [1, 2, 3, 4],
      high: [3, 4, 5, 6],
    });
    const apart = build({
      marks: [bars(), errorBar(other, { x: "day", y1: "low", y2: "high", series: "sex" })],
    });
    apart.scene(estimateText);
    expect(apart.legendEntries().map(({ label }) => label)).toEqual(["f", "m", "f", "m"]);
    expect(new Set(apart.legendEntries().map(({ color }) => color)).size).toBe(4);
    const joined = build({
      scales: { sex: { type: "ordinal" } },
      marks: [
        bar(summary, {
          x: "day",
          y: "mean",
          series: "sex",
          encode: { color: { series: true, scale: "sex" } },
        }),
        errorBar(other, { x: "day", y1: "low", y2: "high", series: "sex" }),
      ],
    });
    joined.scene(estimateText);
    // Only the marks naming the scale join it.
    expect(joined.legendEntries().map(({ key }) => key)).toEqual([
      identityKey({ scale: "sex" }, "f"),
      identityKey({ scale: "sex" }, "m"),
      expect.stringContaining('"field":"sex","value":"f"'),
      expect.stringContaining('"field":"sex","value":"m"'),
    ]);
  });

  it("joins tables derived from one, through the fields they keep", () => {
    const rows = table(
      { t: [0, 1, 0, 1], v: [1, 2, 3, 4], site: ["A", "A", "B", "B"] },
      { name: "rows" },
    );
    const late = derive(rows).filter(true).table();
    const totals = derive(rows)
      .aggregate({ by: ["site"], ops: { total: { op: "sum", field: "v" } } })
      .table();
    const model = build({
      panels: panels([{ id: "a" }, { id: "b" }, { id: "c" }], grid({ columns: 3 })),
      x: { scope: "panel" },
      marks: [
        line(rows, { x: "t", y: "v", series: "site", panel: "a" }),
        line(late, { x: "t", y: "v", series: "site", panel: "b" }),
        bar(totals, { x: "site", y: "total", series: "site", panel: "c" }),
      ],
    });
    const scene = model.scene(estimateText);
    expect(model.legendEntries().map(({ label }) => label)).toEqual(["A", "B"]);
    const strokes = (panel: number) =>
      kinds<LineGeometry>(scene, "line", panel).map(({ stroke }) => stroke);
    expect(strokes(1)).toEqual(strokes(0));
    expect(kinds<RectGeometry>(scene, "rect", 2).map(({ fill }) => fill)).toEqual(strokes(0));
    // A calculated field is the derived table's own.
    const renamed = derive(rows).calculate("site", "x").table();
    const own = build({
      marks: [
        line(rows, { x: "t", y: "v", series: "site" }),
        line(renamed, { x: "t", y: "v", series: "site" }),
      ],
    });
    own.scene(estimateText);
    expect(own.legendEntries().map(({ label }) => label)).toEqual(["A", "B", "x"]);
    // A grouping field kept is the source's; one an operation writes over, the derived table's.
    const counts = (ops: Record<string, { op: "count" }>) =>
      derive(rows)
        .aggregate({ by: ["t", "v", "site"], ops })
        .table() as unknown as typeof rows;
    const valued = (made: typeof rows) => {
      const model = build({
        marks: [line(rows, { x: "t", y: "v" }), line(made, { x: "t", y: "v" })],
      });
      model.scene(estimateText);
      return model.legendEntries().length;
    };
    expect(valued(counts({ n: { op: "count" } }))).toBe(1);
    expect(valued(counts({ v: { op: "count" } }))).toBe(2);
  });

  it("hides every series of an entry, which grouped bars regroup around", () => {
    const model = build({ marks: [bars(), intervals()] });
    const before = model.scene(estimateText);
    const [shownF] = kinds<RectGeometry>(before, "rect");
    model.hidden.add(sex("f"));
    const scene = model.scene(estimateText);
    const rects = kinds<RectGeometry>(scene, "rect");
    const segments = kinds<SegmentGeometry>(scene, "segments");
    expect(rects).toHaveLength(1);
    expect(segments).toHaveLength(1);
    // The other sex's bars take the whole band.
    expect(rects[0]!.rects[2]).toBeGreaterThan(shownF!.rects[2]!);
    expect(legendOf(scene).map(({ label, hidden }) => [label, hidden])).toEqual([
      ["f", true],
      ["m", false],
    ]);
    const panel = scene.panels[0]!;
    const inspection = model.inspect(model.xScale()!.map(0), panel.plot.y + 5)!;
    expect(inspection.points.map(({ label }) => label)).toEqual(["m", "m"]);
  });

  it("stacks visible series only, also for series hidden before any scene", () => {
    const model = build({
      marks: [bar(summary, { x: "day", y: "mean", series: "sex", stack: true })],
    });
    model.hidden.add(sex("f"));
    const scene = model.scene(estimateText);
    const [m] = kinds<RectGeometry>(scene, "rect");
    const y = model.yScale()!;
    expect(m!.rects[1]! + m!.rects[3]!).toBeCloseTo(y.map(0), 3);
    expect(m!.rects[1]).toBeCloseTo(y.map(3), 3);
  });

  it("names series of value fields by their labels, as a line and its band, and scales join tables", () => {
    const rows = table({ t: [0, 1, 2], v: [1, 2, 3], lo: [0, 1, 2], hi: [2, 3, 4] });
    const model = build({
      marks: [
        area(rows, { x: "t", y1: "lo", y2: "hi", label: "latency" }),
        line(rows, { x: "t", y: "v", label: "latency" }),
        line(rows, { x: "t", y: "lo" }),
      ],
    });
    const scene = model.scene(estimateText);
    const [band] = kinds<AreaGeometry>(scene, "area");
    const [trace, low] = kinds<LineGeometry>(scene, "line");
    expect(band!.fill).toBe(trace!.stroke);
    expect(low!.stroke).not.toBe(trace!.stroke);
    expect(model.legendEntries().map(({ label }) => label)).toEqual(["latency", "lo"]);
    // Another table's line of that name stands apart, unless a scale joins them.
    const fit = table({ t: [0, 1, 2], v: [1, 1, 1] });
    const named = { series: true, scale: "fit" } as const;
    const joined = build({
      scales: { fit: { type: "ordinal" } },
      marks: [
        area(rows, { x: "t", y1: "lo", y2: "hi", label: "latency", encode: { color: named } }),
        line(fit, { x: "t", y: "v", label: "latency", encode: { color: named } }),
      ],
    });
    const both = joined.scene(estimateText);
    expect(kinds<AreaGeometry>(both, "area")[0]!.fill).toBe(
      kinds<LineGeometry>(both, "line")[0]!.stroke,
    );
    expect(joined.legendEntries().map(({ key }) => key)).toEqual([
      identityKey({ scale: "fit" }, "latency"),
    ]);
  });

  it("keeps explicit colors, sharing visibility, and lists the first mark's color", () => {
    const model = build({
      marks: [
        bars(),
        errorBar(summary, {
          x: "day",
          y1: "low",
          y2: "high",
          series: "sex",
          stroke: "#444444",
        }),
      ],
    });
    const scene = model.scene(estimateText);
    expect(kinds<SegmentGeometry>(scene, "segments").map((s) => s.stroke)).toEqual([
      "#444444",
      "#444444",
    ]);
    expect(model.legendEntries()[0]!.color).toBe(kinds<RectGeometry>(scene, "rect")[0]!.fill);
    model.hidden.add(sex("m"));
    expect(kinds(model.scene(estimateText), "segments")).toHaveLength(1);
  });

  it("gives a pie's slices their category's color and entry, beside series of the field", () => {
    const sales = table({ t: [0, 0, 1, 1], region: ["N", "S", "N", "S"], v: [1, 2, 3, 4] });
    const model = build({
      panels: panels([{ id: "lines" }, { id: "share" }], grid({ columns: 2 })),
      marks: [
        line(sales, { x: "t", y: "v", color: "region", panel: "lines" }),
        pie(sales, { category: "region", value: "v", panel: "share" }),
      ],
    });
    const scene = model.scene(estimateText);
    expect(model.legendEntries().map(({ label }) => label)).toEqual(["N", "S"]);
    const strokes = kinds<LineGeometry>(scene, "line").map(({ stroke }) => stroke);
    const colors = model.legendEntries().map(({ color }) => color);
    expect(colors).toEqual(strokes);
    model.hidden.add(model.legendEntries()[0]!.key);
    const hidden = model.scene(estimateText);
    expect(kinds(hidden, "line")).toHaveLength(1);
    expect(hidden.panels[1]!.marks.some((m) => m.kind === "arc")).toBe(true);
  });

  it("colors values in their dictionary's order, whichever have rows", () => {
    const model = build({ marks: [bars()] });
    model.scene(estimateText);
    const colors = model.legendEntries().map(({ color }) => color);
    const coded = table(
      { day: ["thu", "fri"], sex: ["m", "m"], mean: [1, 2] },
      { name: "summary" },
    );
    const later = build({ marks: [bar(coded, { x: "day", y: "mean", series: "sex" })] });
    later.scene(estimateText);
    // "m" alone, first in its dictionary, takes the first color.
    expect(later.legendEntries().map(({ color }) => color)).toEqual([colors[0]]);
  });

  it("keeps a value's color while rows are appended, dropped, replaced, and hidden", () => {
    const rows = table({ t: [0, 1, 0, 1], v: [1, 2, 3, 4], region: ["eu", "eu", "us", "us"] });
    const model = build({ marks: [line(rows, { x: "t", y: "v", color: "region" })] });
    const colors = () => {
      model.scene(estimateText);
      return Object.fromEntries(model.series().map((s) => [s.label, s.color]));
    };
    const first = colors();
    rows.append({ t: [2, 2], v: [5, 6], region: ["asia", "us"] });
    expect(colors()).toMatchObject(first);
    // Every row of "eu" leaves the table; the others keep their colors.
    rows.dropFirst(2);
    const later = colors();
    expect(later).toEqual({ us: first.us, asia: later.asia });
    rows.reset({ t: [0, 1], v: [1, 2], region: ["us", "eu"] });
    expect(colors()).toEqual({ us: first.us, eu: first.eu });
    model.hidden.add(model.legendEntries()[0]!.key);
    expect(colors()).toEqual({ us: first.us, eu: first.eu });
    expect(new Set(Object.values(colors())).size).toBe(2);
  });

  it("leaves out of stacks what is hidden, by what a series' rows say it stands for", () => {
    const rows = table({
      t: [0, 1, 0, 1],
      v: [100, 100, 1, 1],
      service: ["a", "a", "b", "b"],
      region: ["eu", "eu", "us", "us"],
    });
    const model = build({
      marks: [area(rows, { x: "t", y: "v", series: "service", color: "region", stack: true })],
    });
    model.scene(estimateText);
    const eu = model.legendEntries().find(({ label }) => label === "eu")!;
    expect(eu.key).toBe(identityKey({ table: { mark: 0 }, field: "region" }, "eu"));
    model.hidden.add(eu.key);
    model.scene(estimateText);
    // Service b stands on the zero line, not on the hidden a's values.
    expect(model.yScale()!.domain[1]).toBeLessThan(2);
  });

  it("leaves out of stacks what is hidden through a declared scale, too", () => {
    const rows = table({
      t: [0, 1, 0, 1],
      v: [10, 10, 20, 20],
      service: ["a", "a", "b", "b"],
      region: ["eu", "eu", "us", "us"],
    });
    const model = build({
      scales: { color: { type: "ordinal" } },
      marks: [area(rows, { x: "t", y: "v", series: "service", color: "region", stack: true })],
    });
    model.scene(estimateText);
    const eu = model.legendEntries().find(({ label }) => label === "eu")!;
    expect(eu.key).toBe(identityKey({ scale: "color" }, "eu"));
    model.hidden.add(eu.key);
    model.scene(estimateText);
    expect(model.yScale()!.domain[1]).toBeLessThanOrEqual(20);
  });

  it("colors a lone pie through a declared scale", () => {
    const rows = table({ c: ["a", "b"], v: [1, 2] });
    const model = build({
      scales: { color: { type: "ordinal", map: { a: "#ff0000", b: "#00ff00" } } },
      marks: [pie(rows, { category: "c", value: "v" })],
    });
    model.scene(estimateText);
    expect(model.legendEntries().map(({ label, color }) => [label, color])).toEqual([
      ["b", "#00ff00"],
      ["a", "#ff0000"],
    ]);
  });

  it("lists layers drawn as one once, and registers items whatever their paint", () => {
    const rows = table({ lon: [0, 10], lat: [0, 10], t: [0, 1], v: [1, 2], kind: ["a", "b"] });
    const model = build({
      legend: true,
      panels: panels([{ id: "line" }, { id: "map" }]),
      marks: [
        line(rows, { x: "t", y: "v", series: "kind", panel: "line" }),
        geopoint(rows, { longitude: "lon", latitude: "lat", series: "kind", panel: "map" }),
        geopoint(rows, {
          longitude: "lon",
          latitude: "lat",
          series: "kind",
          fill: "#000000",
          panel: "map",
        }),
      ],
    });
    model.scene(estimateText);
    expect(model.legendEntries().map(({ label }) => label)).toEqual(["a", "b"]);
    model.hidden.add(model.legendEntries()[0]!.key);
    model.scene(estimateText);
    // Hidden in the map's layers too, the one with a fill of its own included.
    const hidden = [...model.hidden.snapshot()];
    expect(hidden.filter((key) => key.includes('"series":"a"'))).toHaveLength(2);
  });

  it("draws every mark's look in one entry, layout marks' too", () => {
    const rows = table({ lon: [0, 10], lat: [0, 10], t: [0, 1], v: [1, 2], kind: ["a", "b"] });
    const model = build({
      legend: { swatches: "mark" },
      panels: panels([{ id: "line" }, { id: "map" }]),
      marks: [
        line(rows, { x: "t", y: "v", series: "kind", panel: "line" }),
        geopoint(rows, {
          longitude: "lon",
          latitude: "lat",
          series: "kind",
          fill: "#ff0000",
          panel: "map",
        }),
      ],
    });
    const [a] = legendOf(model.scene(estimateText));
    expect(a!.label).toBe("a");
    // The line's stroke, and the point's red glyph.
    expect(a!.sample!.items.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(a!.sample!.items)).toContain("#ff0000");
  });

  it("draws looks of one kind side by side, which over one another would hide", () => {
    const rows = table({ lon: [0, 10], lat: [0, 10], kind: ["a", "b"] });
    const model = build({
      legend: { swatches: "mark" },
      marks: [
        geopoint(rows, { longitude: "lon", latitude: "lat", series: "kind", fill: "#ff0000" }),
        geopoint(rows, { longitude: "lon", latitude: "lat", series: "kind", fill: "#00ff00" }),
      ],
    });
    const [a] = legendOf(model.scene(estimateText));
    const shapes = a!.sample!.items.filter((item) => item.type === "shape");
    expect(shapes.map((item) => item.type === "shape" && item.fill)).toEqual([
      "#ff0000",
      "#00ff00",
    ]);
    const [first, second] = shapes as { at: readonly [number, number] }[];
    expect(second!.at[0]).toBeGreaterThan(first!.at[0]);
  });

  it("places boxes of one entry side by side, each once, however they are drawn", () => {
    const rows = table({ x: ["p", "q"], v: [1, 2], kind: ["a", "b"] });
    const bars = (fill: string, stroke?: string) =>
      bar(rows, { x: "x", y: "v", series: "kind", fill, ...(stroke && { stroke }) });
    const model = build({
      legend: { swatches: "mark" },
      marks: [bars("#ff0000"), bars("#00ff00", "#000000"), bars("#00ff00", "#000000")],
    });
    const [a] = legendOf(model.scene(estimateText));
    const fills = a!.sample!.items.flatMap((item) =>
      item.type === "rect" || item.type === "shape" ? [item.fill] : [],
    );
    expect(fills).toEqual(["#ff0000", "#00ff00"]);
    const [red, green] = a!.sample!.items as readonly {
      x?: number;
      at?: readonly [number, number];
    }[];
    expect(green!.at?.[0] ?? green!.x!).toBeGreaterThan(red!.x ?? red!.at![0]);
  });

  it("places lines of one entry side by side, which over one another would hide", () => {
    const rows = table({ t: [0, 1], v: [1, 2], kind: ["a", "a"] });
    const model = build({
      legend: { swatches: "mark" },
      marks: [
        line(rows, { x: "t", y: "v", series: "kind", stroke: "#ff0000" }),
        line(rows, { x: "t", y: "v", series: "kind", stroke: "#00ff00" }),
      ],
    });
    const [a] = legendOf(model.scene(estimateText));
    const lines = a!.sample!.items.filter((item) => item.type === "segments") as {
      coords: readonly number[];
    }[];
    expect(lines).toHaveLength(2);
    expect(lines[1]!.coords[0]).toBeGreaterThan(lines[0]!.coords[2]!);
  });

  it("draws each mark's own look, and none of marks left out of legends", () => {
    const rows = table({ t: [0, 1], v: [1, 2], kind: ["a", "a"] });
    const model = build({
      legend: { swatches: "mark" },
      marks: [
        point(rows, { x: "t", y: "v", series: "kind", symbol: "triangle" }),
        line(rows, { x: "t", y: "v", series: "kind" }),
        line(rows, { x: "t", y: "v", series: "kind", stroke: "#00ff00", legend: false }),
      ],
    });
    const [a] = legendOf(model.scene(estimateText));
    const kinds = a!.sample!.items.map((item) => item.type);
    // The triangle and the line, not the hidden green line.
    expect(kinds).toContain("shape");
    expect(kinds).toContain("segments");
    expect(JSON.stringify(a!.sample!.items)).not.toContain("#00ff00");
  });

  it("keeps series named through a scale whatever paints them", () => {
    const rows = table({
      t: [0, 1, 0, 1],
      v: [1, 2, 3, 4],
      service: ["a", "a", "b", "b"],
      region: ["eu", "eu", "us", "us"],
    });
    const named = { color: { series: true as const, scale: "groups" } };
    const model = build({
      scales: { groups: { type: "ordinal" } },
      marks: [
        line(rows, { x: "t", y: "v", series: "service", encode: named }),
        area(rows, {
          x: "t",
          y: "v",
          series: "service",
          encode: { ...named, fill: { field: "region" } },
        }),
      ],
    });
    model.scene(estimateText);
    expect(model.legendEntries().map(({ key }) => key)).toEqual([
      identityKey({ scale: "groups" }, "a"),
      identityKey({ scale: "groups" }, "b"),
    ]);
    model.hidden.add(identityKey({ scale: "groups" }, "a"));
    model.scene(estimateText);
    expect(
      model
        .series()
        .filter((s) => !model.hidden.has(s.key))
        .map((s) => s.label),
    ).toEqual(["b", "b"]);
  });

  it("names tables by their marks' places, alike in every chart, and keeps the names", () => {
    const rows = () => table({ t: [0, 1], v: [1, 2], region: ["eu", "us"] });
    const lineOf = (data: ReturnType<typeof rows>) =>
      line(data, { x: "t", y: "v", series: "region" });
    // A chart made before takes nothing from this one's names.
    build({ marks: [lineOf(rows())] }).scene(estimateText);
    const [a, b] = [rows(), rows()];
    const model = build({ marks: [lineOf(a), lineOf(b)] });
    model.scene(estimateText);
    const keys = () => model.legendEntries().map(({ key }) => key);
    expect(keys()).toEqual(
      [{ mark: 0 }, { mark: 1 }].flatMap((name) =>
        ["eu", "us"].map((value) => identityKey({ table: name, field: "region" }, value)),
      ),
    );
    const colorOf = (key: string) => model.legendEntries().find((e) => e.key === key)!.color;
    const bEu = keys()[2]!;
    const color = colorOf(bEu);
    model.hidden.add(keys()[0]!);
    // Without the first mark, the second's table keeps its name: its colors,
    // and nothing of the first's hidden values.
    model.update({ marks: [lineOf(b)] });
    model.scene(estimateText);
    expect(keys()[0]).toBe(bEu);
    expect(colorOf(bEu)).toBe(color);
    expect(model.hidden.has(bEu)).toBe(false);
    // A new table read in that place, as a framework rendering again gives: the same names.
    const kept = rows();
    model.update({ marks: [lineOf(kept)] });
    model.scene(estimateText);
    const keptEu = identityKey({ table: { mark: 0 }, field: "region" }, "eu");
    expect(keys()[0]).toBe(keptEu);
    // A table's own name is never one the chart gives, whatever it reads.
    const own = table({ t: [0], v: [1], region: ["eu"] }, { name: "#0" });
    model.update({ marks: [lineOf(own as never), lineOf(kept)] });
    model.scene(estimateText);
    expect(keys()).toEqual([
      identityKey({ table: "#0", field: "region" }, "eu"),
      keptEu,
      identityKey({ table: { mark: 0 }, field: "region" }, "us"),
    ]);
    // Two tables of one name are refused, and the refused configuration names no table.
    const named = (v: number) => table({ t: [0], v: [v], region: ["eu"] }, { name: "same" });
    expect(() => build({ marks: [lineOf(named(1) as never), lineOf(named(2) as never)] })).toThrow(
      'marks[1]: its table is named "same", as another of the chart\'s tables is; give each table a name of its own',
    );
    const [fresh, later] = [rows(), rows()];
    expect(() =>
      model.update({
        marks: [lineOf(fresh), lineOf(named(1) as never), lineOf(named(2) as never)],
      }),
    ).toThrow(/named "same"/);
    model.update({ marks: [lineOf(later), lineOf(fresh)] });
    model.scene(estimateText);
    expect(keys().filter((_, i) => i % 2 === 0)).toEqual([
      keptEu,
      identityKey({ table: { mark: 1 }, field: "region" }, "eu"),
    ]);
  });

  it("names a table read again anew once another took its place's name", () => {
    const rows = () => table({ t: [0, 1], v: [1, 2], region: ["a", "b"] });
    const lineOf = (data: ReturnType<typeof rows>, id: string) =>
      line(data, { x: "t", y: "v", series: "region", id });
    const [first, then] = [rows(), rows()];
    const model = build({ marks: [lineOf(first, "live")] });
    model.scene(estimateText);
    model.update({ marks: [lineOf(then, "live")] });
    model.scene(estimateText);
    const [a] = model.legendEntries();
    model.hidden.add(a!.key);
    // The first table, read again before the one that took its place, keeps
    // none of what that one stands for: its key, color, and hidden values.
    model.update({ marks: [lineOf(first, "old"), lineOf(then, "live")] });
    model.scene(estimateText);
    const entries = model.legendEntries();
    expect(entries.map(({ key }) => key)).toEqual([
      identityKey({ table: { mark: "old" }, field: "region" }, "a"),
      identityKey({ table: { mark: "old" }, field: "region" }, "b"),
      a!.key,
      identityKey({ table: { mark: "live" }, field: "region" }, "b"),
    ]);
    expect(entries[2]!.color).toBe(a!.color);
    expect(model.hidden.has(a!.key)).toBe(true);
    expect(model.hidden.has(entries[0]!.key)).toBe(false);
  });

  it("lets go of what series and slices a rolling window left behind stood for", () => {
    for (const make of [
      (rows: Table) => line(rows as never, { x: "t", y: "v", series: "g" }),
      (rows: Table) => pie(rows as never, { category: "g", value: "v" }),
    ]) {
      const stream = table({ t: [0], v: [1], g: ["s0"] }, { maxRows: 2 });
      const model = build({ marks: [make(stream as unknown as Table)] });
      model.scene(estimateText);
      model.hidden.add(model.legendEntries()[0]!.key);
      for (let i = 1; i <= 200; i++) {
        stream.append({ t: [i], v: [1], g: [`s${i}`] });
        model.scene(estimateText);
      }
      expect(model.hidden.groups.size).toBeLessThanOrEqual(2);
      // What is shown stays, and hides by what it stands for.
      const [last] = model.legendEntries().slice(-1);
      model.hidden.add(last!.key);
      model.scene(estimateText);
      expect(model.hidden.snapshot().size).toBeGreaterThan(model.hidden.size);
    }
  });

  it("keeps the names of tables colors come from as marks come and go", () => {
    const rows = table({ t: [0, 1, 0, 1], v: [1, 2, 3, 4], region: ["eu", "eu", "us", "us"] });
    // A series field the derived table makes, colored by a field it keeps from its source.
    const made = derive(rows).calculate("lane", col("region")).table();
    const colored = () =>
      line(made as never, { x: "t", y: "v", series: "lane", color: "region", id: "lanes" });
    const model = build({ marks: [colored()] });
    model.scene(estimateText);
    const [eu] = model.legendEntries();
    model.hidden.add(eu!.key);
    const other = line(table({ t: [0], v: [9], region: ["eu"] }), {
      x: "t",
      y: "v",
      series: "region",
    });
    model.update({ marks: [other, colored()] });
    model.scene(estimateText);
    const entries = model.legendEntries();
    expect(entries.filter(({ key }) => key === eu!.key)).toHaveLength(1);
    expect(entries.find(({ key }) => key === eu!.key)!.color).toBe(eu!.color);
    expect(model.hidden.has(eu!.key)).toBe(true);
  });

  it("takes what series stand for from the paint that colors them", () => {
    const rows = table({
      t: [0, 1, 0, 1],
      v: [1, 2, 3, 4],
      service: ["a", "a", "b", "b"],
      region: ["eu", "eu", "us", "us"],
    });
    const model = build({
      marks: [
        line(rows, { x: "t", y: "v", color: "region" }),
        area(rows, {
          x: "t",
          y: "v",
          series: "service",
          encode: { fill: { field: "region" } },
          stack: true,
        }),
      ],
    });
    model.scene(estimateText);
    expect(model.legendEntries().map(({ label }) => label)).toEqual(["eu", "us"]);
  });

  it("keeps what the feature compiler finds series stand for among the chart's scopes", () => {
    const rows = table({ t: [0, 1], v: [1, 2], service: ["a", "b"], region: ["eu", "us"] });
    const model = build({
      scales: { groups: { type: "ordinal" } },
      marks: [
        line(rows, { x: "t", y: "v", series: "service", color: "region" }),
        line(rows, {
          x: "t",
          y: "v",
          series: "service",
          encode: { color: { field: "service", scale: "groups" } },
        }),
      ],
    });
    model.scene(estimateText);
    const scopes = [...model.scopes()];
    expect(scopes).toContain(keyPrefix(identityKey({ table: { mark: 0 }, field: "region" }, "eu")));
    expect(scopes).toContain(keyPrefix(identityKey({ scale: "groups" }, "a")));
  });

  it("reads into a scale the values that color a mark, not its series' when another field colors them", () => {
    const rows = table({ t: [0, 1], v: [1, 2], service: ["a", "a"], region: ["eu", "eu"] });
    const colorOf = (series: "service" | undefined, declared: boolean) => {
      const model = build({
        scales: declared ? { color: { type: "ordinal" } } : { regions: { type: "ordinal" } },
        marks: [
          series === undefined
            ? line(rows, {
                x: "t",
                y: "v",
                encode: { color: { field: "region", scale: declared ? "color" : "regions" } },
              })
            : declared
              ? line(rows, { x: "t", y: "v", series, color: "region" })
              : line(rows, {
                  x: "t",
                  y: "v",
                  series,
                  encode: { color: { field: "region", scale: "regions" } },
                }),
        ],
      });
      model.scene(estimateText);
      return model.legendEntries().map(({ label, color }) => [label, color]);
    };
    for (const declared of [false, true])
      expect(colorOf("service", declared)).toEqual(colorOf(undefined, declared));
  });

  it("splits series by a field of an empty name, and by none with series: false", () => {
    const rows = table({ t: [0, 1, 0, 1], v: [1, 2, 3, 4], "": ["a", "a", "b", "b"] });
    const labels = (series: "" | false) =>
      [
        line(rows, { x: "t", y: "v", series }),
        area(rows, { x: "t", y: "v", series }),
        bar(rows, { x: "t", y: "v", series }),
        point(rows, { x: "t", y: "v", series }),
      ].map((mark) => {
        const model = build({ marks: [mark] });
        model.scene(estimateText);
        return model.series().map((s) => s.label);
      });
    expect(labels("")).toEqual([
      ["a", "b"],
      ["a", "b"],
      ["a", "b"],
      ["a", "b"],
    ]);
    expect(labels(false)).toEqual([["v"], ["v"], ["v"], ["v"]]);
  });

  it("refuses series' names through no scale, and names the channel of a scale the chart lacks", () => {
    const rows = table({ t: [0, 1], v: [1, 2], g: ["a", "b"] });
    const pathOf = (config: ChartConfig) => {
      try {
        build(config).scene(estimateText);
      } catch (error) {
        return [(error as ChartError).path, (error as Error).message];
      }
      return undefined;
    };
    expect(
      pathOf({
        marks: [line(rows, { x: "t", y: "v", encode: { color: { series: true } as never } })],
      }),
    ).toEqual([
      "marks[0].encode.color.scale",
      "line (mark 0) encode.color.scale: required, as the channel names series through a scale; give scale, the name of one of the chart's scales",
    ]);
    // Checked where a paint of the mark's own wins over it too, the chart's "color" declared or not.
    const unscaled = { color: { series: true } } as never;
    for (const scales of [undefined, { color: { type: "ordinal" as const } }])
      expect(
        [
          line(rows, { x: "t", y: "v", stroke: "#123456", encode: unscaled }),
          line(rows, {
            x: "t",
            y: "v",
            encode: { ...(unscaled as object), stroke: { value: "#123456" } } as never,
          }),
          area(rows, { x: "t", y: "v", fill: "#123456", encode: unscaled }),
          bar(rows, { x: "g", y: "v", fill: "#123456", encode: unscaled }),
          bar(rows, {
            x: "g",
            y: "v",
            encode: { ...(unscaled as object), fill: { value: "#123456" } } as never,
          }),
        ].map((mark) => pathOf({ ...(scales && { scales }), marks: [mark] })?.[0]),
      ).toEqual(Array(5).fill("marks[0].encode.color.scale"));
    const missing = { field: "g", scale: "missing" } as const;
    expect(
      [
        line(rows, { x: "t", y: "v", encode: { stroke: missing } }),
        area(rows, { x: "t", y: "v", encode: { fill: missing } }),
        bar(rows, { x: "g", y: "v", encode: { fill: missing } }),
      ].map((mark) => pathOf({ marks: [mark] })?.[0]),
    ).toEqual([
      "marks[0].encode.stroke.scale",
      "marks[0].encode.fill.scale",
      "marks[0].encode.fill.scale",
    ]);
  });

  it("keeps the last configuration whole when an update's theme is refused", () => {
    const rows = table({ t: [0, 1], v: [1, 2] });
    const model = build({ marks: [line(rows, { x: "t", y: "v" })] });
    const before = model.config.marks;
    expect(() =>
      model.update({
        marks: [bar(rows, { x: "t", y: "v" })],
        theme: { extends: "bogus" as never },
      }),
    ).toThrow();
    expect(model.config.marks).toBe(before);
  });

  it("keys are JSON, scope first, which their prefix names", () => {
    const key = identityKey({ table: "data", field: "region" }, 'e"u');
    expect(key).toBe('{"table":"data","field":"region","value":"e\\"u"}');
    expect(JSON.parse(key)).toEqual({ table: "data", field: "region", value: 'e"u' });
    expect(keyPrefix(key)).toBe('{"table":"data","field":"region","value":');
    expect(keyPrefix(JSON.stringify([0, "f"]))).toBeUndefined();
    expect(keyPrefix('{"mark":0,"group":"a"}')).toBeUndefined();
  });
});

describe("identity in specs", () => {
  const spec = (origin?: string) => ({
    data: {
      summary: { columns: { day: ["thu", "fri"], sex: ["f", "m"], mean: [2, 4] } },
      intervals: {
        columns: { day: ["thu", "fri"], sex: ["f", "m"], low: [1, 3], high: [3, 5] },
        ...(origin !== undefined && { origin }),
      },
    },
    marks: [
      { type: "bar", data: "summary", x: "day", y: "mean", series: "sex" },
      { type: "errorbar", data: "intervals", x: "day", y1: "low", y2: "high", series: "sex" },
    ],
  });
  const entries = (data: object) => {
    const model = build(loadSpec(data as never).config);
    model.scene(estimateText);
    return model.legendEntries().map(({ key }) => key);
  };

  it("joins a table made from another (statistics computed elsewhere) by its origin", () => {
    expect(entries(spec())).toHaveLength(4);
    const sexOf = (value: string) => identityKey({ table: "summary", field: "sex" }, value);
    expect(entries(spec("summary"))).toEqual([sexOf("f"), sexOf("m")]);
  });

  it("refuses an origin of no table, of itself, or of a cycle", () => {
    expect(() => loadSpec(spec("summarry") as never)).toThrow(
      'spec.data.intervals.origin: expected the name of another table in spec.data; received "summarry"',
    );
    const cycle = spec("summary");
    (cycle.data.summary as Record<string, unknown>).origin = "intervals";
    expect(() => loadSpec(cycle as never)).toThrow(/origin: the table is made from itself/);
  });
});
