// Window ownership, byte accounting, and deferred calls into a remote source.

import type { RowsWindow } from "./source.ts";

/** Defers source hooks until the model's command has finished. */
export function later(hook: () => void) {
  queueMicrotask(hook);
}

/**
 * A window holding only the fields expected, each in arrays of its own: a
 * column viewing a much larger buffer (a source handing out views of its
 * arrays) would keep that buffer alive, and fields not asked for are not kept.
 */
export function ownColumns(data: RowsWindow, kinds: Readonly<Record<string, string>>): RowsWindow {
  const own = <A extends Float64Array | Int32Array>(array: A): A =>
    array.buffer.byteLength > 65536 && array.buffer.byteLength > 4 * array.byteLength
      ? (array.slice() as A)
      : array;
  const columns: Record<string, RowsWindow["columns"][string]> = Object.create(null);
  for (const field of Object.keys(kinds)) {
    const column = data.columns[field]!;
    columns[field] =
      column instanceof Float64Array ? own(column) : { ...column, codes: own(column.codes) };
  }
  if (data.kind === "groups")
    return {
      ...data,
      columns,
      rowCounts: own(data.rowCounts),
      childCounts: own(data.childCounts),
    };
  return { ...data, columns };
}

/** Bytes a block keeps: its buffers, and its dictionaries' labels at two bytes a character. */
export function bytesOf(data: RowsWindow): number {
  const buffers = new Set<ArrayBufferLike>();
  let bytes = 0;
  for (const column of Object.values(data.columns)) {
    if (column instanceof Float64Array) buffers.add(column.buffer);
    else {
      buffers.add(column.codes.buffer);
      for (const label of column.dictionary) bytes += 2 * label.length + 16;
    }
  }
  if (data.kind === "groups") {
    buffers.add(data.rowCounts.buffer);
    buffers.add(data.childCounts.buffer);
  }
  for (const buffer of buffers) bytes += buffer.byteLength;
  return bytes;
}
