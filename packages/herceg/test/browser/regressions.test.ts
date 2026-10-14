// Runtime behavior that earlier versions got wrong.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { server } from "vitest/browser";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { schedule } from "../../src/dom/scheduler.ts";
import { line } from "../../src/marks/line.ts";
import { modelOf } from "./helpers.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => host.remove());

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("runtime regressions", () => {
  it("sizes to the container's border box, whatever its writing mode", async () => {
    const data = table({ x: [0, 1], y: [0, 1] });
    host.style.cssText = "width:600px;height:300px;border:10px solid transparent";
    const chart = createChart(host, { marks: [line(data, { x: "x", y: "y" })] });
    await expect.poll(() => [modelOf(chart).width, modelOf(chart).height]).toEqual([620, 320]);
    host.style.cssText = "width:600px;height:300px;writing-mode:vertical-rl";
    await expect.poll(() => [modelOf(chart).width, modelOf(chart).height]).toEqual([600, 300]);
    chart.destroy();
  });

  // Firefox measures an inline element holding a block as that block, not
  // the box it lies in, so there a chart in one keeps its first width (a
  // known limit, docs/architecture.md).
  const inlineMeasured = server.browser !== "firefox";

  it.skipIf(!inlineMeasured)(
    "follows an inline host, which gets no resize notifications",
    async () => {
      const data = table({ x: [0, 1], y: [0, 1] });
      // As wide as the content of the box it is in, padding left out.
      host.style.padding = "0 20px";
      const span = document.createElement("span");
      host.append(span);
      const chart = createChart(span, { marks: [line(data, { x: "x", y: "y" })] });
      await expect.poll(() => modelOf(chart).width).toBe(600);
      host.style.width = "800px";
      chart.update({});
      await expect.poll(() => modelOf(chart).width).toBe(800);
      chart.destroy();
    },
  );

  it.skipIf(!inlineMeasured)(
    "measures an inline host as the box it is in, whatever the root's own styles",
    async () => {
      const data = table({ x: [0, 1], y: [0, 1] });
      const style = document.createElement("style");
      // Rules for the host's children, the chart's root among them: the box
      // the host is in decides.
      style.textContent = `span > div:last-child { margin: 0 20px; max-width: 200px;
      transition: width 1s linear; writing-mode: vertical-rl }
      span > div { width: 300px !important }`;
      document.head.append(style);
      const span = document.createElement("span");
      host.append(span);
      try {
        const chart = createChart(span, {
          height: 300,
          marks: [line(data, { x: "x", y: "y" })],
        });
        for (const wide of [600, 800, 800]) {
          host.style.width = `${wide}px`;
          chart.render();
          expect(chart.toSVG()).toContain(`width="${wide}"`);
          await frame();
          expect(modelOf(chart).width).toBe(wide);
        }
        expect([...span.children]).toEqual([chart.root]);
        // A host that stops being inline is measured as any other.
        span.style.cssText = "display:flex;flex-direction:column;gap:20px";
        chart.render();
        await expect.poll(() => [modelOf(chart).width, modelOf(chart).height]).toEqual([800, 300]);
        chart.destroy();
      } finally {
        style.remove();
      }
    },
  );

  it.skipIf(!inlineMeasured)(
    "follows an inline host in a shadow root, or slotted into one, open or closed",
    async () => {
      const data = table({ x: [0, 1], y: [0, 1] });
      for (const [where, mode] of [
        ["inside", "open"],
        ["slotted", "open"],
        ["slotted", "closed"],
      ] as const) {
        const outer = document.createElement("div");
        host.append(outer);
        const shadow = outer.attachShadow({ mode });
        const span = document.createElement("span");
        // Slotted, the span is laid out in the slot's box: a wrapper narrower
        // than the page around it.
        if (where === "slotted") {
          shadow.innerHTML = '<div style="width:350px"><slot></slot></div>';
          outer.append(span);
        } else shadow.append(span);
        const chart = createChart(span, { marks: [line(data, { x: "x", y: "y" })] });
        const wide = where === "slotted" ? 350 : 600;
        await expect.poll(() => modelOf(chart).width).toBe(wide);
        const box = where === "slotted" ? shadow.querySelector("div")! : host;
        box.style.width = `${wide + 100}px`;
        chart.update({});
        await expect.poll(() => modelOf(chart).width).toBe(wide + 100);
        host.style.width = "600px";
        chart.destroy();
        outer.remove();
      }
    },
  );

  it("summarizes the data drawn last, not data changed while offscreen", async () => {
    const data = table({ x: [0, 1, 2], y: [10, 20, 30] });
    const chart = createChart(host, { marks: [line(data, { x: "x", y: "y" })] });
    // A second change within the throttle window schedules a delayed summary.
    data.appendRow({ x: 3, y: 40 });
    chart.render();
    host.style.cssText = "position:absolute;top:-10000px;width:600px;height:300px";
    await frame();
    await frame();
    data.appendRow({ x: 4, y: 50 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
    expect(description.textContent).not.toContain("5 points");
    host.style.cssText = "width:600px;height:300px";
    // The chart draws on the frame after its visibility observer reports it
    // back, which Firefox may do frames later.
    await expect.poll(() => description.textContent).toContain("5 points");
    expect(description.textContent).toContain("last 50");
    chart.destroy();
  });

  it("uses the current container size for an explicit render", async () => {
    const data = table({ x: [0, 1], y: [0, 1] });
    const chart = createChart(host, { marks: [line(data, { x: "x", y: "y" })] });
    await frame();
    await frame();
    host.style.width = "450px";
    chart.render();
    expect(modelOf(chart).width).toBe(450);
    host.style.width = "500px";
    expect(chart.toSVG()).toContain('width="500"');
    chart.destroy();
  });

  it("keeps the value under the pointer fixed when zooming a log axis", () => {
    const data = table({ x: [1, 10, 100], y: [1, 2, 3] });
    const chart = createChart(host, {
      x: { type: "log" },
      interaction: { zoom: true },
      marks: [line(data, { x: "x", y: "y" })],
    });
    const before = modelOf(chart).xScale()!;
    const px = before.map(10);
    const rect = chart.root.getBoundingClientRect();
    chart.root.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -300,
        clientX: rect.left + px,
        bubbles: true,
        cancelable: true,
      }),
    );
    chart.render();
    const after = modelOf(chart).xScale()!;
    expect(after.domain[0]).toBeGreaterThan(0);
    expect(after.map(10)).toBeCloseTo(px, 0);
    chart.destroy();
  });

  it("cleans up when construction fails", () => {
    const data = table({ x: [0, 1], y: [0, 1] });
    expect(() =>
      createChart(host, {
        marks: [line(data, { x: "x", y: "y" })],
        y: { type: "log", domain: [0, 10] },
      }),
    ).toThrow();
    expect(host.childElementCount).toBe(0);
  });

  it("keeps focus on a legend button after toggling it", () => {
    const data = table({ x: [0, 1], a: [0, 1], b: [1, 0] });
    const chart = createChart(host, { marks: [line(data, { x: "x", y: ["a", "b"] })] });
    const button = chart.root.querySelectorAll("button")[1]!;
    button.focus();
    button.click();
    chart.render();
    expect(document.activeElement).toBe(button);
    expect(button.getAttribute("aria-pressed")).toBe("false");
    chart.destroy();
  });

  it("refreshes the accessible summary after a burst of updates", async () => {
    const data = table({ x: [0, 1, 2], y: [1, 2, 3] });
    const chart = createChart(host, { marks: [line(data, { x: "x", y: "y" })] });
    data.setColumn("y", [100, 200, 300]);
    chart.render();
    const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
    // Accessible summaries refresh at most once a second.
    await expect.poll(() => description.textContent, { timeout: 2000 }).toContain("to 300");
    chart.destroy();
  });

  it("steps through repeated x values with the keyboard", () => {
    const data = table({ x: [0, 0, 1], y: [5, 6, 7] });
    const chart = createChart(host, { marks: [line(data, { x: "x", y: "y" })] });
    const live = chart.root.querySelector("[aria-live]")!;
    const press = (key: string) =>
      chart.root.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    press("ArrowRight");
    expect(live.textContent).toContain("y: 5");
    press("ArrowRight");
    expect(live.textContent).toContain("y: 6");
    press("ArrowRight");
    expect(live.textContent).toContain("y: 7");
    chart.destroy();
  });

  it("keeps rendering other charts when one throws", async () => {
    const data = table({ x: [0, 1], y: [0, 1] });
    const chart = createChart(host, { marks: [line(data, { x: "x", y: "y" })] });
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => {
      errors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener("error", onError);
    schedule({
      visible: true,
      flush: () => {
        throw new Error("broken chart");
      },
    });
    const before = chart.root.querySelector("svg g[clip-path] path")!.getAttribute("d");
    data.setColumn("y", [1, 0]);
    await frame();
    await Promise.resolve();
    window.removeEventListener("error", onError);
    expect(errors).toHaveLength(1);
    expect(chart.root.querySelector("svg g[clip-path] path")!.getAttribute("d")).not.toBe(before);
    chart.destroy();
  });

  it("keeps the lowest y label clear of the first x label in large text", () => {
    const chart = createChart(host, {
      locale: "en-US",
      theme: { fontSize: 24 },
      x: { domain: [1000, 2000], ticks: 2 },
      y: { format: { minimumFractionDigits: 4 } },
      marks: [line(table({ x: [1000, 2000], y: [10000, 20000] }), { x: "x", y: "y" })],
    });
    // Where each label's glyphs are, which engines agree on: text boxes are
    // the font's ascent and descent, which they read from different tables
    // (28 pixels tall in Chrome and WebKit, 30 in Firefox). The box's top is
    // the ascent above the baseline; the glyphs reach as far as canvas
    // metrics of the same font say.
    const context = document.createElement("canvas").getContext("2d")!;
    const labels = (selector: string) =>
      [...chart.root.querySelectorAll<SVGTextElement>(`svg text[${selector}]`)].map((text) => {
        const box = text.getBBox();
        const style = getComputedStyle(text);
        context.font = `${style.fontSize} ${style.fontFamily}`;
        const metrics = context.measureText(text.textContent ?? "");
        const baseline = box.y + metrics.fontBoundingBoxAscent;
        const top = baseline - metrics.actualBoundingBoxAscent;
        const ink = new DOMRect(
          box.x,
          top,
          box.width,
          baseline + metrics.actualBoundingBoxDescent - top,
        );
        return { box, ink };
      });
    const xLabels = labels('dominant-baseline="hanging"');
    const yLabels = labels('text-anchor="end"');
    expect(xLabels.length * yLabels.length).toBeGreaterThan(0);
    // Apart by a quarter of the text's size at least, where they would overlap across.
    const apart = (p: DOMRect, q: DOMRect) =>
      p.x >= q.x + q.width || q.x >= p.x + p.width || Math.max(p.y - q.bottom, q.y - p.bottom) >= 6;
    expect(xLabels.every(({ ink: p }) => yLabels.every(({ ink: q }) => apart(p, q)))).toBe(true);
    // The x labels still fit inside the chart.
    const bottom = Math.max(...xLabels.map(({ box }) => box.y + box.height));
    expect(bottom).toBeLessThanOrEqual(host.getBoundingClientRect().height);
    chart.destroy();
  });
});
