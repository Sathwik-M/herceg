import { Area, Chart, Line } from "@herceg/react";
import type { Chart as HercegChart } from "herceg";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { SeriesData } from "../datasets.ts";
import type { Adapter, ChartHandle, ChartKind, ChartOptions } from "../page/adapter.ts";
import { clientPoint } from "../page/adapter.ts";
import { appendTo, columnsOf, seriesTable } from "./herceg.ts";

// Herceg through its React adapter, to measure what React adds. Mounting and
// resizing go through React props (rendered synchronously with flushSync, as
// a resize handler would); data replacement and streaming change the table
// directly, which is the adapter's documented path for live data.
function lineKind(fill: boolean): ChartKind<SeriesData> {
  return {
    prepare: seriesTable,
    create(container: HTMLElement, data: SeriesData, options: ChartOptions) {
      const source = seriesTable(data);
      const fields = data.ys.map((_, s) => `s${s}`);
      const ref: { current: HercegChart | null } = { current: null };
      const root = createRoot(container);
      const Mark = fill ? Area : Line;
      const render = (width: number, height: number) =>
        flushSync(() =>
          root.render(
            <Chart ref={ref} width={width} height={height} tooltip={options.tooltip}>
              <Mark data={source} x="t" y={fields} />
            </Chart>,
          ),
        );
      render(options.width, options.height);
      const chart = () => ref.current!;
      const handle: ChartHandle<SeriesData> = {
        setData: (next) => source.reset(columnsOf(next)),
        append: (x, ys, keep) => appendTo(source, x, ys, keep),
        // The adapter exposes the chart through `ref` for imperative calls.
        setViewport: (x0, x1) => chart().setViewport([x0, x1]),
        pixelOf: (_series, _index, x, y) =>
          clientPoint(chart().root, chart().model.xScale()!.map(x), chart().model.yScale()!.map(y)),
        resize: (width, height) => render(width, height),
        destroy: () => root.unmount(),
      };
      return handle;
    },
  };
}

export const adapter: Adapter = {
  id: "herceg-react",
  renderer: { normal: "auto, through <Chart>", large: "auto, through <Chart>" },
  line: lineKind(false),
  area: lineKind(true),
};
