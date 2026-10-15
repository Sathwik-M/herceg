// The chart handle: panels and their axes as last drawn, values and pixels,
// inspection without side effects, legend visibility, and render events.
import "./interactive.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, createChart } from "../../src/dom/chart.ts";
import { bar } from "../../src/marks/bar.ts";
import { errorBar } from "../../src/marks/errorbar.ts";
import { line } from "../../src/marks/line.ts";
import { pie } from "../../src/marks/pie.ts";
import { point3d } from "../../src/marks/point3d.ts";
import { rule } from "../../src/marks/rule.ts";
import { facet } from "../../src/model/facet.ts";
import { renderToPDF } from "../../src/pdf.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";

let host: HTMLDivElement;
const charts: Chart[] = [];

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => {
  for (const chart of charts.splice(0)) chart.destroy();
  host.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

function mount(options: Parameters<typeof createChart>[1]): Chart {
  const chart = createChart(host, options);
  charts.push(chart);
  return chart;
}

function pointer(chart: Chart, type: string, x: number, y: number) {
  const rect = chart.root.getBoundingClientRect();
  chart.root.dispatchEvent(
    new PointerEvent(type, { bubbles: true, clientX: rect.left + x, clientY: rect.top + y }),
  );
}

const metrics = () => table({ t: [0, 5, 10], a: [1, 3, 2], b: [2, 1, 3] });
/** A point a little off the middle of the first panel's plot: on a pie, inside a slice. */
const center = (chart: Chart) => {
  const { plot } = chart.getPanels()[0]!;
  return [plot.x + plot.width / 2 + 15, plot.y + plot.height / 2 + 15] as const;
};
/** Two facet panels over the same x values: a, then b. */
const regions = () => table({ t: [0, 1, 0, 1], v: [1, 2, 3, 4], region: ["a", "a", "b", "b"] });

describe("panels", () => {
  it("describe each panel's plot and axes as last drawn", () => {
    const chart = mount({
      marks: [line(metrics(), { x: "t", y: "a" })],
      x: { domain: [0, 10] },
      y: { domain: [0, 4] },
    });
    const [panel, ...others] = chart.getPanels();
    expect(others).toEqual([]);
    expect(panel).toMatchObject({
      key: "",
      label: "",
      x: { type: "linear", domain: [0, 10], bandwidth: 0, group: "", canSetViewport: true },
      y: { type: "linear", domain: [0, 4], bandwidth: 0, group: "", canSetViewport: true },
    });
    expect(panel!.yRight).toBeUndefined();
    const { plot, x, y } = panel!;
    expect(x!.range).toEqual([plot.x, plot.x + plot.width]);
    expect(y!.range).toEqual([plot.y + plot.height, plot.y]);
  });

  it("are copies, which the chart does not read", () => {
    const chart = mount({ marks: [line(metrics(), { x: "t", y: "a" })], x: { domain: [0, 10] } });
    const [panel] = chart.getPanels();
    (panel!.x!.domain as unknown as number[])[0] = 5;
    (panel!.plot as { x: number }).x = -1;
    expect(chart.getPanels()[0]!.x!.domain).toEqual([0, 10]);
    expect(chart.getPanels()[0]!.plot.x).toBeGreaterThan(0);
  });

  it("give category axes their categories and band width, and no viewport", () => {
    const sales = table({ region: ["N", "S", "E"], v: [1, 2, 3] });
    const chart = mount({ marks: [bar(sales, { x: "region", y: "v" })] });
    const { x } = chart.getPanels()[0]!;
    expect(x).toMatchObject({ type: "band", domain: [-0.5, 2.5], categories: ["N", "S", "E"] });
    expect(x!.bandwidth).toBeGreaterThan(0);
    expect(x!.canSetViewport).toBe(false);
    // Shared with the chart's axes, so never changed by anyone.
    expect(Object.isFrozen(x!.categories)).toBe(true);
  });

  it("name facet panels and which scales they share", () => {
    const shared = mount({
      marks: [line(regions(), { x: "t", y: "v" })],
      facet: facet("region"),
    });
    expect(
      shared.getPanels().map(({ key, x, y }) => [key, x!.group, y!.group, y!.canSetViewport]),
    ).toEqual([
      ["a", "", "", true],
      ["b", "", "", true],
    ]);
    shared.destroy();
    const own = mount({
      marks: [line(regions(), { x: "t", y: "v" })],
      facet: facet("region"),
      y: { scope: "panel" },
      x: { scope: "panel" },
    });
    const [a, b] = own.getPanels();
    expect(a!.x!.group).not.toBe(b!.x!.group);
    expect(a!.y!.group).not.toBe(b!.y!.group);
    expect([a!.x!.canSetViewport, a!.y!.canSetViewport]).toEqual([true, false]);
    expect(b!.plot.x).toBeGreaterThan(a!.plot.x + a!.plot.width);
  });

  it("give a layout mark's chart one panel without axes", () => {
    const chart = mount({
      marks: [pie(table({ k: ["a", "b"], v: [1, 2] }), { category: "k", value: "v" })],
    });
    const [panel, ...others] = chart.getPanels();
    expect(others).toEqual([]);
    expect(panel).toMatchObject({ key: "", label: "" });
    expect(panel!.x).toBeUndefined();
    expect(panel!.plot.width).toBeGreaterThan(0);
    expect(chart.toPixel(1, { axis: "x" })).toBeUndefined();
    expect(chart.formatValue(1, { panel: "", axis: "y" })).toBeUndefined();
    expect(() => chart.toPixel(1, { panel: "other", axis: "x" })).toThrow(/no panel "other"/);
  });

  it("describe the last frame drawn until the chart draws again", () => {
    const chart = mount({ marks: [line(metrics(), { x: "t", y: "a" })], x: { domain: [0, 10] } });
    chart.update({ x: { domain: [0, 20] } });
    expect(chart.getPanels()[0]!.x!.domain).toEqual([0, 10]);
    chart.render();
    expect(chart.getPanels()[0]!.x!.domain).toEqual([0, 20]);
    chart.destroy();
    expect(chart.getPanels()).toEqual([]);
  });

  it("describe a layout mark's frame until the chart draws marks along axes, and back", () => {
    const shares = table({ k: ["a", "b"], v: [1, 3] });
    const chart = mount({ marks: [pie(shares, { category: "k", value: "v", id: "shares" })] });
    const slice = chart.inspect(...center(chart))!;
    expect(slice).toMatchObject({ axis: "item", label: "v", points: [{ markId: "shares" }] });
    chart.update({ marks: [line(metrics(), { x: "t", y: "a" })] });
    // The pie is still on screen.
    expect(chart.getPanels()[0]!.x).toBeUndefined();
    expect(chart.inspect(...center(chart))).toEqual(slice);
    chart.render();
    expect(chart.getPanels()[0]!.x).toBeDefined();
    chart.update({ marks: [pie(shares, { category: "k", value: "v" })] });
    expect(chart.getPanels()[0]!.x).toBeDefined();
    chart.render();
    expect(chart.getPanels()[0]!.x).toBeUndefined();
  });
});

describe("pixel mapping", () => {
  it("maps values to pixels and back, without clamping", () => {
    const chart = mount({
      marks: [line(metrics(), { x: "t", y: "a" })],
      x: { domain: [0, 10] },
      y: { domain: [0, 4] },
    });
    const { plot } = chart.getPanels()[0]!;
    const x = { axis: "x" } as const;
    expect(chart.toPixel(0, x)).toBeCloseTo(plot.x, 9);
    expect(chart.toPixel(10, x)).toBeCloseTo(plot.x + plot.width, 9);
    expect(chart.toPixel(20, x)!).toBeGreaterThan(plot.x + plot.width);
    expect(chart.fromPixel(chart.toPixel(7.5, x)!, x)).toBeCloseTo(7.5, 9);
    expect(chart.fromPixel(plot.y, { axis: "y" })).toBeCloseTo(4, 9);
    expect(chart.fromPixel(plot.x - plot.width, x)).toBeCloseTo(-10, 9);
    expect(chart.toPixel(Number.NaN, x)).toBeUndefined();
    expect(chart.fromPixel(Number.POSITIVE_INFINITY, x)).toBeUndefined();
    // The chart has no right axis.
    expect(chart.toPixel(1, { axis: "yRight" })).toBeUndefined();
  });

  it("maps pixels to fractional band indices on category axes", () => {
    const sales = table({ region: ["N", "S", "E"], v: [1, 2, 3] });
    const chart = mount({ marks: [bar(sales, { x: "region", y: "v" })] });
    const x = { axis: "x" } as const;
    const { bandwidth } = chart.getPanels()[0]!.x!;
    const center = chart.toPixel(1, x)!;
    expect(chart.fromPixel(center, x)).toBeCloseTo(1, 9);
    const near = chart.fromPixel(center + bandwidth / 4, x)!;
    expect(near).toBeGreaterThan(1);
    expect(near).toBeLessThan(1.5);
    expect(chart.formatValue(1, x)).toBe("S");
    expect(chart.formatValue(near, x)).toBe("S");
    expect(chart.formatValue(7, x)).toBeUndefined();
  });

  it("leaves out values the axis cannot show", () => {
    const logs = mount({
      marks: [line(table({ t: [0, 1], v: [1, 100] }), { x: "t", y: "v" })],
      y: { type: "log" },
    });
    expect(logs.toPixel(10, { axis: "y" })).toBeDefined();
    expect(logs.toPixel(0, { axis: "y" })).toBeUndefined();
    expect(logs.toPixel(-1, { axis: "y" })).toBeUndefined();
    logs.destroy();
    // Friday 2025-10-10 to Monday 2025-10-13, without the weekend.
    const day = 86_400_000;
    const friday = Date.UTC(2025, 9, 10);
    const breaks = mount({
      timeZone: "UTC",
      marks: [line(table({ t: time([friday, friday + 3 * day]), v: [1, 2] }), { x: "t", y: "v" })],
      x: { breaks: timeBreaks([{ weekdays: ["sat", "sun"] }]) },
    });
    expect(breaks.toPixel(friday + day / 2, { axis: "x" })).toBeDefined();
    expect(breaks.toPixel(friday + 1.5 * day, { axis: "x" })).toBeUndefined();
  });

  it("formats values as the axes' tooltips write them", () => {
    const chart = mount({
      locale: "en-US",
      timeZone: "UTC",
      marks: [line(table({ t: time([0, 3_600_000]), v: [1234.5, 2000] }), { x: "t", y: "v" })],
    });
    const { plot } = chart.getPanels()[0]!;
    const inspection = chart.inspect(chart.toPixel(0, { axis: "x" })!, plot.y + plot.height / 2)!;
    expect(chart.formatValue(inspection.value, { axis: "x" })).toBe(inspection.label);
    const [point] = inspection.points;
    expect(chart.formatValue(point!.value, { axis: "y" })).toBe(point!.text);
    expect(chart.formatValue(Number.NaN, { axis: "y" })).toBeUndefined();
  });

  it("needs the panel in charts of several panels", () => {
    const chart = mount({ marks: [line(regions(), { x: "t", y: "v" })], facet: facet("region") });
    expect(() => chart.toPixel(0, { axis: "x" })).toThrow("panel: required with several panels");
    expect(() => chart.fromPixel(0, { panel: "c", axis: "x" })).toThrow(/no panel "c"/);
    const [a, b] = chart.getPanels();
    // A shared domain, at each panel's own pixels.
    expect(chart.toPixel(0, { panel: "a", axis: "x" })).toBeCloseTo(a!.x!.range[0], 9);
    expect(chart.toPixel(0, { panel: "b", axis: "x" })).toBeCloseTo(b!.x!.range[0], 9);
  });
});

describe("inspect", () => {
  it("finds what the tooltip would show, without a cursor, tooltip, or event", async () => {
    const chart = mount({ marks: [line(metrics(), { x: "t", y: ["a", "b"] })] });
    let hovers = 0;
    chart.on("hover", () => hovers++);
    const { plot } = chart.getPanels()[0]!;
    const inspection = chart.inspect(chart.toPixel(5, { axis: "x" })! + 2, plot.y + 10)!;
    expect(inspection).toMatchObject({ axis: "x", value: 5 });
    expect(inspection.points.map((p) => p.value)).toEqual([3, 1]);
    const nearest = chart.inspect(
      chart.toPixel(5, { axis: "x" })!,
      chart.toPixel(1, { axis: "y" })!,
      {
        mode: "nearest",
      },
    )!;
    expect(nearest.points.map((p) => p.label)).toEqual(["b"]);
    await frame();
    expect(hovers).toBe(0);
    expect(
      chart.root.querySelector<HTMLElement>('[aria-hidden="true"][style*="nowrap"]')!.style.display,
    ).toBe("none");
    // Outside every plot, nothing.
    expect(chart.inspect(1, 1)).toBeUndefined();
  });

  it("finds points as last drawn, with their values read from the table", () => {
    const data = metrics();
    const chart = mount({ marks: [line(data, { x: "t", y: "a" })], y: { domain: [0, 40] } });
    const { plot } = chart.getPanels()[0]!;
    const at = [chart.toPixel(5, { axis: "x" })!, plot.y + 10] as const;
    data.set("a", 1, 30);
    chart.render();
    const [point] = chart.inspect(...at)!.points;
    expect(point).toMatchObject({ value: 30, py: chart.toPixel(30, { axis: "y" }) });
  });

  it("names a facet's panel in what it finds until the chart draws it without facets", () => {
    const chart = mount({ marks: [line(regions(), { x: "t", y: "v" })], facet: facet("region") });
    const [, b] = chart.getPanels();
    const at = [chart.toPixel(1, { panel: "b", axis: "x" })!, b!.plot.y + 5] as const;
    chart.update({ facet: undefined });
    expect(chart.inspect(...at)?.panel).toBe("b");
    chart.render();
    expect(chart.getPanels().map(({ key }) => key)).toEqual([""]);
  });

  it("inspects the panel given, and nothing outside its plot", () => {
    const chart = mount({ marks: [line(regions(), { x: "t", y: "v" })], facet: facet("region") });
    const [, b] = chart.getPanels();
    const at = [chart.toPixel(1, { panel: "b", axis: "x" })!, b!.plot.y + 5] as const;
    expect(chart.inspect(...at)).toMatchObject({ panel: "b", value: 1 });
    expect(chart.inspect(...at, { panel: "b" })).toMatchObject({ panel: "b", value: 1 });
    expect(chart.inspect(...at, { panel: "a" })).toBeUndefined();
    expect(() => chart.inspect(...at, { panel: "c" })).toThrow(/no panel "c"/);
  });
});

describe("visibility", () => {
  it("lists the legend's entries without the legend, and hides and shows by key", () => {
    const chart = mount({ legend: false, marks: [line(metrics(), { x: "t", y: ["a", "b"] })] });
    const entries = chart.getLegend();
    expect(entries.map(({ label }) => label)).toEqual(["a", "b"]);
    expect(entries.every(({ color }) => /^#[0-9a-f]{6}$/i.test(color))).toBe(true);
    const events: (readonly string[])[] = [];
    chart.on("visibility", ({ hiddenKeys }) => events.push(hiddenKeys));
    const [a, b] = entries.map(({ key }) => key);
    const { plot } = chart.getPanels()[0]!;
    const at = [chart.toPixel(5, { axis: "x" })!, plot.y + 10] as const;
    chart.setVisibility(a!, false);
    // Drawn on the next frame: until then, inspection finds what is on screen.
    expect(chart.inspect(...at)!.points.map((p) => p.label)).toEqual(["a", "b"]);
    // Changes nothing, so reports nothing.
    chart.setVisibility(a!, false);
    chart.setHiddenKeys([a!]);
    expect(events).toEqual([[a]]);
    expect(chart.getHiddenKeys()).toEqual([a]);
    chart.render();
    expect(chart.inspect(...at)!.points.map((p) => p.label)).toEqual(["b"]);
    chart.setVisibility([a!, b!], true);
    chart.setVisibility([a!, b!], false);
    chart.setHiddenKeys([]);
    expect(events).toEqual([[a], [], [a, b], []]);
  });

  it("hides the marks standing for a value together, by its entry, across updates", () => {
    const stats = table({
      day: ["thu", "thu", "fri", "fri"],
      sex: ["f", "m", "f", "m"],
      mean: [2, 3, 4, 5],
      low: [1, 2, 3, 4],
      high: [3, 4, 5, 6],
    });
    const marks = [
      bar(stats, { x: "day", y: "mean", series: "sex" }),
      errorBar(stats, { x: "day", y1: "low", y2: "high", series: "sex", dodge: true }),
    ];
    const chart = mount({ renderer: "svg", marks });
    expect(chart.getLegend().map(({ label }) => label)).toEqual(["f", "m"]);
    const buttons = chart.root.querySelectorAll("button");
    expect(buttons).toHaveLength(2);
    buttons[0]!.click();
    chart.render();
    const { plot } = chart.getPanels()[0]!;
    const at = [chart.toPixel(0, { axis: "x" })!, plot.y + 10] as const;
    // Only the other sex's bar and interval are left.
    expect(chart.inspect(...at)!.points.map(({ label }) => label)).toEqual(["m", "m"]);
    const [f] = chart.getHiddenKeys();
    expect(JSON.parse(f!)).toMatchObject({ field: "sex", value: "f" });
    // A series' own key acts on its value's entry.
    chart.setVisibility(f!, true);
    chart.setVisibility(JSON.stringify([1, "f"]), false);
    expect(chart.getHiddenKeys()).toEqual([f]);
    chart.render();
    expect(chart.inspect(...at)!.points.map(({ label }) => label)).toEqual(["m", "m"]);
    // And shows it again, by the same member key.
    chart.setVisibility(JSON.stringify([1, "f"]), true);
    expect(chart.getHiddenKeys()).toEqual([]);
    chart.setVisibility(JSON.stringify([1, "f"]), false);
    chart.update({ marks: [...marks] });
    expect(chart.getHiddenKeys()).toEqual([f]);
    // The entry stays hidden while a mark's series stand for the field's values.
    chart.update({ marks: [bar(stats, { x: "day", y: "mean", series: "sex" })] });
    expect(chart.getHiddenKeys()).toEqual([f]);
    chart.update({ marks: [bar(stats, { x: "day", y: "mean" })] });
    expect(chart.getHiddenKeys()).toEqual([]);
  });

  it("changes through the legend's buttons as through the methods", () => {
    const chart = mount({ marks: [line(metrics(), { x: "t", y: ["a", "b"] })] });
    const events: (readonly string[])[] = [];
    chart.on("visibility", ({ hiddenKeys }) => events.push(hiddenKeys));
    const [button] = chart.root.querySelectorAll("button");
    button!.click();
    const [a] = chart.getLegend();
    expect(events).toEqual([[a!.key]]);
    chart.render();
    expect(button!.getAttribute("aria-pressed")).toBe("false");
    chart.setVisibility(a!.key, true);
    chart.render();
    expect(button!.getAttribute("aria-pressed")).toBe("true");
  });

  it("keeps hidden keys while their series are gone, and drops them with their mark", () => {
    // Rows of series y, then of x: dropping the first leaves x alone.
    const data = table({ t: [0, 1], v: [1, 2], s: ["y", "x"] });
    const series = () => line(data, { x: "t", y: "v", series: "s" });
    const limit = rule({ y: 1 });
    const chart = mount({ marks: [limit, series()] });
    const y = chart.getLegend().find(({ label }) => label === "y")!.key;
    chart.setVisibility(y, false);
    data.dropFirst(1);
    chart.render();
    expect(chart.getLegend().map(({ label }) => label)).toEqual(["x"]);
    expect(chart.getHiddenKeys()).toEqual([y]);
    // The mark built again, in its place, keeps them.
    chart.update({ marks: [limit, series()] });
    expect(chart.getHiddenKeys()).toEqual([y]);
    const events: (readonly string[])[] = [];
    chart.on("visibility", ({ hiddenKeys }) => events.push(hiddenKeys));
    chart.update({ marks: [limit] });
    expect(chart.getHiddenKeys()).toEqual([]);
    expect(events).toEqual([[]]);
  });
});

describe("hidden groups of layout marks", () => {
  it("stay hidden through updates and go with their mark", () => {
    const points = table({ x: [0, 1], y: [0, 1], z: [0, 1], kind: ["a", "b"] });
    const marks = [point3d(points, { x: "x", y: "y", z: "z", series: "kind" })];
    const chart = mount({ marks });
    const [a] = chart.getLegend();
    chart.setVisibility(a!.key, false);
    chart.update({ title: "Points" });
    expect(chart.getHiddenKeys()).toEqual([a!.key]);
    chart.update({ marks: [point3d(points, { x: "x", y: "y", z: "z", id: "other" })] });
    expect(chart.getHiddenKeys()).toEqual([]);
  });
});

describe("the pointer and keyboard", () => {
  it("act on the frame drawn, not on options it has yet to draw", () => {
    const shares = table({ k: ["a", "b", "c"], v: [1, 2, 3] });
    const chart = mount({ marks: [pie(shares, { category: "k", value: "v" })] });
    const clicked: (string | undefined)[] = [];
    chart.on("click", ({ inspection }) => clicked.push(inspection?.points[0]?.label));
    const [x, y] = center(chart);
    chart.update({ marks: [line(metrics(), { x: "t", y: "a" })] });
    pointer(chart, "pointerdown", x, y);
    pointer(chart, "pointerup", x, y);
    expect(clicked).toHaveLength(1);
    expect(["a", "b", "c"]).toContain(clicked[0]);
  });

  it("move the keyboard on the frame drawn, whatever listeners change meanwhile", () => {
    const shares = table({ k: ["a", "b", "c"], v: [1, 2, 3] });
    const chart = mount({ marks: [pie(shares, { category: "k", value: "v" })] });
    const [first] = chart.getLegend();
    let renders = 0;
    chart.on("render", () => renders++);
    const hide = chart.on("render", () => {
      hide();
      chart.setVisibility(first!.key, false);
    });
    chart.update({ title: "Shares" });
    chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(renders).toBe(1);
    expect(chart.root.querySelector("[aria-live]")!.textContent).toContain(first!.label);
  });

  it("select with the keyboard in the panel drawn, whatever listeners change meanwhile", () => {
    const chart = mount({
      marks: [line(regions(), { x: "t", y: "v" })],
      facet: facet("region"),
      x: { scope: "panel" },
      interaction: { brush: "x" },
    });
    const merge = chart.on("render", () => {
      merge();
      chart.update({ facet: undefined, x: undefined });
    });
    chart.update({ title: "Regions" });
    const key = (name: string) =>
      chart.root.dispatchEvent(
        new KeyboardEvent("keydown", { key: name, shiftKey: true, bubbles: true }),
      );
    key("ArrowRight");
    key("ArrowRight");
    expect(chart.selection?.x).not.toBeNull();
  });

  it("draw pending changes before the keyboard moves", () => {
    const shares = table({ k: ["a", "b", "c"], v: [1, 2, 3] });
    const chart = mount({ marks: [pie(shares, { category: "k", value: "v" })] });
    const [first] = chart.getLegend();
    chart.setVisibility(first!.key, false);
    chart.root.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    const live = chart.root.querySelector("[aria-live]")!.textContent!;
    expect(live).not.toBe("");
    expect(live).not.toContain(first!.label);
  });
});

describe("render events", () => {
  it("follow frames that draw the data, not cursor moves", async () => {
    const data = metrics();
    const chart = mount({ marks: [line(data, { x: "t", y: "a" })] });
    let renders = 0;
    chart.on("render", () => renders++);
    chart.render();
    expect(renders).toBe(1);
    const { plot } = chart.getPanels()[0]!;
    pointer(chart, "pointermove", plot.x + 20, plot.y + 20);
    await frame();
    expect(renders).toBe(1);
    data.append({ t: [15], a: [4], b: [0] });
    await frame();
    expect(renders).toBe(2);
  });

  it("let listeners export, and follow exports that draw", () => {
    const data = metrics();
    const chart = mount({ marks: [line(data, { x: "t", y: "a" })], x: { domain: [0, 10] } });
    const exports: string[] = [];
    const exporting = chart.on("render", () => exports.push(chart.toSVG()));
    chart.render();
    expect(exports).toHaveLength(1);
    exporting();
    // An export draws what is pending, then reports the frame: a listener's
    // change shows on the next frame, in the panels and on screen alike.
    const widen = chart.on("render", () => {
      widen();
      chart.update({ x: { domain: [0, 20] } });
    });
    data.append({ t: [7], a: [1], b: [1] });
    const svg = chart.toSVG();
    const labels = () =>
      [...chart.root.querySelectorAll('svg text[dominant-baseline="hanging"]')].map(
        (label) => label.textContent,
      );
    expect(chart.getPanels()[0]!.x!.domain).toEqual([0, 10]);
    expect(labels()).not.toContain("20");
    expect(svg).not.toContain(">20<");
    chart.render();
    expect(chart.getPanels()[0]!.x!.domain).toEqual([0, 20]);
    expect(labels()).toContain("20");
  });

  it("come once an export is written, so listeners cannot change it", () => {
    const options = () => ({
      renderer: "svg" as const,
      marks: [bar(table({ k: ["a", "b"], v: [1, 3] }), { x: "k", y: "v" })],
      y: { domain: [0, 4] as [number, number] },
    });
    const paths = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]);
    const reference = mount(options());
    const expected = paths(reference.toSVG());
    reference.destroy();
    const chart = mount(options());
    chart.update({ title: undefined });
    const taller = chart.on("render", () => {
      taller();
      chart.update({ y: { domain: [0, 40] } });
      chart.render();
    });
    expect(paths(chart.toSVG())).toEqual(expected);
    expect(chart.getPanels()[0]!.y!.domain).toEqual([0, 40]);
  });

  it("come once for views and a selection set in panels of their own", async () => {
    const chart = mount({
      marks: [line(regions(), { x: "t", y: "v" })],
      facet: facet("region"),
      x: { scope: "panel" },
      interaction: { brush: "x" },
    });
    let renders = 0;
    chart.on("render", () => renders++);
    chart.setViewport([0, 0.5], { panel: "a" });
    chart.setViewport([0.5, 1], { panel: "b" });
    chart.select([0.1, 0.2], { panel: "a" });
    expect(renders).toBe(0);
    await frame();
    expect(renders).toBe(1);
    expect(chart.getViewport({ panel: "b" }).x).toEqual([0.5, 1]);
    expect(chart.selectionPanels).toEqual(["a"]);
  });
});

/** The text a PDF's content streams draw, inflated. */
async function pdfText(pdf: Uint8Array): Promise<string> {
  const latin1 = new TextDecoder("latin1");
  const raw = latin1.decode(pdf);
  let text = "";
  for (const match of raw.matchAll(/>>\nstream\n/g)) {
    const start = match.index + match[0].length;
    const length = Number(
      /\/Length (\d+)/.exec(raw.slice(raw.lastIndexOf("<<", start), start))![1],
    );
    const stream = new Blob([pdf.slice(start, start + length)])
      .stream()
      .pipeThrough(new DecompressionStream("deflate"));
    text += latin1.decode(await new Response(stream).arrayBuffer());
  }
  return text;
}

describe("exports", () => {
  const ramp = () =>
    table({
      t: Float64Array.from({ length: 101 }, (_, i) => i),
      a: Float64Array.from({ length: 101 }, (_, i) => i % 7),
      b: Float64Array.from({ length: 101 }, (_, i) => 50 + (i % 5)),
    });

  it("give a PNG of the current state at a scale of the chart's size", async () => {
    const chart = mount({ marks: [line(ramp(), { x: "t", y: ["a", "b"] })] });
    const png = await chart.toPNG();
    expect(png.type).toBe("image/png");
    const image = await createImageBitmap(png);
    expect([image.width, image.height]).toEqual([1200, 600]);
    const small = await createImageBitmap(await chart.toPNG({ scale: 0.5 }));
    expect([small.width, small.height]).toEqual([300, 150]);
    await expect(chart.toPNG({ scale: 0 })).rejects.toThrow(
      "toPNG scale: expected a positive number; received 0",
    );
  });

  it("give a PNG of the state they drew, whatever render listeners change after", async () => {
    const chart = mount({ marks: [line(ramp(), { x: "t", y: "a" })] });
    chart.update({ title: "Pending" });
    const resize = chart.on("render", () => {
      resize();
      host.style.width = "300px";
      chart.render();
    });
    const image = await createImageBitmap(await chart.toPNG({ scale: 1 }));
    expect([image.width, image.height]).toEqual([600, 300]);
    expect(chart.getPanels()[0]!.plot.width).toBeLessThan(300);
  });

  it("keep the theme's background in PNGs, and none for auto", async () => {
    const corner = async (chart: Chart) => {
      const image = await createImageBitmap(await chart.toPNG({ scale: 1 }));
      const canvas = new OffscreenCanvas(image.width, image.height);
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      return [...context.getImageData(1, 1, 1, 1).data];
    };
    const marks = [line(ramp(), { x: "t", y: "a" })];
    expect(await corner(mount({ marks }))).toEqual([255, 255, 255, 255]);
    expect(await corner(mount({ marks, theme: "dark" }))).toEqual([0x12, 0x15, 0x1c, 255]);
    expect((await corner(mount({ marks, theme: "auto" })))[3]).toBe(0);
  });

  it("exports mixed mounted and DOM-free charts as document pages", async () => {
    const chart = mount({ title: "Mounted", marks: [line(ramp(), { x: "t", y: ["a", "b"] })] });
    chart.setViewport([41, 49]);
    chart.setVisibility(chart.getLegend()[1]!.key, false);
    const pdf = renderToPDF([chart, { width: 300, height: 150, title: "Static", marks: [] }], {
      pageSize: "Letter",
      title: "Report",
    });
    const raw = new TextDecoder("latin1").decode(pdf);
    expect(raw).toContain("/Count 2");
    expect(raw.match(/\/MediaBox \[0 0 612 792\]/g)).toHaveLength(2);
    expect(raw.match(/\/S \/Figure/g)).toHaveLength(2);
    const content = await pdfText(pdf);
    expect(content).toContain("(Mounted) Tj");
    expect(content).toContain("(Static) Tj");
    expect(content).toContain("(44) Tj");
    expect(content).not.toContain("(50) Tj");
    expect(content).not.toContain("(Report) Tj");
  });

  it("give a PDF of a mounted chart as it is now: zoomed, with series hidden", async () => {
    const chart = mount({ title: "Ramp", marks: [line(ramp(), { x: "t", y: ["a", "b"] })] });
    const whole = await pdfText(renderToPDF(chart));
    expect(whole).toContain("(40) Tj");
    expect(whole).not.toContain("(44) Tj");
    chart.setViewport([41, 49]);
    chart.setVisibility(chart.getLegend()[1]!.key, false);
    const pdf = renderToPDF(chart);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    const zoomed = await pdfText(pdf);
    expect(zoomed).toContain("(44) Tj");
    // Without the hidden series, the y axis fits the other's values (0 to 6).
    expect(zoomed).not.toContain("(50) Tj");
    expect(whole).toContain("(50) Tj");
  });
});
