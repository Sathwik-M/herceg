// Bars: series side by side by default (overlapping with dodge: false),
// colored by a field without being placed apart, outlined, and labeled in
// styles of their own.
import { describe, expect, it } from "vitest";
import { col } from "../../src/data/expr.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { staticCompilers } from "../../src/render/compilers.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { contrastingText } from "../../src/scale/color.ts";
import type { LabelsGeometry, RectGeometry, Scene, TextGeometry } from "../../src/scene/scene.ts";
import { DARK, LIGHT } from "../../src/theme.ts";
import { keysOf, legendOf } from "../helpers/guides.ts";

function build(config: ChartConfig, width = 600) {
  const model = new ChartModel(
    { locale: "en-US", timeZone: "UTC", ...config },
    undefined,
    ...staticCompilers(),
  );
  model.setSize(width, 300, 1);
  return { model, scene: model.scene(estimateText) };
}

const rects = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is RectGeometry => m.kind === "rect");
const texts = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is TextGeometry => m.kind === "text");
const labelItems = (scene: Scene) =>
  scene.panels[0]!.marks.filter((m): m is LabelsGeometry => m.kind === "labels");
const widthsOf = (g: RectGeometry) =>
  Array.from({ length: g.count }, (_, i) => g.rects[i * 4 + 2]!);

const sales = table({
  month: ["Jan", "Jan", "Feb", "Feb"],
  v: [3, 5, 4, 6],
  region: ["N", "S", "N", "S"],
});
const zones = table({ zone: ["North", "South", "East"], gain: [12, 7, 9] });
const wide = table({ zone: ["North", "South", "East"], a: [12, 7, 9], b: [3, 4, 5] });

describe("bar placement", () => {
  it("place series side by side by default, and overlap them with dodge: false", () => {
    const grouped = rects(
      build({ marks: [bar(sales, { x: "month", y: "v", series: "region" })] }).scene,
    );
    const overlapping = rects(
      build({ marks: [bar(sales, { x: "month", y: "v", series: "region", dodge: false })] }).scene,
    );
    // Grouped bars share the band; overlapping ones take it whole.
    expect(widthsOf(overlapping[0]!)[0]).toBeGreaterThan(2 * widthsOf(grouped[0]!)[0]!);
    expect(overlapping[0]!.rects[0]).toBe(overlapping[1]!.rects[0]);
    expect(grouped[0]!.rects[0]).toBeLessThan(grouped[1]!.rects[0]!);
    // Wide data's fields are series too; stacks pile them in one slot.
    const fields = table({ month: ["Jan", "Feb"], a: [1, 2], b: [3, 4] });
    const wide = rects(build({ marks: [bar(fields, { x: "month", y: ["a", "b"] })] }).scene);
    expect(wide[0]!.rects[0]).toBeLessThan(wide[1]!.rects[0]!);
    const stacked = rects(
      build({ marks: [bar(fields, { x: "month", y: ["a", "b"], stack: true })] }).scene,
    );
    expect(stacked[0]!.rects[0]).toBe(stacked[1]!.rects[0]);
  });

  it("share a legend group's slots with other marks as one series, colored by a field or not", () => {
    // The group places marks side by side; a field's colors place nothing.
    const days = table({ day: ["a", "b"], v: [1, 2], w: [2, 3], site: ["x", "y"] });
    const grouped = rects(
      build({
        marks: [
          bar(days, { x: "day", y: "v", color: "site", label: "A", legendGroup: "g" }),
          bar(days, { x: "day", y: "w", label: "B", legendGroup: "g" }),
        ],
      }).scene,
    );
    const [alone] = rects(build({ marks: [bar(days, { x: "day", y: "v" })] }).scene);
    for (const g of grouped) expect(widthsOf(g)[0]).toBeLessThan(widthsOf(alone!)[0]! / 1.5);
  });

  it("refuses dodge with stack", () => {
    expect(() =>
      bar(sales, { x: "month", y: "v", series: "region", dodge: true, stack: true }),
    ).toThrow("bar dodge: stacked bars pile up in one slot; drop dodge or stack");
  });

  it("refuse a label style that is not a text style, pointing number formats to format", () => {
    expect(() => bar(sales, { x: "month", y: "v", labels: { style: "percent" as never } })).toThrow(
      'bar labels.style: expected a text style such as { fontSize: 12 }; received "percent"; number formats go in labels.format',
    );
  });

  it("gives each bar the whole band when the series field is the band field", () => {
    const [one] = rects(
      build({ marks: [bar(zones, { x: "zone", y: "gain", series: "zone" })] }).scene,
    );
    const [whole] = rects(build({ marks: [bar(zones, { x: "zone", y: "gain" })] }).scene);
    expect(widthsOf(one!)[0]).toBeCloseTo(widthsOf(whole!)[0]!, 6);
  });
});

describe("bar colors", () => {
  it("color each bar by a field through the color scale, without placing bars apart", () => {
    const { scene } = build({
      scales: { color: { type: "ordinal", map: { South: "#00ab41" } } },
      marks: [bar(zones, { x: "zone", y: "gain", color: "zone" })],
    });
    const drawn = rects(scene);
    expect(drawn.map((g) => [g.fill, g.count])).toEqual([
      [LIGHT.palette[0], 1],
      ["#00ab41", 1],
      [LIGHT.palette[2], 1],
    ]);
    const [whole] = rects(build({ marks: [bar(zones, { x: "zone", y: "gain" })] }).scene);
    expect(widthsOf(drawn[0]!)[0]).toBeCloseTo(widthsOf(whole!)[0]!, 6);
    // Rows of one position colored apart still take the whole band: color makes no series.
    const colored = rects(
      build({ marks: [bar(sales, { x: "month", y: "v", color: "region" })] }).scene,
    );
    const [band] = rects(build({ marks: [bar(sales, { x: "month", y: "v" })] }).scene);
    expect(colored.map((g) => widthsOf(g)[0])).toEqual(colored.map(() => widthsOf(band!)[0]));
  });

  it("list the colors a field gives them in a key, and their series in a neutral color", () => {
    const sales = table({
      month: ["Jan", "Jan", "Feb", "Feb"],
      v: [1, 2, 3, 4],
      good: ["yes", "no", "no", "yes"],
      region: ["a", "b", "a", "b"],
    });
    const { scene } = build({
      scales: { color: { type: "ordinal", map: { no: "#c00000" } } },
      marks: [bar(sales, { x: "month", y: "v", series: "region", color: "good" })],
    });
    const [key] = keysOf(scene);
    expect(key!.title.text).toBe("good");
    expect(key!.entries.map((e) => [e.label.text, e.fill])).toEqual([
      ["yes", LIGHT.palette[0]],
      ["no", "#c00000"],
    ]);
    expect(legendOf(scene).map((item) => [item.label, item.color])).toEqual([
      ["a", LIGHT.muted],
      ["b", LIGHT.muted],
    ]);
  });

  it("let a flat fill win over the color channel, and color series by their values", () => {
    const filled = rects(
      build({ marks: [bar(zones, { x: "zone", y: "gain", color: "zone", fill: "#123456" })] })
        .scene,
    );
    expect(filled.map((g) => g.fill)).toEqual(["#123456"]);
    const bySeries = rects(
      build({
        scales: { color: { type: "ordinal", map: { S: "#00ab41" } } },
        marks: [bar(sales, { x: "month", y: "v", series: "region", color: "region" })],
      }).scene,
    );
    expect(bySeries.map((g) => g.fill)).toEqual([LIGHT.palette[0], "#00ab41"]);
  });

  it("take opacity per row from a condition, and looks by a field's value", () => {
    const flagged = table({ zone: ["a", "b", "c"], gain: [1, 2, 3], provisional: [1, 0, 1] });
    const { scene } = build({
      marks: [
        bar(flagged, {
          x: "zone",
          y: "gain",
          encode: {
            // biome-ignore lint/suspicious/noThenProperty: a condition's branch, as specs name it.
            opacity: { condition: { when: col("provisional").eq(1), then: 0.45, otherwise: 1 } },
          },
          style: { by: { field: "zone", map: { c: { stroke: "#222222", strokeWidth: 2 } } } },
        }),
      ],
    });
    expect(rects(scene).map((g) => [g.fillOpacity, g.count, g.edge?.stroke])).toEqual([
      [0.45, 1, undefined],
      [1, 1, undefined],
      [0.45, 1, "#222222"],
    ]);
  });
});

describe("bar edges", () => {
  it("take constant channels and channels of their series field without looks per row", () => {
    const [bars] = rects(
      build({
        marks: [
          bar(zones, {
            x: "zone",
            y: "gain",
            encode: {
              stroke: { value: "#111111" },
              strokeWidth: { value: 2 },
              opacity: { value: 0.5 },
            },
          }),
        ],
      }).scene,
    );
    expect(bars!.edge).toMatchObject({ stroke: "#111111", width: 2, opacity: 0.5 });
    expect(bars!.fillOpacity).toBe(0.5);
  });

  it("share one look between values that paint alike, and fade outlines with their looks", () => {
    const many = table({
      zone: Array.from({ length: 50 }, (_, i) => `z${i}`),
      gain: Array.from({ length: 50 }, (_, i) => i + 1),
      kind: Array.from({ length: 50 }, (_, i) => `k${i}`),
    });
    const drawn = rects(
      build({
        marks: [
          bar(many, {
            x: "zone",
            y: "gain",
            stroke: "#000000",
            encode: {
              // biome-ignore lint/suspicious/noThenProperty: a condition's branch, as specs name it.
              opacity: { condition: { when: col("gain").gt(25), then: 1, otherwise: 0.2 } },
            },
            style: { by: { field: "kind", map: { k3: { dash: "--" } } } },
          }),
        ],
      }).scene,
    );
    // Faded, plain, and dashed: three looks, not one per kind.
    expect(drawn).toHaveLength(3);
    const faded = drawn.find((g) => g.fillOpacity === 0.2)!;
    expect(faded.edge!.opacity).toBe(0.2);
    expect(drawn.some((g) => g.edge!.dash?.length)).toBe(true);
    expect(drawn.reduce((sum, g) => sum + g.count, 0)).toBe(50);
  });

  it("draw rows alike once, where their series' own look makes their looks one", () => {
    const { scene } = build({
      legend: { swatches: "mark" },
      marks: [
        bar(wide, {
          x: "zone",
          y: ["a", "b"],
          encode: {
            // biome-ignore lint/suspicious/noThenProperty: a condition's branch, as specs name it.
            opacity: { condition: { when: col("a").gt(8), then: 1, otherwise: 0.2 } },
          },
          style: { by: { map: { a: { opacity: 0.5 } } } },
        }),
      ],
    });
    // Series a's rows all take its opacity: one look, drawn once, shown in its legend entry.
    const a = rects(scene).filter((g) => g.fill === LIGHT.palette[0]);
    expect(a.map((g) => [g.count, g.fillOpacity])).toEqual([[3, 0.5]]);
    const [entry] = legendOf(scene);
    expect(entry!.sample!.items[0]).toMatchObject({ opacity: 0.5 });
  });

  it("show flat outlined, translucent bars as they look in legends", () => {
    const { scene } = build({
      legend: { swatches: "mark" },
      marks: [bar(wide, { x: "zone", y: ["a", "b"], stroke: "#000000", opacity: 0.5 })],
    });
    expect(legendOf(scene)[0]!.sample!.items[0]).toMatchObject({
      type: "shape",
      stroke: "#000000",
      opacity: 0.5,
    });
    // Outlines alone, unfilled: their outline shows.
    const hollow = build({
      legend: { swatches: "mark" },
      marks: [bar(wide, { x: "zone", y: ["a", "b"], stroke: "#000000", fillOpacity: 0 })],
    });
    const [box] = legendOf(hollow.scene)[0]!.sample!.items;
    expect(box).toMatchObject({ type: "shape", fillOpacity: 0 });
    expect(box).not.toHaveProperty("opacity");
  });

  it("outline bars in their stroke, 1 pixel wide by default", () => {
    const [g] = rects(
      build({ marks: [bar(zones, { x: "zone", y: "gain", stroke: "#222222" })] }).scene,
    );
    expect(g!.edge).toEqual({ stroke: "#222222", width: 1, opacity: 1, dash: undefined });
    const svg = renderToSVG({
      width: 300,
      height: 200,
      marks: [bar(zones, { x: "zone", y: "gain", stroke: "#222222", strokeWidth: 1.5 })],
    });
    expect(svg).toMatch(
      /<path d="[^"]*" fill="#3266d6" fill-opacity="1" stroke="#222222" stroke-width="1.5"\/>/,
    );
  });

  it("outline bars in the background's color with only a width", () => {
    const [g] = rects(
      build({ marks: [bar(zones, { x: "zone", y: "gain", strokeWidth: 2 })] }).scene,
    );
    expect(g!.edge?.stroke).toBe(LIGHT.background);
  });
});

describe("bar value labels", () => {
  const big = table({ zone: ["a", "b", "c"], gain: [80, 60, 2] });

  it("are white inside mid-tone bars and black inside light ones", () => {
    const backdrop = "#ffffff";
    for (const color of [...LIGHT.palette, ...DARK.palette])
      expect(contrastingText(color, 1, backdrop), color).toBe("#ffffff");
    for (const color of ["#e8c547", "#ffcc00", "#4fd18b", "#ffffff"])
      expect(contrastingText(color, 1, backdrop), color).toBe("#000000");
  });

  it("take their own color inside bars and out, and leave out bars shorter than minLength", () => {
    const { scene } = build({
      marks: [
        bar(big, {
          x: "zone",
          y: "gain",
          stack: true,
          labels: { style: { color: "white" }, minLength: 24 },
        }),
      ],
    });
    const [labels] = texts(scene);
    expect(labels!.fill).toBe("white");
    expect(labels!.labels).toEqual(["80", "60"]);
  });

  it("fit and make room for labels in boxes by their boxes' height", () => {
    const boxed = (lineHeight: number, outside: boolean) =>
      build({
        marks: [
          bar(big, {
            x: "zone",
            y: "gain",
            labels: {
              place: { outside },
              style: { background: { fill: "#ffffff" }, padding: 2, lineHeight },
            },
          }),
        ],
      });
    const shown = (scene: Scene) =>
      labelItems(scene).flatMap((g) => g.items.map((item) => item.text));
    // Inside: boxes 19 pixels tall fit the tall bars; 304 fit none.
    expect(shown(boxed(1.25, false).scene)).toEqual(["80", "60"]);
    expect(shown(boxed(25, false).scene)).toEqual([]);
    // Outside: the y axis leaves room for a box above the tallest bar.
    const { model, scene } = boxed(3, true);
    const y = model.yScale()!;
    const plot = scene.panels[0]!.plot;
    expect(y.map(80) - plot.y).toBeGreaterThanOrEqual(3 * 12 + 4);
  });

  it("go inside bars where their place says, white on blue, taking no room past the ends", () => {
    const placed = (attachment: "start" | "center" | "end") => {
      const { scene, model } = build({
        marks: [
          bar(big, {
            x: "zone",
            y: "gain",
            fill: "#3266d6",
            labels: { place: { attachment, outside: false } },
          }),
        ],
      });
      const [labels] = texts(scene);
      return { labels: labels!, y: model.yScale()! };
    };
    const end = placed("end");
    expect(end.labels.fill).toBe("#ffffff");
    // Two labels fit inside their bars; the bar of 2 is too short for one.
    expect(end.labels.labels).toEqual(["80", "60"]);
    // No headroom: the domain ends at the data's nice end.
    expect(end.y.domain[1]).toBe(80);
    const tip = end.y.map(80);
    expect(end.labels.coords[1]).toBeGreaterThan(tip);
    expect(end.labels.coords[1]).toBeLessThan(tip + 20);
    const center = placed("center").labels.coords[1]!;
    expect(center).toBeCloseTo((end.y.map(0) + tip) / 2, 0);
    const start = placed("start").labels.coords[1]!;
    expect(start).toBeLessThan(end.y.map(0));
    expect(start).toBeGreaterThan(end.y.map(0) - 20);
  });

  it("refuse to go outside stacked bars", () => {
    expect(() =>
      bar(big, { x: "zone", y: "gain", stack: true, labels: { place: { outside: true } } }),
    ).toThrow(
      "bar labels.place.outside: stacked bars' labels go inside their segments; drop outside",
    );
  });

  it("write values in a pattern, or a field's values", () => {
    const patterned = texts(
      build({ marks: [bar(big, { x: "zone", y: "gain", labels: { format: { number: ".1f" } } })] })
        .scene,
    );
    expect(patterned.flatMap((t) => t.labels)).toEqual(["80.0", "60.0", "2.0"]);
    const named = texts(
      build({ marks: [bar(big, { x: "zone", y: "gain", labels: { field: "zone" } })] }).scene,
    );
    expect(named.flatMap((t) => t.labels)).toEqual(["a", "b", "c"]);
  });

  it("draw in a style of their own as positioned text", () => {
    const { scene } = build({
      marks: [
        bar(big, { x: "zone", y: "gain", labels: { style: { fontSize: 16, fontWeight: 700 } } }),
      ],
    });
    expect(texts(scene)).toHaveLength(0);
    const items = labelItems(scene).flatMap((g) => g.items);
    expect(items.map((item) => [item.text, item.paint.size, item.paint.weight])).toEqual([
      ["80", 16, 700],
      ["60", 16, 700],
      ["2", 16, 700],
    ]);
    const svg = renderToSVG({
      width: 300,
      height: 200,
      marks: [
        bar(big, { x: "zone", y: "gain", labels: { style: { fontSize: 16, fontWeight: 700 } } }),
      ],
    });
    expect(svg).toMatch(/font-size="16" font-weight="700"[^>]*>80</);
  });
});
