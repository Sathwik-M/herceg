import { type Chart as HercegChart, panels, table } from "herceg";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Legend } from "../src/guides.tsx";
import { Bar, Chart, Line, Pie, Rule } from "../src/index.ts";
import { Cell, Columns, Grid, Inset, Panel, Rows } from "../src/layout.tsx";

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "900px";
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const data = table({
  time: [0, 1, 2, 0, 1, 2],
  p99: [120, 180, 150, 90, 110, 130],
  errors: [3, 5, 2, 1, 4, 2],
  requests: [40, 60, 50, 20, 30, 25],
  region: ["eu", "eu", "eu", "us", "us", "us"],
});

const plots = (chart: HercegChart) =>
  Object.fromEntries(chart.getPanels().map(({ key, plot }) => [key, plot]));

describe("layout elements", () => {
  it("draw the panels of columns and rows, each with the marks inside it", () => {
    const ref: { current: HercegChart | null } = { current: null };
    act(() =>
      root.render(
        <Chart ref={ref} height={600}>
          <Columns weights={[2, 1]}>
            <Rows weights={[2, 1]}>
              <Panel id="latency" title="p99">
                <Line data={data} x="time" y="p99" color="region" />
              </Panel>
              <Panel id="errors" title="Errors">
                <Bar data={data} x="time" y="errors" color="region" />
              </Panel>
            </Rows>
            <Panel id="share" title="By region">
              <Pie data={data} category="region" value="requests" />
            </Panel>
          </Columns>
        </Chart>,
      ),
    );
    const chart = ref.current!;
    const { latency, errors, share } = plots(chart);
    expect(Object.keys(plots(chart))).toEqual(["latency", "errors", "share"]);
    // Rows of weights 2 and 1 make plots of heights 2 to 1; the left column is the wider.
    expect(latency!.height / errors!.height).toBeCloseTo(2, 1);
    expect(latency!.width).toBeGreaterThan(share!.width);
    expect(share!.x).toBeGreaterThan(latency!.x + latency!.width);
  });

  it("name panels without ids by their order, and draw marks given every panel in all", () => {
    const ref: { current: HercegChart | null } = { current: null };
    act(() =>
      root.render(
        <Chart ref={ref}>
          <Rule y={100} panel="*" />
          <Rows>
            <Panel title="First">
              <Line data={data} x="time" y="p99" />
            </Panel>
            <Panel title="Second">
              <Line data={data} x="time" y="errors" />
            </Panel>
          </Rows>
        </Chart>,
      ),
    );
    expect(ref.current!.getPanels().map(({ key }) => key)).toEqual(["panel-1", "panel-2"]);
  });

  it("place cells of a grid, which may span tracks, or fill it row by row", () => {
    const ref: { current: HercegChart | null } = { current: null };
    act(() =>
      root.render(
        <Chart ref={ref} height={500}>
          <Grid rows={[1, 1]} columns={[2, 1]}>
            <Cell row={0} column={0}>
              <Panel id="a">
                <Line data={data} x="time" y="p99" />
              </Panel>
            </Cell>
            <Cell row={1} column={0}>
              <Panel id="b">
                <Line data={data} x="time" y="errors" />
              </Panel>
            </Cell>
            <Cell row={0} column={1} rowSpan={2}>
              <Panel id="c">
                <Line data={data} x="time" y="requests" />
              </Panel>
            </Cell>
          </Grid>
        </Chart>,
      ),
    );
    const { a, b, c } = plots(ref.current!);
    expect(c!.y).toBeCloseTo(a!.y, 0);
    expect(c!.y + c!.height).toBeCloseTo(b!.y + b!.height, 0);

    act(() =>
      root.render(
        <Chart ref={ref}>
          <Grid columns={2}>
            <Panel id="a">
              <Line data={data} x="time" y="p99" />
            </Panel>
            <Panel id="b">
              <Line data={data} x="time" y="errors" />
            </Panel>
            <Panel id="c">
              <Line data={data} x="time" y="requests" />
            </Panel>
          </Grid>
        </Chart>,
      ),
    );
    // Drawn now rather than at the next frame.
    ref.current!.render();
    const filled = plots(ref.current!);
    expect(filled.b!.y).toBeCloseTo(filled.a!.y, 0);
    expect(filled.c!.x).toBeCloseTo(filled.a!.x, 0);
    expect(filled.c!.y).toBeGreaterThan(filled.a!.y + filled.a!.height);
  });

  it("draw an inset over its panel, with its own marks", () => {
    const ref: { current: HercegChart | null } = { current: null };
    act(() =>
      root.render(
        <Chart ref={ref} height={400}>
          <Panel id="latency">
            <Line data={data} x="time" y="p99" color="region" />
            <Inset
              id="detail"
              width={{ fraction: 0.4 }}
              height={{ fraction: 0.4 }}
              x={{ domain: [0, 1] }}
              indicator
            >
              <Line data={data} x="time" y="p99" color="region" />
            </Inset>
          </Panel>
        </Chart>,
      ),
    );
    const { latency, detail } = plots(ref.current!);
    expect(Object.keys(plots(ref.current!))).toEqual(["latency", "detail"]);
    // Inside the panel's plot, at its top right.
    expect(detail!.x).toBeGreaterThan(latency!.x + latency!.width / 2);
    expect(detail!.x + detail!.width).toBeLessThanOrEqual(latency!.x + latency!.width);
    expect(detail!.y).toBeGreaterThanOrEqual(latency!.y);
  });

  it("give a panel a legend of its own, which hides its series there only", () => {
    const ref: { current: HercegChart | null } = { current: null };
    act(() =>
      root.render(
        <Chart ref={ref}>
          <Rows>
            <Panel id="latency">
              <Line data={data} x="time" y="p99" color="region" />
              <Legend place={{ inside: "top-left" }} />
            </Panel>
            <Panel id="errors">
              <Line data={data} x="time" y="errors" color="region" />
            </Panel>
          </Rows>
        </Chart>,
      ),
    );
    const chart = ref.current!;
    chart.setVisibility("eu", false, { panel: "latency" });
    expect(chart.getHiddenKeys({ panel: "latency" })).toEqual(["eu"]);
    expect(chart.getHiddenKeys({ panel: "errors" })).toEqual([]);
  });

  it("keep an equal layout without updating the chart", () => {
    const ref: { current: HercegChart | null } = { current: null };
    const view = (tick: number) => (
      <Chart ref={ref} title={`Latency${"".repeat(tick)}`}>
        <Columns>
          <Panel id="a">
            <Line data={data} x="time" y="p99" />
          </Panel>
          <Panel id="b">
            <Line data={data} x="time" y="errors" />
          </Panel>
        </Columns>
      </Chart>
    );
    act(() => root.render(view(0)));
    const chart = ref.current!;
    let updates = 0;
    const update = chart.update.bind(chart);
    chart.update = (options) => {
      updates++;
      update(options);
    };
    act(() => root.render(view(1)));
    expect(updates).toBe(0);
  });

  it("refuse what they cannot place, saying what to do", () => {
    const refused = (
      children: React.ReactNode,
      props: { panels?: ReturnType<typeof panels> } = {},
    ) => {
      let message = "";
      act(() =>
        root.render(
          <Chart errorMode="inline" onError={(error) => (message = error.message)} {...props}>
            {children}
          </Chart>,
        ),
      );
      return message;
    };
    const line = <Line data={data} x="time" y="p99" />;
    expect(
      refused(
        <Columns weights={[1, 2, 3]}>
          <Panel id="a">{line}</Panel>
        </Columns>,
      ),
    ).toMatch(/<Columns> weights: expected one per child, 1; received 3/);
    expect(refused(<Cell row={0} column={0} />)).toMatch(/<Cell> goes in a <Grid>/);
    expect(refused(<Inset id="x" />)).toMatch(/<Inset> goes in a <Panel>/);
    expect(
      refused(
        <Panel id="a">
          <Line data={data} x="time" y="p99" panel="b" />
        </Panel>,
      ),
    ).toMatch(/<Line> panel: "b" is not the panel it is in, "a"/);
    expect(refused(<Columns>{line}</Columns>)).toMatch(
      /<Columns> children must be <Panel>, <Columns>, <Rows>, or <Grid>; received <Line>/,
    );
    expect(
      refused(
        <>
          <Panel id="a">{line}</Panel>
          <Panel id="b">{line}</Panel>
        </>,
      ),
    ).toMatch(/one layout element places its panels/);
    expect(refused(<Panel id="a">{line}</Panel>, { panels: panels([{ id: "a" }]) })).toMatch(
      /<Chart> panels: layout elements among its children place its panels/,
    );
  });
});
