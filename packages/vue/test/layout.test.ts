import { type Chart as HercegChart, table } from "herceg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type App, createApp, defineComponent, nextTick, shallowRef } from "vue";
import { Legend } from "../src/guides.ts";
import { Bar, Chart, Line, Pie, Rule } from "../src/index.ts";
import { Cell, Columns, Grid, Inset, Panel, Rows } from "../src/layout.ts";

let host: HTMLDivElement;
let app: App | undefined;

beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "900px";
  document.body.append(host);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
});

const data = table({
  time: [0, 1, 2, 0, 1, 2],
  p99: [120, 180, 150, 90, 110, 130],
  errors: [3, 5, 2, 1, 4, 2],
  requests: [40, 60, 50, 20, 30, 25],
  region: ["eu", "eu", "eu", "us", "us", "us"],
});

const components = { Chart, Line, Bar, Pie, Rule, Legend, Columns, Rows, Grid, Cell, Panel, Inset };

/** Mounts `template` with a template ref `view` to its <Chart>; returns the herceg chart. */
async function mount(template: string, state: object = {}): Promise<HercegChart | undefined> {
  const view = shallowRef<InstanceType<typeof Chart> | null>(null);
  app = createApp(
    defineComponent({ components, setup: () => ({ data, view, ...state }), template }),
  );
  app.mount(host);
  await nextTick();
  // Guides other than the chart's own wait for the code that draws them.
  await view.value?.chart?.loading;
  return view.value?.chart ?? undefined;
}

/** What the chart's `error` event says, with the template mounted. */
async function refused(template: string): Promise<string> {
  let message = "";
  await mount(`<Chart @error="heard">${template}</Chart>`, {
    heard: (error: Error) => {
      message = error.message;
    },
  });
  return message;
}

const plots = (chart: HercegChart | undefined) =>
  Object.fromEntries(chart!.getPanels().map(({ key, plot }) => [key, plot]));

describe("layout components", () => {
  it("draw the panels of columns and rows, each with the marks in its slot", async () => {
    const chart = await mount(`
      <Chart ref="view" :height="600">
        <Columns :weights="[2, 1]">
          <Rows :weights="[2, 1]">
            <Panel id="latency" title="p99">
              <Line :data="data" x="time" y="p99" color="region" />
            </Panel>
            <Panel id="errors" title="Errors">
              <Bar :data="data" x="time" y="errors" color="region" />
            </Panel>
          </Rows>
          <Panel id="share" title="By region">
            <Pie :data="data" category="region" value="requests" />
          </Panel>
        </Columns>
      </Chart>`);
    const { latency, errors, share } = plots(chart);
    expect(Object.keys(plots(chart))).toEqual(["latency", "errors", "share"]);
    expect(latency!.height / errors!.height).toBeCloseTo(2, 1);
    expect(latency!.width).toBeGreaterThan(share!.width);
  });

  it("place cells of a grid that span tracks, and panels from v-for", async () => {
    const chart = await mount(
      `
      <Chart ref="view" :height="500">
        <Grid :rows="[1, 1]" :columns="[2, 1]">
          <Cell v-for="(id, k) in ['a', 'b']" :key="id" :row="k" :column="0">
            <Panel :id="id"><Line :data="data" x="time" y="p99" /></Panel>
          </Cell>
          <Cell :row="0" :column="1" :row-span="2">
            <Panel id="c"><Line :data="data" x="time" y="requests" /></Panel>
          </Cell>
        </Grid>
      </Chart>`,
    );
    const { a, b, c } = plots(chart);
    expect(c!.y).toBeCloseTo(a!.y, 0);
    expect(c!.y + c!.height).toBeCloseTo(b!.y + b!.height, 0);
  });

  it("draw an inset over its panel, and give a panel a legend of its own", async () => {
    const chart = await mount(`
      <Chart ref="view" :height="700">
        <Rows>
          <Panel id="latency">
            <Line :data="data" x="time" y="p99" color="region" />
            <Legend :place="{ inside: 'top-left' }" />
            <Inset id="detail" :x="{ domain: [0, 1] }" indicator>
              <Line :data="data" x="time" y="p99" color="region" />
            </Inset>
          </Panel>
          <Panel>
            <Line :data="data" x="time" y="errors" color="region" />
            <Rule :y="3" />
          </Panel>
        </Rows>
      </Chart>`);
    const { latency, detail } = plots(chart);
    expect(Object.keys(plots(chart))).toEqual(["latency", "detail", "panel-3"]);
    expect(detail!.x).toBeGreaterThan(latency!.x + latency!.width / 2);
    chart!.setVisibility("eu", false, { panel: "latency" });
    expect(chart!.getHiddenKeys({ panel: "latency" })).toEqual(["eu"]);
    expect(chart!.getHiddenKeys({ panel: "panel-3" })).toEqual([]);
  });

  it("refuse what they cannot place, saying what to do", async () => {
    const line = `<Line :data="data" x="time" y="p99" />`;
    expect(
      await refused(`<Columns :weights="[1, 2]"><Panel id="a">${line}</Panel></Columns>`),
    ).toMatch(/<Columns> weights: expected one per child, 1; received 2/);
    app?.unmount();
    expect(await refused(`<Cell :row="0" :column="0" />`)).toMatch(/<Cell> goes in a <Grid>/);
    app?.unmount();
    expect(
      await refused(`<Panel id="a"><Line :data="data" x="time" y="p99" panel="b" /></Panel>`),
    ).toMatch(/<Line> panel: "b" is not the panel it is in, "a"/);
    app?.unmount();
    expect(await refused(`<Rows>${line}</Rows>`)).toMatch(/<Rows> children must be <Panel>/);
  });
});
