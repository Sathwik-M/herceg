// A grid column's menu: a WAI menu of what can be done to the column, and a
// list of every column with a check to show or hide it. The grid (grid.ts)
// opens it under a header, from the keyboard, a right click, or the
// header's button, and says what each item does.

export interface MenuItem {
  /** Names the item while the menu is open, so the focus keeps to it as items change. */
  readonly key: string;
  readonly label: string;
  /** Keys doing the same on the column's header, as `aria-keyshortcuts` names them. */
  readonly keys?: string;
  readonly disabled?: boolean;
  /** Whether a check item is checked; actions have none. Check items keep the menu open. */
  readonly checked?: boolean;
  readonly run: () => void;
}

/** Items in a group (named, when it has a title), set apart from the one before. */
export interface MenuGroup {
  readonly title?: string;
  readonly items: readonly MenuItem[];
}

/** A point of the viewport, as pointer events give it. */
interface Point {
  readonly x: number;
  readonly y: number;
}

/** Keys as `aria-keyshortcuts` names them, as people read them. */
const KEY_NAMES: Record<string, string> = { ArrowLeft: "←", ArrowRight: "→", ArrowDown: "↓" };

/**
 * An open menu. Arrow keys, Home, and End move between its items, Enter and
 * Space choose one, and Escape and Tab close it; so does the focus leaving.
 */
export class ColumnMenu {
  readonly element: HTMLDivElement;
  #items: { element: HTMLElement; item: MenuItem }[] = [];
  #open = true;
  /** Set while items are written anew, which takes the focus out of the menu for a moment. */
  #writing = false;
  /** Whether the keys have the focus: since the menu opened, or a key moved it. */
  #keys = true;
  /** Where the pointer was last seen: over the menu, or where it opened the menu. */
  #pointer: Point | null;
  /** Where the pointer stood when the keys took the focus, or was first seen since. */
  #stood: Point | null;
  readonly #closed: (refocus: boolean) => void;

  /**
   * `closed` hears the menu closed, with whether the focus should go back to
   * the header; `pointer` is where the pointer opened it (a click's point).
   */
  constructor(
    document: Document,
    label: string,
    groups: readonly MenuGroup[],
    closed: (refocus: boolean) => void,
    pointer?: Point,
  ) {
    this.#closed = closed;
    this.#pointer = this.#stood = pointer ?? null;
    const element = document.createElement("div");
    element.className = "hg-menu";
    element.setAttribute("role", "menu");
    element.setAttribute("aria-label", label);
    this.element = element;
    this.update(groups);
    element.addEventListener("keydown", this.#onKeyDown);
    element.addEventListener("click", this.#onClick);
    element.addEventListener("pointermove", this.#onPointerMove);
    element.addEventListener("focusout", this.#onFocusOut);
  }

  get open(): boolean {
    return this.#open;
  }

  /**
   * Writes the items anew, keeping the focus on the item with the same key,
   * or at the same place when that item is gone.
   */
  update(groups: readonly MenuGroup[]): void {
    const document = this.element.ownerDocument;
    const active = this.#active();
    const focused = this.#items.findIndex(({ element }) => element === active);
    const key = this.#items[focused]?.item.key;
    const children: HTMLElement[] = [];
    this.#items = [];
    groups.forEach((group, g) => {
      if (g > 0) {
        const separator = document.createElement("div");
        separator.setAttribute("role", "separator");
        children.push(separator);
      }
      let parent: HTMLElement | null = null;
      if (group.title !== undefined) {
        parent = document.createElement("div");
        parent.setAttribute("role", "group");
        parent.setAttribute("aria-label", group.title);
        const title = document.createElement("div");
        title.className = "hg-menu-title";
        title.setAttribute("aria-hidden", "true");
        title.textContent = group.title;
        parent.append(title);
        children.push(parent);
      }
      for (const item of group.items) {
        const element = this.#itemElement(document, item);
        this.#items.push({ element, item });
        if (parent) parent.append(element);
        else children.push(element);
      }
    });
    this.#writing = true;
    try {
      this.element.replaceChildren(...children);
      const same = this.#items.findIndex(({ item }) => item.key === key);
      if (focused >= 0) this.focus(same >= 0 ? same : Math.min(focused, this.#items.length - 1));
    } finally {
      this.#writing = false;
    }
  }

  /** Focuses the item at `index`. */
  focus(index: number): void {
    this.#items[index]?.element.focus();
  }

  /** Removes the menu; with `refocus`, the focus goes back to the header. */
  close(refocus: boolean): void {
    if (!this.#open) return;
    this.#open = false;
    this.element.remove();
    this.#closed(refocus);
  }

  #itemElement(document: Document, item: MenuItem): HTMLElement {
    const element = document.createElement("div");
    const check = item.checked !== undefined;
    element.setAttribute("role", check ? "menuitemcheckbox" : "menuitem");
    element.tabIndex = -1;
    if (check) element.setAttribute("aria-checked", String(item.checked));
    if (item.disabled) element.setAttribute("aria-disabled", "true");
    element.append(item.label);
    if (item.keys) {
      element.setAttribute("aria-keyshortcuts", item.keys);
      const keys = document.createElement("span");
      keys.className = "hg-keys";
      keys.setAttribute("aria-hidden", "true");
      keys.textContent = item.keys
        .split("+")
        .map((key) => KEY_NAMES[key] ?? key)
        .join("+");
      element.append(keys);
    }
    return element;
  }

  #choose(index: number) {
    const entry = this.#items[index];
    if (!entry || entry.item.disabled) return;
    // Actions close the menu first: what they do may move the focus.
    if (entry.item.checked === undefined) this.close(true);
    entry.item.run();
  }

  /** The element with the page's focus, in the menu's document or shadow root. */
  #active(): Element | null {
    return (this.element.getRootNode() as Document | ShadowRoot).activeElement;
  }

  #indexOf(target: EventTarget | null): number {
    return this.#items.findIndex(({ element }) => element === target);
  }

  #onKeyDown = (event: KeyboardEvent) => {
    const count = this.#items.length;
    const at = this.#indexOf(event.target);
    const { key } = event;
    if (key === "ArrowDown") this.focus((at + 1) % count);
    else if (key === "ArrowUp") this.focus((at - 1 + count) % count);
    else if (key === "Home") this.focus(0);
    else if (key === "End") this.focus(count - 1);
    else if (key === "Enter" || key === " ") this.#choose(at);
    else if (key === "Escape") this.close(true);
    else if (key === "Tab") {
      // The focus goes back to the header, from where Tab leaves the grid.
      this.close(true);
      return;
    } else return;
    this.#keys = true;
    this.#stood = this.#pointer;
    event.preventDefault();
    event.stopPropagation();
  };

  #onClick = (event: MouseEvent) => {
    const item = (event.target as Element).closest("[role^=menuitem]");
    this.#choose(this.#indexOf(item));
  };

  #onPointerMove = (event: PointerEvent) => {
    const at = { x: event.clientX, y: event.clientY };
    this.#pointer = at;
    if (this.#keys) {
      // The focus follows the pointer once it moves from where it stood:
      // browsers send moves where it stays (WebKit on Linux does as the
      // items are written anew under a still pointer).
      this.#stood ??= at;
      if (this.#stood.x === at.x && this.#stood.y === at.y) return;
      this.#keys = false;
    }
    const item = (event.target as Element).closest<HTMLElement>("[role^=menuitem]");
    if (item && item !== this.#active()) item.focus();
  };

  #onFocusOut = (event: FocusEvent) => {
    if (this.#writing) return;
    const next = event.relatedTarget as Node | null;
    if (!next || !this.element.contains(next)) this.close(false);
  };
}
