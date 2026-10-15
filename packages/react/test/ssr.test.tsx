// Server rendering: react-dom/server writes the chart's snapshot, and
// hydrateRoot takes it over without a mismatch, the chart adopting its nodes.

import { type Chart as HercegChart, hydration, line, renderToSnapshot, rule, table } from "herceg";
import { act, StrictMode } from "react";
import { createRoot, hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chart } from "../src/index.ts";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  host.remove();
});

const sales = table({
  month: [1, 2, 3, 4, 5],
  units: [12, 18, 9, 22, 15],
  goal: [14, 14, 14, 14, 14],
});
const marks = [line(sales, { x: "month", y: ["units", "goal"] }), rule({ y: 15, label: "Target" })];
const options = { title: "Units", locale: "en-US", timeZone: "UTC" } as const;

describe("server rendering", () => {
  it("hydrates without a mismatch, and the chart takes the server's nodes over", async () => {
    const initial = hydration(
      renderToSnapshot({ ...options, marks }, { width: 600, height: 320, idPrefix: "units" }),
    );
    let chart: HercegChart | null = null;
    const app = (
      <Chart
        {...options}
        marks={marks}
        initial={initial}
        ref={(value) => {
          chart = value;
        }}
      />
    );
    host.innerHTML = renderToString(app);
    const figure = host.querySelector("[role=figure]")!;
    const nodes = [...host.querySelectorAll("svg [data-kind]")];
    expect(nodes.length).toBeGreaterThan(2);
    const errors: unknown[] = [];
    const error = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    act(() => {
      root = hydrateRoot(host, app, { onRecoverableError: (cause) => errors.push(cause) });
    });
    error.mockRestore();
    expect(errors).toEqual([]);
    expect(chart!.root).toBe(figure);
    expect([...host.querySelectorAll("svg [data-kind]")]).toEqual(nodes);
    // It is a chart: its legend toggles series, and it takes updates.
    act(() => host.querySelectorAll("button")[1]!.click());
    expect(chart!.getHiddenKeys()).toHaveLength(1);
    act(() =>
      root!.render(<Chart {...options} title="Units sold" marks={marks} initial={initial} />),
    );
    await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(figure.getAttribute("aria-label")).toBe("Units sold");
  });

  it("mounts afresh in strict mode's second mount, with the same markup", () => {
    const initial = hydration(
      renderToSnapshot({ ...options, marks }, { width: 600, height: 320, idPrefix: "strict" }),
    );
    const app = (
      <StrictMode>
        <Chart {...options} marks={marks} initial={initial} />
      </StrictMode>
    );
    host.innerHTML = renderToString(app);
    act(() => {
      root = hydrateRoot(host, app);
    });
    const figures = host.querySelectorAll("[role=figure]");
    expect(figures).toHaveLength(1);
    expect(figures[0]!.querySelectorAll("svg [data-kind]").length).toBeGreaterThan(2);
  });

  it("refuses a snapshot not passed through hydration(), saying what to do", () => {
    const snapshot = renderToSnapshot(
      { ...options, marks },
      { width: 600, height: 320, idPrefix: "raw" },
    );
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    root = createRoot(host);
    expect(() =>
      act(() => root!.render(<Chart {...options} marks={marks} initial={snapshot as never} />)),
    ).toThrow("Chart initial: expected hydration(snapshot)");
    error.mockRestore();
  });
});
