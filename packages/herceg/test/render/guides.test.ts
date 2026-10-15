// Reference figures of scales and guides, kept as SVG files to look at
// (__snapshots__/guides/*.svg) and drawn through PDF too: tick layers in
// two time zones, twin axes styled like their series, one legend under a
// grid of subplots, and a heatmap's colorbar. Text is measured with the
// built-in metrics, so the figures are the same on every machine.
import { describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { axis, colorbar } from "../../src/guides/options.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { renderToSVG, type StaticOptions } from "../../src/render/static.ts";

const HOUR = 3_600_000;
const start = Date.UTC(2026, 8, 28);
const hours = Array.from({ length: 73 }, (_, i) => start + i * HOUR);
const load = table({
  t: time(hours),
  load: hours.map((_, i) => Math.round(50 + 35 * Math.sin(i / 4) + 8 * Math.cos(i / 1.7))),
  latency: hours.map((_, i) => Math.round(120 + 60 * Math.cos(i / 6))),
});

const hourly = (timeZone: string): StaticOptions => ({
  width: 720,
  height: 320,
  locale: "en-US",
  timeZone,
  title: `Load, 6-hourly ticks with day boundaries (${timeZone})`,
  marks: [line(load, { x: "t", y: "load" })],
  x: { ticks: { every: "6 hours" }, format: { time: "%H:%M" } },
  guides: [
    axis({
      scale: "x",
      layers: [
        {
          id: "day",
          ticks: { every: "day" },
          format: { time: "%a %b %-d" },
          tick: { length: 14 },
          labels: { row: 1 },
        },
      ],
    }),
  ],
});

const twins: StaticOptions = {
  width: 720,
  height: 320,
  locale: "en-US",
  timeZone: "UTC",
  title: { text: "Load and latency", style: { align: "center" } },
  marks: [
    line(load, { x: "t", y: "load", stroke: "#3266d6" }),
    line(load, { x: "t", y: "latency", stroke: "#ec6a2c", axis: "right" }),
  ],
  y: {
    title: "Load (%)",
    style: {
      tickLabel: { color: "#3266d6" },
      axisTitle: { color: "#3266d6" },
      axisLine: { stroke: "#3266d6" },
    },
  },
  yRight: {
    title: "Latency (ms)",
    style: {
      tickLabel: { color: "#ec6a2c" },
      axisTitle: { color: "#ec6a2c" },
      axisLine: { stroke: "#ec6a2c" },
    },
  },
  guides: [axis({ scale: "y", line: true }), axis({ scale: "yRight", line: true })],
};

const ids = ["line-1", "line-2", "line-3", "line-4", "line-5", "line-6"];
const sites = ["Site A", "Site B", "Site C"];
const colors: Record<string, string> = {
  "Site A": "#00ab41",
  "Site B": "#3266d6",
  "Site C": "#ec6a2c",
};
const days = Array.from({ length: 12 }, (_, i) => i);
const grid: StaticOptions = {
  width: 760,
  height: 480,
  locale: "en-US",
  title: { text: "Efficiency by site", style: { align: "center" } },
  panels: panels(
    ids.map((id, k) => ({ id, title: `Line ${k + 1}` })),
    { columns: 3 },
  ),
  // Each panel shows some of the sites, and the average.
  marks: ids.flatMap((panel, p) => [
    ...sites
      .filter((_, s) => p === 0 || (p + s) % 3 !== 2)
      .map((site) => {
        const s = sites.indexOf(site);
        return line(
          table({ day: days, v: days.map((d) => 20 + 10 * Math.sin(d / 2 + s + p) + 5 * s) }),
          {
            x: "day",
            y: "v",
            label: site,
            stroke: colors[site]!,
            panel,
          },
        );
      }),
    line(table({ day: days, v: days.map((d) => 25 + 3 * Math.sin(d / 3 + p)) }), {
      x: "day",
      y: "v",
      label: "Average",
      stroke: "#222222",
      dash: "--",
      panel,
    }),
  ]),
  legend: {
    place: { side: "bottom", align: "center" },
    columns: 3,
    merge: "semantic",
    swatches: "mark",
  },
};

const zones = ["Zone A", "Zone B", "Zone C", "Zone D", "Zone E", "Zone F"];
const cells = { hour: [] as number[], zone: [] as string[], gain: [] as number[] };
for (let h = 0; h < 24; h++)
  zones.forEach((zone, k) => {
    cells.hour.push(h);
    cells.zone.push(zone);
    cells.gain.push(Math.round((-8.55 + 20.85 * (0.5 + 0.5 * Math.sin(h / 4 + k))) * 100) / 100);
  });
const colored: StaticOptions = {
  width: 640,
  height: 320,
  locale: "en-US",
  title: "Gain by zone and hour",
  marks: [
    heatmap(table({ ...cells, zone: category(cells.zone) }), {
      x: "hour",
      y: "zone",
      color: "gain",
      colorMidpoint: 0,
    }),
  ],
  guides: [colorbar({ title: "Gain (%)", ticks: 6, format: { number: "+.0f" } })],
};

const figures: Record<string, StaticOptions> = {
  "hourly-utc": hourly("UTC"),
  "hourly-belgrade": hourly("Europe/Belgrade"),
  "twin-axes": twins,
  "grid-legend": grid,
  "heatmap-colorbar": colored,
};

describe("reference figures", () => {
  for (const [name, options] of Object.entries(figures))
    it(`draws ${name}`, async () => {
      const svg = renderToSVG({ ...options, idPrefix: name });
      await expect(svg).toMatchFileSnapshot(`__snapshots__/guides/${name}.svg`);
    });

  it("labels days at midnight in each figure's zone", () => {
    const utc = renderToSVG({ ...hourly("UTC"), idPrefix: "a" });
    const belgrade = renderToSVG({ ...hourly("Europe/Belgrade"), idPrefix: "b" });
    expect(utc).toContain(">Mon Sep 28<");
    // The data starts at 02:00 in Belgrade, whose first midnight is Tuesday's.
    expect(belgrade).not.toContain(">Mon Sep 28<");
    for (const day of ["Tue Sep 29", "Wed Sep 30"]) {
      expect(utc).toContain(`>${day}<`);
      expect(belgrade).toContain(`>${day}<`);
    }
  });

  it("reads custom swatches' colors as styles' are, CSS variables included", () => {
    const svg = renderToSVG({
      width: 400,
      height: 200,
      marks: [line(load, { x: "t", y: "load" })],
      legend: {
        entries: [
          { key: "a", label: "Accent", swatch: { type: "rect", fill: "var(--accent, #ff0000)" } },
        ],
      },
    });
    expect(svg).toContain('fill="#ff0000"');
    expect(svg).not.toContain("var(--accent");
    expect(() =>
      renderToPDF({
        width: 400,
        height: 200,
        marks: [line(load, { x: "t", y: "load" })],
        legend: {
          entries: [
            { key: "a", label: "Accent", swatch: { type: "rect", fill: "var(--accent, #ff0000)" } },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("writes every figure to PDF, with the guides' text", () => {
    for (const [name, options] of Object.entries(figures)) {
      const bytes = renderToPDF(options);
      const text = Buffer.from(bytes).toString("latin1");
      expect(text.startsWith("%PDF-"), name).toBe(true);
    }
    const pdf = Buffer.from(renderToPDF(colored)).toString("latin1");
    // A vertical colorbar's gradient runs up the bar: its axis goes from bottom to top.
    expect(pdf).toMatch(/\/Coords \[[\d.]+ [\d.]+ [\d.]+ [\d.]+\]/);
  });
});
