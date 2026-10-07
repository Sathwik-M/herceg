import type { LegendItem } from "../scene/scene.ts";
import type { Theme } from "../theme.ts";

interface Entry {
  button: HTMLButtonElement;
  swatch: HTMLSpanElement;
  label: HTMLSpanElement;
}

/**
 * HTML legend with one toggle button per series. Buttons are kept per series
 * key and updated in place, so keyboard focus survives re-renders.
 */
export class Legend {
  readonly element: HTMLDivElement;
  readonly #entries = new Map<string, Entry>();
  readonly #toggle: (key: string) => void;

  constructor(document: Document, toggle: (key: string) => void) {
    this.element = document.createElement("div");
    this.element.style.cssText = "position:absolute;left:0;top:0;width:100%;height:0";
    this.#toggle = toggle;
  }

  update(items: readonly LegendItem[], theme: Theme): void {
    const document = this.element.ownerDocument;
    const seen = new Set<string>();
    let previous: Element | null = null;
    for (const item of items) {
      seen.add(item.key);
      let entry = this.#entries.get(item.key);
      if (!entry) {
        const button = document.createElement("button");
        button.type = "button";
        const swatch = document.createElement("span");
        swatch.style.cssText = "width:10px;height:10px;border-radius:2px;flex:none";
        const label = document.createElement("span");
        button.append(swatch, label);
        button.addEventListener("click", () => this.#toggle(item.key));
        entry = { button, swatch, label };
        this.#entries.set(item.key, entry);
      }
      const { button, swatch, label } = entry;
      button.setAttribute("aria-pressed", String(!item.hidden));
      button.title = item.hidden ? `Show ${item.label}` : `Hide ${item.label}`;
      button.style.cssText = `position:absolute;left:${item.x}px;top:${item.y}px;transform:translateY(-50%);display:flex;align-items:center;gap:6px;padding:0;border:0;background:none;cursor:pointer;color:${theme.text};font:${theme.fontSize}px ${theme.font};opacity:${item.hidden ? 0.45 : 1}`;
      swatch.style.background = item.color;
      label.textContent = item.label;
      label.style.textDecoration = item.hidden ? "line-through" : "";
      // Keep document (tab) order equal to legend order.
      const expected: Element | null = previous
        ? previous.nextElementSibling
        : this.element.firstElementChild;
      if (button !== expected) this.element.insertBefore(button, expected);
      previous = button;
    }
    for (const [key, entry] of this.#entries) {
      if (seen.has(key)) continue;
      entry.button.remove();
      this.#entries.delete(key);
    }
  }
}
