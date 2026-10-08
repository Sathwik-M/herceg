// Themes in output without a page (SVG strings, PNG, PDF): CSS variables
// take their fallbacks, and "auto" is light. Kept out of theme.ts so charts
// in a page, which read variables from it, do not carry this parser.

import type { ThemeEnvironment } from "../theme.ts";

/**
 * `value` with each CSS variable replaced by its fallback, for output that
 * has no page to read variables from. Quoted text is left as it is.
 */
function withFallbacks(value: string, key: string): string {
  let out = "";
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    if (c === '"' || c === "'") {
      const end = skipString(value, i);
      out += value.slice(i, end);
      i = end;
    } else if (value.startsWith("var(", i) && !/[\w-]/.test(value[i - 1] ?? "")) {
      const { end, comma } = closing(value, i + 3, key);
      if (comma < 0) {
        throw new TypeError(
          `theme.${key} is the CSS variable ${value.slice(i, end + 1)}, which only a chart in a page can read; give a fallback, as var(--name, #2a78d6)`,
        );
      }
      out += withFallbacks(value.slice(comma + 1, end).trim(), key);
      i = end + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** The index after the quoted string starting at `start`. */
function skipString(value: string, start: number): number {
  let i = start + 1;
  while (i < value.length && value[i] !== value[start]) i += value[i] === "\\" ? 2 : 1;
  return Math.min(value.length, i + 1);
}

/** The parenthesis closing the one at `open`, and the first comma directly inside. */
function closing(value: string, open: number, key: string): { end: number; comma: number } {
  let depth = 0;
  let comma = -1;
  for (let i = open; i < value.length; i++) {
    const c = value[i];
    if (c === '"' || c === "'") i = skipString(value, i) - 1;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return { end: i, comma };
    else if (c === "," && depth === 1 && comma < 0) comma = i;
  }
  throw new TypeError(`theme.${key} has unbalanced parentheses: ${value}`);
}

const VARIABLE = /\bvar\(/;

/** The environment of output without a page. */
export const NO_PAGE: ThemeEnvironment = {
  color: (value, key) => (VARIABLE.test(value) ? withFallbacks(value, key) : value),
  font: (value) => withFallbacks(value, "font"),
};
