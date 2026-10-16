// How mark components reach their <Chart>: through context, with an empty
// element whose place in the document gives the marks their order.

import type {
  ChartMark,
  CustomDataOptions,
  CustomOptions,
  GuideOptions,
  Panels,
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
export function built<T extends object = ChartMark>(make: () => T): T | Refused {
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

/** A mounted guide component (<Legend>) as <Chart> sees it. */
export interface GuideEntry {
  readonly node: Element;
  readonly guide: GuideOptions | Refused;
}

/**
 * A mounted layout component as <Chart> sees it: its element holds those of
 * the components inside it, and `place` makes the chart's panels of the
 * layout its components make (place.ts, loaded only with layout components).
 */
export interface LayoutEntry {
  readonly node: Element;
  /** Which component it is, and its props; reading them tracks the component's props. */
  readonly kind: "Columns" | "Rows" | "Grid" | "Cell" | "Panel" | "Inset";
  readonly props: Readonly<Record<string, unknown>>;
  /** The chart's panels, of the layout components `entries` in template order, and its `panels` prop. */
  readonly place: (entries: readonly LayoutEntry[], prop: Panels | undefined) => Panels;
}

export type Entry = MarkEntry | GuideEntry | LayoutEntry;

export interface MarkList {
  add(entry: Entry): void;
  remove(entry: Entry): void;
  /** The next panel's place among those declared, for an id when it gives none ("panel-3"). */
  nextPanel(): number;
}

const MARKS = Symbol("herceg marks");
const PANEL = Symbol("herceg panel");

/** Lets mark components among the children of a <Chart> add themselves. */
export function provideMarks(list: MarkList): void {
  setContext(MARKS, list);
}

/** The <Chart> of the calling component, which `name` must be inside. */
export function chartOf(name: string): MarkList {
  const list = getContext<MarkList | undefined>(MARKS);
  if (!list) throw new Error(`<${name}> must be inside a <Chart>`);
  return list;
}

/**
 * Adds the calling component to its <Chart> while the returned attachment's
 * element is mounted. That element orders the components as the template
 * does, also when `{#if}` or `{#each}` adds one later.
 */
export function partAnchor(name: string, part: (node: Element) => Entry): Attachment {
  const list = chartOf(name);
  return (node) => {
    const entry = part(node);
    list.add(entry);
    return () => list.remove(entry);
  };
}

/** Adds the calling mark component to its <Chart> while its anchor is mounted (see `partAnchor`). */
export function markAnchor(name: string, mark: () => ChartMark | Refused): Attachment {
  return partAnchor(name, (node) => ({
    node,
    get mark() {
      return mark();
    },
  }));
}

/**
 * The panel components inside a <Panel> or an <Inset> draw in (reading `id`
 * tracks its props); inside another layout component, none, as `where` says.
 */
export interface PanelScope {
  readonly id: string | undefined;
  readonly where: string;
}

/** Makes the calling layout component the scope of the components inside it. */
export function providePanel(scope: PanelScope): void {
  setContext(PANEL, scope);
}

/**
 * For the calling mark or guide component: its options in the panel of
 * the <Panel> or <Inset> it is inside, whose id a `panel` of its own may
 * only repeat; outside one, its options as they are.
 */
export function panelled(name: string): <O>(options: O) => O {
  const scope = getContext<PanelScope | undefined>(PANEL);
  return (options) => {
    if (!scope) return options;
    const { id } = scope;
    if (id === undefined)
      throw new Error(`<${name}> goes in a <Panel>, not directly in ${scope.where}`);
    const own = (options as { panel?: unknown }).panel;
    if (own === undefined) return { ...(options as object), panel: id } as typeof options;
    if (own !== id)
      throw new Error(
        `<${name}> panel: "${own}" is not the panel it is in, "${id}"; drop panel, or move <${name}> into that panel`,
      );
    return options;
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
