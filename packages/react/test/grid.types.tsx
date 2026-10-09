// Compile-time tests of <Grid>: checked by `npm run typecheck`, never executed.
import { rowView, table } from "herceg";
import { createGridModel, type Grid as HercegGrid } from "herceg/grid";
import { useMemo, useRef } from "react";
import { Grid } from "../src/grid.tsx";

const requests = table({ latency: new Float64Array(3), host: ["a", "b", "c"] });
type Requests = { latency: "number"; host: "category" };

export function Requests() {
  const model = useMemo(
    () =>
      createGridModel({
        data: rowView(requests),
        columns: [{ field: "host" }, { field: "latency" }],
      }),
    [],
  );
  const ref = useRef<HercegGrid<Requests> | null>(null);
  return <Grid model={model} ariaLabel="Requests" theme="dark" headerHeight={36} ref={ref} />;
}

export function Unnamed() {
  const model = useMemo(() => createGridModel({ data: rowView(requests), columns: [] }), []);
  // @ts-expect-error grids need an accessible name
  return <Grid model={model} />;
}
