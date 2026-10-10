import { describe, expect, it } from "vitest";
import { category, encodedCategory } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import type { Polyline } from "../../src/lod/polyline.ts";
import { violin } from "../../src/marks/violin.ts";
import { describeChart } from "../../src/model/describe.ts";
import { facet } from "../../src/model/facet.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type {
  AreaGeometry,
  LineGeometry,
  PointGeometry,
  RectGeometry,
  SegmentGeometry,
} from "../../src/scene/scene.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec, ViolinSpec } from "../../src/spec/spec.ts";
import { validateSpec } from "../../src/spec/validate.ts";
import legacyViolins from "./fixtures/violin-legacy.json";

const data = () =>
  table({
    g: ["a", "a", "a", "a", "b", "b", "b", "b"],
    s: ["first", "first", "second", "second", "first", "first", "second", "second"],
    v: [1, 3, 2, 4, 5, 7, 6, 8],
  });
function build(config: ChartConfig, width = 600) {
  const model = new ChartModel({ locale: "en-US", ...config });
  model.setSize(width, 300, 1);
  return { model, scene: model.scene(estimateText) };
}
function extent(path: Polyline, axis: number, run = 0) {
  const coords = Array.from(
    { length: path.runEnd(run) - path.starts[run]! },
    (_, i) => path.coords[(path.starts[run]! + i) * 2 + axis]!,
  );
  return [Math.min(...coords), Math.max(...coords)] as const;
}

describe("violin options", () => {
  // Full SVGs captured from the HEAD revision recorded in the fixture, before these options.
  it.each(legacyViolins.cases)(
    "preserves legacy SVG for $name (horizontal $horizontal)",
    (legacy) => {
      const axes = legacy.horizontal
        ? ({ x: "v", y: "g" } as const)
        : ({ x: "g", y: "v" } as const);
      const samples = table({
        g: category(legacy.columns.g),
        s: category(legacy.columns.s),
        v: legacy.columns.v,
      });
      for (const defaults of [{}, { split: false, inner: "box" }] as const) {
        const svg = renderToSVG({
          width: 600,
          height: 300,
          locale: "en-US",
          timeZone: "UTC",
          marks: [
            violin(samples, {
              ...axes,
              ...defaults,
              ...(legacy.series ? { series: "s" as const } : {}),
              ...(legacy.bandwidth === undefined ? {} : { bandwidth: legacy.bandwidth }),
            }),
          ],
          ...(legacy.log ? { [legacy.horizontal ? "x" : "y"]: { type: "log", nice: false } } : {}),
        }).replace(/herceg-svg-\d+/g, "herceg-svg");
        // These fixtures compare the drawing; generated descriptions are tested separately.
        expect(svg.replace(/ aria-labelledby="[^"]*"|<desc[^>]*>[\s\S]*?<\/desc>/g, "")).toBe(
          legacy.svg,
        );
      }
    },
  );

  it.each([false, true])(
    "draws positive quartiles below the first log density sample (horizontal %s)",
    (horizontal) => {
      for (const split of [false, true]) {
        const values = [0.001, 0.002, 0.003, 1, 100];
        const samples = table({
          g: values.concat(values).map(() => "a"),
          s: values.map(() => "first").concat(values.map(() => "second")),
          v: values.concat(values),
        });
        const { model, scene } = build({
          marks: [
            violin(samples, {
              ...(horizontal ? ({ x: "v", y: "g" } as const) : ({ x: "g", y: "v" } as const)),
              series: "s",
              split,
              inner: "quartiles",
            }),
          ],
          [horizontal ? "x" : "y"]: { type: "log", nice: false },
        });
        const marks = scene.panels[0]!.marks;
        const across = horizontal ? model.xScale()! : model.yScale()!;
        const axis = horizontal ? 0 : 1;
        const lines = marks.filter((m) => m.key.endsWith("|quartiles")) as LineGeometry[];
        const medians = marks.filter((m) => m.key.endsWith("|median-line")) as LineGeometry[];
        expect(lines.map((line) => line.path.starts.length)).toEqual([2, 2]);
        expect(medians.map((line) => line.path.starts.length)).toEqual([1, 1]);
        for (const line of [...lines, ...medians]) {
          const outline = marks.find(
            (m) => m.key === line.key.replace(/\|(quartiles|median-line)$/, "|outline"),
          ) as LineGeometry;
          for (let run = 0; run < line.path.starts.length; run++) {
            const start = line.path.starts[run]!;
            const statistic = line.dash ? [0.002, 1][run]! : 0.003;
            expect(line.path.coords[start * 2 + axis]).toBeCloseTo(across.map(statistic), 4);
            expect(line.path.coords[start * 2 + 1 - axis]).not.toBe(
              line.path.coords[(start + 1) * 2 + 1 - axis],
            );
            for (let k = start; k < line.path.runEnd(run); k++) {
              const px = line.path.coords[k * 2]!;
              const py = line.path.coords[k * 2 + 1]!;
              expect(
                Array.from({ length: outline.path.count }, (_, i) => i).some(
                  (i) =>
                    Math.abs(outline.path.coords[i * 2]! - px) < 0.001 &&
                    Math.abs(outline.path.coords[i * 2 + 1]! - py) < 0.001,
                ),
              ).toBe(true);
            }
          }
        }
      }
    },
  );

  it.each([false, true])(
    "keeps inserted statistic widths finite for tiny values (horizontal %s)",
    (horizontal) => {
      const { scene } = build({
        marks: [
          violin(table({ g: ["a", "a", "a"], v: [1e-308, 2e-308, 3e-308] }), {
            ...(horizontal ? ({ x: "v", y: "g" } as const) : ({ x: "g", y: "v" } as const)),
            bandwidth: 1e-308,
            inner: "quartiles",
          }),
        ],
        [horizontal ? "x" : "y"]: { type: "log" },
      });
      for (const mark of scene.panels[0]!.marks) {
        const path =
          mark.kind === "area" ? (mark as AreaGeometry).upper : (mark as LineGeometry).path;
        expect(Array.from(path.coords.subarray(0, path.count * 2)).every(Number.isFinite)).toBe(
          true,
        );
        if (mark.key.endsWith("|quartiles")) expect(path.count).toBe(4);
        if (mark.key.endsWith("|median-line")) expect(path.count).toBe(2);
      }
    },
  );

  it.each([false, true])(
    "excludes failed densities with no inner marks from extents and inspection (horizontal %s)",
    (horizontal) => {
      const axes = horizontal ? ({ x: "v", y: "g" } as const) : ({ x: "g", y: "v" } as const);
      const small = table({ g: ["a", "a"], v: [1, 2] });
      const huge = table({ g: ["b", "b"], v: [1000, 2000] });
      const config = { [horizontal ? "x" : "y"]: { nice: false } };
      const visible = () => violin(small, { ...axes, inner: "none", label: "visible" });
      const reference = build({ ...config, marks: [visible()] });
      const invisible = (samples: typeof small) =>
        violin(samples, { ...axes, bandwidth: 1e308, inner: "none", label: "invisible" });
      const distant = build({ ...config, marks: [visible(), invisible(huge)] });
      const valueScale = (model: ChartModel) => (horizontal ? model.xScale()! : model.yScale()!);
      expect(valueScale(distant.model).domain).toEqual(valueScale(reference.model).domain);
      const { model, scene } = build({ ...config, marks: [visible(), invisible(small)] });
      const panel = model.panels()[0]!;
      const along = horizontal ? panel.y : panel.x;
      const across = horizontal ? panel.x : panel.y;
      const pixel = horizontal ? [across.map(1.5), along.map(0)] : [along.map(0), across.map(1.5)];
      for (const mode of ["nearest", horizontal ? "nearest-y" : "nearest-x"] as const)
        expect(model.inspect(pixel[0]!, pixel[1]!, mode)!.points.map((p) => p.label)).toEqual([
          "visible",
        ]);
      expect(model.keyboardStops(panel.key).map((s) => s.label)).toEqual(["visible"]);
      const undrawn = model.panelSeries(panel.key).find((s) => s.label === "invisible")!;
      expect(model.inspectPosition(undrawn.key, 0)).toBeUndefined();
      const onlyInvisible = build({ marks: [invisible(small)] });
      expect(onlyInvisible.model.keyboardStops("")).toEqual([]);
      expect(
        onlyInvisible.model.inspectPosition(onlyInvisible.model.panelSeries("")[0]!.key, 0),
      ).toBeUndefined();
      expect(scene.panels[0]!.marks.some((m) => m.key.startsWith(`${undrawn.key}|`))).toBe(false);
      for (const inner of [undefined, "box", "quartiles"] as const) {
        const fallback = build({
          marks: [violin(small, { ...axes, bandwidth: 1e308, ...(inner ? { inner } : {}) })],
        });
        const stop = fallback.model.keyboardStops("")[0]!;
        expect(fallback.model.inspectPosition(stop.key, 0)!.points[0]!.value).toBe(1.5);
        if (inner === "quartiles") {
          expect(
            (
              fallback.scene.panels[0]!.marks.find((m) =>
                m.key.endsWith("|median-line"),
              ) as LineGeometry
            ).path.count,
          ).toBe(2);
        } else {
          expect(
            (fallback.scene.panels[0]!.marks.find((m) => m.kind === "rect") as RectGeometry).count,
          ).toBe(1);
        }
      }
      // A constant group remains visible even alongside an undrawn group of the same mark.
      const mixed = build({
        marks: [
          violin(
            table({
              g: ["a", "a", "b", "b"],
              s: ["first", "first", "second", "second"],
              v: [2, 2, 1000, 2000],
            }),
            {
              ...axes,
              series: "s",
              split: true,
              bandwidth: 1e308,
              inner: "none",
            },
          ),
        ],
      });
      expect(mixed.model.keyboardStops("").map((s) => s.label)).toEqual(["first"]);
      expect(valueScale(mixed.model).domain[1]).toBeLessThan(1000);
      expect(
        (mixed.scene.panels[0]!.marks.find((m) => m.kind === "segments") as SegmentGeometry).count,
      ).toBe(1);
      expect(
        mixed.model.inspectPosition(mixed.model.keyboardStops("")[0]!.key, 0)!.points[0]!.value,
      ).toBe(2);
      for (const faceted of [false, true]) {
        const samples = table({
          p: ["P", "P", "P", "P", "P", "P"],
          g: ["a", "a", "b", "b", "c", "c"],
          v: [2, 2, 1000, 2000, 3, 3],
        });
        const result = build({
          marks: [violin(samples, { ...axes, bandwidth: 1e308, inner: "none" })],
          ...(faceted ? { facet: facet("p") } : {}),
        });
        const panelKey = faceted ? "P" : "";
        const stop = result.model.keyboardStops(panelKey)[0]!;
        expect(stop.length).toBe(2);
        expect(Array.from(stop.rows!)).toEqual([0, 2]);
        expect(
          [0, 1].map((k) => result.model.inspectPosition(stop.key, k, panelKey)!.points[0]!.value),
        ).toEqual([2, 3]);
        expect(
          [0, 1].map((k) => result.model.inspectPosition(stop.key, k, panelKey)!.label),
        ).toEqual(["a", "c"]);
      }
    },
  );

  it.each([false, true])(
    "anchors pointer and keyboard inspection at each split half's median (horizontal %s)",
    (horizontal) => {
      for (const inner of ["box", "quartiles", "none"] as const) {
        const samples = table({
          g: ["a", "a", "a", "a"],
          s: ["first", "first", "second", "second"],
          v: [1, 3, 1, 3],
        });
        for (const right of horizontal ? [false] : [false, true]) {
          const { model, scene } = build({
            marks: [
              violin(samples, {
                ...(horizontal
                  ? ({ x: "v", y: "g" } as const)
                  : ({ x: "g", y: "v", axis: right ? "right" : "left" } as const)),
                series: "s",
                split: true,
                inner,
              }),
            ],
          });
          const panel = model.panels()[0]!;
          const along = horizontal ? panel.y : panel.x;
          const across = horizontal ? panel.x : right ? panel.yRight! : panel.y;
          const center = along.map(0);
          const dots = scene.panels[0]!.marks.filter((m) => m.kind === "point") as PointGeometry[];
          for (const [i, label] of [
            [0, "first"],
            [1, "second"],
          ] as const) {
            const side = (i === 0 ? -1 : 1) * (horizontal ? -1 : 1);
            const inside = center + side * along.bandwidth! * 0.2;
            const pixel = horizontal ? [across.map(2), inside] : [inside, across.map(2)];
            const pointer = model.inspect(pixel[0]!, pixel[1]!, "nearest")!;
            expect(pointer.points.map((p) => p.label)).toEqual([label]);
            const keyboard = model.inspectPosition(model.keyboardStops(panel.key)[i]!.key, 0)!;
            for (const read of [pointer, keyboard]) {
              expect(read).toMatchObject({
                axis: horizontal ? "y" : "x",
                position: center,
                label: "a",
              });
              const point = read.points.find((p) => p.label === label)!;
              expect(point.px).toBeCloseTo(pixel[0]!, 4);
              expect(point.py).toBeCloseTo(pixel[1]!, 4);
              if (inner === "box") {
                expect(point.px).toBeCloseTo(dots[i]!.coords[0]!, 4);
                expect(point.py).toBeCloseTo(dots[i]!.coords[1]!, 4);
              }
            }
          }
        }
      }
    },
  );

  it.each([false, true])(
    "draws equal half widths at the shared center in separate colors (horizontal %s)",
    (horizontal) => {
      const mark = violin(data(), {
        ...(horizontal ? ({ x: "v", y: "g" } as const) : ({ x: "g", y: "v" } as const)),
        series: "s",
        split: true,
      });
      const { model, scene } = build({ marks: [mark] });
      const panel = model.panels()[0]!;
      const along = horizontal ? panel.y : panel.x;
      const axis = horizontal ? 1 : 0;
      const areas = scene.panels[0]!.marks.filter((m) => m.kind === "area") as (AreaGeometry & {
        lower: Polyline;
      })[];
      expect(areas.map((a) => a.fill)).toEqual(scene.legend.map((e) => e.color));
      expect(areas[0]!.fill).not.toBe(areas[1]!.fill);
      areas.forEach((area, i) => {
        const side = (i === 0 ? -1 : 1) * (horizontal ? -1 : 1);
        for (let run = 0; run < 2; run++) {
          const center = along.map(run);
          expect(extent(area.lower, axis, run)[0]).toBeCloseTo(center, 4);
          expect(extent(area.lower, axis, run)[1]).toBeCloseTo(center, 4);
          const [lo, hi] = extent(area.upper, axis, run);
          expect(side < 0 ? center - lo : hi - center).toBeCloseTo(along.bandwidth! * 0.4, 4);
          expect(side < 0 ? hi <= center + 0.001 : lo >= center - 0.001).toBe(true);
        }
      });
      // All parts of the inner box belong to that series' half.
      const boxes = scene.panels[0]!.marks.filter((m) => m.kind === "rect") as RectGeometry[];
      boxes.forEach((box, i) => {
        const side = (i === 0 ? -1 : 1) * (horizontal ? -1 : 1);
        const low = box.rects[axis]!;
        const high = low + box.rects[axis + 2]!;
        expect(side < 0 ? high < along.map(0) : low > along.map(0)).toBe(true);
      });
    },
  );

  it.each([false, true])(
    "keeps a missing or hidden partner's half empty (horizontal %s)",
    (horizontal) => {
      const missing = table({
        g: ["a", "a", "a", "a", "b", "b"],
        s: ["first", "first", "second", "second", "second", "second"],
        v: [1, 3, 2, 4, 5, 7],
      });
      const { model, scene } = build({
        marks: [
          violin(missing, {
            ...(horizontal ? ({ x: "v", y: "g" } as const) : ({ x: "g", y: "v" } as const)),
            series: "s",
            split: true,
            inner: "none",
          }),
        ],
        [horizontal ? "x" : "y"]: { domain: [0, 10], nice: false },
      });
      const along = horizontal ? model.yScale()! : model.xScale()!;
      const axis = horizontal ? 1 : 0;
      const areas = scene.panels[0]!.marks.filter((m) => m.kind === "area") as (AreaGeometry & {
        lower: Polyline;
      })[];
      expect(areas.map((a) => a.upper.starts.length)).toEqual([1, 2]);
      const center = along.map(1);
      const [lo, hi] = extent(areas[1]!.upper, axis, 1);
      expect(horizontal ? hi <= center : lo >= center).toBe(true);
      const before = Array.from(areas[1]!.upper.coords.subarray(0, areas[1]!.upper.count * 2));
      model.hidden.add(model.panelSeries(model.panels()[0]!.key)[0]!.key);
      const remaining = model
        .scene(estimateText)
        .panels[0]!.marks.find((m) => m.kind === "area") as AreaGeometry;
      expect(Array.from(remaining.upper.coords.subarray(0, remaining.upper.count * 2))).toEqual(
        before,
      );
      const across = horizontal ? model.xScale()! : model.yScale()!;
      const offset = along.bandwidth! * 0.1 * (horizontal ? -1 : 1);
      const [px, py] = horizontal
        ? [across.map(6), center + offset]
        : [center + offset, across.map(6)];
      expect(model.inspect(px, py, "nearest")!.points[0]!.label).toBe("second");
    },
  );

  it("rejects missing series, invalid options, and more than two observed values, including after updates", () => {
    expect(() => violin(data(), { x: "g", y: "v", split: true })).toThrow(
      /violin split: needs a series field/,
    );
    expect(() => violin(data(), { x: "g", y: "v", split: "true" as never })).toThrow(
      /violin split: expected true or false; received "true"/,
    );
    expect(() => violin(data(), { x: "g", y: "v", inner: "points" as never })).toThrow(
      /violin inner: expected "box", "quartiles", or "none"; received "points"/,
    );
    const live = table({ g: ["a", "a"], s: ["first", "second"], v: [1, 2] }, { maxRows: 10 });
    const { model } = build({
      marks: [violin(live, { x: "g", y: "v", series: "s", split: true })],
    });
    live.appendRow({ g: "b", s: "third", v: 3 });
    expect(() => model.scene(estimateText)).toThrow(
      /violin split: expected at most two series; series field "s" has 3 values/,
    );
    expect(() => violin(live, { x: "g", y: "v", series: "s", split: true })).toThrow(
      /"s" has 3 values/,
    );
    expect(() => build({ marks: [violin(live, { x: "g", y: "v", series: "s" })] })).not.toThrow();
    live.set("s", 2, "first");
    expect(() => model.scene(estimateText)).not.toThrow();
    const unused = table({
      g: category(["a", "a", "a", null]),
      s: encodedCategory(new Int32Array([0, 1, 2, 2]), ["first", "second", "unused"]),
      v: [1, 2, Number.NaN, 3],
    });
    expect(() => violin(unused, { x: "g", y: "v", series: "s", split: true })).not.toThrow();
  });

  it("assigns halves in legend order when dictionary order differs", () => {
    const samples = table({
      g: ["a", "a", "a", "b", "b"],
      s: ["second", "first", "first", "second", "second"],
      v: [Number.NaN, 1, 3, 2, 4],
    });
    const { model, scene } = build({
      marks: [violin(samples, { x: "g", y: "v", series: "s", split: true })],
    });
    expect(scene.legend.map((entry) => entry.label)).toEqual(["first", "second"]);
    const areas = scene.panels[0]!.marks.filter((m) => m.kind === "area") as AreaGeometry[];
    expect(extent(areas[0]!.upper, 0)[1]).toBeLessThan(model.xScale()!.map(0));
    expect(extent(areas[1]!.upper, 0)[0]).toBeGreaterThan(model.xScale()!.map(1));
  });

  it.each([
    [false, "linear"],
    [true, "linear"],
    [false, "log"],
    [true, "log"],
  ] as const)(
    "draws dashed quartiles and a solid median to the density edges (horizontal %s, %s)",
    (horizontal, type) => {
      const axes = horizontal ? ({ x: "v", y: "g" } as const) : ({ x: "g", y: "v" } as const);
      for (const split of [false, true]) {
        const { model, scene } = build({
          marks: [violin(data(), { ...axes, series: "s", split, inner: "quartiles" })],
          [horizontal ? "x" : "y"]: { type },
        });
        const marks = scene.panels[0]!.marks;
        expect(
          marks.some((m) => m.kind === "rect" || m.kind === "point" || m.kind === "segments"),
        ).toBe(false);
        const dashed = marks.filter(
          (m) => m.kind === "line" && (m as LineGeometry).dash,
        ) as LineGeometry[];
        const medians = marks.filter((m) => m.key.endsWith("|median-line")) as LineGeometry[];
        expect(dashed.map((m) => m.path.starts.length)).toEqual([4, 4]);
        expect(medians.map((m) => m.path.starts.length)).toEqual([2, 2]);
        expect(dashed[0]!.dash).toEqual([4, 3]);
        expect(medians[0]!.dash).toBeUndefined();
        const across = horizontal ? model.xScale()! : model.yScale()!;
        expect(dashed[0]!.path.coords[horizontal ? 0 : 1]).toBeCloseTo(across.map(1.5), 4);
        expect(dashed[0]!.path.coords[horizontal ? 4 : 5]).toBeCloseTo(across.map(2.5), 4);
        expect(medians[0]!.path.coords[horizontal ? 0 : 1]).toBeCloseTo(across.map(2), 4);
        // Check both endpoints of every cross-section within its category's drawn run.
        const coord = horizontal ? 0 : 1;
        const other = 1 - coord;
        for (const line of [...dashed, ...medians]) {
          const outline = marks.find(
            (m) => m.key === line.key.replace(/\|(quartiles|median-line)$/, "|outline"),
          ) as LineGeometry;
          const path = outline.path;
          for (let run = 0; run < line.path.starts.length; run++) {
            const categoryRun = line.dash ? Math.floor(run / 2) : run;
            for (let k = line.path.starts[run]!; k < line.path.runEnd(run); k++) {
              const c = line.path.coords[k * 2 + coord]!;
              const target = line.path.coords[k * 2 + other]!;
              const intersections: number[] = [];
              for (let i = path.starts[categoryRun]! + 1; i < path.runEnd(categoryRun); i++) {
                const a = path.coords[(i - 1) * 2 + coord]!;
                const b = path.coords[i * 2 + coord]!;
                if (a !== b && c >= Math.min(a, b) && c <= Math.max(a, b)) {
                  const t = (c - a) / (b - a);
                  intersections.push(
                    path.coords[(i - 1) * 2 + other]! * (1 - t) + path.coords[i * 2 + other]! * t,
                  );
                }
              }
              expect(intersections.some((p) => Math.abs(p - target) < 0.001)).toBe(true);
            }
          }
        }
      }
    },
  );

  it.each([false, true])(
    "keeps boxes and median dots inside narrow halves (horizontal %s)",
    (horizontal) => {
      const samples = table({
        g: Array.from({ length: 160 }, (_, i) => `g${Math.floor(i / 4)}`),
        s: Array.from({ length: 160 }, (_, i) => (i % 4 < 2 ? "first" : "second")),
        v: Array.from({ length: 160 }, (_, i) => (i % 2) + 1),
      });
      const { model, scene } = build(
        {
          marks: [
            violin(samples, {
              ...(horizontal ? ({ x: "v", y: "g" } as const) : ({ x: "g", y: "v" } as const)),
              series: "s",
              split: true,
            }),
          ],
        },
        120,
      );
      const along = horizontal ? model.yScale()! : model.xScale()!;
      const axis = horizontal ? 1 : 0;
      const half = along.bandwidth! * 0.4;
      expect(half).toBeLessThan(3);
      const boxes = scene.panels[0]!.marks.filter((m) => m.kind === "rect") as RectGeometry[];
      const dots = scene.panels[0]!.marks.filter((m) => m.kind === "point") as PointGeometry[];
      for (let s = 0; s < 2; s++)
        for (let k = 0; k < boxes[s]!.count; k++) {
          const center = along.map(k);
          const side = (s === 0 ? -1 : 1) * (horizontal ? -1 : 1);
          const lo = Math.min(center, center + side * half);
          const hi = Math.max(center, center + side * half);
          const box = boxes[s]!;
          const dot = dots[s]!;
          expect(box.rects[k * 4 + axis]!).toBeGreaterThanOrEqual(lo - 0.001);
          expect(box.rects[k * 4 + axis]! + box.rects[k * 4 + axis + 2]!).toBeLessThanOrEqual(
            hi + 0.001,
          );
          expect(dot.coords[k * 2 + axis]! - dot.radius).toBeGreaterThanOrEqual(lo - 0.001);
          expect(dot.coords[k * 2 + axis]! + dot.radius).toBeLessThanOrEqual(hi + 0.001);
        }
    },
  );

  it("removes obsolete inner geometry when options change", () => {
    const samples = data();
    const config = (inner: ViolinSpec["inner"]) => ({
      locale: "en-US",
      marks: [
        violin(samples, {
          x: "g",
          y: "v",
          series: "s",
          split: true,
          ...(inner === undefined ? {} : { inner }),
        }),
      ],
    });
    const { model } = build(config("box"));
    for (const inner of ["quartiles", "none", "box"] as const) {
      model.update(config(inner));
      const marks = model.scene(estimateText).panels[0]!.marks;
      expect(marks.some((m) => m.kind === "rect" || m.kind === "point")).toBe(inner === "box");
      expect(marks.some((m) => m.key.endsWith("|quartiles"))).toBe(inner === "quartiles");
      expect(marks.some((m) => m.key.endsWith("|median-line"))).toBe(inner === "quartiles");
    }
  });

  it("reassigns sides in current whole-table order after a series disappears", () => {
    const samples = table({
      g: ["a", "a", "a", "a"],
      s: ["first", "first", "second", "second"],
      v: [1, 3, 2, 4],
    });
    const options = { x: "g", y: "v", series: "s", split: true, inner: "none" } as const;
    const { model, scene } = build({ marks: [violin(samples, options)] });
    const before = scene.panels[0]!.marks.filter((m) => m.kind === "area") as AreaGeometry[];
    expect(extent(before[1]!.upper, 0)[0]).toBeGreaterThan(model.xScale()!.map(0));
    samples.dropFirst(2);
    const after = model
      .scene(estimateText)
      .panels[0]!.marks.find((m) => m.kind === "area") as AreaGeometry;
    expect(extent(after.upper, 0)[1]).toBeLessThan(model.xScale()!.map(0));
    // Rebuilding a mark from the same current data assigns the same side.
    const rebuilt = build({ marks: [violin(samples, options)] });
    const area = rebuilt.scene.panels[0]!.marks.find((m) => m.kind === "area") as AreaGeometry;
    expect(extent(area.upper, 0)[1]).toBeLessThan(rebuilt.model.xScale()!.map(0));
  });

  it("removes inner marks while retaining the constant-value density fallback", () => {
    const { scene } = build({ marks: [violin(data(), { x: "g", y: "v", inner: "none" })] });
    expect(scene.panels[0]!.marks.map((m) => m.kind)).toEqual(["area", "line"]);
    const flat = table({ g: ["a", "a"], s: ["first", "second"], v: [2, 2] });
    const result = build({
      marks: [violin(flat, { x: "g", y: "v", series: "s", split: true, inner: "none" })],
    });
    const segments = result.scene.panels[0]!.marks.filter(
      (m) => m.kind === "segments",
    ) as SegmentGeometry[];
    expect(segments.map((m) => m.count)).toEqual([1, 1]);
    expect(segments[0]!.coords[0]).toBeCloseTo(result.model.xScale()!.map(0), 4);
    expect(segments[0]!.coords[2]).toBeLessThan(segments[0]!.coords[0]!);
    expect(segments[1]!.coords[2]).toBeGreaterThan(segments[1]!.coords[0]!);
  });

  it.each([false, true])(
    "keeps panel categories, half identities, tooltips, keyboard stops, and summaries (horizontal %s)",
    (horizontal) => {
      const faceted = table({
        p: ["P", "P", "P", "P", "Q", "Q"],
        g: ["a", "a", "b", "b", "c", "c"],
        s: ["first", "first", "second", "second", "second", "second"],
        v: [1, 3, 2, 4, 5, 7],
      });
      const { model, scene } = build({
        marks: [
          violin(faceted, {
            ...(horizontal ? ({ x: "v", y: "g" } as const) : ({ x: "g", y: "v" } as const)),
            series: "s",
            split: true,
            inner: "quartiles",
          }),
        ],
        facet: facet("p"),
        resolve: { [horizontal ? "y" : "x"]: "independent" },
      });
      expect(scene.legend.map((e) => e.label)).toEqual(["first", "second"]);
      expect(model.panels().map((p) => (horizontal ? p.y : p.x).categories)).toEqual([
        ["a", "b"],
        ["c"],
      ]);
      expect(model.keyboardStops("P").map((s) => s.label)).toEqual(["first", "second"]);
      expect(model.keyboardStops("Q").map((s) => s.label)).toEqual(["second"]);
      const read = model.inspectPosition(model.keyboardStops("Q")[0]!.key, 0, "Q")!;
      expect(read).toMatchObject({ panel: "Q", label: "c" });
      expect(read.points[0]!.text).toBe(
        "median 6, quartiles 5.5 to 6.5, values from 5 to 7, 2 values",
      );
      expect(describeChart(model)).toContain("second: 2 violins, medians from 3 (b) to 6 (c).");
      const panel = model.panels()[1]!;
      const along = horizontal ? panel.y : panel.x;
      const across = horizontal ? panel.x : panel.y;
      const center = along.map(0);
      const offset = along.bandwidth! * 0.1 * (horizontal ? -1 : 1);
      const pixel = horizontal
        ? [across.map(6), center + offset]
        : [center + offset, across.map(6)];
      expect(model.inspect(pixel[0]!, pixel[1]!, "nearest", "Q")!.points[0]!.label).toBe("second");
      const area = scene.panels[1]!.marks.find((m) => m.kind === "area") as AreaGeometry & {
        lower: Polyline;
      };
      expect(extent(area.lower, horizontal ? 1 : 0)[0]).toBeCloseTo(center, 4);
    },
  );

  it.each(["box", "quartiles", "none"] as const)(
    "retains separate tooltips and keyboard reads with inner %s",
    (inner) => {
      const { model } = build({
        marks: [violin(data(), { x: "g", y: "v", series: "s", split: true, inner })],
      });
      const panel = model.panels()[0]!;
      const center = panel.x.map(0);
      for (const [i, label, value] of [
        [0, "first", 2],
        [1, "second", 3],
      ] as const) {
        const read = model.inspect(center + (i === 0 ? -20 : 20), panel.y.map(value), "nearest")!;
        expect(read.points.map((p) => p.label)).toEqual([label]);
        expect(
          model
            .inspectPosition(model.keyboardStops(panel.key)[i]!.key, 0)!
            .points.some((p) => p.label === label),
        ).toBe(true);
      }
      expect(model.keyboardStops(panel.key).map((s) => s.label)).toEqual(["first", "second"]);
      expect(describeChart(model)).toContain("first: 2 violins");
      expect(describeChart(model)).toContain("second: 2 violins");
    },
  );
});

describe("violin spec options", () => {
  const spec = (options: Partial<ViolinSpec> = {}): ChartSpec => ({
    data: {
      t: {
        columns: {
          g: ["a", "a", "a", "a"],
          s: ["first", "first", "second", "second"],
          v: [1, 3, 2, 4],
        },
      },
    },
    marks: [{ type: "violin", x: "g", y: "v", ...options }],
  });
  it("load splits and interiors", () => {
    expect(() => validateSpec(spec({ split: false, inner: "box" }))).not.toThrow();
    for (const inner of ["box", "quartiles", "none"] as const) {
      const { config } = loadSpec(spec({ split: true, series: "s", inner }));
      expect(config.marks[0]!.spec).toMatchObject({ split: true, inner });
      expect(() => build(config)).not.toThrow();
    }
  });
  it("validates shape and data-dependent errors", () => {
    expect(() => validateSpec(spec({ split: true }))).toThrow(/series field/);
    expect(() => validateSpec(spec({ split: 1 as never }))).toThrow(/split/);
    expect(() => validateSpec(spec({ inner: "points" as never }))).toThrow(/inner/);
    const many = spec({ split: true, series: "s" });
    many.data!.t = { columns: { g: ["a", "a", "a"], s: ["one", "two", "three"], v: [1, 2, 3] } };
    expect(() => loadSpec(many)).toThrow(/"s" has 3 values/);
  });
});
