// A pivot's grid in the page (`herceg/grid/pivot`): the DOM grid of grid.ts
// over a pivot grid model, with a header row over the columns' own while
// the pivot has several aggregates, where each pivot value heads its
// aggregates' columns (a `columnheader` spanning them, `aria-colspan`). The
// row follows the shown columns' final layout: a value's columns moved apart
// get a header each, and none spans columns held at an edge and others.
// Only the headers over mounted columns are mounted. A pivot that stopped at
// a limit says so in a notice under the grid.

import type { Schema } from "../data/table.ts";
import type { PlacedColumn } from "../grid/columns.ts";
import type { GridModel } from "../grid/model.ts";
import { type PivotGridModel, pivotOfModel } from "../grid/pivot.ts";
import {
  arrange,
  Grid,
  type GridOptions,
  type HeaderRows,
  placeCell,
  setAttribute,
  setText,
} from "./grid.ts";

export interface PivotGridOptions<S extends Schema = Schema> extends Omit<GridOptions, "model"> {
  /** What the grid shows, made with `createPivotGridModel`; the application owns it. */
  model: PivotGridModel<S>;
}

/** A pivot's grid (`createPivotGrid`): a `Grid` whose model is a pivot grid model. */
export type PivotGrid<S extends Schema = Schema> = Omit<Grid, "model"> & {
  readonly model: PivotGridModel<S>;
};

const CSS = `.herceg-grid .hg-band [role=columnheader]{border-inline-start:1px solid var(--hg-line)}
.herceg-grid .hg-notice{position:absolute;left:0;right:0;bottom:0;z-index:3;padding:4px 8px;background:var(--hg-surface);border-top:1px solid var(--hg-rule)}`;

/** A pivot's grid in `container`, which should have a height; see `Grid`. */
export function createPivotGrid<S extends Schema>(
  container: HTMLElement,
  options: PivotGridOptions<S>,
): PivotGrid<S> {
  const model = options.model as unknown as GridModel;
  const headers = new ValueHeaders(container.ownerDocument, model);
  const grid = new Grid(container, { ...options, model } as GridOptions, { headers });
  return grid as unknown as PivotGrid<S>;
}

/** A header mounted over a run of shown columns: a value's, or a blank over columns held at an edge. */
interface Header {
  readonly element: HTMLDivElement;
  readonly text: Text;
}

/** The row of pivot values over their aggregates' headers, and the notice of a pivot that stopped. */
class ValueHeaders implements HeaderRows {
  readonly #model: GridModel;
  readonly #row: HTMLDivElement;
  readonly #notice: HTMLDivElement;
  /** Headers mounted, by the id of their first column. */
  #headers = new Map<string, Header>();

  constructor(document: Document, model: GridModel) {
    this.#model = model;
    this.#row = document.createElement("div");
    this.#row.className = "hg-band";
    this.#row.setAttribute("role", "row");
    this.#row.setAttribute("aria-rowindex", "1");
    this.#notice = document.createElement("div");
    this.#notice.className = "hg-notice";
    this.#notice.setAttribute("role", "status");
    this.#notice.hidden = true;
  }

  rows(layout: readonly PlacedColumn[]): number {
    return layout.some(({ content }) => content.heading !== undefined) ? 1 : 0;
  }

  draw(
    header: HTMLElement,
    columns: readonly number[],
    cells: readonly { readonly element: HTMLElement }[],
    layout: readonly PlacedColumn[],
    width: number,
    span: number,
  ): void {
    const root = header.closest<HTMLElement>(".herceg-grid")!;
    this.#notify(root);
    // A header under a value is named with it: "api, requests" rather than "requests".
    columns.forEach((column, k) => {
      const { title, content } = layout[column]!;
      const element = cells[k]!.element;
      if (content.heading)
        setAttribute(element, "aria-label", `${content.heading.title}, ${title}`);
      else element.removeAttribute("aria-label");
    });
    const row = this.#row;
    if (this.rows(layout) === 0) {
      row.remove();
      root.style.removeProperty("--hg-header-rows");
      return;
    }
    if (row.parentElement !== header) {
      header.prepend(row);
      root.style.setProperty("--hg-header-rows", "2");
    }
    const value = `${span}px`;
    if (row.style.width !== value) row.style.width = value;
    // Runs of shown columns under one heading, and of columns without one
    // held at an edge, whose blanks keep the held headers in place.
    const runs: [number, number][] = [];
    for (const column of columns) {
      if (runs.length > 0 && column < runs.at(-1)![1]) continue;
      const [start, end] = runOf(layout, column);
      if (layout[start]!.content.heading || layout[start]!.pinned) runs.push([start, end]);
    }
    const previous = this.#headers;
    const headers = new Map<string, Header>();
    const document = row.ownerDocument;
    for (const [start, end] of runs) {
      const first = layout[start]!;
      const last = layout[end - 1]!;
      const key = first.id;
      const header = previous.get(key) ?? newHeader(document);
      previous.delete(key);
      headers.set(key, header);
      const { element } = header;
      placeCell(
        element,
        { x: first.x, width: last.x + last.width - first.x, pinned: first.pinned, align: "center" },
        layout,
        start,
        end,
        width,
      );
      const heading = first.content.heading;
      if (heading) {
        setAttribute(element, "role", "columnheader");
        element.removeAttribute("aria-hidden");
        setAttribute(element, "aria-colindex", String(start + 1));
        setAttribute(element, "aria-colspan", String(end - start));
        setText(header.text, heading.title);
      } else {
        // A blank over held columns without a heading: nothing to read.
        element.removeAttribute("role");
        element.removeAttribute("aria-colindex");
        element.removeAttribute("aria-colspan");
        setAttribute(element, "aria-hidden", "true");
        setText(header.text, "");
      }
    }
    for (const header of previous.values()) header.element.remove();
    this.#headers = headers;
    arrange(
      row,
      [...headers.values()].map(({ element }) => element),
      null,
    );
  }

  /** Shows, once the pivot stopped at a limit, what limit it passed. */
  #notify(root: HTMLElement) {
    const notice = this.#notice;
    if (notice.parentElement !== root) {
      const style = root.ownerDocument.createElement("style");
      style.textContent = CSS;
      root.append(style, notice);
    }
    const failure = pivotOfModel(this.#model)?.failure ?? null;
    if (notice.hidden === (failure === null)) return;
    notice.hidden = failure === null;
    notice.textContent = failure ? `Not updating: ${failure.message}.` : "";
  }
}

/** The run of shown columns around `column` under its heading (or none) and held at its edge (or none). */
function runOf(layout: readonly PlacedColumn[], column: number): [number, number] {
  const { pinned, content } = layout[column]!;
  const id = content.heading?.id;
  const same = (at: number) =>
    layout[at]!.pinned === pinned && layout[at]!.content.heading?.id === id;
  let start = column;
  while (start > 0 && same(start - 1)) start--;
  let end = column + 1;
  while (end < layout.length && same(end)) end++;
  return [start, end];
}

function newHeader(document: Document): Header {
  const element = document.createElement("div");
  const text = document.createTextNode("");
  element.append(text);
  return { element, text };
}
