// The page of the first-hover benchmark (run.ts): mounts one chart, or a
// dashboard of ten, moves the pointer onto the first a set time after it
// mounted, and reports how long the tooltip took to show.

import { createChart, line, table, time } from "herceg";

declare global {
  interface Window {
    firstHover: {
      /**
       * Milliseconds from the pointer's move to the tooltip being drawn (its
       * box shown: the frame that paints it has begun), and to the animation
       * frame after that.
       */
      run(options: { delay: number; charts: number }): Promise<[drawn: number, frame: number]>;
      /** Mounts a chart and waits for what it loads: an earlier visit, which caches the chunks. */
      warm(): Promise<void>;
    };
  }
}

/** A day of minutes, two series. */
function minutes() {
  const n = 1440;
  const start = Date.UTC(2026, 0, 1);
  return table({
    t: time(Float64Array.from({ length: n }, (_, i) => start + i * 60_000)),
    a: Float64Array.from({ length: n }, (_, i) => 50 + 20 * Math.sin(i / 60)),
    b: Float64Array.from({ length: n }, (_, i) => 40 + 15 * Math.cos(i / 45)),
  });
}

const tooltipOf = (root: Element) =>
  [...root.children].find(
    (el) => el.tagName === "DIV" && (el as HTMLElement).style.pointerEvents === "none",
  ) as HTMLElement | undefined;

window.firstHover = {
  async warm() {
    const host = document.createElement("div");
    host.style.cssText = "width:600px;height:300px";
    document.getElementById("stage")!.append(host);
    const chart = createChart(host, { marks: [line(minutes(), { x: "t", y: ["a", "b"] })] });
    await chart.loading;
    chart.destroy();
    host.remove();
  },

  async run({ delay, charts }) {
    const stage = document.getElementById("stage")!;
    const hosts = Array.from({ length: charts }, () => {
      const host = document.createElement("div");
      host.style.cssText = "width:600px;height:300px;display:inline-block";
      stage.append(host);
      return host;
    });
    const data = minutes();
    const created = hosts.map((host) =>
      createChart(host, { marks: [line(data, { x: "t", y: ["a", "b"] })], timeZone: "UTC" }),
    );
    // The delay runs from createChart returning (the last chart's).
    const mounted = performance.now();
    const chart = created[0]!;
    // Input a set time after mounting, whatever has loaded by then.
    await new Promise<void>((resolve) =>
      setTimeout(resolve, Math.max(0, mounted + delay - performance.now())),
    );
    const rect = chart.root.getBoundingClientRect();
    const { plot } = chart.getPanels()[0]!;
    const shown = new Promise<[number, number]>((resolve) => {
      const observer = new MutationObserver(() => {
        if (tooltipOf(chart.root)?.style.display !== "block") return;
        observer.disconnect();
        const drawn = performance.now() - input;
        requestAnimationFrame(() => resolve([drawn, performance.now() - input]));
      });
      observer.observe(chart.root, { subtree: true, childList: true, attributes: true });
    });
    const input = performance.now();
    chart.root.dispatchEvent(
      new PointerEvent("pointermove", {
        bubbles: true,
        clientX: rect.left + plot.x + plot.width / 2,
        clientY: rect.top + plot.y + plot.height / 2,
      }),
    );
    return shown;
  },
};
