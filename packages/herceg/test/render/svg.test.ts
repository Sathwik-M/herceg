import { describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { area } from "../../src/marks/area.ts";
import { line } from "../../src/marks/line.ts";
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
      y: { label: "ms" },
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
    const path = /<path d="(M[^"]+)" fill="none" stroke="#2a78d6"/.exec(svg)![1]!;
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
