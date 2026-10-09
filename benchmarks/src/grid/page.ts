// In-page helpers shared by the grid scenario runners: mounting a grid on
// the stage, waiting for its first correct frame, and checking its model.

import type { Metric } from "../page/harness.ts";
import {
  type Adapter,
  GRID_HEIGHT,
  GRID_WIDTH,
  type GridHandle,
  type RowFilter,
  type SortKey,
} from "./adapter.ts";
import type { GridTable } from "./fixture.ts";
import { checkedFrame } from "./frames.ts";
import { type Expected, type Reference, verifyOrder, verifyVisible } from "./reference.ts";

export interface GridResult {
  status: "measured" | "unsupported" | "incorrect";
  reason?: string;
  metrics: Record<string, Metric>;
}

/** A grid showed something other than the reference. */
export class Incorrect extends Error {
  constructor(problem: string) {
    super(`incorrect: ${problem}`);
  }
}

/** How long a grid may take to show a correct frame before it is reported incorrect. */
const CORRECT_WITHIN_MS = 30_000;

export function metric(unit: Metric["unit"], samples: number[] = []): Metric {
  return { unit, samples };
}

export function stage(): HTMLElement {
  return document.getElementById("stage")!;
}

/** A container for one grid on the stage. */
export function box(): HTMLElement {
  const element = document.createElement("div");
  element.style.cssText = `width:${GRID_WIDTH}px;height:${GRID_HEIGHT}px;position:relative;overflow:hidden;line-height:normal;font:13px Arial,sans-serif`;
  stage().append(element);
  return element;
}

/** What a correct frame shows for `order` (null: source order) at a scroll offset. */
export function expectation(
  reference: Reference,
  order: readonly number[] | null,
  top = 0,
  left = 0,
  selected?: (id: number) => boolean,
): Expected {
  return {
    count: order ? order.length : reference.length,
    fields: reference.fields.length,
    idAt: order ? (i) => order[i]! : (i) => reference.start + i,
    text: (id, field) => reference.text(id, field),
    selected,
    top,
    left,
  };
}

export interface Correct {
  /** From `start` to the end of the first correct frame. */
  toFrame: number;
  frames: number;
  /** Frames the harness could not observe before they painted; never counted as correct. */
  unobserved: number;
  /** Time spent in the harness's checks, included in `toFrame`. */
  checking: number;
}

/** Waits for frames until the grid shows `expected`; times from `start`. */
export async function untilCorrect(
  handle: GridHandle,
  expected: Expected,
  start: number,
): Promise<Correct> {
  let checking = 0;
  let unobserved = 0;
  let problem = "no frame could be observed";
  for (let frames = 1; ; frames++) {
    const frame = await checkedFrame(() => verifyVisible(handle.visible(), expected));
    checking += frame.spent;
    if (!frame.observed) unobserved++;
    else if (!frame.value) return { toFrame: frame.time - start, frames, unobserved, checking };
    else problem = frame.value;
    if (performance.now() - start > CORRECT_WITHIN_MS) throw new Incorrect(problem);
  }
}

/** Compares the library's row count and full display order with the reference. */
export function verifyModel(handle: GridHandle, order: readonly number[]): void {
  if (handle.rowCount() !== order.length)
    throw new Incorrect(`reports ${handle.rowCount()} rows, expected ${order.length}`);
  const problem = verifyOrder(handle.order(), order);
  if (problem) throw new Incorrect(problem);
}

export function sourceOrder(reference: Reference): number[] {
  return Array.from({ length: reference.length }, (_, i) => reference.start + i);
}

export interface Mounted {
  handle: GridHandle;
  destroy(): void;
}

/** Mounts a grid from `input` (prepared when left out) and waits for its first correct frame. */
export async function mount(
  adapter: Adapter,
  table: GridTable,
  reference: Reference,
  input: unknown = adapter.prepare(table),
): Promise<Mounted> {
  const element = box();
  const handle = await adapter.mount(element, table, input);
  await untilCorrect(handle, expectation(reference, null), performance.now());
  return {
    handle,
    destroy() {
      handle.destroy();
      element.remove();
    },
  };
}

/** Applies a sort and filter, waits for the result, and verifies the model; untimed. */
export async function applyQuery(
  handle: GridHandle,
  reference: Reference,
  sort: SortKey[],
  filter: RowFilter | null,
  order = reference.order(sort, filter),
): Promise<number[]> {
  if (sort.length > 0) await handle.sort(sort);
  if (filter) await handle.filter(filter);
  await untilCorrect(handle, expectation(reference, order), performance.now());
  verifyModel(handle, order);
  return order;
}
