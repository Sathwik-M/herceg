// Remote grids, imported as `herceg/grid/remote`: a grid over rows that
// live elsewhere (a database behind an API, a worker), its DOM-free model,
// the portable query it sends, the source interface it reads, and
// selections by key or condition. Kept apart from `herceg/grid`, so grids
// over local tables load none of it.

export { createRemoteGrid, type RemoteGrid, type RemoteGridOptions } from "./dom/grid-remote.ts";
export {
  type GridAggregate,
  type GridFieldKind,
  type GridGrouping,
  type GridQuery,
  type GridQueryOf,
  type GridSchema,
  queryFields,
  type RowKey,
  validateGridQuery,
} from "./grid/query.ts";
export {
  createRemoteGridModel,
  type GridQueryInput,
  type RemoteGridMessage,
  RemoteGridModel,
  type RemoteGridModelOptions,
  type RemoteGridRow,
  type RemoteGridStatus,
} from "./grid/remote.ts";
export {
  type RemoteSelection,
  RemoteSelectionStore,
  remoteSelectionStore,
  selectionCondition,
  selectKeys,
  selectMatching,
} from "./grid/remote-selection.ts";
export {
  decodeGroupPath,
  encodeGroupPath,
  type GridSource,
  GridSourceError,
  type GridSourceErrorCode,
  type GroupPath,
  type GroupValue,
  groupCondition,
  type LocateRequest,
  type LocateResult,
  type RowAddress,
  type RowsRequest,
  type RowsWindow,
  type WindowColumn,
} from "./grid/source.ts";
