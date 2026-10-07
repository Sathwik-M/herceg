// Runtime behavior that earlier versions got wrong.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { schedule } from "../../src/dom/scheduler.ts";
import { line } from "../../src/marks/line.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => host.remove());

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describe("runtime regressions", () => {
  it("keeps the value under the pointer fixed when zooming a log axis", () => {
    const data = table({ x: [1, 10, 100], y: [1, 2, 3] });
    const chart = createChart(host, {
      x: { type: "log" },
      interaction: { zoom: true },
      marks: [line(data, { x: "x", y: "y" })],
    });
    const before = chart.model.xScale()!;
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
    const after = chart.model.xScale()!;
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
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const description = document.getElementById(chart.root.getAttribute("aria-describedby")!)!;
    expect(description.textContent).toContain("to 300");
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
});
