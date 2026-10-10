// A remote grid in the page (`herceg/grid/remote`): the DOM grid of grid.ts
// over a remote grid model, with what loading adds. Rows still loading are
// placeholders marked busy (`aria-busy`), the grid itself too while it waits
// for its query's first rows; rows that failed say so, and a notice under
// the grid offers to try again. Failures and the model's refusals are
// announced once each through the grid's live region, which is outside the
// busy grid so announcements are not held back.

import type { Schema } from "../data/table.ts";
import type { ShownRow } from "../grid/base.ts";
import type { RemoteGridModel, RemoteGridRow, RemoteGridStatus } from "../grid/remote.ts";
import { Grid, type GridExtras, type GridOptions, setAttribute } from "./grid.ts";

export interface RemoteGridOptions<S extends Schema = Schema>
  extends Omit<GridOptions<S, RemoteGridModel<S>>, "model"> {
  /** What the grid shows, made with `createRemoteGridModel`; the application owns it. */
  model: RemoteGridModel<S>;
}

/** A remote grid (`createRemoteGrid`): a `Grid` whose model is a remote grid model. */
export type RemoteGrid<S extends Schema = Schema> = Grid<S, RemoteGridModel<S>>;

const INSTRUCTIONS =
  "Rows load as they come into view. Arrow keys, Page Up, Page Down, Home, and End move between cells. Space selects a row, Shift with arrow keys selects a range of rows already loaded, Control A selects every row matching the query, and Escape clears the selection. Enter on a column header sorts by it; Shift and Enter adds it to the sort. On a column header, Shift with Left or Right Arrow moves the column, Alt with Left or Right Arrow resizes it, and Alt and Down Arrow opens its menu.";
const GROUP_INSTRUCTIONS =
  " Rows are grouped. Enter on a group expands or collapses it, and Space selects the rows matching it. On a row's first cell, Right Arrow expands a group, Left Arrow collapses it, and Left Arrow on a collapsed group or a group's row goes to the group holding it.";

const CSS = `.herceg-grid [data-state] [aria-colindex]{color:var(--hg-muted)}
.herceg-grid [data-state=failed] [aria-colindex="1"]{font-style:italic}
.herceg-grid .hg-status{position:absolute;left:0;right:0;bottom:0;z-index:3;display:flex;gap:8px;align-items:center;padding:4px 8px;background:var(--hg-surface);border-top:1px solid var(--hg-rule)}
.herceg-grid .hg-status[hidden]{display:none}
.herceg-grid .hg-status button{font:inherit}`;

/** A remote grid in `container`, which should have a height; see `Grid`. */
export function createRemoteGrid<S extends Schema>(
  container: HTMLElement,
  options: RemoteGridOptions<S>,
): RemoteGrid<S> {
  return new Grid(
    container,
    options as GridOptions<S, RemoteGridModel<S>>,
    new LoadingRows(container.ownerDocument, options.model as unknown as RemoteGridModel),
  );
}

/** What loading adds to the DOM grid: busy and failed rows, the notice, and announcements. */
class LoadingRows implements GridExtras {
  readonly #model: RemoteGridModel;
  readonly #notice: HTMLDivElement;
  readonly #text: Text;
  readonly #button: HTMLButtonElement;
  /** The failure and the message last announced. */
  #said: { error: Error | null; message: number } = { error: null, message: 0 };
  #scroller: HTMLElement | null = null;
  /** The height the notice was last given under the rows, in CSS pixels. */
  #room = 0;

  constructor(document: Document, model: RemoteGridModel) {
    this.#model = model;
    const notice = document.createElement("div");
    notice.className = "hg-status";
    notice.hidden = true;
    this.#text = document.createTextNode("");
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Try again";
    button.addEventListener("click", () => {
      // The button hides as rows load: the focus goes back to the grid, in
      // view (the grid shows its focused cell when it gets the focus), moved
      // before trying again. A refresh takes the focus to the header and back
      // to its record, so its row stays; a header's focus may be waiting to
      // go back to its record, so it is left alone.
      const focus = model.focus;
      const refreshing =
        (model.status.error as { code?: string } | null)?.code === "snapshot-expired";
      if (focus && focus.rowIndex >= 0) {
        const height = model.rowHeight;
        const first = Math.min(model.rowCount - 1, Math.ceil(model.top / height));
        const last = Math.floor((model.top + model.viewportHeight) / height) - 1;
        const away = focus.rowIndex < first || focus.rowIndex > last;
        const rowIndex = away && !refreshing ? first : focus.rowIndex;
        const column = shownColumn(model, focus.columnIndex) ?? focus.column;
        if (rowIndex !== focus.rowIndex || column !== focus.column)
          model.focusCell(rowIndex, column, { reveal: false });
      }
      model.retry();
      this.#scroller?.focus({ preventScroll: true });
    });
    this.#button = button;
    notice.append(this.#text, button);
    this.#notice = notice;
  }

  instructions(grouped: boolean): string {
    return grouped ? INSTRUCTIONS + GROUP_INSTRUCTIONS : INSTRUCTIONS;
  }

  rowCount(): number | null {
    return this.#model.exactRowCount;
  }

  row(element: HTMLElement, row: ShownRow): void {
    const state =
      row.kind === "placeholder" ? (row as RemoteGridRow & { kind: "placeholder" }).state : "";
    setAttribute(element, "data-state", state);
    if (state === "loading") setAttribute(element, "aria-busy", "true");
    else element.removeAttribute("aria-busy");
  }

  drawn(scroller: HTMLElement, say: (text: string) => void): void {
    const root = scroller.parentElement!;
    const notice = this.#notice;
    if (notice.parentElement !== root) {
      const style = root.ownerDocument.createElement("style");
      style.textContent = CSS;
      root.append(style, notice);
    }
    this.#scroller = scroller;
    const model = this.#model;
    const status = model.status;
    // Busy while the first rows of a query load; rows loading later are busy themselves.
    if (status.starting) setAttribute(scroller, "aria-busy", "true");
    else scroller.removeAttribute("aria-busy");
    this.#show(status, scroller);
    const said = this.#said;
    if (status.error && status.error !== said.error)
      say(`Rows could not load: ${status.error.message}`);
    const message = model.message;
    if (message && message.count !== said.message) say(message.text);
    this.#said = { error: status.error, message: message?.count ?? 0 };
  }

  /**
   * Shows the notice while blocks failed, under the grid's rows rather than
   * over them, with a button to try again (to refresh, past an expired
   * snapshot); none for refusals trying again cannot change.
   */
  #show({ error, failed }: RemoteGridStatus, scroller: HTMLElement) {
    const shown = error !== null || failed > 0;
    this.#notice.hidden = !shown;
    const code = (error as { code?: string } | null)?.code;
    const final =
      code === "invalid-query" || code === "unsupported-query" || code === "schema-changed";
    const text = !shown
      ? ""
      : code === "snapshot-expired"
        ? "The rows changed where they live. "
        : final
          ? `The source refused the query: ${error!.message}`
          : "Some rows could not load. ";
    if (this.#text.data !== text) this.#text.data = text;
    this.#button.hidden = final;
    const label = code === "snapshot-expired" ? "Refresh" : "Try again";
    if (this.#button.textContent !== label) this.#button.textContent = label;
    this.#reserve(scroller);
  }

  /**
   * Makes the rows end above the notice, as tall as it is now: measured each
   * frame it shows, and the grid draws a frame whenever it is resized, which
   * can wrap the notice's text.
   */
  #reserve(scroller: HTMLElement) {
    const height = this.#notice.hidden ? 0 : this.#notice.offsetHeight;
    if (height === this.#room) return;
    this.#room = height;
    scroller.style.bottom = height > 0 ? `${height}px` : "";
  }
}

/**
 * The id of the first column wholly in view when the column at
 * `columnIndex` is scrolled away (columns held at an edge always show), or
 * undefined when it is in view.
 */
function shownColumn(model: RemoteGridModel, columnIndex: number): string | undefined {
  const layout = model.columnLayout;
  const column = layout[columnIndex];
  if (!column || column.pinned !== null) return undefined;
  const held = (side: "left" | "right") =>
    layout.filter(({ pinned }) => pinned === side).reduce((sum, { width }) => sum + width, 0);
  const start = model.left + held("left");
  const end = model.left + model.viewportWidth - held("right");
  const inView = ({ x, width }: { x: number; width: number }) => x >= start && x + width <= end;
  if (inView(column)) return undefined;
  return layout.find((other) => other.pinned === null && inView(other))?.id;
}
