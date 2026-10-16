// Checks a chart's layout against its panels and compiles it into the tree
// the solver sizes (layout/grid.ts): each panel's place in it, the order
// panels are drawn and read in (depth first, cells by row then column, a
// panel followed by its insets), which panels line up with each other, and
// which panels a scale's scope groups. Loaded with subplots only.

import { ChartError, type ChartErrorCode } from "../spec/errors.ts";
import type {
  GridLayoutSpec,
  InsetSpec,
  LayoutCellSpec,
  LayoutSpec,
  PanelLayoutSpec,
  ScaleScope,
  TrackSpec,
} from "../spec/spec.ts";

/** A row or column of a grid: a share of the room left (with a least size), or a fixed size. */
export type Track = { weight: number; min: number } | { px: number };

/** Pixels between tracks by default. */
export const GAP = 12;

export interface GridNode {
  id: string | undefined;
  rows: Track[];
  columns: Track[];
  rowGap: number;
  columnGap: number;
  cells: CellNode[];
  /** Where it is in the layout, for messages. */
  path: string;
}

/** A cell of a grid: the tracks it spans, from `row0` up to `row1` (and columns), and what it holds. */
export interface CellNode {
  row0: number;
  row1: number;
  column0: number;
  column1: number;
  content: GridNode | LeafNode;
}

/** A panel in a cell: its index in the layout's order, and the insets over it. */
export interface LeafNode {
  panel: number;
  insets: InsetNode[];
}

export interface InsetNode {
  panel: number;
  spec: InsetSpec;
  insets: InsetNode[];
  path: string;
}

/** Where a panel's cell, or the cell holding it, is on a grid's tracks. */
export interface Footprint {
  grid: GridNode;
  row0: number;
  row1: number;
  column0: number;
  column1: number;
}

/** A panel's place: the footprints from the root grid down to its cell, or the inset it is. */
export interface PanelPlace {
  chain: Footprint[];
  /** For an inset: the panel it is drawn over, and how. */
  parent?: number;
  inset?: InsetNode;
}

export interface CompiledLayout {
  root: GridNode;
  /** The panels' ids in the order they are drawn and read. */
  order: string[];
  places: PanelPlace[];
}

/**
 * The layout of panels `ids` (in the order they are listed): `spec`, or by
 * default one column of the panels in order. Throws for a layout that names
 * a panel the chart does not have, places one twice or never, or puts cells
 * where the grid has no tracks or over each other.
 */
export function compileLayout(
  spec: LayoutSpec | undefined,
  ids: readonly string[],
): CompiledLayout {
  const known = new Set(ids);
  const placed = new Set<string>();
  // Panels placed in cells or as insets, and those fill grids take.
  const named = new Set<string>();
  collectNamed(spec, named);
  const unnamed = ids.filter((id) => !named.has(id));
  const order: string[] = [];
  const places: PanelPlace[] = [];
  const place = (id: string, path: string, at: PanelPlace): number => {
    if (!known.has(id))
      throw layoutError(
        path,
        `no panel "${id}"; name one of ${ids.map((p) => `"${p}"`).join(", ")}`,
        "unknown-reference",
      );
    if (placed.has(id))
      throw layoutError(
        path,
        `panel "${id}" is placed twice; give the second view a different panel id`,
      );
    placed.add(id);
    order.push(id);
    places.push(at);
    return order.length - 1;
  };

  const leaf = (node: PanelLayoutSpec, path: string, chain: Footprint[]): LeafNode => {
    const panel = place(node.panel, `${path}.panel`, { chain });
    return { panel, insets: insetsOf(node.insets, `${path}.insets`, panel) };
  };
  const insetsOf = (list: readonly InsetSpec[] | undefined, path: string, parent: number) =>
    (list ?? []).map((spec, i): InsetNode => {
      const at = `${path}[${i}]`;
      const node: InsetNode = { panel: -1, spec, insets: [], path: at };
      node.panel = place(spec.panel, `${at}.panel`, { chain: [], parent, inset: node });
      node.insets = insetsOf(spec.insets, `${at}.insets`, node.panel);
      return node;
    });

  const grids = new Map<string, string>();
  const grid = (node: GridLayoutSpec, path: string, chain: Footprint[]): GridNode => {
    if (node.id !== undefined) {
      if (grids.has(node.id))
        throw layoutError(
          `${path}.id`,
          `"${node.id}" names the grid at ${grids.get(node.id)} too; give each grid its own id`,
        );
      grids.set(node.id, path);
    }
    const columns = tracksOf(node.columns, `${path}.columns`);
    const cellSpecs = node.cells ?? fill(unnamed.splice(0), columns.length);
    const needed = Math.ceil(cellSpecs.length / columns.length) || 1;
    if (!node.cells && node.rows && node.rows.length < needed)
      throw layoutError(
        `${path}.rows`,
        `${cellSpecs.length} panels fill ${needed} rows of ${columns.length}, and the grid has ${node.rows.length}; add rows or leave rows out`,
      );
    const rows = node.rows
      ? tracksOf(node.rows, `${path}.rows`)
      : Array.from({ length: node.cells ? 1 : needed }, (): Track => ({ weight: 1, min: 0 }));
    const { gap } = node;
    const rowGap = typeof gap === "number" ? gap : (gap?.row ?? GAP);
    const columnGap = typeof gap === "number" ? gap : (gap?.column ?? GAP);
    for (const [name, value] of [
      ["row", rowGap],
      ["column", columnGap],
    ] as const)
      if (!(value >= 0 && Number.isFinite(value)))
        throw layoutError(
          `${path}.gap`,
          `expected pixels of at least 0 between ${name}s; received ${value}`,
        );
    const out: GridNode = { id: node.id, rows, columns, rowGap, columnGap, cells: [], path };
    // Which cell holds each track crossing, to find overlaps.
    const taken = new Map<number, number>();
    // Cells are read by row, then column, whatever order they are listed in;
    // messages name them by their place in the list.
    const listed = cellSpecs.map((cell, c) => ({ cell, c }));
    listed.sort((a, b) => a.cell.row - b.cell.row || a.cell.column - b.cell.column);
    for (const { cell, c } of listed) {
      const at = `${path}.cells[${c}]`;
      const { row, column, rowSpan = 1, columnSpan = 1 } = cell;
      checkIndex(row, rows.length, "row", `${at}.row`);
      checkIndex(column, columns.length, "column", `${at}.column`);
      checkSpan(rowSpan, row, rows.length, "row", `${at}.rowSpan`);
      checkSpan(columnSpan, column, columns.length, "column", `${at}.columnSpan`);
      for (let r = row; r < row + rowSpan; r++)
        for (let k = column; k < column + columnSpan; k++) {
          const key = r * columns.length + k;
          const other = taken.get(key);
          if (other !== undefined)
            throw layoutError(
              at,
              `overlaps cell ${other}; cells of a grid cannot overlap; use an inset to draw a panel over another`,
            );
          taken.set(key, c);
        }
      const footprint = {
        grid: out,
        row0: row,
        row1: row + rowSpan,
        column0: column,
        column1: column + columnSpan,
      };
      const inner = [...chain, footprint];
      const content = cell.content;
      // A layout of one panel is its root's only cell, named as it is given.
      const within = content === spec ? "layout" : `${at}.content`;
      const held =
        content?.type === "grid"
          ? grid(content, within, inner)
          : content?.type === "panel"
            ? leaf(content, within, inner)
            : undefined;
      if (!held)
        throw layoutError(
          `${at}.content`,
          `expected a grid or a panel; received ${JSON.stringify(content)}`,
        );
      out.cells.push({
        row0: row,
        row1: row + rowSpan,
        column0: column,
        column1: column + columnSpan,
        content: held,
      });
    }
    return out;
  };

  const root =
    spec === undefined
      ? grid({ type: "grid", columns: [1] }, "layout", [])
      : spec.type === "panel"
        ? grid({ type: "grid", cells: [{ row: 0, column: 0, content: spec }] }, "layout", [])
        : spec.type === "grid"
          ? grid(spec, "layout", [])
          : undefined;
  if (!root)
    throw layoutError(
      "layout.type",
      `expected "grid" or "panel"; received ${JSON.stringify((spec as { type?: unknown }).type)}`,
    );
  const missing = ids.find((id) => !placed.has(id));
  if (missing !== undefined)
    throw layoutError(
      "layout",
      `panel "${missing}" is placed nowhere; place it in a cell or as an inset, or drop it from panels`,
    );
  return { root, order, places };
}

/** The panels a layout names, in cells and as insets. */
function collectNamed(spec: LayoutSpec | undefined, out: Set<string>): void {
  if (!spec || typeof spec !== "object") return;
  if (spec.type === "panel") {
    out.add(spec.panel);
    collectInsets(spec.insets, out);
  } else for (const cell of spec.cells ?? []) collectNamed(cell.content, out);
}

function collectInsets(list: readonly InsetSpec[] | undefined, out: Set<string>): void {
  for (const inset of list ?? []) {
    out.add(inset.panel);
    collectInsets(inset.insets, out);
  }
}

/** Cells for `ids` filling rows of `columns`, in order. */
function fill(ids: readonly string[], columns: number): LayoutCellSpec[] {
  return ids.map((panel, i) => ({
    row: Math.floor(i / columns),
    column: i % columns,
    content: { type: "panel" as const, panel },
  }));
}

function tracksOf(list: readonly TrackSpec[] | undefined, path: string): Track[] {
  if (list === undefined) return [{ weight: 1, min: 0 }];
  if (!Array.isArray(list) || list.length === 0)
    throw layoutError(
      path,
      `expected a list of at least one track; received ${JSON.stringify(list)}`,
    );
  return list.map((track, i): Track => {
    const at = `${path}[${i}]`;
    if (typeof track === "number") return { weight: positive(track, at, "a weight"), min: 0 };
    if (track && typeof track === "object") {
      if ("px" in track) return { px: positive(track.px, `${at}.px`, "pixels") };
      if ("weight" in track) {
        const min = track.min ?? 0;
        if (!(min >= 0 && Number.isFinite(min)))
          throw layoutError(`${at}.min`, `expected pixels of at least 0; received ${min}`);
        return { weight: positive(track.weight, `${at}.weight`, "a weight"), min };
      }
    }
    throw layoutError(
      at,
      `expected a weight, { weight, min }, or { px }; received ${JSON.stringify(track)}`,
    );
  });
}

function positive(value: number, path: string, what: string): number {
  if (!(typeof value === "number" && value > 0 && Number.isFinite(value)))
    throw layoutError(path, `expected ${what} greater than 0; received ${JSON.stringify(value)}`);
  return value;
}

function checkIndex(index: number, count: number, name: string, path: string): void {
  if (!(Number.isInteger(index) && index >= 0))
    throw layoutError(path, `expected a whole number from 0; received ${JSON.stringify(index)}`);
  if (index >= count)
    throw layoutError(
      path,
      `${index} is past the grid's ${count} ${name}${count === 1 ? "" : "s"}; add ${name}s or move the cell`,
    );
}

function checkSpan(span: number, from: number, count: number, name: string, path: string): void {
  if (!(Number.isInteger(span) && span >= 1))
    throw layoutError(
      path,
      `expected a whole number of at least 1; received ${JSON.stringify(span)}`,
    );
  if (from + span > count)
    throw layoutError(
      path,
      `reaches past the grid's ${count} ${name}${count === 1 ? "" : "s"}; add ${name}s or span fewer`,
    );
}

/** A layout refused, as a ChartError at `path`. */
export function layoutError(
  path: string,
  problem: string,
  code: ChartErrorCode = "invalid-option",
): ChartError {
  return new ChartError({ code, path, message: `${path}: ${problem}` });
}

/**
 * Whether panel `q` lines up with panel `p` along `axis` ("x": on the same
 * columns, "y": on the same rows) and lies after it across them (below it,
 * or right of it): their cells span the same tracks of the grid where they
 * part, and each spans the whole of the cells holding it below that grid,
 * whose grids fill them (a grid of fixed tracks only need not). Insets
 * line up with nothing.
 */
export function linedUp(layout: CompiledLayout, p: number, q: number, axis: "x" | "y"): -1 | 0 | 1 {
  const a = layout.places[p]!.chain;
  const b = layout.places[q]!.chain;
  if (p === q || a.length === 0 || b.length === 0) return 0;
  let d = 0;
  while (d < a.length && d < b.length && same(a[d]!, b[d]!)) d++;
  if (d === a.length || d === b.length) return 0;
  const [fa, fb] = [a[d]!, b[d]!];
  const [lo, hi, across0, across1] =
    axis === "x"
      ? (["column0", "column1", "row0", "row1"] as const)
      : (["row0", "row1", "column0", "column1"] as const);
  if (fa[lo] !== fb[lo] || fa[hi] !== fb[hi]) return 0;
  const whole = (chain: Footprint[]) =>
    chain.slice(d + 1).every((f) => {
      const tracks = axis === "x" ? f.grid.columns : f.grid.rows;
      return f[lo] === 0 && f[hi] === tracks.length && tracks.some((track) => "weight" in track);
    });
  if (!whole(a) || !whole(b)) return 0;
  return fb[across0] >= fa[across1] ? 1 : fa[across0] >= fb[across1] ? -1 : 0;
}

function same(a: Footprint, b: Footprint): boolean {
  return a.grid === b.grid && a.row0 === b.row0 && a.column0 === b.column0;
}

/**
 * The instance of a scale each panel draws with under `scope`, numbered in
 * order of first appearance: one for every panel but insets ("chart"), one
 * each ("panel"), by the rows or columns of the grid holding each panel
 * ("row", "column"), by the tracks of grid `layout` its panels' cells, or
 * the cells holding them, span (`{ layout, by }`), or one for the panels
 * listed (`{ panels }`). Panels a scope leaves out have instances of their
 * own. `path` says where the scope is set, for messages.
 */
export function scopeGroups(layout: CompiledLayout, scope: ScaleScope, path: string): number[] {
  const { places, order } = layout;
  if (typeof scope === "object") checkScope(layout, scope, path);
  const keys = places.map((place, i): string => {
    const own = `panel ${i}`;
    // Insets share a scale only with the panels a list names them among.
    if (typeof scope === "object" && "panels" in scope)
      return scope.panels.includes(order[i]!) ? "listed" : own;
    if (scope === "panel" || place.inset) return own;
    if (scope === "chart") return "chart";
    if (scope === "row" || scope === "column") {
      const f = place.chain.at(-1)!;
      return key(f, scope, place.chain.length - 1);
    }
    const depth = place.chain.findIndex((f) => f.grid.id === scope.layout);
    return depth < 0 ? own : key(place.chain[depth]!, scope.by, depth);
  });
  const numbers = new Map<string, number>();
  return keys.map((k) => {
    let n = numbers.get(k);
    if (n === undefined) {
      n = numbers.size;
      numbers.set(k, n);
    }
    return n;
  });
}

/** A footprint's tracks along `by` in its grid, as a key. */
function key(f: Footprint, by: "row" | "column", depth: number): string {
  const [lo, hi] = by === "row" ? [f.row0, f.row1] : [f.column0, f.column1];
  return `${depth} ${f.grid.path} ${by} ${lo} ${hi}`;
}

function checkScope(
  layout: CompiledLayout,
  scope: Exclude<ScaleScope, string>,
  path: string,
): void {
  if ("panels" in scope) {
    if (!Array.isArray(scope.panels))
      throw layoutError(
        `${path}.panels`,
        `expected a list of panel ids; received ${JSON.stringify(scope.panels)}`,
      );
    for (const [i, id] of scope.panels.entries())
      if (!layout.order.includes(id))
        throw layoutError(
          `${path}.panels[${i}]`,
          `no panel "${id}"; name one of ${layout.order.map((p) => `"${p}"`).join(", ")}`,
          "unknown-reference",
        );
    return;
  }
  if (scope.by !== "row" && scope.by !== "column")
    throw layoutError(
      `${path}.by`,
      `expected "row" or "column"; received ${JSON.stringify(scope.by)}`,
    );
  const ids = gridIds(layout.root);
  if (!ids.includes(scope.layout))
    throw layoutError(
      `${path}.layout`,
      ids.length
        ? `no grid "${scope.layout}"; name one of ${ids.map((id) => `"${id}"`).join(", ")}`
        : `no grid "${scope.layout}"; give the grid an id`,
      "unknown-reference",
    );
}

function gridIds(grid: GridNode, out: string[] = []): string[] {
  if (grid.id !== undefined) out.push(grid.id);
  for (const cell of grid.cells) if ("cells" in cell.content) gridIds(cell.content, out);
  return out;
}
