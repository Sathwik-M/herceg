import { area, createChart, line, table, time } from "herceg";
import type { SeriesData } from "../datasets.ts";
import type { Adapter, ChartHandle, ChartKind, ChartOptions } from "../page/adapter.ts";
import { clientPoint } from "../page/adapter.ts";

// Herceg reads the benchmark's typed arrays in place: a table wraps them
// without copying. The table's maxRows makes it a rolling window, which is
// Herceg's documented streaming path.
function seriesTable(data: SeriesData) {
  const columns: Record<string, Float64Array | ReturnType<typeof time>> = { t: time(data.x) };
  data.ys.forEach((y, s) => {
    columns[`s${s}`] = y;
  });
  return table(columns, { maxRows: data.x.length });
}

function columnsOf(data: SeriesData) {
  const columns: Record<string, Float64Array> = { t: data.x };
  data.ys.forEach((y, s) => {
    columns[`s${s}`] = y;
  });
  return columns;
}

function lineKind(fill: boolean): ChartKind<SeriesData> {
  return {
    prepare: seriesTable,
    create(
      container: HTMLElement,
      data: SeriesData,
      options: ChartOptions,
    ): ChartHandle<SeriesData> {
      const source = seriesTable(data);
      const fields = data.ys.map((_, s) => `s${s}`);
      const chart = createChart(container, {
        width: options.width,
        height: options.height,
        tooltip: options.tooltip,
        marks: [fill ? area(source, { x: "t", y: fields }) : line(source, { x: "t", y: fields })],
      });
      return {
        setData: (next) => source.reset(columnsOf(next)),
        append(x, ys, keep) {
          const batch: Record<string, Float64Array> = { t: x };
          ys.forEach((y, s) => {
            batch[`s${s}`] = y;
          });
          source.append(batch);
          if (source.length > keep) source.dropFirst(source.length - keep);
        },
        pixelOf(_series, _index, x, y) {
          return clientPoint(
            chart.root,
            chart.model.xScale()!.map(x),
            chart.model.yScale()!.map(y),
          );
        },
        resize: (width, height) => chart.update({ width, height }),
        destroy: () => chart.destroy(),
      };
    },
  };
}

export const adapter: Adapter = {
  id: "herceg",
  renderer: { normal: "auto (svg below 4,000 drawn points, canvas above)", large: "auto" },
  line: lineKind(false),
  area: lineKind(true),
};
