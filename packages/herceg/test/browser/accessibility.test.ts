// Automated accessibility audits (axe-core, WCAG 2.1 A and AA plus best
// practices) of charts as they render in the browser and as static SVG, and
// of grids, and checks of the accessibility tree Chrome gives screen
// readers: what a chart or grid is called, what it says about itself, and
// what it announces. They do not replace testing with screen readers.
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { count, mean } from "../../src/data/derive.ts";
import { groupRows } from "../../src/data/groups.ts";
import { rowView } from "../../src/data/row-view.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import { createGrid, type Grid } from "../../src/dom/grid.ts";
import { createGridModel } from "../../src/grid/model.ts";
import { bar } from "../../src/marks/bar.ts";
import { boxplot } from "../../src/marks/boxplot.ts";
import { funnel } from "../../src/marks/funnel.ts";
import { gauge } from "../../src/marks/gauge.ts";
import { graph } from "../../src/marks/graph.ts";
import { heatmap } from "../../src/marks/heatmap.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point } from "../../src/marks/point.ts";
import { point3d } from "../../src/marks/point3d.ts";
import { radar } from "../../src/marks/radar.ts";
import { rule } from "../../src/marks/rule.ts";
import { sankey } from "../../src/marks/sankey.ts";
import { surface } from "../../src/marks/surface.ts";
import { text } from "../../src/marks/text.ts";
import { treemap } from "../../src/marks/treemap.ts";
import { facet } from "../../src/model/facet.ts";
import { panels } from "../../src/model/panels.ts";
import { renderToSVG } from "../../src/render/static.ts";
import { accessibilityTree as treeUnder } from "./helpers.ts";

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
  [
    "a 3D scatter, with its view buttons",
    { marks: [point3d(metrics, { x: "t", y: "a", z: "b", series: "host" })] },
  ],
  [
    "a surface with a color legend",
    {
      marks: [
        surface(table({ x: [0, 1, 0, 1], y: [0, 0, 1, 1], z: [1, 2, 3, 4] }), {
          x: "x",
          y: "y",
          z: "z",
        }),
      ],
    },
  ],
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

/** The accessibility tree under the chart's figure; see `treeUnder`. */
const accessibilityTree = () => treeUnder("figure", ["pressed", "live", "atomic", "focused"]);

const press = (chart: Chart, key: string) =>
  chart.root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));

describe("the accessibility tree", () => {
  it("names and describes a chart once, with a legend of toggle buttons", async () => {
    const chart = mount({
      title: "Latency",
      marks: [line(metrics, { x: "t", y: ["a", "b"] })],
      locale: "en-US",
      timeZone: "UTC",
    });
    await chart.loading;
    const tree = await accessibilityTree();
    expect(tree[0]).toMatch(
      /^figure "Latency" \(Line chart with 2 series\. a: 48 points, .*arrow keys to read values\.\)$/,
    );
    // The description is read as the figure's, never again as text.
    expect(tree.filter((line) => line.includes("Line chart with"))).toHaveLength(1);
    expect(tree).toContain('  group "Legend"');
    expect(tree).toContain('    button "a" (Hide a) pressed=true');
    expect(tree).toContain('    button "b" (Hide b) pressed=true');
    // An empty live region waits for values.
    expect(tree.at(-1)).toBe('  generic "" live=polite atomic=true');
    chart.root.querySelector("button")!.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(await accessibilityTree()).toContain('    button "a" (Show a) pressed=false');
  });

  it("announces the values the keyboard reaches, and only there", async () => {
    const chart = mount({
      title: "Latency",
      marks: [line(metrics, { x: "t", y: ["a", "b"] })],
      locale: "en-US",
      timeZone: "UTC",
    });
    await chart.loading;
    chart.root.focus();
    press(chart, "ArrowRight");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const tree = await accessibilityTree();
    const live = tree.findIndex((line) => line.includes("live=polite"));
    expect(tree[live + 1]).toMatch(/^ {4}StaticText "Jan 1, 2026, 00:00\. a: 100\. b: 95"$/);
    // The tooltip shows the same values, hidden from assistive technology.
    expect(tree.filter((line) => line.includes('StaticText "a"'))).toHaveLength(1);
    press(chart, "ArrowRight");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect((await accessibilityTree()).join("\n")).toContain('StaticText "Jan 1, 2026, 01:00.');
  });

  it("keeps drawings out of the tree, whatever draws them", async () => {
    for (const options of [
      { title: "Signal", marks: [line(dense, { x: "t", y: "v" })] },
      { title: "Revenue", marks: [pie(sales, { category: "region", value: "revenue" })] },
      { marks: [heatmap(metrics, { x: "t", y: "host", value: "a" })] },
    ] satisfies ChartOptions[]) {
      const chart = mount(options);
      await chart.loading;
      const tree = await accessibilityTree();
      // A figure, its legend and buttons, and an empty live region: no canvas, image, or SVG text.
      const roles = new Set(tree.map((line) => line.trim().split(" ")[0]));
      expect(
        [...roles].filter(
          (role) => !["figure", "group", "button", "StaticText", "generic"].includes(role!),
        ),
      ).toEqual([]);
      expect(tree[0]).toMatch(
        options.title ? new RegExp(`^figure "${options.title}" \\(`) : /^figure "Chart" \(/,
      );
      chart.destroy();
      charts.splice(charts.indexOf(chart), 1);
      chart.root.parentElement?.remove();
    }
  });
});

describe("the keyboard", () => {
  const said = (chart: Chart) => chart.root.querySelector("[aria-live]")!.textContent;
  const step = async (chart: Chart, key: string) => {
    press(chart, key);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return said(chart);
  };

  it("reaches every series of points, moving between them with Up and Down", async () => {
    const places = table({
      x: [1, 2, 3, 1.5, 2.5],
      y: [10, 20, 30, 15, 25],
      host: ["east", "east", "east", "west", "west"],
    });
    const chart = mount({
      marks: [point(places, { x: "x", y: "y", series: "host" })],
      locale: "en-US",
    });
    await chart.loading;
    chart.root.focus();
    expect(await step(chart, "ArrowRight")).toContain("east: 10");
    expect(await step(chart, "ArrowRight")).toContain("east: 20");
    // Down goes to the next series, at the point nearest the cursor's x.
    expect(await step(chart, "ArrowDown")).toMatch(/west: (15|25)/);
    expect(await step(chart, "ArrowRight")).toContain("west: 25");
    // Past the last series, Down does nothing; Up goes back.
    expect(await step(chart, "ArrowDown")).toContain("west: 25");
    expect(await step(chart, "ArrowUp")).toMatch(/east: (20|30)/);
  });

  it("stops once at lines, which report every series at their x, and at each series of points", async () => {
    const both = table({ x: [0, 1, 2], a: [1, 2, 3], b: [4, 5, 6], c: [7, 8, 9] });
    const chart = mount({
      marks: [line(both, { x: "x", y: ["a", "b"] }), point(both, { x: "x", y: "c" })],
      locale: "en-US",
    });
    await chart.loading;
    chart.root.focus();
    const first = await step(chart, "ArrowRight");
    expect(first).toContain("a: 1");
    expect(first).toContain("b: 4");
    expect(await step(chart, "ArrowDown")).toContain("c: 7");
    expect(await step(chart, "ArrowDown")).toContain("c: 7");
    expect(await step(chart, "ArrowUp")).toContain("a: 1");
  });

  it("walks a heatmap's rows and columns as they are drawn", async () => {
    const grid = table({
      x: ["a", "b", "a", "b"],
      y: ["top", "top", "bottom", "bottom"],
      v: [1, 2, 3, 4],
    });
    const chart = mount({
      marks: [heatmap(grid, { x: "x", y: "y", value: "v" })],
      locale: "en-US",
    });
    await chart.loading;
    chart.root.focus();
    // Category rows run down the plot: "top" is the first.
    expect(await step(chart, "ArrowRight")).toBe("a. top: 1");
    expect(await step(chart, "ArrowRight")).toBe("b. top: 2");
    expect(await step(chart, "ArrowRight")).toBe("b. top: 2");
    expect(await step(chart, "ArrowDown")).toBe("b. bottom: 4");
    expect(await step(chart, "ArrowLeft")).toBe("a. bottom: 3");
    expect(await step(chart, "ArrowUp")).toBe("a. top: 1");
    // The top edge: nowhere further to go.
    expect(await step(chart, "ArrowUp")).toBe("a. top: 1");
  });

  it("skips holes in a heatmap and reads the value drawn in each cell", async () => {
    // (b, top) is empty; the second (b, bottom) row replaces the first, as drawn.
    const sparse = table({
      x: ["a", "b", "c", "b"],
      y: ["top", "bottom", "top", "bottom"],
      v: [1, 2, 3, 9],
    });
    const chart = mount({
      marks: [heatmap(sparse, { x: "x", y: "y", value: "v" })],
      locale: "en-US",
    });
    await chart.loading;
    chart.root.focus();
    expect(await step(chart, "ArrowRight")).toBe("a. top: 1");
    expect(await step(chart, "ArrowRight")).toBe("c. top: 3");
    // No cell under c: Down goes to the nearest cell in the next row down.
    expect(await step(chart, "ArrowDown")).toBe("b. bottom: 9");
    expect(await step(chart, "ArrowUp")).toBe("a. top: 1");
    expect(await step(chart, "End")).toBe("c. top: 3");
    expect(await step(chart, "Home")).toBe("a. top: 1");
  });

  it("reaches lines whose points are at different places, and recovers when its series hides", async () => {
    const early = table({ t: [0, 2], v: [1, 2] });
    const late = table({ t: [1, 3], v: [3, 4] });
    const chart = mount({
      marks: [
        line(early, { x: "t", y: "v", label: "early" }),
        line(late, { x: "t", y: "v", label: "late" }),
      ],
      locale: "en-US",
    });
    await chart.loading;
    chart.root.focus();
    expect(await step(chart, "ArrowRight")).toBe("0. early: 1");
    expect(await step(chart, "ArrowDown")).toBe("1. late: 3");
    // Hiding the series the cursor is on: Up and Down start again in what is left.
    chart.root.querySelectorAll("button")[1]!.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(await step(chart, "ArrowUp")).toMatch(/early: (1|2)/);
  });

  it("reads fields of one table row by row where x repeats, and keeps x when a series hides", async () => {
    const repeats = table({ x: [0, 0, 10], a: [1, 2, 3], b: [10, 20, 30] });
    const lines = mount({ marks: [line(repeats, { x: "x", y: ["a", "b"] })], locale: "en-US" });
    await lines.loading;
    lines.root.focus();
    expect(await step(lines, "ArrowRight")).toBe("0. a: 1. b: 10");
    expect(await step(lines, "ArrowRight")).toBe("0. a: 2. b: 20");
    const host = lines.root.parentElement;
    lines.destroy();
    host?.remove();
    charts.splice(0);
    const points = mount({
      marks: [point(repeats, { x: "x", y: "a" }), point(repeats, { x: "x", y: "b" })],
      locale: "en-US",
    });
    await points.loading;
    points.root.focus();
    await step(points, "End");
    expect(await step(points, "ArrowDown")).toBe("10. b: 30");
    points.root.querySelectorAll("button")[1]!.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(await step(points, "ArrowUp")).toBe("10. a: 3");
  });

  it("starts a keyboard selection afresh on another axis", async () => {
    const line_ = table({ t: [10, 20], v: [1, 2] });
    const bars = table({ category: ["a", "b"], v: [100, 200] });
    const chart = mount({
      marks: [line(line_, { x: "t", y: "v", axis: "right" }), bar(bars, { x: "v", y: "category" })],
      interaction: { brush: "xy" },
      locale: "en-US",
    });
    await chart.loading;
    chart.root.focus();
    press(chart, "End");
    chart.root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowLeft", shiftKey: true, bubbles: true }),
    );
    chart.root.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }),
    );
    expect(chart.selection?.y).toEqual([0, 0]);
  });
});

describe("text alternatives of legends", () => {
  it("say what color scales and shape keys show", async () => {
    const cells = table({ x: ["a", "b"], y: ["row", "row"], v: [2, 9] });
    const chart = mount({
      marks: [
        heatmap(cells, { x: "x", y: "y", value: "v", colorDomain: [-100, 100], colorMidpoint: 0 }),
      ],
      locale: "en-US",
    });
    await chart.loading;
    expect((await accessibilityTree())[0]).toContain(
      "Color shows v from -100 to 100, diverging at 0.",
    );
    // A legend with no buttons is not announced as an empty group.
    expect((await accessibilityTree()).join("\n")).not.toContain('group "Legend"');
    const host = chart.root.parentElement;
    chart.destroy();
    host?.remove();
    charts.splice(0);
    const shapes = mount({
      marks: [point(metrics, { x: "a", y: "b", symbol: "host" })],
      locale: "en-US",
    });
    await shapes.loading;
    expect((await accessibilityTree())[0]).toContain(
      "Shape shows host: circle for west, square for east.",
    );
  });
});

describe("grids", () => {
  const grids: Grid<never>[] = [];
  afterEach(() => {
    for (const grid of grids.splice(0)) {
      const host = grid.root.parentElement;
      grid.destroy();
      host?.remove();
    }
  });

  /** A grid of 1,000 requests, sorted, with rows selected and a cell focused. */
  function grid(theme: "light" | "dark" | "high-contrast" | "high-contrast-dark", page: string) {
    const host = document.createElement("div");
    host.style.cssText = `width:600px;height:300px;background:${page}`;
    document.body.append(host);
    const rows = 1000;
    const data = table({
      id: Float64Array.from({ length: rows }, (_, i) => i),
      ms: Float64Array.from({ length: rows }, (_, i) =>
        i % 13 === 0 ? Number.NaN : (i * 37) % 500,
      ),
      at: time(Float64Array.from({ length: rows }, (_, i) => start + i * 60_000)),
      host: category(Array.from({ length: rows }, (_, i) => ["web", "api", "db"][i % 3]!)),
    });
    const model = createGridModel({
      data: rowView(data),
      columns: [
        { field: "id" },
        { field: "ms", title: "Latency" },
        { field: "at" },
        { field: "host" },
      ],
      locale: "en-US",
      timeZone: "UTC",
    });
    const created = createGrid(host, { model, ariaLabel: "Requests", theme });
    grids.push(created as unknown as Grid<never>);
    model.cycleSort("host");
    model.select(1);
    model.select(3, "range");
    created.focusCell(2, "ms");
    return created;
  }

  for (const [theme, page] of [
    ["light", "#ffffff"],
    ["dark", "#121212"],
    ["high-contrast", "#ffffff"],
    ["high-contrast-dark", "#000000"],
  ] as const) {
    it(`pass audits in the ${theme} theme, sorted, with rows selected and a cell focused`, async () => {
      const created = grid(theme, page);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(await violations(created.root.parentElement!)).toEqual([]);
    });
  }

  it("pass audits with no column shown, and with columns but no rows", async () => {
    const created = grid("light", "#ffffff");
    created.model.setColumns([{ field: "id", hidden: true }]);
    created.render();
    expect(await violations(created.root.parentElement!)).toEqual([]);
    created.model.setColumns([{ field: "id" }]);
    created.model.data.setQuery({ filter: false });
    created.render();
    expect(await violations(created.root.parentElement!)).toEqual([]);
  });

  it("expose a named grid of header cells and rows that say whether they are selected", async () => {
    grid("light", "#ffffff");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    // Cells' text nodes repeat their names.
    const tree = (await treeUnder("grid", ["multiselectable", "selected", "focused"])).filter(
      (line) => !line.trim().startsWith("StaticText"),
    );
    expect(tree[0]).toMatch(
      /^grid "Requests" \(Arrow keys, .* adds it to the sort\.\) multiselectable=true$/,
    );
    expect(tree.slice(1, 7)).toEqual([
      '  rowgroup ""',
      '    row "id Latency at host"',
      '      columnheader "id"',
      '      columnheader "Latency"',
      '      columnheader "at"',
      // The sort mark is hidden; aria-sort says the order.
      '      columnheader "host"',
    ]);
    const rows = tree.filter((line) => line.trim().startsWith("row ")).slice(1);
    // Sorted by host: api rows (1, 4, 7, ...) come first.
    expect(rows.slice(0, 4)).toEqual([
      '    row "1 37 Jan 1, 2026, 00:01:00 api" selected=false',
      '    row "4 148 Jan 1, 2026, 00:04:00 api" selected=true',
      '    row "7 259 Jan 1, 2026, 00:07:00 api" selected=true',
      '    row "10 370 Jan 1, 2026, 00:10:00 api" selected=true',
    ]);
    expect(tree.filter((line) => line.includes("focused=true"))).toEqual([
      '      gridcell "259" focused=true',
    ]);
  });

  /** The requests grouped by host: api expanded and partly selected, web selected, a row focused. */
  function grouped(theme: "light" | "dark" | "high-contrast" | "high-contrast-dark", page: string) {
    const host = document.createElement("div");
    host.style.cssText = `width:600px;height:300px;background:${page}`;
    document.body.append(host);
    const rows = 120;
    const data = table({
      id: Float64Array.from({ length: rows }, (_, i) => i),
      ms: Float64Array.from({ length: rows }, (_, i) => (i * 37) % 500),
      host: category(Array.from({ length: rows }, (_, i) => ["web", "api", "db"][i % 3]!)),
    });
    const view = rowView(data);
    const model = createGridModel({
      data: view,
      groups: groupRows(view, { by: ["host"], ops: { n: count(), avg: mean("ms") } }),
      columns: [
        { field: "host" },
        { field: "id" },
        { field: "ms", title: "Latency", aggregate: "avg", format: { maximumFractionDigits: 0 } },
      ],
      locale: "en-US",
    });
    const created = createGrid(host, { model, ariaLabel: "Requests", theme });
    grids.push(created as unknown as Grid<never>);
    model.setExpanded(["api"], true);
    model.select(0);
    model.select(2, "toggle");
    model.select(3, "toggle");
    created.focusCell(3, "id");
    return created;
  }

  for (const [theme, page] of [
    ["light", "#ffffff"],
    ["high-contrast-dark", "#000000"],
  ] as const) {
    it(`pass audits grouped, in the ${theme} theme, with a group partly selected`, async () => {
      const created = grouped(theme, page);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      expect(await violations(created.root.parentElement!)).toEqual([]);
    });
  }

  it("expose groups as a tree grid whose rows say their level, place, expansion, and selection", async () => {
    grouped("light", "#ffffff");
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const tree = (
      await treeUnder("treegrid", [
        "multiselectable",
        "level",
        "expanded",
        "selected",
        "checked",
        "focused",
      ])
    ).filter((line) => !line.trim().startsWith("StaticText"));
    expect(tree[0]).toMatch(
      /^treegrid "Requests" \(Arrow keys, .* goes to the group\.\) multiselectable=true$/,
    );
    expect(tree.slice(6, 22)).toEqual([
      '  rowgroup ""',
      // The checkbox's name and state are read with the group's cell.
      '    row "Select web (40) 265" level=1 expanded=false',
      '      gridcell "Select web (40)"',
      '        checkbox "Select" checked=true',
      '      gridcell ""',
      '      gridcell "265"',
      '    row "Select api (40) 252" level=1 expanded=true',
      '      gridcell "Select api (40)"',
      '        checkbox "Select" checked=mixed',
      '      gridcell ""',
      '      gridcell "252"',
      '    row "api 1 37" level=2 selected=true',
      '      gridcell "api"',
      '      gridcell "1"',
      '      gridcell "37"',
      '    row "api 4 148" level=2 selected=true',
    ]);
    expect(tree.filter((line) => line.includes("focused=true"))).toEqual([
      '      gridcell "4" focused=true',
    ]);
  });

  it("announce what sorting and selecting did, politely and outside the grid", async () => {
    const created = grid("light", "#ffffff");
    const live = created.root.querySelector("[aria-live]")!;
    expect(live.closest("[role=grid]")).toBeNull();
    expect(live.getAttribute("aria-live")).toBe("polite");
    created.root.querySelector<HTMLElement>("[role=columnheader]")!.click();
    expect(live.textContent).toBe("Sorted by id, ascending");
  });
});
