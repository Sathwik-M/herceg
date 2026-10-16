// How layout components reach their <Chart>: each adds an entry, whose
// element holds those of the components inside it, and the chart's first
// layout component makes the chart's panels of the tree they form (see
// herceg/layout). Loaded only with layout components.

import type { Panels } from "herceg";
import {
  type InsetOptions,
  type LayoutCellOptions,
  type LayoutOptions,
  type PanelDefinition,
  panels,
  type Tracks,
  cell as toCell,
  columns as toColumns,
  grid as toGrid,
  inset as toInset,
  panel as toPanel,
  rows as toRows,
} from "herceg/layout";
import type { Attachment } from "svelte/attachments";
import { type LayoutEntry, partAnchor, plain } from "./marks.js";

/** Adds the calling layout component to its <Chart> while its element is mounted. */
export function layoutAnchor(
  kind: LayoutEntry["kind"],
  props: () => Record<string, unknown>,
): Attachment {
  return partAnchor(kind, (node) => ({
    node,
    kind,
    get props() {
      return plain(props()) as Record<string, unknown>;
    },
    place,
  }));
}

/** `options` without the settings left out (undefined), for options that may be absent but not undefined. */
function given<T extends object>(options: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

function count(tracks: Tracks): number {
  return typeof tracks === "number" ? tracks : tracks.length;
}

/** Tracks of `children.length` weights 1, or `weights`, which must give one per child. */
function tracksFor(tag: string, weights: Tracks | undefined, children: readonly unknown[]): Tracks {
  if (children.length === 0) throw new Error(`${tag}: expected children; received none`);
  if (weights !== undefined && count(weights) !== children.length)
    throw new Error(
      `${tag} weights: expected one per child, ${children.length}; received ${count(weights)}`,
    );
  return weights ?? children.length;
}

/**
 * The chart's panels, placed by the layout of `entries`, in template order,
 * whose first is its root: refused beside the chart's own `panels` prop.
 */
function place(entries: readonly LayoutEntry[], prop: Panels | undefined): Panels {
  const [root, second] = entries.filter(
    (entry) => !entries.some((other) => other !== entry && other.node.contains(entry.node)),
  );
  if (second)
    throw new Error(
      `<Chart>: one layout component places its panels, and <${second.kind}> is a second; put it inside the first`,
    );
  if (prop)
    throw new Error(
      "<Chart> panels: layout components among its children place its panels; drop panels, or the layout components",
    );
  // Panels without ids are named in the order they are made, which an id given may repeat.
  const ids = new Set<string>();
  for (const { kind, props } of entries) {
    if (kind !== "Panel" && kind !== "Inset") continue;
    const id = props.id as string;
    if (ids.has(id))
      throw new Error(
        `<${kind}> id: "${id}" names two panels; give each its own (those without one are "panel-1", "panel-2", ... in the order they are made)`,
      );
    ids.add(id);
  }
  const byNode = new Map(entries.map((entry) => [entry.node, entry]));
  const children = new Map<LayoutEntry, LayoutEntry[]>(entries.map((entry) => [entry, []]));
  for (const entry of entries)
    for (let node = entry.node.parentElement; node; node = node.parentElement) {
      const parent = byNode.get(node);
      if (!parent) continue;
      children.get(parent)!.push(entry);
      break;
    }

  const nodeOf = (entry: LayoutEntry): LayoutOptions => {
    const { kind } = entry;
    const props = entry.props as Record<string, never>;
    const inner = children.get(entry)!;
    if (kind === "Columns" || kind === "Rows") {
      const { weights, id, gap } = props as { weights?: Tracks; id?: string; gap?: number };
      const nodes = inner.map(nodeOf);
      const make = kind === "Columns" ? toColumns : toRows;
      return make(tracksFor(`<${kind}>`, weights, nodes), nodes, given({ id, gap }));
    }
    if (kind === "Grid") return gridOf(props, inner);
    if (kind === "Panel") {
      const definition = props as PanelDefinition;
      return toPanel(definition, insetsOf(entry, `panel "${definition.id}"`));
    }
    throw new Error(
      kind === "Cell" ? "<Cell> goes in a <Grid>" : "<Inset> goes in a <Panel> or another <Inset>",
    );
  };

  /** A panel's insets, the only layout components it may hold. */
  const insetsOf = (entry: LayoutEntry, where: string): InsetOptions[] | undefined => {
    const insets = children.get(entry)!.map((child) => {
      if (child.kind !== "Inset")
        throw new Error(
          `<${child.kind}> goes in a <Chart> or another layout component, not in ${where}: put it beside the <Panel>`,
        );
      const { place, width, height, indicator, ...definition } = child.props as Omit<
        InsetOptions,
        "panel"
      > &
        PanelDefinition;
      const nested = insetsOf(child, `inset "${definition.id}"`);
      return toInset(
        definition as PanelDefinition,
        given({ place, width, height, indicator, insets: nested }),
      );
    });
    return insets.length > 0 ? insets : undefined;
  };

  const gridOf = (props: Record<string, never>, inner: LayoutEntry[]): LayoutOptions => {
    let { rows, columns, id, gap } = props as {
      rows?: Tracks;
      columns?: Tracks;
      id?: string;
      gap?: number;
    };
    const cells = inner.filter((child) => child.kind === "Cell");
    let placed: LayoutCellOptions[];
    if (cells.length === inner.length)
      placed = cells.map((child) => {
        const [only, ...more] = children.get(child)!;
        if (!only || more.length > 0)
          throw new Error(
            `<Cell>: expected one <Panel>, <Columns>, <Rows>, or <Grid>; received ${more.length + (only ? 1 : 0)}`,
          );
        const { row, column, rowSpan, columnSpan } = child.props as {
          row: number;
          column: number;
          rowSpan?: number;
          columnSpan?: number;
        };
        return toCell(given({ row, column, rowSpan, columnSpan }), nodeOf(only));
      });
    else if (cells.length === 0) {
      // Filled row by row, `columns` across.
      const across = columns === undefined ? 1 : count(columns);
      placed = inner.map((child, k) =>
        toCell({ row: Math.floor(k / across), column: k % across }, nodeOf(child)),
      );
      rows ??= Math.max(1, Math.ceil(inner.length / across));
    } else
      throw new Error(
        "<Grid> children: expected <Cell> components, or panels and grids to fill it row by row; received both",
      );
    return toGrid(given({ rows, columns, id, gap }), placed);
  };

  return panels(nodeOf(root!));
}
