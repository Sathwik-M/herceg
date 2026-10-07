import type { Inspection } from "../model/model.ts";
import type { Theme } from "../theme.ts";

function isDark(theme: Theme): boolean {
  // Light text implies a dark theme.
  const hex = theme.text.replace("#", "");
  if (hex.length !== 6) return false;
  const value = Number.parseInt(hex, 16);
  return ((value >> 16) & 255) + ((value >> 8) & 255) + (value & 255) > 382;
}

export class Tooltip {
  readonly element: HTMLDivElement;

  constructor(document: Document) {
    this.element = document.createElement("div");
    this.element.style.cssText =
      "position:absolute;left:0;top:0;pointer-events:none;display:none;white-space:nowrap;padding:6px 8px;border-radius:6px;line-height:1.35;z-index:1;font-variant-numeric:tabular-nums";
  }

  show(
    inspection: Inspection,
    theme: Theme,
    pointer: { x: number; y: number },
    bounds: { width: number; height: number },
  ) {
    const { element } = this;
    const dark = isDark(theme);
    element.style.background = dark ? "#262624" : "#ffffff";
    element.style.color = theme.text;
    element.style.border = `1px solid ${dark ? "rgba(255,255,255,0.12)" : "rgba(11,11,11,0.12)"}`;
    element.style.boxShadow = "0 2px 8px rgba(0,0,0,0.15)";
    element.style.font = `${theme.fontSize}px ${theme.font}`;
    element.replaceChildren();
    const document = element.ownerDocument;
    const header = document.createElement("div");
    header.textContent = inspection.label;
    header.style.cssText = `color:${theme.muted};margin-bottom:2px`;
    element.append(header);
    for (const point of inspection.points) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:6px";
      const swatch = document.createElement("span");
      swatch.style.cssText = `width:8px;height:8px;border-radius:2px;background:${point.color};flex:none`;
      const label = document.createElement("span");
      label.textContent = point.label;
      label.style.flex = "1";
      const value = document.createElement("span");
      value.textContent = point.text;
      value.style.cssText = "font-weight:600;margin-left:12px";
      row.append(swatch, label, value);
      element.append(row);
    }
    element.style.display = "block";
    // Right of the pointer, flipped when it would overflow the chart.
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    let x = pointer.x + 14;
    if (x + width > bounds.width) x = Math.max(0, pointer.x - 14 - width);
    const y = Math.min(Math.max(0, pointer.y - height / 2), Math.max(0, bounds.height - height));
    element.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  }

  hide() {
    this.element.style.display = "none";
  }
}

/** Plain-text version of an inspection for screen reader announcements. */
export function describeInspection(inspection: Inspection): string {
  return [
    inspection.label,
    ...inspection.points.map((point) => `${point.label}: ${point.text}`),
  ].join(". ");
}
