// What a grid's headers do to their columns (grid.ts draws the grid):
// dragging a header's edge resizes its column, previewed once a frame, and
// dragging the rest of it moves the column among those of its region (pinned
// left, unpinned, pinned right). Keys on a focused header and a column menu
// (grid-menu.ts) do the same, and also pin, hide, and show columns. Each
// says what it did through the grid's live region.

import type { Schema } from "../data/table.ts";
import type { BaseGridModel } from "../grid/base.ts";
import {
  type GridColumn,
  type GridColumnLayout,
  MIN_COLUMN_WIDTH,
  type PinSide,
} from "../grid/columns.ts";
import { ColumnMenu, type MenuGroup, type MenuItem } from "./grid-menu.ts";

/** What the controls need of their grid. */
export interface ColumnHost<S extends Schema> {
  readonly model: BaseGridModel<S>;
  readonly root: HTMLElement;
  /** The grid's scroll container, where its pointer events arrive. */
  readonly scroller: HTMLElement;
  /** The header cells mounted, in order. */
  headerCells(): readonly { readonly id: string; readonly element: HTMLElement }[];
  /** The cell an element shows (row -1 for a header), as the model has it now; null when gone. */
  cellOf(element: Element | null): { rowIndex: number; column: string } | null;
  /** Draws now; with `focus`, the page's focus goes to the model's focused cell. */
  render(focus: boolean): void;
  /** Draws on the next frame. */
  invalidate(): void;
  say(text: string): void;
}

/** How far a press on a header moves before it drags, in CSS pixels: farther than a click. */
const DRAG_THRESHOLD = 4;
/** How much the keys and the menu resize a column by, in CSS pixels. */
const RESIZE_STEP = 16;

/**
 * A header pressed: dragged past `DRAG_THRESHOLD`, its edge resizes the
 * column and the rest of it moves the column. Escape puts things back.
 */
type Gesture =
  | {
      readonly kind: "resize";
      readonly id: string;
      readonly pointerId: number;
      readonly x: number;
      /** The column's width when pressed. */
      readonly width: number;
      /** 1 when dragging right widens; -1 for columns held at the right, resized from their left edge. */
      readonly direction: 1 | -1;
      started: boolean;
      /** The width the pointer asks for, applied on the next frame. */
      wanted: number;
    }
  | {
      readonly kind: "move";
      readonly id: string;
      readonly pointerId: number;
      readonly x: number;
      readonly y: number;
      started: boolean;
      /** Where the column would go if let go now. */
      drop: Drop | null;
    };

/** Where a moved column would go: before which column (null: last), and the boundary's x in the page. */
interface Drop {
  readonly before: string | null;
  readonly x: number;
}

export class ColumnControls<S extends Schema> {
  readonly #host: ColumnHost<S>;
  /** The line showing where a moved column would drop. */
  readonly #dropLine: HTMLDivElement;
  #gesture: Gesture | null = null;
  /** Set when a drag ends, so the click its press ends in does nothing: a drag never sorts. */
  #dragEnded = false;
  /** The open menu, its column, and the layout its items were written for. */
  #menu: {
    readonly id: string;
    readonly menu: ColumnMenu;
    seen: { columns: readonly GridColumn<S>[]; layout: readonly GridColumnLayout[]; width: number };
  } | null = null;
  readonly #stop: () => void;

  constructor(host: ColumnHost<S>) {
    this.#host = host;
    const line = host.root.ownerDocument.createElement("div");
    line.className = "hg-drop";
    line.hidden = true;
    host.root.append(line);
    this.#dropLine = line;
    const scroller = host.scroller;
    const listeners = [
      ["pointerdown", this.#onPointerDown],
      ["pointermove", this.#onPointerMove],
      ["lostpointercapture", this.#onLostCapture],
      ["mousedown", this.#onMouseDown],
      ["contextmenu", this.#onContextMenu],
    ] as const;
    for (const [type, listener] of listeners)
      scroller.addEventListener(type, listener as EventListener);
    this.#stop = () => {
      for (const [type, listener] of listeners)
        scroller.removeEventListener(type, listener as EventListener);
    };
  }

  /** The column whose header is being dragged to a new place, if any. */
  get moving(): string | null {
    const gesture = this.#gesture;
    return gesture?.kind === "move" && gesture.started ? gesture.id : null;
  }

  /** Applies the width a resize drag asks for: once a frame, however often the pointer moved. */
  flush(): void {
    const gesture = this.#gesture;
    if (gesture?.kind === "resize" && gesture.started && this.#has(gesture.id))
      this.#host.model.resizeColumn(gesture.id, gesture.wanted);
  }

  /**
   * Follows the model before a draw: a menu goes with its column, and
   * otherwise says what can be done now. Whether the page's focus, which the
   * menu held, should go back to the grid's focused cell.
   */
  sync(): boolean {
    const open = this.#menu;
    if (!open) return false;
    const { model, root } = this.#host;
    if (model.columnIndex(open.id) < 0) {
      const active = (root.getRootNode() as Document | ShadowRoot).activeElement;
      const held = open.menu.element.contains(active);
      open.menu.close(false);
      return held;
    }
    const { seen } = open;
    if (
      seen.columns !== model.columns ||
      seen.layout !== model.columnLayout ||
      seen.width !== model.viewportWidth
    )
      this.#refreshMenu();
    return false;
  }

  /**
   * Keys on the focused header of the column `id`: Shift and Left or Right
   * move it, Alt and Left or Right resize it, Alt and Down (or Shift and
   * F10) open its menu. Whether `event` was one of them, and handled.
   */
  keyDown(event: KeyboardEvent, id: string): boolean {
    const { key, altKey, shiftKey, ctrlKey, metaKey } = event;
    if (ctrlKey || metaKey) return false;
    if ((altKey && !shiftKey && key === "ArrowDown") || (shiftKey && !altKey && key === "F10")) {
      event.preventDefault();
      this.#openMenu(id);
      return true;
    }
    const step = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
    if (step === 0 || altKey === shiftKey) return false;
    event.preventDefault();
    if (shiftKey) this.#moveBy(id, step);
    else this.#resizeBy(id, step * RESIZE_STEP);
    this.#host.render(true);
    return true;
  }

  /** Whether a click is the controls': the end of a drag, or on a header's edge or menu button. */
  click(event: MouseEvent): boolean {
    if (this.#dragEnded) {
      this.#dragEnded = false;
      return true;
    }
    const clicked = event.target as Element;
    const button = clicked.closest(".hg-menu-button");
    if (button) {
      const target = this.#host.cellOf(button.closest("[role=columnheader]"));
      if (target) this.#openMenu(target.column);
      return true;
    }
    // A click on a header's edge is a resize that did not start.
    return clicked.closest(".hg-resize") !== null;
  }

  /** Puts back what a drag under way changed, closes the menu, and stops listening. */
  destroy(): void {
    if (this.#gesture) this.#endGesture(false);
    this.#menu?.menu.close(false);
    this.#stop();
    this.#dropLine.remove();
  }

  // Commands, from keys, the menu, and drags; each says what it did.

  /** Moves a column `step` places among the shown columns of its region. */
  #moveBy(id: string, step: -1 | 1) {
    const { model } = this.#host;
    if (model.columnIndex(id) < 0) return;
    const region = this.#region(id);
    const neighbor = region[region.indexOf(id) + step];
    if (neighbor !== undefined) model.moveColumn(id, step < 0 ? neighbor : this.#after(neighbor));
    model.focusCell(-1, id);
    this.#sayPlace(id);
  }

  #resizeBy(id: string, change: number) {
    const { model } = this.#host;
    const column = model.columnLayout[model.columnIndex(id)];
    if (!column) return;
    model.resizeColumn(id, column.width + change);
    model.focusCell(-1, id);
    this.#sayWidth(id);
  }

  #pin(id: string, side: PinSide | null) {
    const { model } = this.#host;
    if (model.columnIndex(id) < 0) return;
    // The menu offering it may be older than the grid's width.
    if (side && !model.canPin(id)) {
      this.#host.say(`The grid is too narrow to pin ${this.#titleOf(id)}`);
      return;
    }
    model.pinColumn(id, side);
    model.focusCell(-1, id);
    this.#host.say(`${this.#titleOf(id)} ${side ? `pinned to the ${side}` : "unpinned"}`);
  }

  /** Shows or hides a column; the last one shown stays. */
  #setVisible(id: string, visible: boolean) {
    const { model } = this.#host;
    if (!this.#has(id) || (!visible && model.columnLayout.length <= 1)) return;
    model.setColumnVisible(id, visible);
    this.#host.say(`${this.#titleOf(id)} ${visible ? "shown" : "hidden"}`);
  }

  /** The shown columns of the region `id` is pinned to (or of the unpinned ones), in order. */
  #region(id: string): string[] {
    const { model } = this.#host;
    const pins = new Map(model.columns.map((column) => [column.id!, column.pin ?? null]));
    const side = pins.get(id);
    return model.columnLayout.filter((column) => pins.get(column.id) === side).map(({ id }) => id);
  }

  /** The column after `id` in the columns' order, or null for the last. */
  #after(id: string): string | null {
    const columns = this.#host.model.columns;
    return columns[columns.findIndex((column) => column.id === id) + 1]?.id ?? null;
  }

  #has(id: string): boolean {
    return this.#host.model.columns.some((column) => column.id === id);
  }

  #titleOf(id: string): string {
    const column = this.#host.model.columns.find((other) => other.id === id);
    return column ? (column.title ?? column.field) : id;
  }

  #sayPlace(id: string) {
    const { model } = this.#host;
    const place = `column ${model.columnIndex(id) + 1} of ${model.columnLayout.length}`;
    this.#host.say(`${this.#titleOf(id)}, ${place}`);
  }

  #sayWidth(id: string) {
    const { model } = this.#host;
    const column = model.columnLayout[model.columnIndex(id)];
    if (column) this.#host.say(`${column.title}, ${Math.round(column.width)} pixels wide`);
  }

  // The menu

  /** Opens the menu of the column `id` under its header, focusing its first item. */
  #openMenu(id: string) {
    this.#menu?.menu.close(false);
    const { model, root } = this.#host;
    if (model.columnIndex(id) < 0) return;
    // The header comes into view and is drawn, for the menu to go under it.
    model.focusCell(-1, id);
    this.#host.render(false);
    const header = this.#host.headerCells().find((cell) => cell.id === id)?.element;
    if (!header) return;
    const menu = new ColumnMenu(
      root.ownerDocument,
      `${this.#titleOf(id)} column`,
      this.#menuGroups(id),
      (refocus) => {
        if (this.#menu?.menu === menu) this.#menu = null;
        if (refocus) this.#host.render(true);
      },
    );
    this.#menu = { id, menu, seen: this.#seen() };
    const element = menu.element;
    root.append(element);
    const area = root.getBoundingClientRect();
    const box = header.getBoundingClientRect();
    const top = box.bottom - area.top;
    const left = Math.min(area.width - element.offsetWidth, box.left - area.left);
    element.style.top = `${top}px`;
    element.style.maxHeight = `${Math.max(160, area.height - top - 4)}px`;
    element.style.left = `${Math.max(0, left)}px`;
    menu.focus(0);
  }

  /** The layout as the menu's items are written for it. */
  #seen() {
    const { model } = this.#host;
    return { columns: model.columns, layout: model.columnLayout, width: model.viewportWidth };
  }

  /** Writes the open menu's items for the layout as it is now. */
  #refreshMenu() {
    const open = this.#menu;
    if (!open) return;
    open.seen = this.#seen();
    open.menu.update(this.#menuGroups(open.id));
  }

  /** What the menu of the column `id` offers, as things are now. */
  #menuGroups(id: string): MenuGroup[] {
    const { model } = this.#host;
    const column = model.columns.find((other) => other.id === id)!;
    const width = model.columnLayout[model.columnIndex(id)]?.width ?? 0;
    const region = this.#region(id);
    const at = region.indexOf(id);
    const shown = model.columnLayout.length;
    // The menu closes before an action runs; after it, the focus goes to the header.
    const act = (command: () => void) => () => {
      command();
      this.#host.render(true);
    };
    const actions: MenuItem[] = [
      {
        key: "move-left",
        label: "Move left",
        keys: "Shift+ArrowLeft",
        disabled: at <= 0,
        run: act(() => this.#moveBy(id, -1)),
      },
      {
        key: "move-right",
        label: "Move right",
        keys: "Shift+ArrowRight",
        disabled: at === region.length - 1,
        run: act(() => this.#moveBy(id, 1)),
      },
      {
        key: "narrower",
        label: "Narrower",
        keys: "Alt+ArrowLeft",
        disabled: width <= MIN_COLUMN_WIDTH,
        run: act(() => this.#resizeBy(id, -RESIZE_STEP)),
      },
      {
        key: "wider",
        label: "Wider",
        keys: "Alt+ArrowRight",
        run: act(() => this.#resizeBy(id, RESIZE_STEP)),
      },
    ];
    for (const side of ["left", "right"] as const)
      if (column.pin !== side)
        actions.push({
          key: `pin-${side}`,
          label: `Pin to the ${side}`,
          // A pin the grid is too narrow to hold would not keep the column in view.
          disabled: !model.canPin(id),
          run: act(() => this.#pin(id, side)),
        });
    if (column.pin)
      actions.push({ key: "unpin", label: "Unpin", run: act(() => this.#pin(id, null)) });
    actions.push({
      key: "hide",
      label: "Hide column",
      disabled: shown <= 1,
      run: act(() => this.#setVisible(id, false)),
    });
    // Every column, checked when shown; the last one shown stays.
    const choices = model.columns.map(
      (other): MenuItem => ({
        // Column ids may be any text; a prefix keeps them apart from actions.
        key: `column:${other.id}`,
        label: other.title ?? other.field,
        checked: !other.hidden,
        disabled: !other.hidden && shown <= 1,
        run: () => {
          // Checked or not as the column is now, whatever the menu said.
          const now = model.columns.find((column) => column.id === other.id);
          if (now) this.#setVisible(now.id!, Boolean(now.hidden));
          const open = this.#menu;
          if (open?.id === id && model.columnIndex(id) >= 0) this.#refreshMenu();
          else open?.menu.close(true);
        },
      }),
    );
    return [{ items: actions }, { title: "Columns", items: choices }];
  }

  #onContextMenu = (event: MouseEvent) => {
    const target = this.#host.cellOf((event.target as Element).closest("[role=columnheader]"));
    if (!target) return;
    event.preventDefault();
    this.#openMenu(target.column);
  };

  // Dragging

  #onMouseDown = (event: MouseEvent) => {
    // A header's edge and button leave the page's focus where it is.
    if ((event.target as Element).closest(".hg-resize,.hg-menu-button")) event.preventDefault();
  };

  #onPointerDown = (event: PointerEvent) => {
    // A new press: the click it ends in counts.
    this.#dragEnded = false;
    if (event.button !== 0 || this.#gesture) return;
    const { model, scroller } = this.#host;
    const pressed = event.target as Element;
    const target = this.#host.cellOf(pressed.closest("[role=columnheader]"));
    if (!target || pressed.closest(".hg-menu-button")) return;
    const { column: id } = target;
    const { pointerId, clientX: x, clientY: y } = event;
    if (pressed.closest(".hg-resize")) {
      const { width, pinned } = model.columnLayout[model.columnIndex(id)]!;
      const direction = pinned === "right" ? -1 : 1;
      this.#gesture = {
        kind: "resize",
        id,
        pointerId,
        x,
        width,
        direction,
        started: false,
        wanted: width,
      };
      // Pressing an edge holds the pointer, so a drag past the grid keeps resizing.
      scroller.setPointerCapture(pointerId);
    } else if (event.pointerType !== "touch") {
      // Touches on headers scroll; touch users move columns with the menu.
      this.#gesture = { kind: "move", id, pointerId, x, y, started: false, drop: null };
    } else return;
    // The pointer may be let go anywhere, over the grid or not.
    const document = this.#host.root.ownerDocument;
    document.addEventListener("keydown", this.#onGestureKey, true);
    document.addEventListener("pointerup", this.#onPointerUp, true);
    document.addEventListener("pointercancel", this.#onPointerCancel, true);
  };

  #onPointerMove = (event: PointerEvent) => {
    const gesture = this.#gesture;
    if (gesture?.pointerId !== event.pointerId) return;
    // Let go where no release reached the page (another frame, a lost window).
    if (event.buttons === 0) {
      this.#endGesture(false);
      return;
    }
    const { root, scroller } = this.#host;
    const dx = event.clientX - gesture.x;
    if (!gesture.started) {
      const moved =
        gesture.kind === "resize" ? Math.abs(dx) : Math.hypot(dx, event.clientY - gesture.y);
      if (moved <= DRAG_THRESHOLD) return;
      gesture.started = true;
      if (gesture.kind === "move") scroller.setPointerCapture(event.pointerId);
      root.dataset.dragging = gesture.kind;
      // The header being moved is drawn as such.
      this.#host.invalidate();
    }
    if (gesture.kind === "resize") {
      gesture.wanted = Math.round(gesture.width + gesture.direction * dx);
      this.#host.invalidate();
    } else {
      gesture.drop = this.#dropAt(gesture.id, event.clientX);
      const line = this.#dropLine;
      line.hidden = !gesture.drop;
      if (gesture.drop)
        line.style.left = `${gesture.drop.x - root.getBoundingClientRect().left - 1}px`;
    }
  };

  #onPointerUp = (event: PointerEvent) => {
    if (this.#gesture?.pointerId === event.pointerId) this.#endGesture(true);
  };

  #onPointerCancel = (event: PointerEvent) => {
    if (this.#gesture?.pointerId === event.pointerId) this.#endGesture(false);
  };

  /** The scroller lost a drag's pointer otherwise than by its release: the drag is over. */
  #onLostCapture = (event: PointerEvent) => {
    const gesture = this.#gesture;
    if (gesture?.pointerId === event.pointerId && (gesture.started || gesture.kind === "resize"))
      this.#endGesture(false);
  };

  #onGestureKey = (event: KeyboardEvent) => {
    if (event.key !== "Escape" || !this.#gesture) return;
    // Escape puts the column back; the grid's own Escape (clearing the selection) waits.
    event.preventDefault();
    event.stopPropagation();
    this.#endGesture(false);
  };

  /** Ends a press on a header: a drag commits, or with `commit` false puts the column back. */
  #endGesture(commit: boolean) {
    const gesture = this.#gesture!;
    this.#gesture = null;
    const { model, root, scroller } = this.#host;
    const document = root.ownerDocument;
    document.removeEventListener("keydown", this.#onGestureKey, true);
    document.removeEventListener("pointerup", this.#onPointerUp, true);
    document.removeEventListener("pointercancel", this.#onPointerCancel, true);
    if (scroller.hasPointerCapture(gesture.pointerId))
      scroller.releasePointerCapture(gesture.pointerId);
    delete root.dataset.dragging;
    this.#dropLine.hidden = true;
    // A press let go where it was is a click; one put back with Escape is not.
    if (!gesture.started && commit) return;
    this.#dragEnded = true;
    this.#host.invalidate();
    // The columns may have been replaced while the pointer was down.
    if (!gesture.started || !this.#has(gesture.id)) return;
    if (gesture.kind === "resize" && commit) {
      model.resizeColumn(gesture.id, gesture.wanted);
      this.#sayWidth(gesture.id);
    } else if (gesture.kind === "resize") {
      // Back to the width it had, as given: resizing would hold it to the
      // room pins have now, which a narrower grid may have taken away.
      const width = gesture.width;
      model.setColumns(
        model.columns.map((column) => (column.id === gesture.id ? { ...column, width } : column)),
      );
    } else if (commit && gesture.drop) {
      const { before } = gesture.drop;
      if (before !== null && !this.#has(before)) return;
      model.moveColumn(gesture.id, before);
      this.#sayPlace(gesture.id);
    }
  }

  /**
   * Where the column `id` would drop with the pointer at `x` in the page:
   * before the first mounted header of its region whose middle is past `x`
   * (kept within the region's part of the viewport), or after the last.
   */
  #dropAt(id: string, x: number): Drop | null {
    const { model, scroller } = this.#host;
    const region = this.#region(id);
    const mounted = this.#host.headerCells().filter((cell) => region.includes(cell.id));
    if (mounted.length === 0) return null;
    const layout = model.columnLayout;
    let [leftWidth, rightWidth] = [0, 0];
    for (const { pinned, width } of layout) {
      if (pinned === "left") leftWidth += width;
      else if (pinned === "right") rightWidth += width;
    }
    const view = scroller.getBoundingClientRect();
    let [lo, hi] = [view.left, view.left + model.viewportWidth];
    const pinned = layout[model.columnIndex(region[0]!)]!.pinned;
    if (pinned === "left") hi = lo + leftWidth;
    else if (pinned === "right") lo = hi - rightWidth;
    else [lo, hi] = [lo + leftWidth, hi - rightWidth];
    const within = Math.max(lo, Math.min(hi, x));
    for (const cell of mounted) {
      const box = cell.element.getBoundingClientRect();
      if (within < box.left + box.width / 2) return { before: cell.id, x: box.left };
    }
    const last = mounted.at(-1)!;
    const next = region[region.indexOf(last.id) + 1];
    return {
      before: next ?? this.#after(last.id),
      x: last.element.getBoundingClientRect().right,
    };
  }
}
