// What marks' drawings are cut to: their plot by default, the chart, or
// nothing, in static SVG and PDF output.
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { text } from "../../src/marks/text.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG, type StaticOptions } from "../../src/render/static.ts";
import { loadSpec } from "../../src/spec/load.ts";
import type { ChartSpec } from "../../src/spec/spec.ts";

const values = table({ x: [0, 1, 2], y: [1, 3, 2], name: ["a", "b", "c"] });
const sparkline = (marks: StaticOptions["marks"]): StaticOptions => ({
  width: 140,
  height: 48,
  padding: 0,
  x: { show: false, nice: false },
  y: { show: false, nice: false },
  legend: false,
  marks,
});
const markers = (clip?: false | "plot" | "chart") =>
  point(values, { x: "x", y: "y", fill: "#ff0000", ...(clip !== undefined && { clip }) });

/** The id of the clip path cutting the first element filled `fill`; "" for none. */
function cutOf(svg: string, fill: string): string {
  const open: string[] = [];
  const before = svg.slice(0, svg.indexOf(`fill="${fill}"`));
  for (const [tag] of before.matchAll(/<g(?=[\s>])[^>]*>|<\/g>/g)) {
    if (tag === "</g>") open.pop();
    else open.push(/clip-path="url\(#([^)]+)\)"/.exec(tag)?.[1] ?? "");
  }
  return open.filter(Boolean).at(-1) ?? "";
}

describe("clip", () => {
  it("cuts data to the plot by default, so end markers are halved", () => {
    const svg = renderToSVG(sparkline([line(values, { x: "x", y: "y" }), markers()]));
    expect(cutOf(svg, "#ff0000")).toMatch(/-clip-0$/);
    expect(svg).not.toContain("-clip-chart");
  });

  it("leaves markers whole with false, drawing them above the data the plot cuts", () => {
    const svg = renderToSVG(sparkline([markers(false), line(values, { x: "x", y: "y" })]));
    expect(cutOf(svg, "#ff0000")).toBe("");
    // The line, cut to the plot, comes first though the markers were listed first.
    expect(svg.indexOf('stroke="#3266d6"')).toBeLessThan(svg.indexOf('fill="#ff0000"'));
    // The chart does not grow: the markers at its edges are still cut by its size.
    expect(svg).toContain('width="140" height="48" viewBox="0 0 140 48"');
  });

  it("cuts to the chart's box with a clip path of its own", () => {
    const svg = renderToSVG(sparkline([markers("chart")]));
    expect(svg).toMatch(
      /<clipPath id="([^"]+)-clip-chart"><rect width="140" height="48"\/><\/clipPath>/,
    );
    expect(cutOf(svg, "#ff0000")).toMatch(/-clip-chart$/);
  });

  it("cuts labels and text only when their marks ask for it", () => {
    const labels = text(values, { x: "x", y: "y", textField: "name", fill: "#00aa00" });
    const plain = renderToSVG(sparkline([labels]));
    expect(cutOf(plain, "#00aa00")).toBe("");
    const cut = renderToSVG(
      sparkline([
        text(values, { x: "x", y: "y", textField: "name", fill: "#00aa00", clip: "plot" }),
      ]),
    );
    expect(cutOf(cut, "#00aa00")).toMatch(/-clip-0$/);
    // A mark's clip cuts all it draws: a bar's labels with its bars.
    const bars = table({ k: ["a", "b"], v: [1, 2] });
    const labelled = renderToSVG({
      width: 300,
      height: 200,
      marks: [bar(bars, { x: "k", y: "v", fill: "#0000aa", labels: true, clip: "chart" })],
    });
    expect(cutOf(labelled, "#0000aa")).toMatch(/-clip-chart$/);
    expect((labelled.match(/clip-path="url\(#[^)]+-clip-chart\)"/g) ?? []).length).toBe(2);
  });

  it("cuts PDF output the same way", () => {
    const content = (options: StaticOptions) => {
      const pdf = Buffer.from(renderToPDF(options)).toString("latin1");
      const streams = [...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map((m) =>
        inflateSync(Buffer.from(m[1]!, "latin1")).toString("latin1"),
      );
      return streams.find((s) => s.includes("/Figure"))!;
    };
    const cuts = (options: StaticOptions) => content(options).match(/ re W n/g)?.length ?? 0;
    const plotted = sparkline([markers()]);
    expect(cuts(plotted)).toBe(1);
    expect(cuts(sparkline([markers(false)]))).toBe(1);
    expect(content(sparkline([markers("chart")]))).toContain("q 0 0 140 48 re W n");
    // Only the panel's plot is cut, and the markers are painted after it is restored.
    const free = content(sparkline([markers(false)]));
    expect(free.lastIndexOf("1 0 0 rg")).toBeGreaterThan(free.indexOf("Q\n"));
  });

  it("is refused in specs unless it is a known boundary", () => {
    const spec = (clip: unknown) =>
      ({
        data: { t: { columns: { x: [0, 1], y: [1, 2] } } },
        marks: [{ type: "line", x: "x", y: "y", clip }],
      }) as unknown as ChartSpec;
    expect(() => loadSpec(spec(false), [])).not.toThrow();
    expect(() => loadSpec(spec("chart"), [])).not.toThrow();
    expect(() => loadSpec(spec(true), [])).toThrow(
      'marks[0].clip: expected "plot", "chart", or false; received true',
    );
    expect(() => loadSpec(spec("panel"), [])).toThrow('received "panel"');
  });
});
