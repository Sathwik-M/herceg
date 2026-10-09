// Automated accessibility audits (axe-core, WCAG 2.1 A and AA plus best
// practices) of charts as they render in the browser and as static SVG.
// They check names, roles, focusable controls, and the like; they do not
// replace testing with screen readers.
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { graph } from "../../src/marks/graph.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { radar } from "../../src/marks/radar.ts";
import { rule } from "../../src/marks/rule.ts";
import { sankey } from "../../src/marks/sankey.ts";
import { text } from "../../src/marks/text.ts";
import { treemap } from "../../src/marks/treemap.ts";
import { facet } from "../../src/model/facet.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToSVG } from "../../src/render/static.ts";

const RULES: axe.RunOptions = {
  runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
  // A chart is a part of a page; page-level rules (landmarks, a main heading) belong to the page.
  rules: { region: { enabled: false }, "page-has-heading-one": { enabled: false } },
};

const charts: Chart[] = [];
afterEach(() => {
  for (const chart of charts.splice(0)) {
    const host = chart.root.parentElement;
    chart.destroy();
    host?.remove();
  }
});

function mount(options: ChartOptions): Chart {
  const host = document.createElement("div");
  host.style.cssText = "width:600px;height:320px";
  document.body.append(host);
  const chart = createChart(host, options);
  charts.push(chart);
  return chart;
}

/** axe's violations in `element`, as rule ids with the elements they name. */
async function violations(element: Element): Promise<string[]> {
  const results = await axe.run(element, RULES);
  // An audit that checked nothing would pass anything.
  expect(results.passes.length).toBeGreaterThan(0);
  return results.violations.flatMap((v) =>
    v.nodes.map((node) => `${v.id}: ${node.target.join(" ")}`),
  );
}

const start = Date.UTC(2026, 0, 1);
const times = time(Float64Array.from({ length: 48 }, (_, i) => start + i * 3_600_000));
const metrics = table({
  t: times,
  a: Float64Array.from({ length: 48 }, (_, i) => 100 + Math.sin(i / 4) * 20),
  b: Float64Array.from({ length: 48 }, (_, i) => 80 + Math.cos(i / 5) * 15),
  host: Array.from({ length: 48 }, (_, i) => (i % 2 ? "east" : "west")),
});
const dense = table({
  t: Float64Array.from({ length: 20_000 }, (_, i) => i),
  v: Float64Array.from({ length: 20_000 }, (_, i) => Math.sin(i / 300)),
});
const sales = table({
  region: ["North", "South", "East", "West"],
  country: ["A", "B", "C", "D"],
  revenue: [40, 25, 20, 15],
});
const flows = table({
  from: ["Coal", "Gas", "Gas", "Wind"],
  to: ["Grid", "Grid", "Heat", "Grid"],
  twh: [5, 3, 2, 4],
});
const players = table({ name: ["Ana", "Bo"], speed: [7, 5], power: [4, 8], range: [6, 6] });

const cases: [string, ChartOptions][] = [
  [
    "a line chart with a legend, a rule, and a label",
    {
      title: "Latency",
      marks: [
        line(metrics, { x: "t", y: ["a", "b"] }),
        rule({ y: 110, label: "SLO" }),
        text({ x: start + 5 * 3_600_000, y: 120, label: "Deploy" }),
      ],
      interaction: { zoom: true, brush: "x" },
    },
  ],
  ["a dense line drawn on a canvas", { title: "Signal", marks: [line(dense, { x: "t", y: "v" })] }],
  ["grouped bars", { title: "Hosts", marks: [bar(metrics, { x: "host", y: ["a", "b"] })] }],
  ["points by series", { marks: [point(metrics, { x: "a", y: "b", series: "host" })] }],
  [
    "a heatmap with a color legend",
    { marks: [heatmap(metrics, { x: "t", y: "host", value: "a" })] },
  ],
  ["box plots", { marks: [boxplot(metrics, { x: "host", y: "a" })] }],
  ["small multiples", { marks: [line(metrics, { x: "t", y: "a" })], facet: facet("host") }],
  [
    "subplots",
    {
      marks: [
        line(metrics, { x: "t", y: "a", panel: "a" }),
        bar(metrics, { x: "t", y: "b", panel: "b" }),
      ],
      panels: panels([
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ]),
    },
  ],
  ["a pie", { title: "Revenue", marks: [pie(sales, { category: "region", value: "revenue" })] }],
  ["a treemap", { marks: [treemap(sales, { path: ["region", "country"], value: "revenue" })] }],
  ["a gauge", { marks: [gauge(table({ cpu: [73] }), { value: "cpu", label: "CPU" })] }],
  ["a funnel", { marks: [funnel(sales, { category: "region", value: "revenue" })] }],
  ["a radar", { marks: [radar(players, { fields: ["speed", "power", "range"], series: "name" })] }],
  ["a Sankey diagram", { marks: [sankey(flows, { source: "from", target: "to", value: "twh" })] }],
  ["a network", { marks: [graph(flows, { source: "from", target: "to", value: "twh" })] }],
];

describe("accessibility audits", () => {
  it("catch what they are meant to catch", async () => {
    const host = document.createElement("div");
    host.innerHTML = '<div role="button" tabindex="0"></div><svg role="img"></svg>';
    document.body.append(host);
    try {
      const found = await violations(host);
      expect(found.some((v) => v.startsWith("aria-command-name"))).toBe(true);
      expect(found.some((v) => v.startsWith("svg-img-alt"))).toBe(true);
    } finally {
      host.remove();
    }
  });

  for (const [name, options] of cases) {
    it(`find nothing to fix in ${name}`, async () => {
      const chart = mount(options);
      await chart.loading;
      expect(await violations(chart.root)).toEqual([]);
    });
  }

  for (const theme of ["light", "dark", "high-contrast", "high-contrast-dark"] as const) {
    it(`find nothing to fix in the ${theme} theme, legend text included`, async () => {
      const chart = mount({
        title: "Latency",
        theme,
        marks: [line(metrics, { x: "t", y: ["a", "b"] }), bar(metrics, { x: "t", y: "b" })],
      });
      expect(await violations(chart.root)).toEqual([]);
    });
  }

  it("find nothing to fix with a tooltip shown and the keyboard on a point", async () => {
    const chart = mount({ title: "Latency", marks: [line(metrics, { x: "t", y: ["a", "b"] })] });
    chart.root.focus();
    chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const rect = chart.root.getBoundingClientRect();
    chart.root.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: rect.left + 300,
        clientY: rect.top + 150,
        pointerId: 1,
      }),
    );
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(await violations(chart.root)).toEqual([]);
  });

  it("find nothing to fix in static SVG", async () => {
    const host = document.createElement("div");
    host.innerHTML = renderToSVG({
      title: "Latency",
      description: "Two series over two days",
      width: 600,
      height: 320,
      marks: [line(metrics, { x: "t", y: ["a", "b"] }), rule({ y: 110, label: "SLO" })],
    });
    document.body.append(host);
    try {
      expect(await violations(host)).toEqual([]);
    } finally {
      host.remove();
    }
  });
});
