// Herceg's grid through `@herceg/react/grid`: the same table, view, and model
// as the plain adapter, with the grid mounted by React (rendered
// synchronously with flushSync). Data, sorting, filtering, scrolling, and
// selection go through the model and table, never React, as the component
// documents.

import { Grid } from "@herceg/react/grid";
import type { Schema, Table } from "herceg";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { type Adapter, GRID_HEIGHT, GRID_WIDTH, HEADER_HEIGHT } from "../adapter.ts";
import { hercegHandle, hercegTable, THEME } from "./herceg.ts";

export const adapter: Adapter = {
  id: "herceg-react",
  renderer: "DOM rows and cells, mounted through @herceg/react/grid (React 19)",
  processing: { sort: "native (row view)", filter: "native (row view, expression)" },
  prepare: hercegTable,
  mount: (container, fixture, input) =>
    hercegHandle(container, fixture, input as Table<Schema>, (model) => {
      const root = createRoot(container);
      flushSync(() =>
        root.render(
          <Grid
            model={model}
            ariaLabel="Benchmark grid"
            headerHeight={HEADER_HEIGHT}
            theme={THEME}
            style={{ width: GRID_WIDTH, height: GRID_HEIGHT }}
          />,
        ),
      );
      return { destroy: () => root.unmount() };
    }),
};
