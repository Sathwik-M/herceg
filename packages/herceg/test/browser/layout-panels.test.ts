// Layout marks in facet panels and subplots in the browser: tooltips, clicks,
// keyboard reading, the legend, and the wheel, panel by panel.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { facet } from "../../src/model/facet.ts";
import { panels } from "../../src/model/panels.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:320px";
  document.body.append(host);
});

afterEach(() => host.remove());

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function pointer(chart: Chart, type: string, x: number, y: number) {
  const rect = chart.root.getBoundingClientRect();
  chart.root.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      clientX: rect.left + x,
      clientY: rect.top + y,
      pointerId: 1,
    }),
  );
}

function key(chart: Chart, name: string) {
  chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
}

const said = (chart: Chart) => chart.root.querySelector("[aria-live]")!.textContent;
const tooltip = (chart: Chart) =>
  [...chart.root.children].find(
    (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
  ) as HTMLElement;
/** The outline of the item inspected: the overlay's path that has a visibility. */
const outline = (chart: Chart) =>
  chart.root.querySelector("svg path[stroke-linejoin='round'][fill='none'][visibility]")!;

// North: a 50, b 30, c 20. South: a 10, b 30.
const sales = table({
  region: ["North", "North", "North", "South", "South"],
  product: ["a", "b", "c", "a", "b"],
  revenue: [50, 30, 20, 10, 30],
  week: [0, 1, 2, 3, 4],
});
const shares = (options: { panel?: string } = {}) =>
  pie(sales, { category: "product", value: "revenue", ...options });

/** A point inside the largest slice of a pie, which starts at the top: right of the center. */
function inLargest(chart: Chart, panel: number) {
  const { plot } = chart.getPanels()[panel]!;
  return { x: plot.x + plot.width / 2 + 12, y: plot.y + plot.height / 2 };
}

describe("pies in facet panels", () => {
  const mount = (options: Partial<ChartOptions> = {}) =>
    createChart(host, { locale: "en-US", marks: [shares()], facet: facet("region"), ...options });

  it("show the slice under the pointer, of its panel's rows, and report it clicked", async () => {
    const chart = mount();
    const [north, south] = chart.getPanels();
    expect([north!.key, south!.key]).toEqual(["North", "South"]);
    expect(north!.x).toBeUndefined();
    const { x, y } = inLargest(chart, 1);
    pointer(chart, "pointermove", x, y);
    await frame();
    expect(tooltip(chart).textContent).toContain("b");
    expect(tooltip(chart).textContent).toContain("30 (75%)");
    expect(outline(chart).getAttribute("visibility")).toBe("visible");
    const clicks: (string | undefined)[] = [];
    chart.on("click", ({ inspection }) =>
      clicks.push(`${inspection?.panel} ${inspection?.points[0]?.label}`),
    );
    const north0 = inLargest(chart, 0);
    pointer(chart, "pointerdown", north0.x, north0.y);
    pointer(chart, "pointerup", north0.x, north0.y);
    expect(clicks).toEqual(["North a"]);
    chart.destroy();
  });

  it("read a panel's slices with Left and Right, and move between panels with Up and Down", () => {
    const chart = mount();
    chart.root.focus();
    key(chart, "ArrowRight");
    expect(said(chart)).toBe("North: revenue. a: 50 (50%)");
    key(chart, "ArrowRight");
    expect(said(chart)).toBe("revenue. b: 30 (30%)");
    key(chart, "ArrowDown");
    expect(said(chart)).toBe("South: revenue. b: 30 (75%)");
    key(chart, "End");
    expect(said(chart)).toBe("revenue. a: 10 (25%)");
    // At the last panel, Down goes nowhere.
    key(chart, "ArrowDown");
    expect(said(chart)).toBe("revenue. a: 10 (25%)");
    key(chart, "ArrowUp");
    expect(said(chart)).toBe("North: revenue. a: 50 (50%)");
    chart.destroy();
  });

  it("stop at a panel with nothing to read and say so, from any key", () => {
    const quiet = table({ region: ["North", "South"], product: ["a", "a"], revenue: [0, 5] });
    const chart = createChart(host, {
      locale: "en-US",
      marks: [pie(quiet, { category: "product", value: "revenue" })],
      facet: facet("region"),
    });
    chart.root.focus();
    key(chart, "ArrowRight");
    expect(said(chart)).toBe("North: Pie of revenue by product, with nothing to show.");
    key(chart, "ArrowDown");
    expect(said(chart)).toBe("South: revenue. a: 5 (100%)");
    key(chart, "ArrowUp");
    expect(said(chart)).toBe("North: Pie of revenue by product, with nothing to show.");
    chart.destroy();
  });

  it("say a panel has nothing left to read when its last item is hidden", () => {
    const few = table({
      region: ["North", "South", "South"],
      product: ["a", "a", "b"],
      revenue: [5, 3, 2],
    });
    const chart = createChart(host, {
      locale: "en-US",
      marks: [pie(few, { category: "product", value: "revenue" })],
      facet: facet("region"),
    });
    chart.root.focus();
    key(chart, "ArrowRight");
    expect(said(chart)).toBe("North: revenue. a: 5 (100%)");
    chart.root.querySelectorAll("button")[0]!.click();
    chart.render();
    key(chart, "ArrowRight");
    expect(said(chart)).toBe("Pie of revenue by product, with nothing to show.");
    key(chart, "ArrowDown");
    expect(said(chart)).toBe("South: revenue. b: 2 (100%)");
    chart.destroy();
  });

  it("hide a product in every panel from the one legend", () => {
    const chart = mount();
    expect(chart.getLegend().map(({ label }) => label)).toEqual(["a", "b", "c"]);
    const buttons = chart.root.querySelectorAll("button");
    expect(buttons).toHaveLength(3);
    buttons[1]!.click();
    chart.render();
    chart.root.focus();
    key(chart, "ArrowRight");
    key(chart, "ArrowRight");
    expect(said(chart)).toBe("revenue. c: 20 (28.6%)");
    key(chart, "ArrowDown");
    expect(said(chart)).toBe("South: revenue. a: 10 (100%)");
    expect(chart.root.getAttribute("aria-describedby")).toBeTruthy();
    chart.destroy();
  });
});

describe("a pie beside a line in subplots", () => {
  const mount = (options: Partial<ChartOptions> = {}) =>
    createChart(host, {
      locale: "en-US",
      marks: [line(sales, { x: "week", y: "revenue", panel: "trend" }), shares({ panel: "share" })],
      panels: panels(
        [
          { id: "trend", title: "Trend" },
          { id: "share", title: "Share" },
        ],
        { columns: 2 },
      ),
      ...options,
    });

  it("give the pie's panel no axes, and its items to the pointer", async () => {
    const chart = mount();
    const [trend, share] = chart.getPanels();
    expect(trend!.x).toBeDefined();
    expect(share!.x).toBeUndefined();
    expect(chart.toPixel(1, { panel: "share", axis: "x" })).toBeUndefined();
    expect(() => chart.toPixel(1, { panel: "nowhere", axis: "x" })).toThrow('no panel "nowhere"');
    expect(() => chart.toPixel(1, { axis: "x" })).toThrow("several panels");
    const { x, y } = inLargest(chart, 1);
    pointer(chart, "pointermove", x, y);
    await frame();
    expect(tooltip(chart).textContent).toContain("60 (42.9%)");
    expect(chart.inspect(x, y)?.panel).toBe("share");
    // Over the line's panel, the line's value along x.
    const along = chart.toPixel(2, { panel: "trend", axis: "x" })!;
    pointer(chart, "pointermove", along, trend!.plot.y + 10);
    await frame();
    expect(outline(chart).getAttribute("visibility")).toBe("hidden");
    expect(chart.inspect(along, trend!.plot.y + 10)?.panel).toBe("trend");
    chart.destroy();
  });

  it("zoom the line's panel, the pie's taking clicks and leaving the wheel alone", () => {
    const chart = mount({ interaction: { zoom: "x", brush: "x" } });
    const views: unknown[] = [];
    chart.on("viewport", (event) => views.push(event));
    const clicks: (string | undefined)[] = [];
    chart.on("click", ({ inspection }) => clicks.push(inspection?.panel));
    const wheel = (x: number, y: number) => {
      const rect = chart.root.getBoundingClientRect();
      chart.root.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          deltaY: -100,
          clientX: rect.left + x,
          clientY: rect.top + y,
        }),
      );
    };
    const pie = inLargest(chart, 1);
    wheel(pie.x, pie.y);
    expect(views).toEqual([]);
    const { plot } = chart.getPanels()[0]!;
    wheel(plot.x + plot.width / 2, plot.y + plot.height / 2);
    expect(views).toHaveLength(1);
    // Double-clicking the pie resets no view either.
    const rect = chart.root.getBoundingClientRect();
    const zoomed = chart.getViewport({ panel: "trend" }).x;
    chart.root.dispatchEvent(
      new MouseEvent("dblclick", {
        bubbles: true,
        clientX: rect.left + pie.x,
        clientY: rect.top + pie.y,
      }),
    );
    chart.render();
    expect(chart.getViewport({ panel: "trend" }).x).toEqual(zoomed);
    // A drag on the pie is no brush; a press and release there is a click.
    pointer(chart, "pointerdown", pie.x, pie.y);
    pointer(chart, "pointerup", pie.x, pie.y);
    expect(clicks).toEqual(["share"]);
    expect(chart.selection).toBeNull();
    chart.destroy();
  });

  it("read a panel drawn anew as a pie, from its first slice or its summary", () => {
    const chart = mount();
    chart.root.focus();
    key(chart, "ArrowRight");
    key(chart, "ArrowDown");
    key(chart, "ArrowUp");
    expect(said(chart)).toMatch(/^Trend: /);
    // The line's panel now holds an empty pie, under the same id.
    const none = table({ product: ["a"], revenue: [0] });
    chart.update({
      marks: [
        pie(none, { category: "product", value: "revenue", panel: "trend" }),
        shares({ panel: "share" }),
      ],
    });
    chart.render();
    key(chart, "ArrowRight");
    expect(said(chart)).toBe("Pie of revenue by product, with nothing to show.");
    chart.destroy();
  });

  it("step from the line's stop down to the pie's slices, and back up", () => {
    const chart = mount();
    chart.root.focus();
    key(chart, "ArrowRight");
    expect(said(chart)).toMatch(/^Trend: /);
    key(chart, "ArrowDown");
    expect(said(chart)).toBe("Share: revenue. a: 60 (42.9%)");
    key(chart, "ArrowRight");
    expect(said(chart)).toBe("revenue. b: 60 (42.9%)");
    key(chart, "ArrowUp");
    expect(said(chart)).toMatch(/^Trend: .*revenue: 50/);
    chart.destroy();
  });
});
