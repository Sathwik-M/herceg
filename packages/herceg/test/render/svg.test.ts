import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { area } from "../../src/marks/area.ts";
import { bar } from "../../src/marks/bar.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { point } from "../../src/marks/point.ts";
import { rule } from "../../src/marks/rule.ts";
import { renderToSVG } from "../../src/render/static.ts";

const start = Date.UTC(2026, 9, 7, 8);
const metrics = table({
  t: time(Float64Array.from({ length: 12 }, (_, i) => start + i * 300_000)),
  api: [120, 135, 128, 150, 162, 158, 171, 166, 180, 175, 190, 186],
  db: [80, 82, null, 90, 95, 92, 99, 101, 98, 105, 110, 108],
});

describe("renderToSVG", () => {
  it("renders a deterministic line chart", () => {
    const svg = renderToSVG({
      width: 480,
      height: 240,
      title: "Latency",
      description: "API and database latency.",
      timeZone: "UTC",
      locale: "en-US",
      marks: [line(metrics, { x: "t", y: ["api", "db"] }), rule({ y: 150, label: "SLO" })],
      y: { title: "ms" },
      idPrefix: "latency",
    });
    expect(svg).toMatchSnapshot();
  });

  it("is a valid standalone SVG with an accessible name", () => {
    const svg = renderToSVG({
      width: 300,
      height: 150,
      title: "A & B <test>",
      marks: [line(metrics, { x: "t", y: "api" })],
    });
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    expect(svg).toContain('role="img"');
    expect(svg).toContain("<title");
    expect(svg).toContain("A &#38; B &#60;test&#62;");
  });

  it("splits lines at missing values", () => {
    const svg = renderToSVG({
      width: 300,
      height: 150,
      marks: [line(metrics, { x: "t", y: "db" })],
    });
    const path = /<path d="(M[^"]+)" fill="none" stroke="#3266d6"/.exec(svg)![1]!;
    expect(path.match(/M/g)).toHaveLength(2);
  });

  it("renders stacked areas and dark themes", () => {
    const svg = renderToSVG({
      width: 480,
      height: 240,
      theme: "dark",
      timeZone: "UTC",
      locale: "en-US",
      marks: [area(metrics, { x: "t", y: ["api", "db"], stack: true })],
      idPrefix: "stacked",
    });
    expect(svg).toMatchSnapshot();
  });
});

describe("renderToSVG sizing", () => {
  const sparkline = {
    width: 140,
    height: 48,
    padding: 0,
    legend: false,
    x: { show: false },
    y: { show: false },
    marks: [line(metrics, { x: "t", y: "api" })],
  } as const;
  const root = (svg: string) => svg.slice(0, svg.indexOf(">") + 1);

  it("is the chart's size by default", () => {
    expect(root(renderToSVG(sparkline))).toContain('width="140" height="48" viewBox="0 0 140 48"');
    expect(renderToSVG(sparkline)).not.toContain("vector-effect");
  });

  it("is fluid without width and height, stretched or fitted as asked", () => {
    const fluid = root(renderToSVG({ ...sparkline, sizing: "fluid", preserveAspectRatio: "none" }));
    expect(fluid).not.toMatch(/ (width|height)=/);
    expect(fluid).toContain('viewBox="0 0 140 48" preserveAspectRatio="none"');
    expect(root(renderToSVG({ ...sparkline, preserveAspectRatio: "xMinYMid slice" }))).toContain(
      'width="140" height="48" viewBox="0 0 140 48" preserveAspectRatio="xMinYMid slice"',
    );
  });

  it("keeps strokes their width in pixels when asked", () => {
    const svg = renderToSVG({
      ...sparkline,
      sizing: "fluid",
      strokeScaling: "fixed",
      idPrefix: "spark 1",
    });
    // Scoped to this document, so an SVG inlined in a page leaves the page's own alone.
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" id="spark 1"/);
    expect(svg).toContain('<style>[id="spark 1"] *{vector-effect:non-scaling-stroke}</style>');
    // Any prefix selects its document: quotes and backslashes are escaped in the selector.
    expect(renderToSVG({ ...sparkline, strokeScaling: "fixed", idPrefix: '9"\\' })).toContain(
      '<style>[id="9\\22 \\5c "] *{',
    );
  });

  it("refuses fonts that were not prepared", () => {
    expect(() => renderToSVG({ ...sparkline, fonts: [] as never })).toThrow(
      "renderToSVG fonts: expected prepared fonts; wrap the font sources in prepareFonts(...) from herceg/fonts",
    );
  });

  it("refuses sizes it does not know", () => {
    expect(() => renderToSVG({ ...sparkline, sizing: "auto" as "fluid" })).toThrow(
      'renderToSVG sizing: expected "fixed" or "fluid"; received "auto"',
    );
    expect(() =>
      renderToSVG({ ...sparkline, preserveAspectRatio: "xMidYMid stretch" as "none" }),
    ).toThrow('renderToSVG preserveAspectRatio: expected "none" or an alignment');
    expect(() => renderToSVG({ ...sparkline, strokeScaling: true as never })).toThrow(
      'renderToSVG strokeScaling: expected "scale" or "fixed"; received true',
    );
  });
});

describe("renderToSVG for bars and heatmaps", () => {
  it("renders grouped bars as one path per series", () => {
    const sales = table({ region: ["N", "S", "E"], q1: [10, 20, 30], q2: [5, -10, 15] });
    const svg = renderToSVG({
      width: 400,
      height: 200,
      locale: "en-US",
      idPrefix: "bars",
      marks: [bar(sales, { x: "region", y: ["q1", "q2"] })],
    });
    expect(svg).toMatchSnapshot();
  });

  it("draws translucent points as separate circles so overlaps darken", () => {
    const pts = table({ x: [1, 1, 2], y: [1, 1, 2] });
    const svg = (fillOpacity: number) =>
      renderToSVG({
        width: 200,
        height: 100,
        marks: [point(pts, { x: "x", y: "y", fillOpacity })],
      });
    expect(svg(0.5)).toMatch(/<g fill="[^"]+" fill-opacity="0.5">(<circle [^>]+\/>){3}<\/g>/);
    expect(svg(1)).not.toContain("<circle");
    const rgba = renderToSVG({
      width: 200,
      height: 100,
      marks: [point(pts, { x: "x", y: "y", fill: "rgba(0, 0, 0, 0.5)" })],
    });
    expect(rgba).toMatch(/(<circle [^>]+\/>){3}/);
  });

  it("embeds heatmaps as a PNG image with a color legend", () => {
    const cells = table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], v: [1, 2, 3, 4] });
    const svg = renderToSVG({
      width: 300,
      height: 200,
      locale: "en-US",
      idPrefix: "cells",
      marks: [heatmap(cells, { x: "x", y: "y", color: "v" })],
    });
    expect(svg).toContain("<image");
    expect(svg).toContain("data:image/png;base64,iVBOR");
    expect(svg).toContain('<linearGradient id="cells-ramp-0">');
  });
});
