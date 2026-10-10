import type { ChartSpec } from "herceg/spec";

export function itemChart(type: "treemap" | "sunburst" | "graph", title = "Items") {
  const spec: ChartSpec = {
    title,
    width: 400,
    height: 200,
    renderer: "svg",
    interaction: type === "graph" ? { drag: true } : { zoom: true },
    data: {
      data: {
        columns: {
          region: { type: "category", codes: 0, dictionary: ["East", "West"] },
          city: { type: "category", codes: 1, dictionary: ["A", "B", "C"] },
          value: { type: "number", dtype: "float64", buffer: 2 },
        },
      },
    },
    marks:
      type === "graph"
        ? [{ type, data: "data", source: "region", target: "city" }]
        : [{ type, data: "data", path: ["region", "city"], value: "value" }],
  };
  return {
    spec,
    buffers: [new Int32Array([0, 0, 1]), new Int32Array([0, 1, 2]), new Float64Array([5, 2, 4])],
  };
}

export function key(root: ParentNode, value: string, shiftKey = false) {
  root
    .querySelector('[role="figure"]')!
    .dispatchEvent(
      new KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true }),
    );
}
