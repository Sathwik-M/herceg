// Pivots in grids, imported as `herceg/grid/pivot`: a grid model of a row
// pivot (`herceg/pivot`) and the DOM grid that draws it, its values over
// their aggregates. Kept apart from `herceg/grid`, so grids that show no
// pivot load none of it.

export { createPivotGrid, type PivotGrid, type PivotGridOptions } from "./dom/grid-pivot.ts";
export {
  createPivotGridModel,
  type PivotColumnOptions,
  type PivotGridModel,
  type PivotGridModelOptions,
} from "./grid/pivot.ts";
