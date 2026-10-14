// Titles of charts and panels: text alone, or text with where it goes and
// how it looks.

import type { PanelTitleSpec, TitleSpec } from "../spec/spec.ts";

/** A title's text; undefined without one. */
export function titleText(
  title: string | TitleSpec | PanelTitleSpec | undefined,
): string | undefined {
  return typeof title === "object" ? title.text : title;
}
