// View limits, edge events, sync channels, and the cursor API.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { category, time } from "../../src/data/column.ts";
import { table } from "../../src/data/table.ts";
import { type Chart, type ChartOptions, createChart } from "../../src/dom/chart.ts";
import type { ChartEvents } from "../../src/dom/events.ts";
import { bar } from "../../src/marks/bar.ts";
import { line } from "../../src/marks/line.ts";
import { facet } from "../../src/model/facet.ts";
import { panels } from "../../src/model/panels.ts";
import { timeBreaks } from "../../src/scale/breaks.ts";
import { MOUSE } from "./helpers.ts";

let hosts: HTMLDivElement[] = [];

function host(): HTMLDivElement {
  const element = document.createElement("div");
  element.style.cssText = "width:600px;height:300px";
  document.body.append(element);
  hosts.push(element);
  return element;
}

beforeEach(() => {
  hosts = [];
});

afterEach(() => {
  for (const element of hosts) element.remove();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** A day of minutes, from `start` (epoch ms). */
function minutes(start: number, count: number) {
  return {
    t: time(Float64Array.from({ length: count }, (_, i) => start + i * 60_000)),
    v: Float64Array.from({ length: count }, (_, i) => Math.sin(i / 30)),
  };
}

function drag(chart: Chart, from: number, to: number) {
  const rect = chart.root.getBoundingClientRect();
  const { plot } = chart.getPanels()[0]!;
  const y = rect.top + plot.y + plot.height / 2;
  const at = (type: string, x: number) =>
    chart.root.dispatchEvent(
      new PointerEvent(type, {
        bubbles: true,
        clientX: rect.left + x,
        clientY: y,
        pointerId: MOUSE,
        button: 0,
      }),
    );
  return {
    start: () => at("pointerdown", from),
    move: (x: number) => at("pointermove", x),
    end: (x: number) => at("pointerup", x),
    whole() {
      this.start();
      this.move((from + to) / 2);
      this.move(to);
      this.end(to);
    },
  };
}

function heard<K extends keyof ChartEvents>(chart: Chart, type: K): ChartEvents[K][] {
  const events: ChartEvents[K][] = [];
  chart.on(type, (event) => events.push(event));
  return events;
}

describe("limits", () => {
  it("keep every change of view inside the extent, pans keeping their span", () => {
    const chart = createChart(host(), {
      marks: [line(table({ x: [0, 50, 100], y: [1, 2, 3] }), { x: "x", y: "y" })],
      interaction: { pan: "x", limits: { x: { extent: [0, 100] } } },
    });
    chart.setViewport([-30, 20]);
    expect(chart.getViewport().x).toEqual([0, 50]);
    chart.setViewport([60, 150]);
    expect(chart.getViewport().x).toEqual([10, 100]);
    // Wider than the extent: the extent.
    chart.setViewport([-50, 200]);
    expect(chart.getViewport().x).toEqual([0, 100]);
    chart.setViewport([10, 30]);
    chart.render();
    const { plot } = chart.getPanels()[0]!;
    drag(chart, plot.x + 10, plot.x + plot.width).whole();
    const [lo, hi] = chart.getViewport().x!;
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(20, 6);
    chart.destroy();
  });

  it("hold views inside limits that change, and read log axes from the options", () => {
    const chart = createChart(host(), {
      marks: [line(table({ x: [1, 10, 100], y: [1, 2, 3] }), { x: "x", y: "y" })],
      interaction: { limits: { x: { extent: [0, 100] } } },
    });
    chart.setViewport([60, 80]);
    chart.update({ interaction: { limits: { x: { extent: [0, 50] } } } });
    expect(chart.getViewport().x).toEqual([30, 50]);
    // A log axis not drawn yet: by ratios, the view's own kept.
    chart.update({ x: { type: "log" }, interaction: { limits: { x: { extent: [null, 100] } } } });
    chart.setViewport([20, 200]);
    const [lo, hi] = chart.getViewport().x!;
    expect(lo).toBeCloseTo(10, 6);
    expect(hi).toBeCloseTo(100, 6);
    expect(() => chart.render()).not.toThrow();
    chart.destroy();
  });

  it("report and share views that limits changed by update moved", () => {
    const options = (extent: readonly [number, number]) => ({
      marks: [line(table({ x: [0, 50, 100], y: [1, 2, 3] }), { x: "x", y: "y" })],
      interaction: { limits: { x: { extent } }, sync: { viewport: "tight" } },
    });
    const chart = createChart(host(), options([0, 100]));
    const peer = createChart(host(), options([0, 100]));
    chart.setViewport([60, 80]);
    expect(peer.getViewport().x).toEqual([60, 80]);
    const views = heard(chart, "viewport");
    chart.update(options([0, 50]));
    expect(views.map(({ x }) => x)).toEqual([[30, 50]]);
    expect(peer.getViewport().x).toEqual([30, 50]);
    // Limits that run backwards are refused, changing nothing.
    expect(() => chart.update(options([100, 0]))).toThrow(
      "interaction.limits.x.extent: expected two finite numbers, ascending",
    );
    expect(chart.getViewport().x).toEqual([30, 50]);
    chart.destroy();
    peer.destroy();
  });

  it("leave an end without a bound open, and refuse an extent that runs backwards", () => {
    const chart = createChart(host(), {
      marks: [line(table({ x: [0, 50, 100], y: [1, 2, 3] }), { x: "x", y: "y" })],
      interaction: { limits: { x: { extent: [0, null] } } },
    });
    chart.setViewport([500, 900]);
    expect(chart.getViewport().x).toEqual([500, 900]);
    chart.setViewport([-10, 30]);
    expect(chart.getViewport().x).toEqual([0, 40]);
    chart.destroy();
  });
});

describe("edges", () => {
  it("report coming near an end once, and again after moving away", async () => {
    const start = Date.UTC(2026, 0, 1);
    const chart = createChart(host(), {
      marks: [line(table(minutes(start, 600)), { x: "t", y: "v" })],
      interaction: {
        pan: "x",
        limits: { x: { extent: [start, null], edge: { threshold: 0.1, hysteresis: 0.05 } } },
      },
    });
    const edges = heard(chart, "edge");
    const hour = 3_600_000;
    chart.setViewport([start + 4 * hour, start + 5 * hour]);
    await frame();
    expect(edges).toEqual([]);
    // A tenth of an hour from the start: near it.
    chart.setViewport([start + 0.05 * hour, start + 1.05 * hour]);
    await frame();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ scale: "x", side: "start", bound: start, cause: "api" });
    // Still near: no second event.
    chart.setViewport([start + 0.02 * hour, start + 1.02 * hour]);
    await frame();
    expect(edges).toHaveLength(1);
    // Within the hysteresis: not yet away.
    chart.setViewport([start + 0.12 * hour, start + 1.12 * hour]);
    await frame();
    chart.setViewport([start, start + hour]);
    await frame();
    expect(edges).toHaveLength(1);
    chart.setViewport([start + 0.3 * hour, start + 1.3 * hour]);
    await frame();
    chart.setViewport([start, start + hour]);
    await frame();
    expect(edges).toHaveLength(2);
    chart.destroy();
  });

  it("report again when the end moves, the view near it still", async () => {
    const start = Date.UTC(2026, 0, 1);
    const hour = 3_600_000;
    const limits = (from: number) => ({ x: { extent: [from, null] as const, edge: true } });
    const chart = createChart(host(), {
      marks: [line(table(minutes(start, 600)), { x: "t", y: "v" })],
      interaction: { pan: "x", limits: limits(start) },
    });
    const edges = heard(chart, "edge");
    chart.setViewport([start + 0.01 * hour, start + 1.01 * hour]);
    await frame();
    expect(edges.map(({ bound }) => bound)).toEqual([start]);
    // History loaded: the end moved, a little.
    chart.update({ interaction: { pan: "x", limits: limits(start - 0.02 * hour) } });
    await frame();
    expect(edges.map(({ bound }) => bound)).toEqual([start, start - 0.02 * hour]);
    chart.destroy();
  });

  it("report each edge once, also to listeners that draw again", async () => {
    const start = Date.UTC(2026, 0, 1);
    const end = start + 59 * 60_000;
    const chart = createChart(host(), {
      marks: [line(table(minutes(start, 60)), { x: "t", y: "v" })],
      interaction: { limits: { x: { extent: [start, end], edge: true } } },
    });
    const sides: string[] = [];
    chart.on("edge", ({ side }) => {
      sides.push(side);
      chart.update({ title: `Near the ${side}` });
      chart.render();
    });
    await frame();
    await frame();
    expect(sides.sort()).toEqual(["end", "start"]);
    chart.destroy();
  });

  it("measure log axes by ratios, where ends that are not positive bound nothing", async () => {
    const chart = createChart(host(), {
      x: { type: "log" },
      marks: [line(table({ x: [1, 10, 100], y: [1, 2, 3] }), { x: "x", y: "y" })],
      interaction: { limits: { x: { extent: [-1, 1000], edge: true } } },
    });
    const edges = heard(chart, "edge");
    await frame();
    chart.setViewport([2, 50]);
    await frame();
    chart.setViewport([3, 40]);
    await frame();
    expect(edges).toEqual([]);
    chart.destroy();
  });

  it("report the edges a view is near as the chart starts, to listeners added after", async () => {
    const start = Date.UTC(2026, 0, 1);
    const chart = createChart(host(), {
      marks: [line(table(minutes(start, 60)), { x: "t", y: "v" })],
      interaction: { limits: { x: { extent: [start, null], edge: true } } },
    });
    const edges = heard(chart, "edge");
    await frame();
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ side: "start", bound: start });
    chart.destroy();
  });

  it("load history while dragging, the view holding where it is", async () => {
    const hour = 3_600_000;
    const start = Date.UTC(2026, 0, 1, 12);
    let loaded = start;
    const data = table(minutes(start, 360));
    const chart = createChart(host(), {
      marks: [line(data, { x: "t", y: "v" })],
      interaction: { pan: "x", limits: { x: { extent: [loaded, null], edge: true } } },
    });
    const edges = heard(chart, "edge");
    // History arrives as the view nears the oldest data loaded: older rows
    // go first, and the extent widens.
    chart.on("edge", ({ side }) => {
      if (side !== "start") return;
      loaded -= 3 * hour;
      const older = minutes(loaded, 180);
      const all = minutes(loaded, 180 + data.length);
      data.reset({ t: all.t, v: Float64Array.from([...older.v, ...data.numbers("v")]) });
      chart.update({
        interaction: { pan: "x", limits: { x: { extent: [loaded, null], edge: true } } },
      });
    });
    chart.setViewport([start + 2 * hour, start + 3 * hour]);
    chart.render();
    const { plot } = chart.getPanels()[0]!;
    const gesture = drag(chart, plot.x + 10, plot.x + plot.width);
    gesture.start();
    const viewsBefore: number[] = [];
    // Three plot widths: three hours, past the two loaded before the view.
    for (let i = 1; i <= 12; i++) {
      gesture.move(plot.x + 10 + (i * plot.width) / 4);
      viewsBefore.push(chart.getViewport().x![0]);
      await frame();
    }
    gesture.end(plot.x + 10 + 3 * plot.width);
    // The drag went on past the first history loaded, and the view moved
    // steadily: loading did not make it jump.
    expect(edges.filter(({ side }) => side === "start").length).toBeGreaterThanOrEqual(1);
    expect(loaded).toBeLessThan(start);
    expect(chart.getViewport().x![0]).toBeLessThan(start);
    for (let i = 1; i < viewsBefore.length; i++)
      expect(viewsBefore[i]!).toBeLessThanOrEqual(viewsBefore[i - 1]!);
    chart.destroy();
  });
});

describe("sync channels", () => {
  it("share only the channels named, each with its group", async () => {
    const data = table(minutes(Date.UTC(2026, 0, 1), 120));
    const a = createChart(host(), {
      marks: [line(data, { x: "t", y: "v" })],
      interaction: { zoom: "x", sync: { cursor: "ops" } },
    });
    const b = createChart(host(), {
      marks: [line(data, { x: "t", y: "v" })],
      interaction: { zoom: "x", sync: { cursor: "ops" } },
    });
    const hovers = heard(b, "hover");
    a.setViewport([Date.UTC(2026, 0, 1, 0, 30), Date.UTC(2026, 0, 1, 1)]);
    expect(b.getViewport().x).toBeNull();
    const rect = a.root.getBoundingClientRect();
    const { plot } = a.getPanels()[0]!;
    await frame();
    a.root.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: rect.left + plot.x + plot.width / 2,
        clientY: rect.top + plot.y + plot.height / 2,
      }),
    );
    await frame();
    expect(hovers.at(-1)?.inspection?.axis).toBe("x");
    a.destroy();
    b.destroy();
  });

  it("carry categories by name, so charts of other orders follow", async () => {
    const a = createChart(host(), {
      marks: [bar(table({ k: category(["a", "b", "c"]), v: [1, 2, 3] }), { x: "k", y: "v" })],
      interaction: { brush: "x", sync: "names" },
    });
    const b = createChart(host(), {
      marks: [bar(table({ k: category(["c", "b", "a"]), v: [3, 2, 1] }), { x: "k", y: "v" })],
      interaction: { brush: "x", sync: "names" },
    });
    // a's first two categories, a and b, are b's last two.
    a.select({ x: [0, 1], y: null, lasso: null });
    expect(b.selection?.x).toEqual([1, 2]);
    b.showCursor({ x: "b" });
    await b.loading;
    await frame();
    expect(a.root.querySelectorAll("svg line[visibility='visible']").length).toBeGreaterThan(0);
    a.destroy();
    b.destroy();
  });

  it("let a chart along y follow a chart along x through the channel's scale", () => {
    const a = createChart(host(), {
      marks: [line(table({ x: [0, 10, 20], y: [1, 2, 3] }), { x: "x", y: "y" })],
      interaction: { zoom: "x", sync: { viewport: "v" } },
    });
    const b = createChart(host(), {
      marks: [line(table({ x: [1, 2, 3], y: [0, 10, 20] }), { x: "x", y: "y", orient: "y" })],
      interaction: { zoom: "y", sync: { viewport: { group: "v", scale: "y" } } },
    });
    a.setViewport([5, 15]);
    expect(b.getViewport().y).toEqual([5, 15]);
    b.setViewport({ y: [2, 8] });
    expect(a.getViewport().x).toEqual([2, 8]);
    a.destroy();
    b.destroy();
  });
});

describe("sync channels along y", () => {
  it("share a y range with every chart of the group, without echoing it", () => {
    const charts = [0, 1, 2].map(() =>
      createChart(host(), {
        marks: [line(table({ x: [1, 2, 3], y: [0, 10, 20] }), { x: "x", y: "y", orient: "y" })],
        interaction: { zoom: "y", sync: { viewport: { group: "rows", scale: "y" } } },
      }),
    );
    const views = charts.map((chart) => heard(chart, "viewport"));
    charts[0]!.setViewport({ y: [2, 8] });
    for (const chart of charts) expect(chart.getViewport().y).toEqual([2, 8]);
    charts[2]!.setViewport({ y: [1, 5] });
    for (const chart of charts) expect(chart.getViewport().y).toEqual([1, 5]);
    // Each heard each change once.
    expect(views.map((heard) => heard.length)).toEqual([2, 2, 2]);
    for (const chart of charts) chart.destroy();
  });
});

describe("showCursor", () => {
  it("shows negative numbers and times before 1970 as any other", async () => {
    const chart = createChart(host(), {
      marks: [line(table({ x: [-20, -10, 0, 10], y: [1, 2, 3, 4] }), { x: "x", y: "y" })],
    });
    const hovers = heard(chart, "hover");
    chart.showCursor({ x: -10 });
    await frame();
    expect(hovers.at(-1)?.inspection?.points[0]?.value).toBe(2);
    chart.destroy();
  });

  it("shows the cursor without a tooltip, reports it, shares it, and hides it", async () => {
    const data = table({ x: [0, 1, 2, 3, 4], y: [1, 3, 2, 5, 4] });
    const a = createChart(host(), {
      marks: [line(data, { x: "x", y: "y" })],
      tooltip: false,
      interaction: { sync: { cursor: "c" } },
    });
    const b = createChart(host(), {
      marks: [line(data, { x: "x", y: "y" })],
      interaction: { sync: { cursor: "c" } },
    });
    const hovers = heard(a, "hover");
    const others = heard(b, "hover");
    a.showCursor({ x: 3 });
    await a.loading;
    await frame();
    expect(hovers.at(-1)?.inspection?.points[0]?.value).toBe(5);
    expect(others.at(-1)?.inspection?.points[0]?.value).toBe(5);
    // The crosshair shows where the tooltip is off: the cursor is the application's.
    const tooltip = [...a.root.children].find(
      (el) => el.tagName === "DIV" && (el as HTMLElement).style.pointerEvents === "none",
    ) as HTMLElement;
    expect(tooltip.style.display).not.toBe("block");
    a.hideCursor({ broadcast: false });
    await frame();
    expect(hovers.at(-1)?.inspection).toBeUndefined();
    expect(others.at(-1)?.inspection?.points[0]?.value).toBe(5);
    expect(() => a.showCursor({ x: Number.NaN })).toThrow(
      "showCursor x: expected a finite number or a category's name; received NaN",
    );
    a.destroy();
    b.destroy();
  });
});

/** Hours from `start` (epoch ms). */
function hours(start: number, count: number) {
  return {
    t: time(Float64Array.from({ length: count }, (_, i) => start + i * 3_600_000)),
    v: Float64Array.from({ length: count }, (_, i) => i),
  };
}

const tooltipOf = (chart: Chart) =>
  [...chart.root.children].filter(
    (el) =>
      el.tagName === "DIV" &&
      (el as HTMLElement).style.pointerEvents === "none" &&
      (el as HTMLElement).style.display === "block",
  );

/** Where the visible crosshairs cross, in pixels along x. */
const crosshairs = (chart: Chart) =>
  [...chart.root.querySelectorAll("svg line")]
    .filter((line) => line.getAttribute("visibility") === "visible")
    .map((line) => Number(line.getAttribute("x1")));

describe("synced cursors", () => {
  const start = Date.UTC(2026, 0, 5); // a Monday
  const hour = 3_600_000;

  it("follow a chart of another range with the cursor alone, leaving the view", async () => {
    const days2 = createChart(host(), {
      marks: [line(table(hours(start + 28 * 24 * hour, 48)), { x: "t", y: "v" })],
      interaction: { zoom: "x", sync: { cursor: "ops" } },
    });
    const days30 = createChart(host(), {
      marks: [line(table(hours(start, 30 * 24)), { x: "t", y: "v" })],
      interaction: { zoom: "x", sync: { cursor: "ops" } },
    });
    const hovers = heard(days30, "hover");
    const at = start + 29 * 24 * hour + 5 * hour;
    days2.showCursor({ x: at });
    await frame();
    expect(hovers.at(-1)?.inspection).toMatchObject({ axis: "x", value: at });
    expect(days30.getViewport().x).toBeNull();
    // Their own tooltip only where asked for.
    expect(tooltipOf(days30)).toHaveLength(0);
    days2.destroy();
    days30.destroy();
  });

  it("read the last hourly reading at or before a minute's time with previous", async () => {
    const minuteData = table(minutes(start, 24 * 60));
    const hourly = table(hours(start, 24));
    const by = createChart(host(), {
      marks: [line(minuteData, { x: "t", y: "v" })],
      interaction: { sync: { cursor: "readings" } },
    });
    // Small, so that all are on screen: charts off it do not draw.
    const small = () => {
      const element = host();
      element.style.height = "120px";
      return element;
    };
    const snapped = (snap: "previous" | "next" | "nearest") =>
      createChart(small(), {
        marks: [line(hourly, { x: "t", y: "v" })],
        interaction: { sync: { cursor: { group: "readings", snap } } },
      });
    const [previous, next, nearest] = [snapped("previous"), snapped("next"), snapped("nearest")];
    const heardOf = [previous, next, nearest].map((chart) => heard(chart, "hover"));
    by.showCursor({ x: start + 10 * hour + 37 * 60_000 });
    await frame();
    const read = heardOf.map((hovers) => hovers.at(-1)?.inspection);
    expect(read.map((inspection) => inspection?.value)).toEqual([
      start + 10 * hour,
      start + 11 * hour,
      start + 11 * hour,
    ]);
    expect(read[0]?.points.map(({ value }) => value)).toEqual([10]);
    // Before the first reading, previous has none to show.
    by.showCursor({ x: start - 30 * 60_000 });
    await frame();
    expect(heardOf[0]!.at(-1)?.inspection).toBeUndefined();
    for (const chart of [by, previous, next, nearest]) chart.destroy();
  });

  it("read the last point at or before a value among points at one x, past those not drawn", async () => {
    const chart = createChart(host(), {
      marks: [line(table({ x: [0, 1, 1, 2], y: [10, Number.NaN, 25, 30] }), { x: "x", y: "y" })],
    });
    const hovers = heard(chart, "hover");
    chart.showCursor({ x: 1 }, { snap: "previous" });
    await frame();
    expect(hovers.at(-1)?.inspection?.points.map(({ value }) => value)).toEqual([25]);
    chart.showCursor({ x: 1.5 }, { snap: "next" });
    await frame();
    expect(hovers.at(-1)?.inspection?.points.map(({ value }) => value)).toEqual([30]);
    chart.destroy();
  });

  it("show the receiving chart's tooltip when the channel asks, one to a chart", async () => {
    const by = createChart(host(), {
      marks: [line(table(hours(start, 48)), { x: "t", y: "v" })],
      interaction: { sync: { cursor: "tips" } },
    });
    const regions = table({
      ...hours(start, 48),
      region: category(Array.from({ length: 48 }, (_, i) => (i % 2 ? "north" : "south"))),
    });
    const faceted = createChart(host(), {
      marks: [line(regions, { x: "t", y: "v" })],
      facet: facet("region"),
      interaction: { sync: { cursor: { group: "tips", tooltip: true, snap: "previous" } } },
    });
    by.showCursor({ x: start + 6 * hour + 20 * 60_000 });
    await frame();
    expect(crosshairs(faceted)).toHaveLength(2);
    const shown = tooltipOf(faceted);
    expect(shown).toHaveLength(1);
    by.destroy();
    faceted.destroy();
  });

  it("show nothing for a time out of the receiver's view, or in a break it leaves out", async () => {
    const by = createChart(host(), {
      marks: [line(table(hours(start, 24 * 14)), { x: "t", y: "v" })],
      interaction: { sync: { cursor: "gaps" } },
    });
    const zoomed = createChart(host(), {
      marks: [line(table(hours(start, 24 * 14)), { x: "t", y: "v" })],
      interaction: { zoom: "x", sync: { cursor: "gaps" } },
    });
    const weekdays = createChart(host(), {
      x: { breaks: timeBreaks([{ weekdays: ["sat", "sun"] }]) },
      marks: [line(table(hours(start, 24 * 14)), { x: "t", y: "v" })],
      interaction: { sync: { cursor: "gaps" } },
    });
    zoomed.setViewport([start, start + 2 * 24 * hour]);
    const [inView, inBreak] = [heard(zoomed, "hover"), heard(weekdays, "hover")];
    // Saturday: after the zoomed view, and in the weekdays' break.
    by.showCursor({ x: start + 5 * 24 * hour + 12 * hour });
    await frame();
    expect(inView.at(-1)?.inspection).toBeUndefined();
    expect(inBreak.at(-1)?.inspection).toBeUndefined();
    expect(crosshairs(zoomed)).toEqual([]);
    expect(crosshairs(weekdays)).toEqual([]);
    for (const chart of [by, zoomed, weekdays]) chart.destroy();
  });

  it("share where the keyboard's cursor is, as the pointer's", async () => {
    const data = table({ x: [0, 1, 2, 3], y: [1, 2, 3, 4] });
    const by = createChart(host(), {
      marks: [line(data, { x: "x", y: "y" })],
      interaction: { sync: { cursor: "keys" } },
    });
    const other = createChart(host(), {
      marks: [line(data, { x: "x", y: "y" })],
      interaction: { sync: { cursor: "keys" } },
    });
    const hovers = heard(other, "hover");
    by.root.focus();
    by.root.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await frame();
    await frame();
    expect(hovers.at(-1)?.inspection?.value).toBe(3);
    // The pointer shares where it is; the keyboard, pressed again, where it is.
    const rect = by.root.getBoundingClientRect();
    const { plot } = by.getPanels()[0]!;
    const at = (type: string, x: number) =>
      by.root.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          clientX: rect.left + x,
          clientY: rect.top + plot.y + plot.height / 2,
          pointerId: MOUSE,
        }),
      );
    at("pointermove", plot.x + 2);
    await frame();
    expect(hovers.at(-1)?.inspection?.value).toBe(0);
    at("pointerleave", -10);
    by.root.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await frame();
    await frame();
    expect(hovers.at(-1)?.inspection?.value).toBe(3);
    // Leaving takes it back, as data gone from under it does.
    by.root.blur();
    await frame();
    await frame();
    expect(hovers.at(-1)?.inspection).toBeUndefined();
    by.root.focus();
    by.root.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    await frame();
    await frame();
    expect(hovers.at(-1)?.inspection?.value).toBe(3);
    by.update({
      marks: [line(table({ x: [] as number[], y: [] as number[] }), { x: "x", y: "y" })],
    });
    await frame();
    await frame();
    expect(hovers.at(-1)?.inspection).toBeUndefined();
    by.root.blur();
    by.destroy();
    other.destroy();
  });
});

describe("the cursor across panels", () => {
  const data = table({
    t: [0, 1, 2, 3, 4, 5],
    v: [1, 2, 3, 4, 5, 6],
  });
  const twoPanels = (extra: Partial<ChartOptions> = {}) =>
    createChart(host(), {
      panels: panels([{ id: "a" }, { id: "b" }]),
      marks: [
        line(data, { x: "t", y: "v", panel: "a" }),
        line(table({ t: [0, 2, 4], v: [6, 4, 2] }), { x: "t", y: "v", panel: "b" }),
      ],
      ...extra,
    });

  /** Where a value is drawn along x in a panel, in pixels of the chart. */
  const at = (chart: Chart, panel: string, value: number) =>
    chart.toPixel(value, { axis: "x", panel })!;
  /** A crosshair's x, as drawn at a value. */
  const crossing = (chart: Chart, panel: string, value: number) =>
    Math.round(at(chart, panel, value)) + 0.5;

  function hover(chart: Chart, panel: string, value: number) {
    const { plot } = chart.getPanels().find(({ key }) => key === panel)!;
    const rect = chart.root.getBoundingClientRect();
    chart.root.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: rect.left + at(chart, panel, value),
        clientY: rect.top + plot.y + plot.height / 2,
        pointerId: MOUSE,
      }),
    );
  }

  it("shows in the panels sharing the hovered one's x scale, its tooltip in that one", async () => {
    const chart = twoPanels();
    hover(chart, "a", 2);
    await frame();
    expect(crosshairs(chart).sort()).toEqual(
      [crossing(chart, "a", 2), crossing(chart, "b", 2)].sort(),
    );
    expect(tooltipOf(chart)).toHaveLength(1);
    // With tooltips asked for, each panel shows one.
    chart.update({ interaction: { sync: { panels: { tooltip: true } } } });
    hover(chart, "a", 2);
    await frame();
    expect(tooltipOf(chart)).toHaveLength(2);
    // Off, the hovered panel alone.
    chart.update({ interaction: { sync: { panels: false } } });
    hover(chart, "a", 2);
    await frame();
    expect(crosshairs(chart)).toHaveLength(1);
    chart.destroy();
  });

  it("reads panels with x scales of their own when asked, on their scales, as it snaps", async () => {
    const chart = twoPanels({ x: { scope: "panel" } });
    hover(chart, "a", 3);
    await frame();
    // Scales of their own: the hovered panel alone, by default.
    expect(crosshairs(chart)).toHaveLength(1);
    chart.update({
      x: { scope: "panel" },
      interaction: { sync: { panels: { snap: "previous" } } },
    });
    const hovers: number[] = [];
    hover(chart, "a", 3);
    await frame();
    expect(crosshairs(chart)).toHaveLength(2);
    // Panel b's last point at or before 3 is at 2.
    expect(crosshairs(chart)).toContain(crossing(chart, "b", 2));
    void hovers;
    chart.destroy();
  });

  it("follows the keyboard's cursor through one panel", async () => {
    const chart = twoPanels();
    chart.root.focus();
    for (const key of ["Home", "ArrowRight", "ArrowRight"])
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await frame();
    expect(crosshairs(chart).sort()).toEqual(
      [crossing(chart, "a", 2), crossing(chart, "b", 2)].sort(),
    );
    chart.destroy();
  });
});
