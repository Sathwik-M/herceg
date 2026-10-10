// Maps, trees, and networks navigated with real pointer and keyboard input
// (through the browser, over CDP): panning and zooming maps, lassoing their
// rows, drilling into treemaps and sunbursts, and moving a network's nodes.

import { afterEach, describe, expect, it } from "vitest";
import { cdp, userEvent } from "vitest/browser";
import { type FeatureCollection, fromGeoJSON } from "../../src/data/geojson.ts";
import { selectionStore } from "../../src/data/selection.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import type { ChartEvents } from "../../src/dom/events.ts";
import { geopoint } from "../../src/marks/geopoint.ts";
import { geoshape } from "../../src/marks/geoshape.ts";
import { graph } from "../../src/marks/graph.ts";
import { sunburst } from "../../src/marks/sunburst.ts";
import { treemap } from "../../src/marks/treemap.ts";
import type { ItemInspection } from "../../src/model/model.ts";
import { rowSelection } from "../../src/model/row-selection.ts";
import { accessibilityTree, modelOf } from "./helpers.ts";

const mounted: Chart[] = [];
const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const chart of mounted.splice(0)) chart.destroy();
  for (const host of hosts.splice(0)) host.remove();
});

async function mount(options: ChartOptions): Promise<Chart> {
  const host = document.createElement("div");
  // Within the test frame's 414 pixels: input beyond them lands nowhere.
  host.style.cssText = "width:400px;height:300px";
  document.body.append(host);
  hosts.push(host);
  const chart = createChart(host, { locale: "en-US", renderer: "svg", ...options });
  mounted.push(chart);
  // Controls load the first time a chart draws a mark that has them.
  await chart.loading;
  return chart;
}

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** Where the chart's root is in the page the browser's input lands on. */
function origin(chart: Chart) {
  const rect = chart.root.getBoundingClientRect();
  const page = window.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
  return { x: page.left + rect.left, y: page.top + rect.top };
}

/** Real mouse input at (x, y) of the chart's root; Shift when `shift`. */
async function mouse(
  chart: Chart,
  type: "mousePressed" | "mouseMoved" | "mouseReleased" | "mouseWheel",
  x: number,
  y: number,
  { shift = false, clickCount = 1, deltaY = 0, held = false } = {},
) {
  const at = origin(chart);
  await cdp().send("Input.dispatchMouseEvent", {
    type,
    x: at.x + x,
    y: at.y + y,
    button: type === "mouseWheel" || (type === "mouseMoved" && !held) ? "none" : "left",
    buttons: type === "mousePressed" || held ? 1 : 0,
    clickCount,
    modifiers: shift ? 8 : 0,
    deltaX: 0,
    deltaY,
  });
}

/** A drag from one pixel of the chart to another, in steps. */
async function drag(chart: Chart, from: [number, number], to: [number, number], shift = false) {
  await mouse(chart, "mouseMoved", ...from, { shift });
  await mouse(chart, "mousePressed", ...from, { shift });
  for (const t of [0.25, 0.5, 0.75, 1]) {
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    await mouse(chart, "mouseMoved", x, y, { shift, held: true });
  }
  await mouse(chart, "mouseReleased", ...to, { shift });
}

/** A key pressed on the chart's root now, with no frame before what comes next. */
function press(chart: Chart, key: string, shiftKey = false) {
  chart.root.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
}

/** Events of one type, as they come. */
function heard<K extends keyof ChartEvents>(chart: Chart, type: K): ChartEvents[K][] {
  const events: ChartEvents[K][] = [];
  chart.on(type, (event) => events.push(event));
  return events;
}

const ring = (x: number, y: number, s: number) => [
  [x, y],
  [x + s, y],
  [x + s, y + s],
  [x, y + s],
  [x, y],
];
const countries = (): FeatureCollection => ({
  type: "FeatureCollection",
  features: Array.from({ length: 10 }, (_, i) => ({
    type: "Feature" as const,
    properties: { name: `C${i}` },
    geometry: { type: "Polygon" as const, coordinates: [ring(i * 10, -5, 10)] },
  })),
});
const radians = Math.PI / 180;

/** The map's plane as last drawn. */
const plane = (chart: Chart) => modelOf(chart).items!.result()!.plane!;
const span = (range: readonly [number, number] | null) => range && range[1] - range[0];

describe("maps", () => {
  const map = (options: Partial<ChartOptions> = {}) =>
    mount({
      marks: [geoshape(fromGeoJSON(countries()), { labelField: "name" })],
      projection: "equirectangular",
      interaction: { zoom: true },
      ...options,
    });

  it("zoom with the wheel at the pointer, pan when dragged, and reset on double-click", async () => {
    const chart = await map();
    const views = heard(chart, "viewport");
    const clicks = heard(chart, "click");
    const { x, y } = plane(chart);
    // The middle of C2.
    const [px, py] = [x.map(25 * radians), y.map(0)];
    const before = (chart.inspect(px, py) as ItemInspection).key;
    await mouse(chart, "mouseMoved", px, py);
    await mouse(chart, "mouseWheel", px, py, { deltaY: -300 });
    await frame();
    expect(views).toHaveLength(1);
    const zoomed = views[0]!;
    expect(span(zoomed.x)!).toBeLessThan(span(x.domain)! / 1.5);
    expect(zoomed.yRight).toBeNull();
    // What was under the pointer still is.
    expect((chart.inspect(px, py) as ItemInspection).key).toBe(before);
    expect(plane(chart).zoom).toBeGreaterThan(1.5);

    await drag(chart, [px, py], [px + 60, py]);
    await frame();
    const panned = views.at(-1)!;
    const k = plane(chart).x.range[1] - plane(chart).x.range[0];
    expect(panned.x![0]).toBeCloseTo(zoomed.x![0] - (60 * span(zoomed.x)!) / k, 6);
    expect(span(panned.x)).toBeCloseTo(span(zoomed.x)!, 9);
    // A drag is no click.
    expect(clicks).toEqual([]);

    await mouse(chart, "mousePressed", px, py);
    await mouse(chart, "mouseReleased", px, py);
    await mouse(chart, "mousePressed", px, py, { clickCount: 2 });
    await mouse(chart, "mouseReleased", px, py, { clickCount: 2 });
    await frame();
    expect(views.at(-1)).toEqual({ x: null, y: null, yRight: null });
    expect(chart.getViewport()).toEqual({ x: null, y: null, yRight: null });
    expect(plane(chart).zoom).toBe(1);
  });

  it("pan with Shift and the arrow keys, zoom with plus and minus, and read regions with the arrows", async () => {
    const chart = await map();
    const views = heard(chart, "viewport");
    const live = chart.root.querySelector("[aria-live]")!;
    chart.root.focus();
    await userEvent.keyboard("{+}");
    expect(live.textContent).toBe("Zoom 1.3 times the whole map.");
    const zoomed = views.at(-1)!;
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(live.textContent).toBe("Moved right.");
    const right = views.at(-1)!;
    expect(right.x![0]).toBeCloseTo(zoomed.x![0] + span(zoomed.x)! / 8, 9);
    await userEvent.keyboard("{ArrowRight}");
    await frame();
    // The arrows still read the regions drawn.
    expect(live.textContent).toMatch(/^Region\. C\d/);
    await userEvent.keyboard("{0}");
    expect(live.textContent).toBe("Showing the whole map.");
    expect(chart.getViewport().x).toBeNull();
    chart.render();
    const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain("Shift with the arrow keys pans it");
  });

  it("add up commands made before a frame draws them", async () => {
    const chart = await map();
    chart.root.focus();
    const fitted = plane(chart);
    const whole = span(fitted.x.domain)!;
    press(chart, "+");
    press(chart, "+");
    expect(whole / span(chart.getViewport().x)!).toBeCloseTo(1.5625, 6);
    press(chart, "0");
    const [px, py] = [fitted.x.map(25 * radians), fitted.y.map(0)];
    for (let i = 0; i < 2; i++)
      chart.root.dispatchEvent(
        new WheelEvent("wheel", {
          deltaY: -100,
          clientX: chart.root.getBoundingClientRect().left + px,
          clientY: chart.root.getBoundingClientRect().top + py,
          bubbles: true,
          cancelable: true,
        }),
      );
    expect(whole / span(chart.getViewport().x)!).toBeCloseTo(Math.exp(0.4), 6);
    await frame();
    expect(plane(chart).zoom).toBeCloseTo(Math.exp(0.4), 6);
  });

  it("start each command from the view asked for, of any shape, drawn or not", async () => {
    const chart = await map();
    chart.root.focus();
    const fitted = plane(chart);
    const whole = span(fitted.x.domain)!;
    const [x0] = fitted.x.domain;
    // An x range alone at twice the map's scale, zoomed in before a frame.
    chart.setViewport({ x: [x0, x0 + whole / 2] });
    press(chart, "+");
    const zoomed = chart.getViewport();
    expect(whole / span(zoomed.x)!).toBeCloseTo(2.5, 6);
    // A drag before a frame pans that view, not the one drawn: synthetic
    // events, so no frame comes between them.
    chart.root.setPointerCapture = () => {};
    const rect = chart.root.getBoundingClientRect();
    const [px, py] = [fitted.x.map(25 * radians), fitted.y.map(0)];
    const pointer = (type: string, x: number, buttons: number) =>
      chart.root.dispatchEvent(
        new PointerEvent(type, {
          pointerId: 1,
          pointerType: "mouse",
          isPrimary: true,
          button: 0,
          buttons,
          clientX: rect.left + x,
          clientY: rect.top + py,
          bubbles: true,
        }),
      );
    pointer("pointerdown", px, 1);
    pointer("pointermove", px + 20, 1);
    pointer("pointermove", px + 40, 1);
    pointer("pointerup", px + 40, 0);
    const panned = chart.getViewport();
    const [left, right] = fitted.x.range;
    expect(span(panned.x)).toBeCloseTo(span(zoomed.x)!, 9);
    expect(panned.x![0]).toBeCloseTo(zoomed.x![0] - (40 * span(zoomed.x)!) / (right - left), 9);
    await frame();
    expect(plane(chart).zoom).toBeCloseTo(2.5, 6);
  });

  it("outline regions that reach past the plot only inside it, hovered or read", async () => {
    const chart = await map();
    const fitted = plane(chart);
    const [x0, x1] = [20 * radians, 30 * radians];
    // C2 and its neighbors' edges across the plot, their tops and bottoms past it.
    chart.setViewport({ x: [x0 - radians, x1 + radians] });
    await frame();
    const { x, y } = plane(chart);
    expect(span(y.domain)!).toBeLessThan(10 * radians);
    const [left, right] = x.range;
    const [bottom, top] = y.range;
    const outline = chart.root.querySelector<SVGPathElement>(
      "path[fill='none'][stroke-width='2'][stroke-linejoin='round']",
    )!;
    const inPlot = () => {
      const coords = outline
        .getAttribute("d")!
        .match(/-?[\d.]+/g)!
        .map(Number);
      return coords.every((v, i) =>
        i % 2 === 0 ? v >= left - 0.1 && v <= right + 0.1 : v >= top - 0.1 && v <= bottom + 0.1,
      );
    };
    await mouse(chart, "mouseMoved", x.map(25 * radians), y.map(0));
    await frame();
    expect(outline.getAttribute("visibility")).toBe("visible");
    expect(inPlot()).toBe(true);
    await mouse(chart, "mouseMoved", 2, 2);
    chart.root.focus();
    await userEvent.keyboard("{ArrowRight}");
    await frame();
    expect(outline.getAttribute("visibility")).toBe("visible");
    expect(inPlot()).toBe(true);
    expect(fitted.zoom).toBe(1);
  });

  /** A square frame 20 degrees wide with a hole 18 wide, as a map's only region. */
  const frameMap = () =>
    mount({
      marks: [
        geoshape(
          fromGeoJSON({
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                properties: { name: "Frame" },
                geometry: { type: "Polygon", coordinates: [ring(-10, -10, 20), ring(-9, -9, 18)] },
              },
            ],
          }),
          { labelField: "name" },
        ),
      ],
      projection: "equirectangular",
      interaction: { zoom: true },
    });

  it.each([
    ["a sliver at the view's left", map, { x: [29 * radians, 31 * radians] as const, y: null }],
    // The frame's top, a strip a few pixels high over its hole: thinner
    // than the anchor's lines across the view are apart.
    [
      "a strip a few pixels high",
      frameMap,
      { x: [0, 0.2 * radians] as const, y: [8.01 * radians, 9.01 * radians] as const },
    ],
  ] as const)(
    "show the keyboard's tooltip in the part of a region the view shows: %s",
    async (_, made, view) => {
      const chart = await made();
      chart.setViewport(view);
      await frame();
      chart.root.focus();
      await userEvent.keyboard("{ArrowRight}");
      await frame();
      const tooltip = [...chart.root.children].find(
        (el) => (el as HTMLElement).style.pointerEvents === "none" && el.tagName === "DIV",
      ) as HTMLElement;
      expect(tooltip.style.display).toBe("block");
      const box = tooltip.getBoundingClientRect();
      const room = chart.root.getBoundingClientRect();
      expect(box.right).toBeGreaterThan(room.left);
      expect(box.left).toBeLessThan(room.right);
      const read = modelOf(chart).inspectItem(modelOf(chart).stepItem(undefined, 1)!)!.points[0]!;
      const [left, right] = plane(chart).x.range;
      expect(read.px).toBeGreaterThanOrEqual(left);
      expect(read.px).toBeLessThanOrEqual(right);
    },
  );

  it("have a toolbar that zooms, pans, and shows the whole map", async () => {
    const chart = await map();
    await userEvent.click(chart.root.querySelector<HTMLElement>("[aria-label='Zoom in']")!);
    await frame();
    expect(plane(chart).zoom).toBeCloseTo(1.25, 6);
    await userEvent.click(chart.root.querySelector<HTMLElement>("[aria-label='Pan left']")!);
    await userEvent.click(
      chart.root.querySelector<HTMLElement>("[aria-label='Show the whole map']")!,
    );
    await frame();
    expect(chart.getViewport().x).toBeNull();
    const tree = await accessibilityTree("figure", ["pressed"]);
    expect(tree.filter((line) => line.includes("toolbar") || line.includes("button"))).toEqual([
      '  toolbar "Map"',
      '    button "Zoom in" (Zoom in)',
      '    button "Zoom out" (Zoom out)',
      '    button "Pan left" (Pan left)',
      '    button "Pan right" (Pan right)',
      '    button "Pan up" (Pan up)',
      '    button "Pan down" (Pan down)',
      '    button "Show the whole map" (Show the whole map)',
    ]);
  });

  it("lasso regions into a row selection, and pan with Shift-drag", async () => {
    const regions = fromGeoJSON(countries());
    const store = selectionStore(regions);
    const chart = await mount({
      marks: [geoshape(regions, { labelField: "name" })],
      projection: "equirectangular",
      interaction: { zoom: true, brush: "lasso" },
      rowSelection: rowSelection({ store, channel: "picked" }),
    });
    const selects = heard(chart, "select");
    const { x, y } = plane(chart);
    const [top, bottom] = [y.map(4 * radians), y.map(-4 * radians)];
    const [left, right] = [x.map(22 * radians), x.map(48 * radians)];
    await mouse(chart, "mouseMoved", left, top);
    await mouse(chart, "mousePressed", left, top);
    for (const [px, py] of [
      [right, top],
      [right, bottom],
      [left, bottom],
      [left, top + 1],
    ] as const)
      await mouse(chart, "mouseMoved", px, py, { held: true });
    await mouse(chart, "mouseReleased", left, top + 1);
    await frame();
    const held = store.get("picked");
    expect(held?.kind === "rows" && [...held.rows.positions()]).toEqual([2, 3, 4]);
    expect(selects).toHaveLength(1);
    expect(selects[0]!.lasso).not.toBeNull();
    // The lasso is drawn on the map, and stays there as it pans.
    const outline = () => chart.root.querySelector("path[d^='M'][fill-opacity], g path[d$='Z']");
    expect(outline()).not.toBeNull();
    const views = heard(chart, "viewport");
    await drag(chart, [x.map(65 * radians), y.map(0)], [x.map(65 * radians) - 50, y.map(0)], true);
    await frame();
    expect(views.length).toBeGreaterThan(0);
    // Panning selected nothing else.
    expect(selects).toHaveLength(1);
    const svg = chart.toSVG();
    expect(svg).toContain("matrix(");
  });

  it("draw the lasso selected as it changes, with no row selection to draw a scene", async () => {
    const chart = await map({ interaction: { brush: "lasso" } });
    const { x, y } = plane(chart);
    const [top, bottom] = [y.map(4 * radians), y.map(-4 * radians)];
    const [left, right] = [x.map(22 * radians), x.map(48 * radians)];
    await mouse(chart, "mouseMoved", left, top);
    await mouse(chart, "mousePressed", left, top);
    for (const [px, py] of [
      [right, top],
      [right, bottom],
      [left, bottom],
    ] as const)
      await mouse(chart, "mouseMoved", px, py, { held: true });
    await mouse(chart, "mouseReleased", left, bottom);
    await frame();
    const lasso = chart.selection!.lasso!;
    // The map's lasso outlines, shown or not.
    const shown = () =>
      [...chart.root.querySelectorAll("path[clip-path^='url(#herceg-map-lasso']")].some(
        (path) => path.getAttribute("visibility") === "visible",
      );
    expect(shown()).toBe(true);
    chart.root.focus();
    await userEvent.keyboard("{Escape}");
    await frame();
    expect(chart.selection).toBeNull();
    expect(shown()).toBe(false);
    chart.select({ x: null, y: null, lasso });
    await frame();
    expect(shown()).toBe(true);
  });

  it("keep a lasso and its rows when a click lands on a layer of another table", async () => {
    const regions = fromGeoJSON(countries());
    const cities = table({ lon: [65], lat: [0] });
    const store = selectionStore(regions);
    const chart = await mount({
      marks: [
        geoshape(regions, { labelField: "name" }),
        geopoint(cities, { longitude: "lon", latitude: "lat", radius: 8 }),
      ],
      projection: "equirectangular",
      interaction: { brush: "lasso" },
      rowSelection: rowSelection({ store, channel: "picked" }),
    });
    const { x, y } = plane(chart);
    const [top, bottom] = [y.map(4 * radians), y.map(-4 * radians)];
    const [left, right] = [x.map(2 * radians), x.map(18 * radians)];
    await mouse(chart, "mouseMoved", left, top);
    await mouse(chart, "mousePressed", left, top);
    for (const [px, py] of [
      [right, top],
      [right, bottom],
      [left, bottom],
      [left, top + 1],
    ] as const)
      await mouse(chart, "mouseMoved", px, py, { held: true });
    await mouse(chart, "mouseReleased", left, top + 1);
    await frame();
    const picked = () => {
      const held = store.get("picked");
      return held?.kind === "rows" ? [...held.rows.positions()] : held;
    };
    expect(picked()).toEqual([0, 1]);
    // The city stands for no region: a click on it changes nothing.
    await click(chart, x.map(65 * radians), y.map(0));
    await frame();
    expect(picked()).toEqual([0, 1]);
    expect(chart.selection?.lasso).toBeTruthy();
    // A click off the data clears both.
    await click(chart, x.map(85 * radians), y.map(30 * radians));
    await frame();
    expect(picked()).toBeNull();
    expect(chart.selection).toBeNull();
  });
});

const sales = () =>
  table({
    region: ["Europe", "Europe", "Europe", "Asia", "Asia"],
    country: ["France", "France", "Spain", "Japan", "India"],
    city: ["Paris", "Lyon", "Madrid", "Tokyo", "Delhi"],
    revenue: [40, 10, 20, 50, 30],
  });

/** The item drawn as `label`, by its path, in keyboard order. */
function itemNamed(chart: Chart, label: string): ItemInspection {
  const model = modelOf(chart);
  let key = model.stepItem(undefined, 1);
  const seen = new Set<string>();
  while (key !== undefined && !seen.has(key)) {
    seen.add(key);
    const item = model.inspectItem(key) as ItemInspection;
    if (item.points[0]!.label === label) return item;
    key = model.stepItem(key, 1);
  }
  throw new Error(`No item ${label}`);
}

/** A pixel inside an item's box (from its outline) near its top left corner: a treemap group's own strip. */
function corner(item: ItemInspection): [number, number] {
  const [x, y] = item.outline.match(/-?[\d.]+/g)!.map(Number);
  return [x! + 4, y! + 4];
}

async function click(chart: Chart, x: number, y: number) {
  await mouse(chart, "mouseMoved", x, y);
  await mouse(chart, "mousePressed", x, y);
  await mouse(chart, "mouseReleased", x, y);
}

describe("treemaps and sunbursts", () => {
  it("drill into a group clicked, report it, and go back by a breadcrumb", async () => {
    const chart = await mount({
      marks: [treemap(sales(), { path: ["region", "country", "city"], value: "revenue" })],
      interaction: { zoom: true },
    });
    const drills = heard(chart, "drill");
    await click(chart, ...corner(itemNamed(chart, "Europe")));
    expect(drills).toEqual([
      { key: '[0,"Europe"]', path: [{ key: '[0,"Europe"]', label: "Europe" }] },
    ]);
    expect(chart.drillRoot?.key).toBe('[0,"Europe"]');
    const live = chart.root.querySelector("[aria-live]")!;
    expect(live.textContent).toMatch(
      /^Europe\. Treemap of revenue by region \/ country \/ city in Europe:/,
    );
    await click(chart, ...corner(itemNamed(chart, "Europe / France")));
    expect(drills.at(-1)!.path.map(({ label }) => label)).toEqual(["Europe", "France"]);
    // A leaf has nothing under it: a click there drills no further.
    await click(chart, ...corner(itemNamed(chart, "Europe / France / Paris")));
    expect(drills).toHaveLength(2);
    // The breadcrumbs: buttons over the steps drawn, the last the current place.
    const tree = await accessibilityTree("figure", []);
    const nav = tree.findIndex((line) => line.includes("navigation"));
    expect(tree.slice(nav, nav + 8)).toEqual([
      '  navigation "Path"',
      '    button "All"',
      '      StaticText "All"',
      '    button "Europe"',
      '      StaticText "Europe"',
      '    generic ""',
      '      StaticText "France"',
      '  toolbar "Tree"',
    ]);
    const europe = chart.root.querySelector<HTMLElement>("nav button:nth-of-type(2)")!;
    const box = europe.getBoundingClientRect();
    const at = chart.root.getBoundingClientRect();
    await click(chart, box.left - at.left + box.width / 2, box.top - at.top + box.height / 2);
    expect(drills.at(-1)!.key).toBe('[0,"Europe"]');
  });

  it("open the node read with Enter, go up with Backspace, and the whole tree with 0", async () => {
    const chart = await mount({
      marks: [treemap(sales(), { path: ["region", "country", "city"], value: "revenue" })],
      interaction: { zoom: true },
    });
    const drills = heard(chart, "drill");
    chart.root.focus();
    // The first node read is the largest region, Asia, then its largest country.
    await userEvent.keyboard("{ArrowRight}");
    await userEvent.keyboard("{Enter}");
    expect(drills.at(-1)!.key).toBe('[0,"Asia"]');
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(drills.at(-1)!.key).toBe('[0,"Asia","Japan"]');
    await userEvent.keyboard("{Backspace}");
    expect(drills.at(-1)!.key).toBe('[0,"Asia"]');
    await userEvent.keyboard("{0}");
    expect(drills.at(-1)!.key).toBeNull();
    chart.render();
    const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain("Enter opens the node read");
  });

  it("select a node's rows by click when a row selection takes clicks, and drill with Enter", async () => {
    const data = sales();
    const store = selectionStore(data);
    const chart = await mount({
      marks: [treemap(data, { path: ["region", "country", "city"], value: "revenue" })],
      interaction: { zoom: true },
      rowSelection: rowSelection({ store, channel: "picked" }),
    });
    const drills = heard(chart, "drill");
    await click(chart, ...corner(itemNamed(chart, "Europe")));
    const held = store.get("picked");
    expect(held?.kind === "rows" && [...held.rows.positions()]).toEqual([0, 1, 2]);
    expect(drills).toEqual([]);
    chart.root.focus();
    await userEvent.keyboard("{ArrowRight}{Enter}");
    expect(drills.at(-1)!.key).toBe('[0,"Asia"]');
    // Space selects the rows of the node read, as clicks do: Japan's.
    await userEvent.keyboard("{ArrowRight} ");
    const after = store.get("picked");
    expect(after?.kind === "rows" && [...after.rows.positions()]).toEqual([3]);
  });

  it("draw every branch of a drilled tree, and report when the data takes its root", async () => {
    const data = sales();
    const chart = await mount({
      marks: [treemap(data, { path: ["region", "country", "city"], value: "revenue" })],
      interaction: { zoom: true },
    });
    const drills = heard(chart, "drill");
    chart.setDrillRoot(["Europe"]);
    chart.render();
    // France and Spain: a group and a leaf rectangle geometry each, all in the page.
    const scene = modelOf(chart).scene(() => 0);
    const rects = scene.panels[0]!.marks.filter((m) => m.kind === "rect").length;
    expect(chart.root.querySelectorAll('[data-kind="rect"]').length).toBe(rects);
    chart.setDrillRoot(["Europe", "Spain"]);
    chart.render();
    data.reset({
      region: ["Europe", "Asia"],
      country: ["France", "Japan"],
      city: ["Paris", "Tokyo"],
      revenue: [40, 50],
    });
    await frame();
    expect(drills.at(-1)).toEqual({
      key: '[0,"Europe"]',
      path: [{ key: '[0,"Europe"]', label: "Europe" }],
    });
  });

  it("report the data's change of root before a listener drills again", async () => {
    const data = sales();
    const chart = await mount({
      marks: [treemap(data, { path: ["region", "country", "city"], value: "revenue" })],
      interaction: { zoom: true },
    });
    chart.setDrillRoot(["Europe", "Spain"]);
    chart.render();
    const drills: (string | null)[] = [];
    chart.on("drill", ({ key }) => {
      drills.push(key);
      if (key === '[0,"Europe"]') chart.setDrillRoot(["Asia"]);
    });
    data.reset({
      region: ["Europe", "Asia"],
      country: ["France", "Japan"],
      city: ["Paris", "Tokyo"],
      revenue: [40, 50],
    });
    await frame();
    await frame();
    expect(drills).toEqual(['[0,"Europe"]', '[0,"Asia"]']);
    expect(chart.drillRoot?.key).toBe('[0,"Asia"]');
  });

  it("go up from the root set when the data took it before a frame", async () => {
    const org = table({
      name: ["CEO", "CTO", "Dev", "CFO"],
      boss: [null, "CEO", "CTO", "CEO"],
      cost: [5, 3, 2, 4],
    });
    const chart = await mount({
      marks: [treemap(org, { node: "name", parent: "boss", value: "cost" })],
      interaction: { zoom: true },
    });
    chart.setDrillRoot(["CEO", "CTO", "Dev"]);
    chart.render();
    chart.root.focus();
    org.reset({ name: ["CEO", "CFO"], boss: [null, "CEO"], cost: [5, 4] });
    press(chart, "Backspace");
    chart.root.querySelector<HTMLElement>("[aria-label='Up one level']")!.click();
    await frame();
    expect(chart.drillRoot?.key).toBeNull();
  });

  it("go up from a root set but not drawn yet", async () => {
    const org = table({
      name: ["CEO", "CTO", "Dev", "CFO"],
      boss: [null, "CEO", "CTO", "CEO"],
      cost: [5, 3, 2, 4],
    });
    const chart = await mount({
      marks: [treemap(org, { node: "name", parent: "boss", value: "cost" })],
      interaction: { zoom: true },
    });
    chart.root.focus();
    chart.setDrillRoot(["CEO", "CTO"]);
    press(chart, "Backspace");
    await frame();
    expect(chart.drillRoot?.path.map(({ label }) => label)).toEqual(["CEO"]);
  });

  it("fold a deep path, its folded steps still buttons, the nearest on top", async () => {
    const names = Array.from({ length: 9 }, (_, i) => `Department ${i + 1}`);
    const org = table({
      name: [...names, ...names.map((name) => `${name} team`)],
      boss: [null, ...names.slice(0, -1), ...names],
      cost: [...names.map(() => 0), ...names.map(() => 1)],
    });
    const chart = await mount({
      marks: [treemap(org, { node: "name", parent: "boss", value: "cost" })],
      interaction: { zoom: true },
    });
    const drills = heard(chart, "drill");
    chart.setDrillRoot(names.slice(0, 8));
    await frame();
    const tree = await accessibilityTree("figure", []);
    const nav = tree.indexOf('  navigation "Path"');
    const buttons = tree
      .slice(nav, tree.indexOf('  toolbar "Tree"'))
      .filter((line) => /^ {4}button/.test(line));
    expect(buttons).toEqual(["All", ...names.slice(0, 7)].map((name) => `    button "${name}"`));
    // A click on the fold goes to the step nearest the parent it hides.
    const shown = modelOf(chart).items!.result()!.drill!.crumbs;
    const folded = shown.filter(({ x }) => x === shown[1]!.x);
    expect(folded.length).toBeGreaterThan(1);
    const { x, y, width, height } = folded.at(-1)!;
    await click(chart, x + width / 2, y + height / 2);
    await frame();
    expect(drills.at(-1)!.path.at(-1)!.label).toBe(folded.at(-1)!.label);
  });

  it("go back up from a sunburst's middle", async () => {
    const chart = await mount({
      marks: [sunburst(sales(), { path: ["region", "country"], value: "revenue" })],
      interaction: { zoom: true },
    });
    const drills = heard(chart, "drill");
    const asia = itemNamed(chart, "Asia").points[0]!;
    await click(chart, asia.px, asia.py);
    expect(drills.at(-1)!.key).toBe('[0,"Asia"]');
    const middle = modelOf(chart).inspectItem('[0,"Asia"]')!.points[0]!;
    await click(chart, middle.px, middle.py);
    expect(drills.at(-1)!.key).toBeNull();
    await userEvent.click(chart.root.querySelector<HTMLElement>("nav button") ?? chart.root);
  });
});

describe("networks", () => {
  const ring = () => table({ from: ["a", "b", "c", "d"], to: ["b", "c", "d", "a"] });
  const network = (options: Partial<ChartOptions> = {}) =>
    mount({
      marks: [graph(ring(), { source: "from", target: "to" })],
      interaction: { drag: true },
      ...options,
    });
  const where = (chart: Chart, name: string) => {
    const { px, py } = modelOf(chart).inspectItem(JSON.stringify([0, name]))!.points[0]!;
    return [px, py] as [number, number];
  };

  it("move a node dragged, which stays where it is dropped, its links following", async () => {
    const chart = await network();
    const moves = heard(chart, "itemMove");
    const clicks = heard(chart, "click");
    const [ax, ay] = where(chart, "a");
    const b = where(chart, "b");
    await drag(chart, [ax, ay], [ax + 40, ay + 30]);
    await frame();
    expect(moves).toHaveLength(1);
    expect(moves[0]!.key).toBe('[0,"a"]');
    expect(moves[0]!.position).not.toBeNull();
    const [nx, ny] = where(chart, "a");
    expect(nx).toBeCloseTo(ax + 40, 0);
    expect(ny).toBeCloseTo(ay + 30, 0);
    expect(where(chart, "b")).toEqual(b);
    expect(clicks).toEqual([]);
    // It stays as the chart redraws, and goes back with the toolbar's button.
    chart.render();
    expect(where(chart, "a")[0]).toBeCloseTo(ax + 40, 0);
    await userEvent.click(
      chart.root.querySelector<HTMLElement>("[aria-label='Put moved nodes back']")!,
    );
    await frame();
    expect(moves.at(-1)).toEqual({ key: '[0,"a"]', position: null });
    expect(where(chart, "a")[0]).toBeCloseTo(ax, 6);
  });

  it("move the node read with Shift and the arrow keys, and put it back with 0", async () => {
    const chart = await network();
    const moves = heard(chart, "itemMove");
    const live = chart.root.querySelector("[aria-live]")!;
    chart.root.focus();
    await userEvent.keyboard("{ArrowRight}");
    const key = moves.length === 0 ? live.textContent : "";
    expect(key).toMatch(/^Links\. a: /);
    const [x, y] = where(chart, "a");
    await userEvent.keyboard("{Shift>}{ArrowRight}{/Shift}");
    await frame();
    expect(live.textContent).toBe("Moved a right.");
    expect(where(chart, "a")[0]).toBeCloseTo(x + 10, 0);
    expect(where(chart, "a")[1]).toBeCloseTo(y, 0);
    await userEvent.keyboard("{0}");
    await frame();
    expect(moves.at(-1)!.position).toBeNull();
    expect(where(chart, "a")[0]).toBeCloseTo(x, 6);
  });

  it("draw a node where it is dragged before it is dropped, and drop nothing the data took", async () => {
    const links = ring();
    const chart = await mount({
      marks: [graph(links, { source: "from", target: "to" })],
      interaction: { drag: true },
    });
    const moves = heard(chart, "itemMove");
    const [ax, ay] = where(chart, "a");
    await mouse(chart, "mouseMoved", ax, ay);
    await mouse(chart, "mousePressed", ax, ay);
    await mouse(chart, "mouseMoved", ax + 20, ay + 10, { held: true });
    await mouse(chart, "mouseMoved", ax + 40, ay + 20, { held: true });
    await frame();
    // Shown where the pointer is, not yet a move.
    expect(where(chart, "a")[0]).toBeCloseTo(ax + 40, 0);
    expect(moves).toEqual([]);
    // The network changes under the drag: it ends without a move or an error.
    links.reset({ from: ["b", "c"], to: ["c", "d"] });
    await frame();
    await mouse(chart, "mouseMoved", ax + 50, ay + 20, { held: true });
    await mouse(chart, "mouseReleased", ax + 50, ay + 20);
    await frame();
    expect(moves).toEqual([]);
  });

  it("drop nothing when the network loses the node before the drop is drawn", async () => {
    const links = ring();
    const chart = await mount({
      marks: [graph(links, { source: "from", target: "to" })],
      interaction: { drag: true },
    });
    const moves = heard(chart, "itemMove");
    const [ax, ay] = where(chart, "a");
    await mouse(chart, "mouseMoved", ax, ay);
    await mouse(chart, "mousePressed", ax, ay);
    await mouse(chart, "mouseMoved", ax + 30, ay, { held: true });
    // No frame between the change and the release.
    links.reset({ from: ["b", "c"], to: ["c", "d"] });
    await mouse(chart, "mouseReleased", ax + 30, ay);
    await frame();
    expect(moves).toEqual([]);
    expect(modelOf(chart).layoutSummary()).toMatch(/^Network of 3 nodes/);
  });

  it("move a node dragged by touch, which leaves the page where it is", async () => {
    const chart = await network();
    const moves = heard(chart, "itemMove");
    const [ax, ay] = where(chart, "a");
    const at = origin(chart);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", x: number, y: number) =>
      cdp().send("Input.dispatchTouchEvent", {
        type,
        touchPoints:
          type === "touchEnd"
            ? []
            : [{ x: at.x + x, y: at.y + y, radiusX: 1, radiusY: 1, force: 1 }],
      });
    expect(chart.root.style.touchAction).toBe("none");
    await touch("touchStart", ax, ay);
    await touch("touchMove", ax + 15, ay + 15);
    await touch("touchMove", ax + 30, ay + 30);
    await touch("touchEnd", ax + 30, ay + 30);
    await frame();
    expect(moves).toHaveLength(1);
    expect(where(chart, "a")[0]).toBeCloseTo(ax + 30, 0);
  });

  it("add up key moves before a frame, and put back moves the data took without failing", async () => {
    const links = ring();
    const chart = await mount({
      marks: [graph(links, { source: "from", target: "to" })],
      interaction: { drag: true },
    });
    chart.root.focus();
    await userEvent.keyboard("{ArrowRight}");
    const [x, y] = where(chart, "a");
    press(chart, "ArrowRight", true);
    press(chart, "ArrowRight", true);
    await frame();
    expect(where(chart, "a")[0]).toBeCloseTo(x + 20, 0);
    expect(where(chart, "a")[1]).toBeCloseTo(y, 0);
    // The node goes with a change not drawn yet: putting moves back, by key or button, fails nothing.
    links.reset({ from: ["b", "c"], to: ["c", "d"] });
    press(chart, "ArrowRight", true);
    press(chart, "0");
    chart.root.querySelector<HTMLElement>("[aria-label='Put moved nodes back']")!.click();
    await frame();
    expect(modelOf(chart).items!.movedItems.size).toBe(0);
  });

  it("stop a node the keys move at the room's edge, and turn it back at once", async () => {
    const chart = await network();
    chart.root.focus();
    await userEvent.keyboard("{ArrowRight}");
    for (let i = 0; i < 60; i++) press(chart, "ArrowRight", true);
    await frame();
    const [edge, y] = where(chart, "a");
    // Past the edge, with no frame between the presses, and with frames.
    for (let i = 0; i < 20; i++) press(chart, "ArrowRight", true);
    press(chart, "ArrowLeft", true);
    await frame();
    expect(where(chart, "a")[0]).toBeCloseTo(edge - 10, 0);
    for (const key of ["ArrowRight", "ArrowRight", "ArrowRight", "ArrowLeft"]) {
      press(chart, key, true);
      await frame();
    }
    expect(where(chart, "a")[0]).toBeCloseTo(edge - 10, 0);
    expect(where(chart, "a")[1]).toBeCloseTo(y, 0);
  });

  it("drop without failing when a render listener changes the network", async () => {
    const links = ring();
    const chart = await mount({
      marks: [graph(links, { source: "from", target: "to" })],
      interaction: { drag: true },
    });
    let reset = false;
    chart.on("render", () => {
      if (!reset) return;
      reset = false;
      links.reset({ from: ["b", "c"], to: ["c", "d"] });
    });
    const [ax, ay] = where(chart, "a");
    await mouse(chart, "mouseMoved", ax, ay);
    await mouse(chart, "mousePressed", ax, ay);
    await mouse(chart, "mouseMoved", ax + 30, ay, { held: true });
    reset = true;
    await frame();
    await mouse(chart, "mouseReleased", ax + 30, ay);
    await frame();
    expect(modelOf(chart).items!.movedItems.size).toBe(0);
  });

  it("drag the node drawn on top where nodes overlap", async () => {
    const nodes = table({ name: ["a", "b", "c", "d"], weight: [1, 9, 1, 1] });
    const chart = await network({
      marks: [graph(ring(), { source: "from", target: "to", nodes, node: "name", size: "weight" })],
    });
    // The small node a on the large node b, drawn above it.
    const [bx, by] = where(chart, "b");
    const moves = modelOf(chart).items!.result()!.moves!;
    const [x, y] = moves.toLayout('[0,"a"]', bx, by);
    chart.setItemPosition('[0,"a"]', { x, y });
    await frame();
    const moved = heard(chart, "itemMove");
    await drag(chart, [bx, by], [bx - 40, by]);
    await frame();
    expect(moved.map(({ key }) => key)).toEqual(['[0,"a"]']);
    expect(where(chart, "b")).toEqual([bx, by]);
  });

  it("move nothing without interaction.drag", async () => {
    const chart = await network({ interaction: {} });
    const moves = heard(chart, "itemMove");
    const [ax, ay] = where(chart, "a");
    await drag(chart, [ax, ay], [ax + 40, ay + 30]);
    expect(moves).toEqual([]);
    expect(where(chart, "a")).toEqual([ax, ay]);
  });
});
