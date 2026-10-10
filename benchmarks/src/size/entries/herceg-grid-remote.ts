import { createRemoteGrid, createRemoteGridModel, type GridSource } from "herceg/grid/remote";

export function render(element: HTMLElement, x: Float64Array, y: Float64Array) {
  // A source answering from the page's arrays, as an HTTP source would from its responses.
  const source: GridSource = {
    schema: { source: "values", version: "1", fields: { t: "time", v: "number" }, key: null },
    async rows(request) {
      const end = Math.min(x.length, request.offset + request.limit);
      return {
        kind: "rows",
        revision: request.revision,
        snapshot: "values",
        parent: request.parent,
        offset: request.offset,
        length: end - request.offset,
        total: x.length,
        columns: { t: x.slice(request.offset, end), v: y.slice(request.offset, end) },
      };
    },
  };
  const model = createRemoteGridModel({ source, columns: [{ field: "t" }, { field: "v" }] });
  return createRemoteGrid(element, { model, ariaLabel: "Values" });
}
