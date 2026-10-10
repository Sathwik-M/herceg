import type { Chart, ProjectionName, ProjectionSpec } from "herceg";
import type { ChartSpec } from "herceg/spec";
import { MountedChart } from "../../../packages/herceg/src/dom/chart.ts";

export function mapSpec(
  projection: ProjectionName | ProjectionSpec = "conic-equal-area",
): ChartSpec {
  return {
    width: 400,
    height: 300,
    renderer: "svg",
    projection,
    interaction: { zoom: true, brush: "lasso" },
    rowSelection: { channel: "picked" },
    data: {
      data: {
        columns: {
          lon: { type: "number", dtype: "float64", buffer: 0 },
          lat: { type: "number", dtype: "float64", buffer: 1 },
        },
      },
    },
    marks: [{ type: "geopoint", data: "data", longitude: "lon", latitude: "lat" }],
  };
}

/** Zoom and lasso the first point in the projection actually drawn. */
export function focusMap(chart: Chart) {
  const result = MountedChart.modelOf(chart).items!.result()!;
  const plane = result.plane!;
  const first = result.item(0);
  const cx = plane.x.invert(first.px),
    cy = plane.y.invert(first.py);
  const hx = (plane.x.domain[1] - plane.x.domain[0]) / 8;
  const hy = (plane.y.domain[1] - plane.y.domain[0]) / 8;
  chart.setViewport({ x: [cx - hx, cx + hx], y: [cy - hy, cy + hy] });
  chart.render();
  chart.select({
    x: null,
    y: null,
    lasso: [
      [cx - 0.01, cy - 0.01],
      [cx + 0.01, cy - 0.01],
      [cx + 0.01, cy + 0.01],
      [cx - 0.01, cy + 0.01],
    ],
  });
  return { viewport: chart.getViewport(), selection: chart.selection };
}
