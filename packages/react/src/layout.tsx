// Layout elements, imported as `@herceg/react/layout`: where a <Chart>'s
// panels go, written as the tree they make (see herceg/layout). They render
// nothing: <Chart> reads them among its children, as it reads mark
// elements, and makes its `panels` of them. Marks and legends inside a
// <Panel> or an <Inset> draw in it.
//
// ```tsx
// <Chart height={600}>
//   <Columns weights={[2, 1]}>
//     <Rows weights={[2, 1]}>
//       <Panel id="latency" title="p99">
//         <Line data={data} x="time" y="p99" color="region" />
//       </Panel>
//       <Panel id="errors" title="Errors">
//         <Bar data={data} x="time" y="errors" color="region" />
//       </Panel>
//     </Rows>
//     <Panel id="share" title="By region">
//       <Pie data={data} category="region" value="requests" />
//     </Panel>
//   </Columns>
// </Chart>
// ```

import {
  type GridOptions,
  type InsetOptions,
  type LayoutCellOptions,
  type LayoutOptions,
  normalizeLayout,
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
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
import { collect, type PartElement, type Parts, type Placing } from "./chart.tsx";

export interface ColumnsProps extends GridOptions {
  /** The columns' widths, left to right: weights, `{ weight, min }`, or `{ px }`; equal by default. */
  weights?: Tracks | undefined;
  /** A <Panel>, <Columns>, <Rows>, or <Grid> per column. */
  children?: ReactNode;
}

export interface RowsProps extends GridOptions {
  /** The rows' heights, top to bottom: weights, `{ weight, min }`, or `{ px }`; equal by default. */
  weights?: Tracks | undefined;
  /** A <Panel>, <Columns>, <Rows>, or <Grid> per row. */
  children?: ReactNode;
}

export interface GridProps extends GridOptions {
  rows?: Tracks | undefined;
  columns?: Tracks | undefined;
  /**
   * <Cell> elements, or panels and grids that fill the grid row by row (with
   * as many rows as they need when `rows` is left out).
   */
  children?: ReactNode;
}

export interface CellProps {
  /** Where the cell starts, from 0, and how many tracks it spans (1 by default). */
  row: number;
  column: number;
  rowSpan?: number | undefined;
  columnSpan?: number | undefined;
  /** One <Panel>, <Columns>, <Rows>, or <Grid>. */
  children?: ReactNode;
}

/** A panel's settings (its id may be left out), and the marks, legends, and insets drawn in it. */
export type PanelProps = PanelDefinition & { children?: ReactNode };

/** An inset's panel settings and its place and size over its parent's plot. */
export type InsetProps = PanelDefinition &
  Omit<InsetOptions, "panel" | "insets"> & { children?: ReactNode };

/** A panel's settings and what is drawn in it, from the <Panel> or <Inset> that gives them. */
interface Drawn {
  definition: PanelDefinition;
  children: ReactElement[];
}

/** An element that is a node of a layout. */
interface LayoutElement<P> extends PartElement<P> {
  nodeOf: (props: P, drawn: Drawn[]) => LayoutOptions;
}

/** The name an element is written with, for messages: "<Line>". */
function tagOf(type: unknown): string {
  const named = type as { displayName?: string; name?: string } | null;
  return `<${named?.displayName ?? named?.name ?? "element"}>`;
}

/** How the elements inside panel `panel` take it, a `panel` of their own only repeating it. */
function placing(panel: string): Placing {
  return {
    panel,
    props(type, props) {
      const own = (props as { panel?: unknown }).panel;
      if (own === undefined) return { ...props, panel };
      if (own !== panel) {
        const tag = tagOf(type);
        throw new Error(
          `${tag} panel: "${own}" is not the panel it is in, "${panel}"; drop panel, or move ${tag} into that panel`,
        );
      }
      return props;
    },
  };
}

/** The elements among `children`, those in fragments included. */
function elementsOf(children: ReactNode): ReactElement[] {
  return Children.toArray(children).flatMap((child) => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment)
      return elementsOf((child.props as { children?: ReactNode }).children);
    return [child];
  });
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

/** The layout node `child` makes, as a child of `parent`. */
function nodeOf(child: ReactElement, drawn: Drawn[], parent: string): LayoutOptions {
  const element = child.type as Partial<LayoutElement<unknown>>;
  if (typeof element.nodeOf !== "function")
    throw new Error(
      `${parent} children must be <Panel>, <Columns>, <Rows>, or <Grid>; received ${tagOf(child.type)}: put marks in a <Panel>`,
    );
  return element.nodeOf(child.props, drawn);
}

/**
 * A layout element: as one of <Chart>'s children, it makes the chart's
 * panels of the layout it is the root of, and adds the marks and legends
 * drawn in them.
 */
function layoutElement<P>(
  name: string,
  node: (props: P, drawn: Drawn[]) => LayoutOptions,
): LayoutElement<P> {
  const tag = `<${name}>`;
  const element = (() => null) as unknown as LayoutElement<P>;
  element.displayName = name;
  element.nodeOf = node;
  element.addTo = (props: P, parts: Parts, inside: Placing | undefined) => {
    if (inside)
      throw new Error(
        `${tag} goes in a <Chart> or another layout element, not in panel "${inside.panel}": put it beside the <Panel>`,
      );
    if (parts.panels)
      throw new Error(
        `<Chart>: one layout element places its panels, and ${tag} is a second; put it inside the first`,
      );
    const drawn: Drawn[] = [];
    const normal = normalizeLayout([], node(props, drawn));
    parts.panels = panels(normal.list, normal.layout);
    for (const { definition, children } of drawn)
      collect(children, parts, placing(normal.idOf(definition)));
  };
  return element;
}

/** An element that goes only where its parent element reads it, and is refused elsewhere. */
function placedElement<P>(name: string, where: string): PartElement<P> {
  const element = (() => null) as unknown as PartElement<P>;
  element.displayName = name;
  element.addTo = () => {
    throw new Error(`<${name}> goes in ${where}`);
  };
  return element;
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

/** Cells side by side, as wide as `weights` say (equal by default): a <Panel>, <Columns>, <Rows>, or <Grid> each. */
export const Columns = /* @__PURE__ */ layoutElement(
  "Columns",
  ({ weights, children, id, gap }: ColumnsProps, drawn) => {
    const nodes = elementsOf(children).map((child) => nodeOf(child, drawn, "<Columns>"));
    return toColumns(tracksFor("<Columns>", weights, nodes), nodes, given({ id, gap }));
  },
);

/** Cells from the top down, as tall as `weights` say (equal by default): a <Panel>, <Columns>, <Rows>, or <Grid> each. */
export const Rows = /* @__PURE__ */ layoutElement(
  "Rows",
  ({ weights, children, id, gap }: RowsProps, drawn) => {
    const nodes = elementsOf(children).map((child) => nodeOf(child, drawn, "<Rows>"));
    return toRows(tracksFor("<Rows>", weights, nodes), nodes, given({ id, gap }));
  },
);

/** A cell of a <Grid>: at `row` and `column` (from 0), spanning `rowSpan` and `columnSpan` tracks. */
export const Cell = /* @__PURE__ */ placedElement<CellProps>("Cell", "a <Grid>");

/**
 * Rows and columns of tracks holding <Cell> elements, which may span
 * tracks; or holding panels and grids that fill it row by row.
 */
export const Grid = /* @__PURE__ */ layoutElement(
  "Grid",
  ({ rows, columns, children, id, gap }: GridProps, drawn) => {
    const elements = elementsOf(children);
    const cells = elements.filter((child) => child.type === Cell);
    let placed: LayoutCellOptions[];
    if (cells.length === elements.length)
      placed = cells.map((child) => {
        const { children: content, ...place } = child.props as CellProps;
        const [only, ...more] = elementsOf(content);
        if (!only || more.length > 0)
          throw new Error(
            `<Cell>: expected one <Panel>, <Columns>, <Rows>, or <Grid>; received ${more.length + (only ? 1 : 0)}`,
          );
        return toCell(given(place), nodeOf(only, drawn, "<Cell>"));
      });
    else if (cells.length === 0) {
      // Filled row by row, `columns` across.
      const across = columns === undefined ? 1 : count(columns);
      placed = elements.map((child, k) =>
        toCell({ row: Math.floor(k / across), column: k % across }, nodeOf(child, drawn, "<Grid>")),
      );
      rows ??= Math.max(1, Math.ceil(elements.length / across));
    } else
      throw new Error(
        "<Grid> children: expected <Cell> elements, or panels and grids to fill it row by row; received both",
      );
    return toGrid(given({ rows, columns, id, gap }), placed);
  },
);

/** The insets among a panel's children, and the rest, drawn in it. */
function split(children: ReactNode, drawn: Drawn[], definition: PanelDefinition) {
  const own: Drawn = { definition, children: [] };
  drawn.push(own);
  const insets: InsetOptions[] = [];
  for (const child of elementsOf(children))
    if (child.type === Inset) insets.push(insetOf(child.props as InsetProps, drawn));
    else own.children.push(child);
  return insets.length > 0 ? insets : undefined;
}

function insetOf(props: InsetProps, drawn: Drawn[]): InsetOptions {
  const { children, place, width, height, indicator, ...definition } = props;
  const insets = split(children, drawn, definition);
  return toInset(definition, given({ place, width, height, indicator, insets }));
}

/**
 * A panel: its settings (`id`, `title`, `x`, `y`, ...; the id may be left
 * out), with the marks, legends, and insets drawn in it as children. Marks
 * take its id as their `panel`.
 */
export const Panel = /* @__PURE__ */ layoutElement(
  "Panel",
  ({ children, ...definition }: PanelProps, drawn) =>
    toPanel(definition, split(children, drawn, definition)),
);

/**
 * A panel drawn over its parent <Panel>'s plot (or another inset's), at
 * `place` and `width` by `height` (the top right, 35%, by default), with
 * scales of its own: its settings, and the marks, legends, and insets drawn
 * in it as children.
 */
export const Inset = /* @__PURE__ */ placedElement<InsetProps>(
  "Inset",
  "a <Panel> or another <Inset>",
);
