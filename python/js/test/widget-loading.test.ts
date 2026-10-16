// The notebook widget mounting a subplot chart whose first scene waits for
// the guide compiler. A test file of its own: each runs in a page of its
// own, where the compiler has not loaded yet.

import { afterEach, expect, it, vi } from "vitest";
import { MountedChart } from "../../../packages/herceg/src/dom/chart.ts";
import widgetModule, { type Snapshot } from "../widget.ts";
import { MockModel, snapshot } from "./widget-model.ts";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

it("restores panels' views and cameras, and keeps what a panel's legend hid, once the panels are known", async () => {
  const listener = vi.spyOn(MountedChart.prototype, "on");
  const base = snapshot({ interaction: { zoom: "x" } });
  const [marked] = base.spec.marks;
  const camera = { azimuth: 140, elevation: 40, zoom: 2, perspective: false };
  const subplots: Snapshot = {
    ...base,
    spec: {
      ...base.spec,
      panels: [{ id: "a" }, { id: "b" }, { id: "c", camera: { azimuth: 20 } }],
      layout: { type: "grid", columns: [1, 1, 1] },
      // A panel's legend needs the guide compiler, which loads first. One
      // of its own entries toggles a mark its legends leave out.
      guides: [
        { type: "legend", panel: "a" },
        {
          type: "legend",
          panel: "a",
          entries: [
            { key: "quiet", label: "Quiet", targets: [{ mark: "q" }] },
            { key: "other", label: "Other", targets: [{ mark: "r" }] },
          ],
        },
      ],
      marks: [
        { ...marked!, color: "host", panel: "a" },
        { ...marked!, color: "host", id: "q", legend: false, panel: "a" },
        { ...marked!, color: "host", id: "r", legend: false, panel: "a" },
        { ...marked!, color: "host", panel: "b" },
        { type: "point3d", x: "t", y: "v", z: "v", data: "data", panel: "c" },
      ],
    } as Snapshot["spec"],
    panel_states: {
      viewport: { a: null, b: { x: [1, 2], y: null, yRight: null, time: [] } },
      camera: { c: camera },
    },
  };
  const model = new MockModel({ _chart: subplots, _listening: ["camera"] });
  const widget = widgetModule();
  cleanups.push(widget.initialize({ model }));
  const host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
  cleanups.push(widget.render({ model, el: host }), () => host.remove());
  const chart = listener.mock.instances[0] as MountedChart;
  // Its panels come with its first scene. A view Python sends meanwhile
  // waits for them.
  expect(chart.getPanels()).toEqual([]);
  model.receive({
    type: "viewport",
    revision: 1,
    viewport: { x: [0.5, 1.5], y: null, yRight: null },
    panel: "a",
  });
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await chart.loading;
  await frame();
  expect(chart.getViewport({ panel: "b" }).x).toEqual([1, 2]);
  expect(chart.getViewport({ panel: "a" }).x).toEqual([0.5, 1.5]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(chart.getCamera({ panel: "c" })).toMatchObject(camera);
  await new Promise((resolve) => setTimeout(resolve, 150));
  // Python is not told of the panel's default camera in place of its own.
  for (const message of model.messages("camera").filter(({ panel }) => panel === "c"))
    expect(message.camera).toMatchObject({ azimuth: 140 });
  // What clicks on panel a's legends hid stays hidden there when Python
  // sends the chart again: what series stand for, and a named mark's series.
  const [entry] = chart.getLegend();
  const buttons = [
    ...host.querySelectorAll<HTMLButtonElement>('[aria-label="Legend"] button'),
  ].filter((button) => button.textContent === "a");
  const own = buttons.find((button) => {
    button.click();
    const there = chart.getHiddenKeys({ panel: "a" }).length > 0 && !chart.getHiddenKeys().length;
    if (!there) button.click();
    return there;
  });
  expect(own).toBeDefined();
  [...host.querySelectorAll("button")].find((button) => button.textContent === "Quiet")!.click();
  const quiet = chart.getHiddenKeys({ panel: "a" }).filter((key) => key.startsWith('["q"'));
  expect(quiet).toHaveLength(1);
  await frame();
  model.set("_chart", { ...subplots, revision: 2 });
  const again = listener.mock.instances.at(-1) as MountedChart;
  expect(again).not.toBe(chart);
  await again.loading;
  await frame();
  expect(again.getHiddenKeys({ panel: "a" })).toEqual(
    expect.arrayContaining([entry!.key, ...quiet]),
  );
  expect(again.getHiddenKeys()).not.toContain(entry!.key);
  expect(again.getViewport({ panel: "b" }).x).toEqual([1, 2]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
  // Hidden in the chart, one of two marks of the same values shown again in
  // panel a stays so, and the other hidden, after another snapshot.
  again.setHiddenKeys([entry!.key]);
  const button = (label: string) =>
    [...host.querySelectorAll("button")].find((b) => b.textContent === label)!;
  button("Quiet").click();
  again.render();
  const pressed = () =>
    [button("Quiet"), button("Other")].map((b) => b.getAttribute("aria-pressed"));
  expect(pressed()).toEqual(["true", "false"]);
  model.set("_chart", { ...subplots, revision: 3 });
  const third = listener.mock.instances.at(-1) as MountedChart;
  expect(third).not.toBe(again);
  await third.loading;
  third.render();
  expect(third.getHiddenKeys()).toEqual([entry!.key]);
  expect(pressed()).toEqual(["true", "false"]);
});
