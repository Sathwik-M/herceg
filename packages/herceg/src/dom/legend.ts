import { HIDDEN } from "../model/legend.ts";
import { shapeMarkup } from "../render/svg.ts";
import type { LegendGuide, LegendItem } from "../scene/scene.ts";
import type { TextPaint } from "../style/style.ts";

interface Entry {
  button: HTMLButtonElement;
  swatch: HTMLSpanElement;
  /** The label, and its text: in it when the label has a box, else the label itself. */
  label: HTMLSpanElement;
  text: HTMLSpanElement;
  /** What the entry last showed, to skip rewriting unchanged entries. */
  shown: string;
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
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", "Legend");
    this.element.style.cssText = "position:absolute;left:0;top:0;width:100%;height:0";
    this.#toggle = toggle;
  }

  /** Shows the legend's entries, in its label style; none without a legend. */
  update(legend: LegendGuide | undefined): void {
    const items = legend?.entries ?? [];
    const labelStyle: [string, string] = legend ? labelStyles(legend) : ["", ""];
    // An empty group would still be announced.
    this.element.hidden = items.length === 0;
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
        entry = { button, swatch, label, text: label, shown: "" };
        this.#entries.set(item.key, entry);
      }
      // Rewriting styles every frame would make the browser recompute them.
      const label = legend!.label;
      const shown = `${item.x}|${item.y}|${item.hidden}|${item.color}|${item.glyph}|${item.stroke}|${item.label}|${label.css}|${label.color}|${label.opacity}|${labelStyle}`;
      if (shown !== entry.shown) {
        entry.shown = shown;
        show(entry, item, label, labelStyle);
      }
      const { button } = entry;
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

/**
 * CSS of the labels as the legend guide's text items draw them: their box,
 * whose edge is where the text would be without one, a line height and its
 * padding tall, its outline centered on its edge; and their text's halo.
 * Opacity is the text's alone (see `show`), which leaves the box as it is.
 */
function labelStyles(legend: LegendGuide): [box: string, text: string] {
  const { background, padding, lineHeight } = legend.label;
  const { halo } = legend;
  let box = "";
  if (background) {
    box = `background:${background.fill};line-height:${lineHeight}px;padding:${padding.map((p) => `${p}px`).join(" ")};border-radius:${background.radius ?? 0}px`;
    if (background.stroke) {
      const width = background.strokeWidth ?? 1;
      box += `;outline:${width}px solid ${background.stroke};outline-offset:${-width / 2}px`;
    }
  }
  let text = "";
  if (halo) {
    // The outline's inner half lies under the fill, as SVG halos' does.
    const color =
      halo.opacity < 1
        ? `color-mix(in srgb,${halo.color} ${halo.opacity * 100}%,transparent)`
        : halo.color;
    text = `-webkit-text-stroke:${halo.width}px ${color};paint-order:stroke fill`;
  }
  return [box, text];
}

function show(
  entry: Entry,
  item: LegendItem,
  paint: TextPaint,
  [box, ink]: [string, string],
): void {
  const { button, swatch, label } = entry;
  // Text in a box takes an element of its own, so its opacity leaves the box alone.
  if (!box !== (entry.text === label)) {
    label.textContent = "";
    entry.text = box ? label.appendChild(label.ownerDocument.createElement("span")) : label;
  }
  const { text } = entry;
  button.setAttribute("aria-pressed", String(!item.hidden));
  button.title = item.hidden ? `Show ${item.label}` : `Hide ${item.label}`;
  button.style.cssText = `position:absolute;left:${item.x}px;top:${item.y}px;transform:translateY(-50%);display:flex;align-items:center;gap:6px;padding:0;border:0;background:none;cursor:pointer;color:${paint.color};font:${paint.css}`;
  // A hidden series' swatch and text fade, as static output draws them; the box does not.
  const fade = item.hidden ? HIDDEN : 1;
  swatch.style.opacity = String(fade);
  // Point series show their symbol, as the SVG legend draws it; others a rounded square.
  swatch.style.background = item.glyph ? "none" : item.color;
  swatch.innerHTML = item.glyph
    ? `<svg width="10" height="10" style="display:block;overflow:visible">${shapeMarkup({ type: "shape", d: item.glyph, at: [5, 5], fill: item.color, stroke: item.stroke })}</svg>`
    : "";
  label.style.cssText = box;
  text.textContent = item.label;
  if (text !== label) text.style.cssText = ink;
  else if (ink) label.style.cssText = ink;
  text.style.opacity = String(paint.opacity * fade);
  text.style.textDecoration = item.hidden ? "line-through" : "";
}
