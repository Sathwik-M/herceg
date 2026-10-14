// A chart's toolbar of buttons for what its controls do with a drag or a
// key (turn a 3D chart, pan and zoom a map, reset moved nodes), for people
// who use neither: shown while the pointer is over the chart or focus is in
// it, and focusable while hidden, which shows it.

import type { Theme } from "../theme.ts";

/** A circling arrow: back to the view the chart starts with. */
export const RESET_GLYPH = "M4.5 9A3.5 3.5 0 1 0 6 5.2M4 3v3h3";

export interface ToolButton {
  label: string;
  /** SVG path data, drawn in a 16 x 16 box with round caps. */
  glyph: string;
  act(): void;
  /** For toggles: whether the button is pressed now (`aria-pressed`). */
  pressed?(): boolean;
  /** Whether the button is left out now, for buttons of options that may be off. */
  hidden?(): boolean;
}

export class Toolbar {
  readonly element: HTMLDivElement;
  readonly #buttons: { button: HTMLButtonElement; tool: ToolButton }[];
  readonly #stop: (() => void)[] = [];
  #theme = "";
  #visible = false;
  #shown = true;
  /** Pixels from the right and bottom edges of the chart. */
  #corner = "right:6px;bottom:6px";

  /** A toolbar named `label` in the bottom right corner of `root` (see `place`). */
  constructor(root: HTMLElement, label: string, tools: readonly ToolButton[]) {
    const document = root.ownerDocument;
    this.element = document.createElement("div");
    this.element.setAttribute("role", "toolbar");
    this.element.setAttribute("aria-label", label);
    this.#buttons = tools.map((tool) => {
      const button = document.createElement("button");
      button.type = "button";
      button.title = tool.label;
      button.setAttribute("aria-label", tool.label);
      button.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" style="display:block"><path d="${tool.glyph}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
      button.addEventListener("click", () => {
        tool.act();
        this.refresh();
      });
      return { button, tool };
    });
    this.element.append(...this.#buttons.map(({ button }) => button));
    this.refresh();
    this.#place();
    root.append(this.element);
    const on = <K extends keyof HTMLElementEventMap>(type: K, handler: () => void) => {
      root.addEventListener(type, handler);
      this.#stop.push(() => root.removeEventListener(type, handler));
    };
    on("pointerenter", () => this.#show(true));
    on("focusin", () => this.#show(true));
    const hide = () => {
      if (!root.matches(":hover") && !root.contains(document.activeElement)) this.#show(false);
    };
    on("pointerleave", () => setTimeout(hide));
    on("focusout", () => setTimeout(hide));
  }

  /** Whether an element is in the toolbar, whose presses are its buttons'. */
  contains(target: EventTarget | null): boolean {
    return this.element.contains(target as Node);
  }

  /** Shows the toolbar at all, or leaves it out (none of its buttons apply). */
  set shown(shown: boolean) {
    this.#shown = shown;
    this.#place();
  }

  /** Places the toolbar in the bottom right corner of `room` (a panel's plot) in a chart of `width` by `height`. */
  place(
    room: { x: number; y: number; width: number; height: number },
    width: number,
    height: number,
  ) {
    const corner = `right:${width - room.x - room.width + 6}px;bottom:${height - room.y - room.height + 6}px`;
    if (corner === this.#corner) return;
    this.#corner = corner;
    this.#place();
  }

  /** Reads toggles' states, and which buttons are left out, again. */
  refresh(): void {
    for (const { button, tool } of this.#buttons) {
      if (tool.pressed) button.setAttribute("aria-pressed", String(tool.pressed()));
      button.style.display = tool.hidden?.() ? "none" : "block";
    }
  }

  /** Styles the buttons for a theme, when it changed. */
  style(theme: Theme): void {
    const key = `${theme.text}|${theme.tooltipBackground}|${theme.tooltipBorder}`;
    if (key === this.#theme) return;
    this.#theme = key;
    for (const { button } of this.#buttons)
      button.style.cssText = `width:24px;height:24px;padding:3px;border:1px solid ${theme.tooltipBorder};border-radius:4px;background:${theme.tooltipBackground};color:${theme.text};cursor:pointer`;
    this.refresh();
  }

  dispose(): void {
    for (const stop of this.#stop.splice(0)) stop();
    this.element.remove();
  }

  #show(visible: boolean): void {
    this.#visible = visible;
    this.#place();
  }

  /** Hidden buttons stay focusable, and show when focused; a toolbar left out is neither. */
  #place(): void {
    this.element.style.cssText = `position:absolute;${this.#corner};display:${this.#shown ? "flex" : "none"};gap:2px;transition:opacity 120ms;opacity:${this.#visible ? 1 : 0}`;
  }
}
