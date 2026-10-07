// Small helpers for writing SVG markup.

import type { SvgElement } from "../scene/scene.ts";

/** Rounds to 0.1 px: invisible at any pixel ratio and keeps paths short. */
export function n(value: number): string {
  return String(Math.round(value * 10) / 10);
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A `stroke-dasharray` attribute, or nothing for solid strokes. */
export function dashAttribute(value: readonly number[] | undefined): string {
  return value && value.length > 0 ? ` stroke-dasharray="${value.join(" ")}"` : "";
}

/** Markup of elements, for drawings that describe their output as elements. */
export function markupOf(elements: readonly SvgElement[]): string {
  let out = "";
  for (const { tag, attributes } of elements) {
    out += `<${tag}`;
    for (const name in attributes) out += ` ${name}="${escapeXml(attributes[name]!)}"`;
    out += "/>";
  }
  return out;
}
