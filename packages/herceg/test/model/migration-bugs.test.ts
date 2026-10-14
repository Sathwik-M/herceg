import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { areaPath } from "../../src/draw/area.ts";
import { labelHalo } from "../../src/draw/text.ts";
import { timeTickLabels } from "../../src/format/format.ts";
import { estimateText } from "../../src/layout/text.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { graph } from "../../src/marks/graph.ts";
import { line } from "../../src/marks/line.ts";
import { radar } from "../../src/marks/radar.ts";
import { region } from "../../src/marks/region.ts";
import { sankey } from "../../src/marks/sankey.ts";
import { text } from "../../src/marks/text.ts";
import { planAxis, valueFormatter } from "../../src/model/axis.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { rangeNavigator } from "../../src/model/navigator.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import { TimeScale } from "../../src/scale/time.ts";
import type { AreaGeometry, LineGeometry, TextGeometry } from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import { LIGHT } from "../../src/theme.ts";

function build(config: ChartConfig, width = 600) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, 300, 1);
  return { model, scene: model.scene(estimateText) };
}

const data = table({ category: ["A", "B", "C"], value: [10, 20, 30] });
const flows = table({ source: ["A", "B"], target: ["B", "C"], value: [10, 5] });

/** A label's default halo over `theme`'s background: its color and opacity. */
function textHalo(fill: string, theme: typeof LIGHT) {
  const { color, opacity, width } = labelHalo(undefined, fill, { theme })!;
  expect(width).toBe(3);
  return { color, opacity };
}

describe("text halos", () => {
  it.each(["#e06600", "#949494", "rgb(224 102 0)", "hsl(27.3 100% 43.9%)", "red"])(
    "uses the white surface for %s at 3:1 contrast, even when black text would contrast more",
    (fill) => expect(textHalo(fill, LIGHT)).toEqual({ color: LIGHT.background, opacity: 1 }),
  );
  it("falls back below 3:1, with transparency, or with an unresolved color", () => {
    for (const fill of ["#959595", "#F88C3B", "rgba(224,102,0,0.2)"])
      expect(textHalo(fill, LIGHT)).toEqual({ color: "#000000", opacity: 0.85 });
    expect(textHalo("var(--ink)", LIGHT)).toEqual({ color: "#ffffff", opacity: 0.85 });
    expect(textHalo("#000", { ...LIGHT, background: "transparent" }).opacity).toBe(0.85);
    expect(textHalo("#888", { ...LIGHT, background: "#111111" })).toEqual({
      color: "#111111",
      opacity: 1,
    });
    expect(textHalo("red", { ...LIGHT, background: "white" })).toEqual({
      color: "white",
      opacity: 1,
    });
  });
  it.each([
    ["text", () => text({ x: 1, y: 1, label: "note", halo: false })],
    ["region", () => region({ x1: 0, x2: 2, label: "note", halo: false })],
    ["bar", () => bar(data, { x: "category", y: "value", labels: true, halo: false })],
    ["funnel", () => funnel(data, { category: "category", value: "value", halo: false })],
    ["radar", () => radar(data, { category: "category", value: "value", halo: false })],
    [
      "sankey",
      () => sankey(flows, { source: "source", target: "target", value: "value", halo: false }),
    ],
    [
      "graph",
      () =>
        graph(flows, { source: "source", target: "target", linkLabelField: "source", halo: false }),
    ],
  ] as const)("accepts halo:false on %s helpers and portable specs", (_, make) => {
    const mark = make();
    const spec = {
      marks: [{ ...mark.spec, data: "d" }],
      data: {
        d: {
          columns:
            mark.spec.type === "sankey" || mark.spec.type === "graph"
              ? { source: ["A", "B"], target: ["B", "C"], value: [10, 5] }
              : { category: ["A", "B", "C"], value: [10, 20, 30] },
        },
      },
    };
    for (const config of [{ marks: [mark] }, loadSpec(spec).config]) {
      const { scene } = build(config);
      const labels = scene.panels
        .flatMap((p) => p.marks)
        .filter((g): g is TextGeometry => g.kind === "text");
      expect(labels.length).toBeGreaterThan(0);
      expect(labels.every((g) => !g.halo)).toBe(true);
      expect(renderToSVG({ ...config, width: 600, height: 300 })).not.toContain(
        'paint-order="stroke"',
      );
    }
  });
  it("lets the navigator turn off label halos and serialize the option", () => {
    const navigator = rangeNavigator({ halo: false });
    expect(navigator.toJSON()).toEqual({ halo: false });
    const { scene } = build({
      marks: [line(table({ x: [0, 10], y: [0, 1] }), { x: "x", y: "y" })],
      navigator,
    });
    const labels = scene.panels
      .flatMap((p) => p.marks)
      .filter((g): g is TextGeometry => g.kind === "text");
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((g) => !g.halo)).toBe(true);
  });
});

describe("time tick labels", () => {
  it.each([
    [
      "dates over hours",
      "2026-09-29",
      "2026-10-06",
      14,
      { month: "short", day: "numeric" },
      ["Sep 29", "Sep 30", "Oct 1", "Oct 2", "Oct 3", "Oct 4", "Oct 5", "Oct 6"],
    ],
    [
      "months over days",
      "2026-01-01",
      "2026-04-01",
      45,
      { month: "short" },
      ["Jan", "Feb", "Mar", "Apr"],
    ],
    [
      "years over months",
      "2024-01-01",
      "2027-01-01",
      36,
      { year: "numeric" },
      ["2024", "2025", "2026", "2027"],
    ],
  ] as const)(
    "chooses distinguishable boundaries for %s",
    (_, start, stop, count, format, expected) => {
      const planned = planAxis(
        { type: "time", spec: { format }, zone: "UTC", locale: "en-US" },
        [Date.parse(start), Date.parse(stop)],
        [0, 1200],
        count,
      );
      expect(planned.labels).toEqual(expected);
      expect(planned.labels).toHaveLength(planned.ticks.length);
    },
  );
  it("drops nonadjacent duplicates, including narrow month initials and repeated DST hours", () => {
    for (const [format, domain, zone] of [
      [{ month: "narrow" }, [Date.UTC(2026, 0, 1), Date.UTC(2027, 0, 1)], "UTC"],
      [
        { hour: "numeric" },
        [Date.UTC(2026, 10, 1, 4), Date.UTC(2026, 10, 1, 9)],
        "America/New_York",
      ],
    ] as const) {
      const { ticks, labels } = planAxis(
        { type: "time", spec: { format }, zone, locale: "en-US" },
        domain,
        [0, 600],
        12,
      );
      expect(new Set(labels).size).toBe(labels.length);
      expect(ticks.length).toBe(labels.length);
      expect(ticks.length).toBeGreaterThan(0);
    }
  });
  it("keeps distinguishable defaults and uses tooltipFormat only for values", () => {
    const domain = [Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 2)] as const;
    const scale = new TimeScale(domain, [0, 600], "UTC");
    const context = {
      type: "time",
      spec: { tooltipFormat: { year: "numeric" } },
      zone: "UTC",
      locale: "en-US",
    } as const;
    const planned = planAxis(context, domain, [0, 600], 4);
    expect(planned.ticks).toEqual(scale.ticks(4));
    expect(planned.labels).toEqual(
      timeTickLabels(scale.ticks(4), scale.interval(4), "UTC", "en-US"),
    );
    expect(valueFormatter(context, String)(domain[0])).toBe("2026");
  });
  it("keeps a tick inside a month without a month boundary, including broken axes", () => {
    const domain = [Date.UTC(2026, 0, 4), Date.UTC(2026, 0, 24)] as const;
    const breaks = timeBreaks([{ weekdays: ["sat", "sun"] }]).calendar("UTC");
    for (const calendar of [undefined, breaks]) {
      const planned = planAxis(
        {
          type: "time",
          spec: { format: { month: "short" } },
          zone: "UTC",
          locale: "en-US",
          breaks: calendar,
        },
        domain,
        [0, 600],
        30,
      );
      expect(planned.labels).toEqual(["Jan"]);
    }
  });
});

describe("isolated line and area rows", () => {
  it.each(["linear", "step", "step-before", "step-after", "monotone"] as const)(
    "paints isolated %s runs after tracing and LOD, in either orientation",
    (curve) => {
      for (const orient of ["x", "y"] as const)
        for (const dense of [false, true]) {
          const n = dense ? 10000 : 5;
          const values = Float64Array.from({ length: n }, (_, i) =>
            i < 5 ? [1, NaN, 3, NaN, 5][i]! : 1 + Math.sin(i),
          );
          const input = table({
            position: Float64Array.from({ length: n }, (_, i) => i),
            value: values,
            lower: Float64Array.from(values, (v) => v - 1),
          });
          const fields =
            orient === "x"
              ? ({ x: "position", y: "value", orient } as const)
              : ({ y: "position", x: "value", orient } as const);
          for (const mark of [
            line(input, { ...fields, curve, strokeWidth: 4 }),
            area(input, { ...fields, curve, strokeWidth: 4 }),
            area(input, { ...fields, curve, strokeWidth: 4, line: false }),
            orient === "x"
              ? area(input, { x: "position", y1: "lower", y2: "value", curve, strokeWidth: 4 })
              : area(input, {
                  y: "position",
                  x1: "lower",
                  x2: "value",
                  orient,
                  curve,
                  strokeWidth: 4,
                }),
          ]) {
            const { scene } = build({ marks: [mark] }, dense ? 160 : 600);
            const g = scene.panels[0]!.marks[0] as LineGeometry | AreaGeometry;
            const svg =
              g.kind === "line"
                ? g.draw.svg(g, { theme: scene.theme, encodeRaster: undefined })
                : g.draw.svg(g, { theme: scene.theme, encodeRaster: undefined });
            if (!dense && g.kind === "area") expect(areaPath(g)).toBe("");
            const path = g.kind === "line" ? g.path : g.upper;
            const x = Math.round(path.coords[0]! * 10) / 10;
            const y = Math.round(path.coords[1]! * 10) / 10;
            expect(svg).toContain(`M${x} ${y}L${x} ${y}`);
            expect(svg).toContain('stroke-linecap="round"');
            expect(svg).toContain('stroke-width="4"');
            if (dense) expect(path.count).toBeLessThan(n);
          }
        }
    },
  );
});
