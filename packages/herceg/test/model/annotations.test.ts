// Annotations: rules, regions, and text from constants or table rows.
import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { segmentMeetsBox, segmentsMeet } from "../../src/layout/label-boxes.ts";
import { estimateText } from "../../src/layout/text.ts";
import { bar } from "../../src/marks/bar.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { region } from "../../src/marks/region.ts";
import { rule } from "../../src/marks/rule.ts";
import { text } from "../../src/marks/text.ts";
import { describeChart } from "../../src/model/describe.ts";
import { type ChartConfig, ChartModel } from "../../src/model/model.ts";
import { measurePdfText } from "../../src/render/pdf-fonts.ts";
import { renderToSVG } from "../../src/render/static.ts";
import type {
  MarkGeometry,
  RectGeometry,
  RuleGeometry,
  Scene,
  TextGeometry,
} from "../../src/scene/scene.ts";
import { LIGHT } from "../../src/theme.ts";

function build(config: ChartConfig, width = 600, height = 300) {
  const model = new ChartModel({ locale: "en-US", timeZone: "UTC", ...config });
  model.setSize(width, height, 1);
  return { model, scene: model.scene(estimateText) };
}

const of = <K extends MarkGeometry["kind"]>(scene: Scene, kind: K) =>
  scene.panels[0]!.marks.filter((m) => m.kind === kind) as Extract<MarkGeometry, { kind: K }>[];

const start = Date.UTC(2026, 0, 1);
const hour = 3_600_000;
const metrics = table({
  time: time(Array.from({ length: 24 }, (_, i) => start + i * hour)),
  value: Array.from({ length: 24 }, (_, i) => 100 + i),
});

describe("rule", () => {
  it("draws one rule per row of a table, with text from a field", () => {
    const deploys = table({
      time: time([start + 2 * hour, start + 30 * hour, start + 5 * hour]),
      version: ["v1", "v2", "v3"],
    });
    const { scene, model } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        rule(deploys, { x: "time", textField: "version" }),
      ],
    });
    // The x domain stretches to include every event.
    expect(model.xScale()!.domain[1]).toBeGreaterThanOrEqual(start + 30 * hour);
    const rules = of(scene, "rule") as RuleGeometry[];
    expect(rules.map((r) => r.label)).toEqual(["v1", "v2", "v3"]);
    expect(rules[0]!.x1).toBeCloseTo(model.xScale()!.map(start + 2 * hour), 3);
    expect(rules[0]!.y1).toBe(scene.panels[0]!.plot.y);
  });

  it("formats number text for the chart's locale and takes Date constants", () => {
    const limits = table({ y: [1234.5], label: [1234.5] });
    const { scene } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        rule(limits, { y: "y", textField: "label" }),
        rule({ x: new Date(start + hour), label: "start" }),
      ],
    });
    expect(of(scene, "rule").map((r) => r.label)).toEqual(["1,234.5", "start"]);
  });

  it("leaves rules outside the view out and needs a table for fields", () => {
    const events = table({ at: [0, 1000] });
    const { scene, model } = build({
      marks: [line(metrics, { x: "time", y: "value" }), rule(events, { x: "at" })],
    });
    model.setViewport([start, start + hour]);
    expect(of(model.scene(estimateText), "rule")).toHaveLength(0);
    expect(of(scene, "rule").length).toBe(2);
    expect(() => rule({ x: "at" } as never)).toThrow(
      'rule x: "at" names a field, and fields need a table; pass the table first, or give a number or Date',
    );
    expect(() => region({ x1: "2026-01-21", x2: "2026-01-25" } as never)).toThrow(
      'region x1: "2026-01-21" names a field',
    );
    expect(() => rule({ y: 250, textField: "version" } as never)).toThrow(
      'rule textField: "version" names a field, and fields need a table; pass the table first, or give constant text as label',
    );
  });
});

describe("region", () => {
  it("shades an x range across the plot's height with a label in its corner", () => {
    const { scene, model } = build({
      marks: [
        region({ x1: start + 2 * hour, x2: start + 4 * hour, label: "Maintenance" }),
        line(metrics, { x: "time", y: "value" }),
      ],
    });
    // Regions draw in mark order, so this one is underneath the line.
    expect(scene.panels[0]!.marks[0]!.kind).toBe("rect");
    const shade = scene.panels[0]!.marks[0] as RectGeometry;
    const x = model.xScale()!;
    const [rx, ry, rw, rh] = Array.from(shade.rects.subarray(0, 4));
    expect(rx).toBeCloseTo(x.map(start + 2 * hour), 3);
    expect(rx! + rw!).toBeCloseTo(x.map(start + 4 * hour), 3);
    expect([ry, rh]).toEqual([scene.panels[0]!.plot.y, scene.panels[0]!.plot.height]);
    expect([shade.fill, shade.fillOpacity]).toEqual([scene.theme.muted, 0.15]);
    const label = of(scene, "text")[0] as TextGeometry;
    expect(label.labels).toEqual(["Maintenance"]);
    expect([label.anchor, label.coords[0]]).toEqual(["start", rx! + 4]);
  });

  it("shades one region per row and clips them to the plot", () => {
    const incidents = table({
      from: time([start + hour, start + 20 * hour]),
      to: time([start + 3 * hour, start + 40 * hour]),
      title: ["db", "network"],
    });
    const { model } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        region(incidents, { x1: "from", x2: "to", textField: "title" }),
      ],
      x: { domain: [start, start + 23 * hour] },
    });
    const scene = model.scene(estimateText);
    const shade = of(scene, "rect")[0] as RectGeometry;
    expect(shade.count).toBe(2);
    // The second incident runs past the domain; it stops at the plot's edge.
    expect(shade.rects[4]! + shade.rects[6]!).toBeCloseTo(
      scene.panels[0]!.plot.x + scene.panels[0]!.plot.width,
      3,
    );
    expect((of(scene, "text")[0] as TextGeometry).labels).toEqual(["db", "network"]);
  });

  it("shades y ranges across the plot's width and counts them toward y", () => {
    const { scene, model } = build({
      marks: [line(metrics, { x: "time", y: "value" }), region({ y1: 200, y2: 300 })],
    });
    expect(model.yScale()!.domain[1]).toBeGreaterThanOrEqual(300);
    const [rx, , rw] = Array.from((of(scene, "rect")[0] as RectGeometry).rects.subarray(0, 4));
    expect([rx, rw]).toEqual([scene.panels[0]!.plot.x, scene.panels[0]!.plot.width]);
  });

  it("counts rectangles toward y only where they overlap the x view", () => {
    const boxes = table({ x1: [0, 100], x2: [1, 101], y1: [0, 0], y2: [10, 1000] });
    const { model } = build({
      marks: [region(boxes, { x1: "x1", x2: "x2", y1: "y1", y2: "y2" })],
      x: { domain: [0, 2] },
    });
    expect(model.yScale()!.domain[1]).toBe(10);
  });

  it("reaches the bottom of a log axis from zero", () => {
    const positive = table({ x: [1, 2], y: [10, 1000] });
    const { scene } = build({
      marks: [line(positive, { x: "x", y: "y" }), region({ y1: 0, y2: 100 })],
      y: { type: "log" },
    });
    const [, ry, , rh] = Array.from((of(scene, "rect")[0] as RectGeometry).rects.subarray(0, 4));
    expect(ry! + rh!).toBeCloseTo(scene.panels[0]!.plot.y + scene.panels[0]!.plot.height, 3);
  });

  it("shades from the low end of a reversed log axis", () => {
    const positive = table({ x: [1, 2], y: [1, 100] });
    const { scene, model } = build({
      marks: [line(positive, { x: "x", y: "y" }), region({ y1: 0, y2: 10 })],
      y: { type: "log", domain: [100, 1] },
    });
    const y = model.yScale()!;
    const [, ry, , rh] = Array.from((of(scene, "rect")[0] as RectGeometry).rects.subarray(0, 4));
    expect(Math.min(ry!, ry! + rh!)).toBeCloseTo(Math.min(y.map(1), y.map(10)), 3);
    expect(Math.max(ry!, ry! + rh!)).toBeCloseTo(Math.max(y.map(1), y.map(10)), 3);
  });

  it("leaves out rows with infinite ends", () => {
    const open = table({ from: [0.2, 0.4], to: [Number.POSITIVE_INFINITY, 0.6] });
    const series = table({ x: [0, 1], y: [0, 1] });
    const { scene } = build({
      marks: [line(series, { x: "x", y: "y" }), region(open, { x1: "from", x2: "to" })],
    });
    expect((of(scene, "rect")[0] as RectGeometry).count).toBe(1);
  });

  it("places constants on a category axis by band index", () => {
    const sales = table({ region: ["N", "S", "E"], v: [1, 2, 3] });
    const { scene, model } = build({
      marks: [bar(sales, { x: "region", y: "v" }), region({ x1: -0.5, x2: 0.5 }), rule({ x: 2 })],
    });
    const x = model.xScale()!;
    const shade = of(scene, "rect")[1] as RectGeometry;
    expect(shade.rects[0]).toBeCloseTo(x.map(-0.5), 3);
    expect(shade.rects[0]! + shade.rects[2]!).toBeCloseTo(x.map(0.5), 3);
    expect((of(scene, "rule")[0] as RuleGeometry).x1).toBeCloseTo(x.map(2), 3);
    // Rules on heatmap bands, as before annotations read tables.
    const cells = table({ c: ["a", "b"], r: ["x", "y"], v: [1, 2] });
    const grid = build({ marks: [heatmap(cells, { x: "c", y: "r", color: "v" }), rule({ y: 0 })] });
    expect(of(grid.scene, "rule")).toHaveLength(1);
  });

  it("needs complete pairs", () => {
    // Types refuse these; JavaScript callers get errors.
    expect(() => region({ x1: 1 } as never)).toThrow(/both x1 and x2/);
    expect(() => region({} as never)).toThrow(/needs x1 and x2, y1 and y2, or both/);
  });
});

describe("text", () => {
  it("places a label at a point with offsets, and leaves out points outside the plot", () => {
    const { scene, model } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        text({ x: start + 5 * hour, y: 105, label: "Peak", anchor: "start", dx: 6, dy: -8 }),
        text({ x: start + 100 * hour, y: 105, label: "Gone" }),
      ],
      x: { domain: [start, start + 23 * hour] },
    });
    const [label] = of(scene, "text") as TextGeometry[];
    expect(of(scene, "text")).toHaveLength(1);
    expect(label!.labels).toEqual(["Peak"]);
    expect(label!.coords[0]).toBeCloseTo(model.xScale()!.map(start + 5 * hour) + 6, 3);
    expect(label!.coords[1]).toBeCloseTo(model.yScale()!.map(105) - 8, 3);
    expect([label!.anchor, label!.fill]).toEqual(["start", scene.theme.text]);
  });

  it("labels rows from a table with a category or number field", () => {
    const peaks = table({ at: [start + hour, start + 2 * hour], v: [101, 102], name: ["a", null] });
    const { scene } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        text(peaks, { x: "at", y: "v", textField: "name" }),
        text(peaks, { x: "at", y: "v", textField: "v" }),
      ],
    });
    const [names, values] = of(scene, "text") as TextGeometry[];
    expect(names!.labels).toEqual(["a", ""]);
    expect(values!.labels).toEqual(["101", "102"]);
  });

  it("only counts labels inside the x view toward y", () => {
    const notes = table({ at: [start, start + 1000 * hour], v: [100, 1e6] });
    const { model } = build({
      marks: [
        line(metrics, { x: "time", y: "value" }),
        text(notes, { x: "at", y: "v", label: "!" }),
      ],
    });
    model.setViewport([start, start + 23 * hour]);
    model.scene(estimateText);
    expect(model.yScale()!.domain[1]).toBeLessThan(1000);
  });

  it("hides or moves labels that would cover earlier ones", () => {
    // Three labels above nearly the same point, and one apart.
    const crowd = table({
      at: [start + 4 * hour, start + 4 * hour, start + 4 * hour, start + 18 * hour],
      v: [110, 110.2, 109.8, 110],
      name: ["first", "second", "third", "apart"],
    });
    const labels = (overlap?: "hide" | "move") => {
      const { scene, model } = build({
        marks: [
          line(metrics, { x: "time", y: "value" }),
          text(crowd, { x: "at", y: "v", textField: "name", dy: -10, ...(overlap && { overlap }) }),
        ],
      });
      return { label: (of(scene, "text") as TextGeometry[])[0]!, y: model.yScale()! };
    };
    expect(labels().label.labels).toEqual(["first", "second", "third", "apart"]);
    // Hidden: the first label at a point wins, in row order.
    expect(labels("hide").label.labels).toEqual(["first", "apart"]);
    // Moved: the second goes below its point, and the third where it fits.
    const { label: moved, y } = labels("move");
    expect(moved.labels).toEqual(["first", "second", "third", "apart"]);
    expect(moved.coords[3]).toBeGreaterThan(y.map(110.2));
  });

  it("keeps moving labels in the plot", () => {
    // At the plot's top right corner, the first label goes below and before
    // its point; the second has no room left, nor a clear line farther out.
    const corner = table({ at: [10, 10], v: [5, 5], name: ["one", "two"] });
    const { scene, model } = build({
      marks: [text(corner, { x: "at", y: "v", textField: "name", dy: -10, overlap: "move" })],
      x: { domain: [0, 10] },
      y: { domain: [0, 5] },
    });
    const [label] = of(scene, "text") as TextGeometry[];
    expect(label!.labels).toEqual(["one"]);
    const { plot } = scene.panels[0]!;
    expect(label!.coords[0]).toBeLessThan(model.xScale()!.map(10));
    expect(label!.coords[1]).toBeGreaterThan(model.yScale()!.map(5));
    expect(label!.coords[1]).toBeLessThan(plot.y + plot.height);
  });

  it("moves labels farther out with a line back to their point when the nearest places are taken", () => {
    // A tight cluster of points: labels take the places next to them first,
    // then the rest go a ring or two out, for every anchor.
    const names = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const xs = names.map((_, i) => 5 + (i % 5) * 0.05);
    const ys = names.map((_, i) => 5 + Math.floor(i / 5) * 0.1);
    const cluster = table({ at: xs, v: ys, name: names });
    for (const anchor of ["middle", "start", "end"] as const) {
      const { scene, model } = build({
        marks: [
          text(cluster, { x: "at", y: "v", textField: "name", anchor, dy: -12, overlap: "move" }),
        ],
        x: { domain: [0, 10] },
        y: { domain: [0, 10] },
      });
      const [label] = of(scene, "text") as TextGeometry[];
      const [leaders] = of(scene, "segments");
      expect(leaders!.draw.guide).toBe(true);
      expect(leaders!.stroke).toBe(scene.theme.muted);
      expect(leaders!.count).toBeGreaterThan(0);
      expect(leaders!.count).toBeLessThan(label!.count);
      // Labels come in row order, whichever pass placed them.
      expect(label!.labels).toEqual(names.filter((name) => label!.labels.includes(name)));
      // Each label's box with the room kept around it, as placement sees it.
      const font = `${scene.theme.fontSize}px ${scene.theme.font}`;
      const half = Math.ceil(scene.theme.fontSize * 0.6);
      const boxes = label!.labels.map((name, k) => {
        const width = estimateText(name, font);
        const shift = anchor === "start" ? width / 2 : anchor === "end" ? -width / 2 : 0;
        const cx = label!.coords[k * 2]! + shift;
        const cy = label!.coords[k * 2 + 1]!;
        return { name, inner: [cx - width / 2, cy - half, cx + width / 2, cy + half] };
      });
      // Boxes with the room kept around them, less a hundredth of a pixel
      // for line ends stored as 32-bit floats on a box's side.
      const room = 2 - 0.01;
      const pad = ([x0, y0, x1, y1]: number[]) =>
        [x0! - room, y0! - room, x1! + room, y1! + room] as const;
      const dot = (name: string) => {
        const i = names.indexOf(name);
        return [model.xScale()!.map(xs[i]!), model.yScale()!.map(ys[i]!)] as const;
      };
      const lines = Array.from({ length: leaders!.count }, (_, k) =>
        Array.from(leaders!.coords.subarray(k * 4, k * 4 + 4)),
      );
      for (const [k, [sx, sy, ex, ey]] of lines.entries()) {
        // A line ends on its own label's text box and starts 3 pixels from that label's point.
        const own = boxes.find(
          ({ inner: [x0, y0, x1, y1] }) =>
            ex! >= x0! - 1e-3 && ex! <= x1! + 1e-3 && ey! >= y0! - 1e-3 && ey! <= y1! + 1e-3,
        )!;
        expect(own).toBeDefined();
        const [px, py] = dot(own.name);
        expect(Math.hypot(sx! - px, sy! - py)).toBeCloseTo(3, 3);
        // It passes through no other label, no other point, and no other line.
        for (const box of boxes) {
          if (box !== own)
            expect(segmentMeetsBox(sx!, sy!, ex!, ey!, ...pad(box.inner))).toBe(false);
        }
        for (const name of names) {
          if (name === own.name) continue;
          const [qx, qy] = dot(name);
          const r = 3 - 0.01;
          expect(segmentMeetsBox(sx!, sy!, ex!, ey!, qx - r, qy - r, qx + r, qy + r)).toBe(false);
        }
        for (const [j, other] of lines.entries()) {
          if (j !== k)
            expect(
              segmentsMeet(sx!, sy!, ex!, ey!, ...(other as [number, number, number, number])),
            ).toBe(false);
        }
      }
    }
    // Labels in reach of their point need no line.
    const near = table({ at: [5, 5], v: [5, 5], name: ["a", "b"] });
    const close = build({
      marks: [text(near, { x: "at", y: "v", textField: "name", dy: -12, overlap: "move" })],
      x: { domain: [0, 10] },
      y: { domain: [0, 10] },
    });
    expect(of(close.scene, "segments")).toEqual([]);
    // Static SVG draws the lines too, in the muted color.
    const svg = renderToSVG({
      width: 600,
      height: 300,
      x: { domain: [0, 10] },
      y: { domain: [0, 10] },
      marks: [text(cluster, { x: "at", y: "v", textField: "name", dy: -12, overlap: "move" })],
    });
    expect(svg).toContain(`fill="none" stroke="${LIGHT.muted}" stroke-width="1"`);
  });

  it("keep lines from crossing each other", () => {
    // Without the check, two of these points' lines cross.
    const at = [4.7, 4.779, 5.153, 4.975, 5.02, 4.831, 4.728, 5.107];
    const v = [5.108, 5.261, 4.93, 5.012, 5.199, 4.721, 4.732, 5.018];
    const points = table({ at, v, name: at.map((_, i) => `p${i}`) });
    const { scene } = build({
      marks: [text(points, { x: "at", y: "v", textField: "name", dy: -12, overlap: "move" })],
      x: { domain: [0, 10] },
      y: { domain: [0, 10] },
    });
    const [leaders] = of(scene, "segments");
    expect(leaders!.count).toBeGreaterThan(1);
    const c = leaders!.coords;
    for (let a = 0; a < leaders!.count; a++) {
      for (let b = a + 1; b < leaders!.count; b++) {
        const [ax, ay, bx, by] = c.subarray(a * 4, a * 4 + 4);
        const [cx, cy, dx, dy] = c.subarray(b * 4, b * 4 + 4);
        expect(segmentsMeet(ax!, ay!, bx!, by!, cx!, cy!, dx!, dy!)).toBe(false);
      }
    }
  });

  it("place labels by their text's width from any anchor, and skip empty ones", () => {
    // Labels ending at points by the plot's right edge cannot stay there.
    const edge = table({ at: [10, 2], v: [2.5, 2.5], name: ["right edge", ""] });
    const { scene, model } = build({
      marks: [
        text(edge, { x: "at", y: "v", textField: "name", anchor: "end", dx: 8, overlap: "move" }),
      ],
      x: { domain: [0, 10] },
      y: { domain: [0, 5] },
    });
    const [label] = of(scene, "text") as TextGeometry[];
    expect(label!.labels).toEqual(["right edge"]);
    // Moved before its point, the label ends a few pixels short of it.
    const px = model.xScale()!.map(10);
    expect(label!.coords[0]).toBeLessThan(px - 4);
    expect(label!.coords[0]).toBeGreaterThan(px - 12);
    // An empty label before a visible one at the same point takes no room.
    const pair = table({ at: [5, 5], v: [2, 2], name: ["", "shown"] });
    const hidden = build({
      marks: [text(pair, { x: "at", y: "v", textField: "name", overlap: "hide" })],
    });
    expect((of(hidden.scene, "text") as TextGeometry[])[0]!.labels).toEqual(["shown"]);
  });

  it("keep labels apart in PDF layout, measured in the PDF's own fonts", () => {
    // Twenty i's are wider in Times than the Helvetica estimate allows for.
    const pair = table({ at: [3, 6], v: [5, 5], name: ["i".repeat(20), "i".repeat(20)] });
    const model = new ChartModel({
      marks: [text(pair, { x: "at", y: "v", textField: "name", overlap: "hide" })],
      x: { domain: [0, 9] },
      y: { domain: [0, 10] },
      theme: { style: { text: { font: "Georgia, serif" } } },
      locale: "en-US",
    });
    model.setSize(240, 200, 1);
    const scene = model.scene(measurePdfText);
    const [label] = of(scene, "text") as TextGeometry[];
    const gap = model.xScale()!.map(6) - model.xScale()!.map(3);
    expect(gap).toBeLessThan(measurePdfText("i".repeat(20), "12px Georgia, serif"));
    expect(label!.labels).toHaveLength(1);
  });

  it("finish quickly with offsets far outside the chart", () => {
    for (const overlap of ["hide", "move"] as const) {
      const { scene } = build({
        marks: [text({ x: 5, y: 5, label: "far", dx: 1e20, overlap })],
        x: { domain: [0, 10] },
        y: { domain: [0, 10] },
      });
      // Hidden labels keep the author's place; moving ones fall back beside their point.
      expect((of(scene, "text") as TextGeometry[]).flatMap((g) => g.labels)).toEqual(["far"]);
    }
  });

  it("needs exactly one of label or text", () => {
    expect(() => text({ x: 1, y: 1 } as never)).toThrow(
      /text: needs exactly one of label and textField/,
    );
    expect(() =>
      text(metrics, { x: "time", y: "value", label: "a", textField: "value" } as never),
    ).toThrow(/text: needs exactly one of label and textField/);
    expect(() => text(metrics, { x: "time", y: "value", textField: "time" as never })).toThrow(
      /text textField: field "time" holds time values; expected category or number/,
    );
  });
});

describe("annotations in the text alternative", () => {
  it("lists annotation text and positions after the series", () => {
    const deploys = table({ at: time([start + 3 * hour]), version: ["v41"] });
    const { model } = build({
      marks: [
        region({ x1: start + 5 * hour, x2: start + 6 * hour, label: "Incident" }),
        line(metrics, { x: "time", y: "value", label: "p99" }),
        rule({ y: 140, label: "SLO" }),
        rule(deploys, { x: "at", textField: "version" }),
        text({ x: start + 23 * hour, y: 123, label: "123 ms" }),
      ],
    });
    const description = describeChart(model);
    expect(description).toMatch(/^Line chart with 1 series\. p99: 24 points/);
    expect(description).toContain("Region: Incident (x Jan 1, 2026, 05:00 to Jan 1, 2026, 06:00).");
    expect(description).toContain("Rule: SLO (y 140).");
    expect(description).toContain("Rule: v41 (x Jan 1, 2026, 03:00).");
    expect(description).toContain("Label: 123 ms (x Jan 1, 2026, 23:00, y 123).");
  });

  it("describes charts of annotations alone, listing at most ten items", () => {
    const many = table({ at: Array.from({ length: 12 }, (_, i) => i) });
    const { model } = build({ marks: [rule(many, { x: "at" })] });
    const description = describeChart(model);
    expect(description).toBe(
      "Rules: x 0, x 1, x 2, x 3, x 4, x 5, x 6, x 7, x 8, x 9, and 2 more.",
    );
  });
});

describe("annotations in static SVG", () => {
  it("draws regions with the data and text above it, with a halo", () => {
    const svg = renderToSVG({
      width: 400,
      height: 200,
      marks: [
        region({ x1: start + 2 * hour, x2: start + 4 * hour }),
        line(metrics, { x: "time", y: "value" }),
        text({ x: start + 3 * hour, y: 110, label: "a < b" }),
      ],
    });
    const clipped = svg.slice(svg.indexOf("<g clip-path"), svg.indexOf("</g>"));
    expect(clipped.indexOf('fill-opacity="0.15"')).toBeLessThan(clipped.indexOf('fill="none"'));
    expect(svg).toMatch(
      /<g fill="#1c2333" text-anchor="middle" stroke="#ffffff" stroke-opacity="1"[^>]*paint-order="stroke">/,
    );
    expect(svg).toContain(">a &#60; b</text>");
  });

  it("chooses the halo by the label's own color", () => {
    const svg = renderToSVG({
      width: 400,
      height: 200,
      marks: [
        line(metrics, { x: "time", y: "value" }),
        text({ x: start + 3 * hour, y: 110, label: "light", fill: "#ffffff" }),
      ],
    });
    expect(svg).toContain('<g fill="#ffffff" text-anchor="middle" stroke="#000000"');
    const functional = renderToSVG({
      width: 400,
      height: 200,
      marks: [text({ x: 1, y: 1, label: "light", fill: "rgb(255 255 255)" })],
    });
    expect(functional).toContain('stroke="#000000"');
  });
});
