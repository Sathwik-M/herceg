// How mark components reach their <Chart>: through context, with an empty
// element whose place in the document gives the marks their order.

import type {
  ChartMark,
  CustomDataOptions,
  CustomOptions,
  RegionDataOptions,
  RegionOptions,
  RowView,
  RuleDataOptions,
  RuleOptions,
  Schema,
  Table,
  TextDataOptions,
  TextOptions,
} from "herceg";
import { getContext, setContext } from "svelte";
import type { Attachment } from "svelte/attachments";

/** Props of a mark component: the mark's options plus the table it reads. */
export type WithData<O, S extends Schema> = O & { data: Table<S> };
/** Props of marks that show a table's rows or a row view's. */
export type WithRows<O, S extends Schema> = O & { data: Table<S> | RowView<S> };

// Annotations and custom marks draw from constants, or from `data` and its
// fields. Their components are generic in the table rather than its schema,
// so the template checker infers the table from `data` before it types
// callbacks such as `draw`.

type NoData = { data?: undefined };
export type RuleProps<T> = { data?: T } & (T extends Table<infer S extends Schema>
  ? RuleDataOptions<S>
  : RuleOptions & NoData);
export type RegionProps<T> = { data?: T } & (T extends Table<infer S extends Schema>
  ? RegionDataOptions<S>
  : RegionOptions & NoData);
export type TextProps<T> = { data?: T } & (T extends Table<infer S extends Schema>
  ? TextDataOptions<S>
  : TextOptions & NoData);
export type CustomProps<T> = { data?: T } & (T extends Table<infer S extends Schema>
  ? CustomDataOptions<S>
  : CustomOptions & NoData);

/** What a mark component's props were refused for, which its <Chart> shows (or throws). */
export interface Refused {
  readonly refused: unknown;
}

/**
 * A mark component's mark, or what refused its props (an unknown field):
 * caught here, since Svelte reads the mark as it checks what changed, before
 * its <Chart> could catch it.
 */
export function built(make: () => ChartMark): ChartMark | Refused {
  try {
    return make();
  } catch (refused) {
    return { refused };
  }
}

/** A mounted mark component as <Chart> sees it. */
export interface MarkEntry {
  /** The component's anchor element, in template order among the others. */
  readonly node: Element;
  /** The component's current mark, or what refused it; reading it tracks the component's props. */
  readonly mark: ChartMark | Refused;
}

export interface MarkList {
  add(entry: MarkEntry): void;
  remove(entry: MarkEntry): void;
}

const MARKS = Symbol("herceg marks");

/** Lets mark components among the children of a <Chart> add themselves. */
export function provideMarks(list: MarkList): void {
  setContext(MARKS, list);
}

/**
 * Adds the calling mark component to its <Chart> while the returned
 * attachment's element is mounted. That empty element orders the marks as
 * the template does, also when `{#if}` or `{#each}` adds one later.
 */
export function markAnchor(name: string, mark: () => ChartMark | Refused): Attachment {
  const list = getContext<MarkList | undefined>(MARKS);
  if (!list) throw new Error(`<${name}> must be inside a <Chart>`);
  return (node) => {
    const entry: MarkEntry = {
      node,
      get mark() {
        return mark();
      },
    };
    list.add(entry);
    return () => list.remove(entry);
  };
}

/**
 * A copy of plain arrays and objects, so a mark never sees later in-place
 * changes of `$state` it was built from, and reading the copy tracks every
 * nested value. Class instances such as tables are kept as they are.
 */
export function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(object).map((key) => [key, plain(object[key])]));
  }
  return value;
}
