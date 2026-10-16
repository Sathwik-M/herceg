import { type ChartError, type Chart as HercegChart, table } from "herceg";
import { flushSync, mount, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Layouts from "./Layouts.svelte";

let host: HTMLDivElement;
let mounted: Record<string, unknown> | undefined;

beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "900px";
  document.body.append(host);
});

afterEach(() => {
  if (mounted) unmount(mounted);
  mounted = undefined;
  flushSync();
  host.remove();
});

const data = table({
  time: [0, 1, 2, 0, 1, 2],
  p99: [120, 180, 150, 90, 110, 130],
  errors: [3, 5, 2, 1, 4, 2],
  requests: [40, 60, 50, 20, 30, 25],
  region: ["eu", "eu", "eu", "us", "us", "us"],
});

type Shape = Parameters<typeof Layouts>[1]["shape"];

/** Mounts the layout `shape`; its chart is drawn, once the code its guides need has loaded. */
async function render(shape: Shape) {
  const errors: string[] = [];
  const props = $state({
    data,
    shape,
    chart: null as HercegChart | null,
    heard: (error: ChartError) => errors.push(error.message),
  });
  mounted = mount(Layouts, { target: host, props });
  flushSync();
  await props.chart?.loading;
  return { chart: props.chart, errors };
}

const plots = (chart: HercegChart | null) =>
  Object.fromEntries(chart!.getPanels().map(({ key, plot }) => [key, plot]));

describe("layout components", () => {
  it("draw the panels of columns and rows, each with the marks inside it", async () => {
    const { chart } = await render("readme");
    const { latency, errors, share } = plots(chart);
    expect(Object.keys(plots(chart))).toEqual(["latency", "errors", "share"]);
    expect(latency!.height / errors!.height).toBeCloseTo(2, 1);
    expect(latency!.width).toBeGreaterThan(share!.width);
  });

  it("place cells of a grid that span tracks, and panels from each blocks", async () => {
    const { chart } = await render("grid");
    const { a, b, c } = plots(chart);
    expect(c!.y).toBeCloseTo(a!.y, 0);
    expect(c!.y + c!.height).toBeCloseTo(b!.y + b!.height, 0);
  });

  it("draw an inset over its panel, and give a panel a legend of its own", async () => {
    const { chart } = await render("inset");
    expect(Object.keys(plots(chart))).toEqual(["latency", "detail", "panel-3"]);
    const { latency, detail } = plots(chart);
    expect(detail!.x).toBeGreaterThan(latency!.x + latency!.width / 2);
    chart!.setVisibility("eu", false, { panel: "latency" });
    expect(chart!.getHiddenKeys({ panel: "latency" })).toEqual(["eu"]);
    expect(chart!.getHiddenKeys({ panel: "panel-3" })).toEqual([]);
  });

  it("refuse what they cannot place, saying what to do", async () => {
    const said = async (shape: Shape) => {
      const { errors } = await render(shape);
      if (mounted) unmount(mounted);
      mounted = undefined;
      flushSync();
      return errors.join("\n");
    };
    expect(await said("weights")).toMatch(
      /<Columns> weights: expected one per child, 1; received 2/,
    );
    expect(await said("stray")).toMatch(/<Line> goes in a <Panel>, not directly in <Rows>/);
    expect(await said("conflict")).toMatch(/<Line> panel: "b" is not the panel it is in, "a"/);
    expect(await said("twice")).toMatch(
      /<Panel> id: "panel-1" names two panels; give each its own/,
    );
    expect(await said("nested")).toMatch(
      /<Columns> goes in a <Chart> or another layout component, not in panel "a"/,
    );
  });
});
