// A chart whose guides need the guide compiler, when the compiler cannot
// load: it draws nothing and exports nothing until the compiler loads, and
// draws again once its configuration no longer needs it.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { table } from "../../src/data/table.ts";
import { createChart } from "../../src/dom/chart.ts";
import { line } from "../../src/marks/line.ts";

// The compiler's module loads, but making the compiler fails, as a module
// that cannot load would fail the import: at once, or when a test says.
const load = vi.hoisted(() => ({
  failing: (): Promise<never> => Promise.reject(new Error("offline")),
}));
vi.mock("../../src/guides/compile.ts", () => ({ guideCompiler: () => load.failing() }));

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.cssText = "width:600px;height:300px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

const data = table({ x: [0, 1, 2], v: [1, 3, 2] });
const texts = () =>
  [...host.querySelectorAll("svg text")].map((text) => text.textContent).filter(Boolean);

it("draws nothing while the compiler cannot load, and draws once nothing needs it", async () => {
  const chart = createChart(host, {
    marks: [line(data, { x: "x", y: "v" })],
    y: { title: "Load", format: { number: ".1f" } },
  });
  await expect(chart.loading).rejects.toThrow();
  // Still blocked after the failure: no frame, and an export throws what failed.
  chart.render();
  expect(texts()).toEqual([]);
  expect(() => chart.toSVG()).toThrow(
    expect.objectContaining({ phase: "load", message: "offline" }),
  );
  // An update still needing it tries again, and fails again.
  chart.update({ y: { title: "Again", format: { number: ".2f" } } });
  await expect(chart.loading).rejects.toThrow();
  expect(texts()).toEqual([]);
  // Without what needs the compiler, the chart draws.
  chart.update({ y: { title: "Plain" } });
  await chart.loading;
  chart.render();
  expect(texts()).toContain("Plain");
  chart.destroy();
});

it("keeps what an update drew when a load the update made needless fails", async () => {
  const failing = load.failing;
  let fail: ((error: Error) => void) | undefined;
  load.failing = () => new Promise<never>((_, reject) => (fail = reject));
  const errors: unknown[] = [];
  const chart = createChart(host, {
    marks: [line(data, { x: "x", y: "v" })],
    y: { title: "Load", format: { number: ".1f" } },
    onError: (error) => errors.push(error),
  });
  const loading = chart.loading;
  await vi.waitFor(() => expect(fail).toBeDefined());
  chart.update({ y: { title: "Plain" } });
  chart.render();
  expect(texts()).toContain("Plain");
  fail!(new Error("offline"));
  await expect(loading).rejects.toThrow("offline");
  chart.render();
  expect(texts()).toContain("Plain");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(errors).toEqual([]);
  expect(chart.toSVG()).toContain("Plain");
  chart.destroy();
  load.failing = failing;
});
