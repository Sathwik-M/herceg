// Conformance fixtures for grid sources, imported as
// `herceg/grid/conformance`: what a server answering remote grids must
// answer, and a checker for its tests.

export {
  type ConformanceDriver,
  type ConformanceReport,
  checkGridSource,
  type FixtureColumn,
  type FixtureInsert,
  type FixtureRequest,
  type FixtureValue,
  GRID_SOURCE_FIXTURES,
  type SourceFixture,
} from "./grid/conformance.ts";
