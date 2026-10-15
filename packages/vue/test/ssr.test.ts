// Server rendering: Vue's renderToString writes the chart's snapshot, and
// createSSRApp().mount takes it over without a mismatch, the chart adopting
// its nodes.

import { type Chart as HercegChart, hydration, line, renderToSnapshot, rule, table } from "herceg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSSRApp, defineComponent, h, nextTick, shallowRef } from "vue";
import { renderToString } from "vue/server-renderer";
import { Chart } from "../src/index.ts";

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

const sales = table({ month: [1, 2, 3, 4, 5], units: [12, 18, 9, 22, 15] });
const marks = [line(sales, { x: "month", y: "units" }), rule({ y: 15, label: "Target" })];

describe("server rendering", () => {
  it("hydrates without a mismatch, and the chart takes the server's nodes over", async () => {
    const initial = hydration(
      renderToSnapshot({ title: "Units", marks }, { width: 600, height: 320, idPrefix: "units" }),
    );
    const chart = shallowRef<HercegChart | null>(null);
    const title = shallowRef("Units");
    const App = defineComponent({
      setup: () => () =>
        h(Chart, {
          title: title.value,
          marks,
          initial,
          ref: (component: unknown) => {
            chart.value = (component as { chart: HercegChart | null } | null)?.chart ?? null;
          },
        }),
    });
    host.innerHTML = await renderToString(createSSRApp(App));
    const figure = host.querySelector("[role=figure]")!;
    const nodes = [...host.querySelectorAll("svg [data-kind]")];
    expect(nodes.length).toBeGreaterThan(1);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = createSSRApp(App);
    app.mount(host);
    await nextTick();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(chart.value!.root).toBe(figure);
    expect([...host.querySelectorAll("svg [data-kind]")]).toEqual(nodes);
    title.value = "Units sold";
    await nextTick();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    expect(figure.getAttribute("aria-label")).toBe("Units sold");
    app.unmount();
  });
});
