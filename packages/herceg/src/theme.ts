// Themes: tokens (the colors styles are made of) and role styles (how each
// kind of text and line looks), resolved once per configuration into plain
// values the model and renderers read.

import { checkRamp, isLightColor } from "./scale/color.ts";
import type { ThemeName, ThemeSpec } from "./spec/spec.ts";
import type { PlotStyle, StyleRoles, ThemeTokens } from "./spec/style.ts";
import {
  cascade,
  type StrokePaint,
  strokePaint,
  type TextPaint,
  textPaint,
} from "./style/style.ts";

/** Every role's style, resolved. */
export interface ThemeStyles {
  text: TextPaint;
  title: TextPaint;
  panelTitle: TextPaint;
  axisTitle: TextPaint;
  tickLabel: TextPaint;
  legendLabel: TextPaint;
  legendTitle: TextPaint;
  /** The plot's background and border, as the theme sets them (either may be unset). */
  plot: PlotStyle;
  grid: StrokePaint;
  axisLine: StrokePaint;
  tick: StrokePaint;
  line: { strokeWidth: number };
  bar: { radius: number };
  tooltip: { fill: string; stroke: string };
}

/** Role styles as a theme resolves them: every role, with what its defaults give. */
export type ThemeRoles = Readonly<Required<StyleRoles>> & {
  readonly line: { strokeWidth: number };
  readonly bar: { radius: number };
  readonly tooltip: { fill: string; stroke: string };
};

/** The text roles, which start from the theme's base text. */
export type TextRole =
  | "title"
  | "panelTitle"
  | "axisTitle"
  | "tickLabel"
  | "legendLabel"
  | "legendTitle";

export interface Theme extends Required<ThemeTokens> {
  /** The base text's font family and size, as most text is set. */
  font: string;
  fontSize: number;
  /**
   * The theme's role styles, its own defaults with the chart's theme
   * changes, its colors resolved: what guides and panels with styles of
   * their own cascade from.
   */
  roles: ThemeRoles;
  /** Every role's style resolved from `roles`. */
  style: ThemeStyles;
}

/** A built-in theme: its tokens and the settings its role styles are made from. */
interface Base {
  tokens: Required<ThemeTokens>;
  font: string;
  fontSize: number;
  titleSize: number;
  lineWidth: number;
  barRadius: number;
  tooltip: { fill: string; stroke: string };
}

// The platform's interface font: SF Pro on Apple systems, Segoe UI on
// Windows, Roboto on Android; nothing to load.
const FONT =
  'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';

// Cool slate neutrals keep the chrome (text, grid, axes) quiet so the data
// carries the color. Categorical colors come in a fixed order of hues
// (cobalt, persimmon, viridian, violet, red, sky, saffron, orchid), with
// steps of their own for light and dark surfaces; adjacent series stay
// distinguishable under simulated color-vision deficiencies (OKLab ΔE ≥ 10)
// and every color reaches 3:1 against its surface. Charts with more than
// eight series reuse colors from the start. Continuous color uses one hue,
// from a low end visible against the surface to strong.
const SEQUENTIAL = [
  "#9ab6ef",
  "#7b9fe8",
  "#5b87df",
  "#3f6fd2",
  "#2e59b6",
  "#22468f",
  "#183568",
  "#0f2448",
];
const SEQUENTIAL_DARK = [
  "#2b4f94",
  "#3561ad",
  "#4474c8",
  "#5a8ae0",
  "#7ca3ea",
  "#a1bdf2",
  "#c6d8f8",
  "#e8effd",
];
// Blue below the midpoint, red above, through a neutral gray (ColorBrewer RdBu).
const DIVERGING = [
  "#2166ac",
  "#4393c3",
  "#92c5de",
  "#d1e5f0",
  "#f7f7f7",
  "#fddbc7",
  "#f4a582",
  "#d6604d",
  "#b2182b",
];
// Named themes paint a surface of their own, so they read the same on any
// page and in exports; "auto" is transparent, taking the page's.
const LIGHT_BASE: Base = {
  tokens: {
    background: "#ffffff",
    text: "#1c2333",
    muted: "#5d6677",
    grid: "#e8ebf0",
    axis: "#cfd5de",
    palette: [
      "#3266d6",
      "#ec6a2c",
      "#109e7f",
      "#7651d8",
      "#e0464f",
      "#1f8fc8",
      "#c18300",
      "#c4489b",
    ],
    sequential: SEQUENTIAL,
    diverging: DIVERGING,
    rise: "#109e7f",
    fall: "#e0464f",
  },
  font: FONT,
  fontSize: 12,
  titleSize: 15,
  lineWidth: 2,
  barRadius: 4,
  tooltip: { fill: "#ffffff", stroke: "#dfe3ea" },
};

const DARK_BASE: Base = {
  ...LIGHT_BASE,
  tokens: {
    ...LIGHT_BASE.tokens,
    background: "#12151c",
    text: "#e8ebf1",
    muted: "#9aa3b4",
    grid: "#252a34",
    axis: "#3a4150",
    palette: [
      "#5b8def",
      "#dc6f3a",
      "#20a181",
      "#9478ec",
      "#e0555d",
      "#3497cd",
      "#bf8a12",
      "#cb5da3",
    ],
    sequential: SEQUENTIAL_DARK,
    rise: "#20a181",
    fall: "#e0555d",
  },
  tooltip: { fill: "#1b1f28", stroke: "#303643" },
};

// High contrast: text and axes in black or white, grid lines at 4.5:1, wider
// lines, larger text, and categorical colors each at least 4.5:1 against the
// page (checked with OKLab color-vision simulation for adjacent series).
const HIGH_CONTRAST_BASE: Base = {
  ...LIGHT_BASE,
  tokens: {
    ...LIGHT_BASE.tokens,
    background: "#ffffff",
    text: "#000000",
    muted: "#1f1f1f",
    grid: "#767676",
    axis: "#000000",
    palette: [
      "#0057b8",
      "#b84a00",
      "#b3176f",
      "#7a5c00",
      "#007c99",
      "#c41e2a",
      "#6a3fc0",
      "#007a4d",
    ],
    sequential: ["#7d9ee6", "#4a76d6", "#2d58b6", "#20438d", "#152f66", "#0b1c40"],
    rise: "#007a4d",
    fall: "#c41e2a",
  },
  fontSize: 13,
  titleSize: 16,
  lineWidth: 2.5,
  tooltip: { fill: "#ffffff", stroke: "#000000" },
};

const HIGH_CONTRAST_DARK_BASE: Base = {
  ...HIGH_CONTRAST_BASE,
  tokens: {
    ...HIGH_CONTRAST_BASE.tokens,
    background: "#000000",
    text: "#ffffff",
    muted: "#e6e6e6",
    grid: "#8c8c8c",
    axis: "#ffffff",
    palette: [
      "#6cb6ff",
      "#4fd18b",
      "#b49cff",
      "#ff9a4d",
      "#42d6e8",
      "#ff6b6b",
      "#e8c547",
      "#ff7ac6",
    ],
    sequential: ["#3561ad", "#4f82d9", "#7ca3ea", "#a1bdf2", "#c6d8f8", "#f2f6fe"],
    rise: "#4fd18b",
    fall: "#ff6b6b",
  },
  tooltip: { fill: "#000000", stroke: "#ffffff" },
};

const BASES: Record<Exclude<ThemeName, "auto">, Base> = {
  light: LIGHT_BASE,
  dark: DARK_BASE,
  "high-contrast": HIGH_CONTRAST_BASE,
  "high-contrast-dark": HIGH_CONTRAST_DARK_BASE,
};

/** A built-in theme's role styles, made from its settings and the chart's tokens. */
function baseRoles(base: Base, { text, muted, grid, axis }: Required<ThemeTokens>): StyleRoles {
  const line = (stroke: string) => ({ stroke, strokeWidth: 1, dash: [], opacity: 1 });
  // Text roles take the base text's color unless they say.
  return {
    text: {
      font: base.font,
      fontSize: base.fontSize,
      fontWeight: 400,
      fontStyle: "normal",
      color: text,
      opacity: 1,
      lineHeight: 1.25,
    },
    title: { fontSize: base.titleSize, fontWeight: 600 },
    panelTitle: { fontWeight: 600 },
    tickLabel: { color: muted },
    grid: line(grid),
    axisLine: line(axis),
    tick: line(axis),
    line: { strokeWidth: base.lineWidth },
    bar: { radius: base.barRadius },
    tooltip: { ...base.tooltip },
  };
}

/**
 * Where a theme is shown: whether the page prefers dark colors (for
 * "auto"), and how to read CSS colors and fonts such as `var(--accent)`.
 * The DOM runtime supplies one; without it, "auto" is light and a CSS
 * variable takes its fallback (`var(--accent, #2a78d6)`).
 */
export interface ThemeEnvironment {
  /** Whether the chart sits on a dark surface, which "auto" follows. */
  dark?: boolean;
  /** A CSS color value, from the token or style property `key`, as a color the renderers read. */
  color?(value: string, key: string): string;
  /** A CSS font-family value as a font list. */
  font?(value: string): string;
}

const VARIABLE = /\bvar\(/;

/**
 * Colors that depend on the page: variables, the current color, colors that
 * follow the color scheme, and the system colors.
 */
const PAGE_COLOR =
  /\bvar\(|\bcurrentcolor\b|\blight-dark\(|\b(?:canvas|canvastext|linktext|visitedtext|activetext|buttonface|buttontext|buttonborder|field|fieldtext|highlight|highlighttext|selecteditem|selecteditemtext|mark|marktext|graytext|accentcolor|accentcolortext)\b/i;

/** Colors every renderer and ramp reads as they are. */
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/** Theme tokens that are single colors. */
const COLORS = ["background", "text", "muted", "grid", "axis", "rise", "fall"] as const;
/** Theme tokens that are lists of colors. */
const LISTS = ["palette", "sequential", "diverging"] as const;
/** The roles of styles, in the order they resolve. */
const ROLES = [
  "text",
  "title",
  "panelTitle",
  "axisTitle",
  "tickLabel",
  "legendLabel",
  "legendTitle",
  "plot",
  "grid",
  "axisLine",
  "tick",
  "line",
  "bar",
  "tooltip",
] as const;

/**
 * Whether a theme reads the page: "auto", or CSS variables and colors that
 * depend on the page anywhere in its tokens and styles (a font family named
 * like a system color counts too, which costs only a read of the page).
 */
export function themeReadsPage(
  theme: ThemeName | ThemeSpec | undefined,
  styles?: unknown,
): boolean {
  if (theme === "auto") return true;
  if (styles !== undefined && PAGE_COLOR.test(JSON.stringify(styles))) return true;
  if (theme === undefined || typeof theme === "string") return false;
  return theme.extends === "auto" || PAGE_COLOR.test(JSON.stringify(theme));
}

/** How an environment reads colors: CSS values in any syntax as renderers read them. */
function colorsOf(environment: ThemeEnvironment): (value: string, key: string) => string {
  return (value, key) =>
    HEX.test(value) || value === "transparent" || !environment.color
      ? value
      : environment.color(value, key);
}

/**
 * A copy of a style with its colors (color, fill, stroke, and those of its
 * background box and halo) and font read as `environment` reads them,
 * `pathOf` naming a property in messages.
 */
export function readStyle<T extends object>(
  style: T,
  pathOf: (key: string) => string,
  environment: ThemeEnvironment,
): T {
  const color = colorsOf(environment);
  const out = { ...style } as Record<string, unknown>;
  for (const [key, value] of Object.entries(style))
    if (typeof value === "string" && /^(color|fill|stroke)$/.test(key))
      out[key] = color(value, pathOf(key));
    else if (value && typeof value === "object" && !Array.isArray(value))
      out[key] = readStyle(value, (inner) => `${pathOf(key)}.${inner}`, environment);
  if (environment.font && typeof out.font === "string" && VARIABLE.test(out.font))
    out.font = environment.font(out.font);
  return out as T;
}

/**
 * What `environment` reads now of the colors and fonts in `value` (a
 * chart's guide and panel styles): an environment answering from those
 * readings, for styles resolved after a page's reader is gone, and the
 * readings, to compare to learn whether a change of the page changed them.
 * A value that cannot be read now (a variable without a fallback, without
 * a page) is read, and refused, only where it is used.
 */
export function readNow(
  value: unknown,
  environment: ThemeEnvironment,
): { environment: ThemeEnvironment; reading: string } {
  const color = colorsOf(environment);
  const colors = new Map<string, string>();
  const fonts = new Map<string, string>();
  JSON.stringify(value, (key, v) => {
    try {
      if (typeof v === "string" && /^(color|fill|stroke)$/.test(key)) colors.set(v, color(v, key));
      else if (key === "font" && environment.font && VARIABLE.test(v))
        fonts.set(v, environment.font(v));
    } catch {}
    return v;
  });
  return {
    environment: {
      color: (v, key) => colors.get(v) ?? color(v, key),
      font: (v) => fonts.get(v) ?? environment.font?.(v) ?? v,
    },
    reading: JSON.stringify([...colors, ...fonts]),
  };
}

/** Built-in themes, resolved once: they read no page, and keep their identity across updates. */
const builtIn = new Map<ThemeName, Theme>();

/**
 * A chart's theme as the model and renderers read it: its tokens, role
 * styles, and paints. Named themes other than "auto" are resolved once.
 */
export function resolveTheme(
  theme: ThemeName | ThemeSpec | undefined,
  environment: ThemeEnvironment = {},
): Theme {
  const name = theme ?? "light";
  if (typeof name !== "string" || name === "auto") return build(theme, environment);
  let resolved = builtIn.get(name);
  if (!resolved) {
    resolved = build(name, environment);
    builtIn.set(name, resolved);
  }
  return resolved;
}

function build(theme: ThemeName | ThemeSpec | undefined, environment: ThemeEnvironment): Theme {
  return paints(resolveTokens(theme, environment));
}

/** A theme's tokens and role styles, resolved without the paints charts draw with. */
export interface ResolvedTokens {
  tokens: Required<ThemeTokens>;
  roles: ThemeRoles;
}

/** A theme's tokens and role styles, as `resolveTheme` resolves them: what grids read. */
export function resolveTokens(
  theme: ThemeName | ThemeSpec | undefined,
  environment: ThemeEnvironment = {},
): ResolvedTokens {
  const named = (name: ThemeName | undefined, role: string): Base => {
    if (name === undefined) return LIGHT_BASE;
    if (name === "auto") {
      const base = environment.dark ? DARK_BASE : LIGHT_BASE;
      return { ...base, tokens: { ...base.tokens, background: "transparent" } };
    }
    if (!Object.hasOwn(BASES, name))
      throw new Error(
        `${role}: no theme "${name}"; use "${[...Object.keys(BASES), "auto"].join('", "')}"`,
      );
    return BASES[name];
  };
  const spec: ThemeSpec = theme === undefined || typeof theme === "string" ? {} : theme;
  const base = named(
    typeof theme === "string" ? theme : spec.extends,
    typeof theme === "string" ? "theme" : "theme.extends",
  );
  // In a page, colors in any CSS syntax become hex (or rgba()), which ramps,
  // contrast checks, and PDF output read. Without an environment, values
  // are used as given.
  const color = colorsOf(environment);
  const tokens = { ...base.tokens } as Required<ThemeTokens>;
  const given = spec.tokens ?? {};
  for (const key of COLORS) {
    const value = given[key] ?? tokens[key];
    (tokens as unknown as Record<string, string>)[key] = color(value, `theme.tokens.${key}`);
  }
  for (const key of LISTS)
    (tokens as unknown as Record<string, readonly string[]>)[key] = (given[key] ?? tokens[key]).map(
      (value, i) => color(value, `theme.tokens.${key}[${i}]`),
    );
  checkRamp(tokens.sequential, "theme.tokens.sequential");
  checkRamp(tokens.diverging, "theme.tokens.diverging");

  // Role styles: the base theme's, made from the tokens, with the chart's
  // changes property by property, their colors and fonts read as tokens are.
  const defaults = baseRoles(base, tokens);
  const roles = {} as Record<(typeof ROLES)[number], object>;
  for (const name of ROLES)
    roles[name] = readStyle(
      cascade<object>([defaults[name], spec.style?.[name]]),
      (key) => `theme.style.${name}.${key}`,
      environment,
    );
  // Text turned light on a light base (or dark on a dark one) without a
  // tooltip of its own gets the tooltip of the other kind of theme.
  const light = isLightColor(tokens.text);
  const own = spec.style?.tooltip ?? {};
  if (own.fill === undefined && light !== undefined && light !== isLightColor(base.tokens.text)) {
    const other = light ? DARK_BASE : LIGHT_BASE;
    const tooltip = roles.tooltip as { fill: string; stroke: string };
    tooltip.fill = other.tooltip.fill;
    if (own.stroke === undefined) tooltip.stroke = other.tooltip.stroke;
  }
  return { tokens, roles: roles as unknown as ThemeRoles };
}

/** A theme with every role's paint. */
function paints({ tokens, roles: resolved }: ResolvedTokens): Theme {
  const style = {
    plot: resolved.plot,
    line: resolved.line,
    bar: resolved.bar,
    tooltip: resolved.tooltip,
  } as ThemeStyles;
  // The base text, then the text roles over it.
  for (const role of ROLES.slice(0, 7) as ("text" | TextRole)[])
    style[role] = textPaint([resolved.text, resolved[role]]);
  for (const role of ["grid", "axisLine", "tick"] as const)
    style[role] = strokePaint([resolved[role]]);
  return {
    ...tokens,
    font: style.text.font,
    fontSize: style.text.size,
    roles: resolved,
    style,
  };
}

/** The built-in themes, resolved. */
export const LIGHT: Theme = /* @__PURE__ */ resolveTheme("light");
export const DARK: Theme = /* @__PURE__ */ resolveTheme("dark");
export const HIGH_CONTRAST: Theme = /* @__PURE__ */ resolveTheme("high-contrast");
export const HIGH_CONTRAST_DARK: Theme = /* @__PURE__ */ resolveTheme("high-contrast-dark");

export function paletteColor(theme: Theme, index: number): string {
  return theme.palette[index % theme.palette.length]!;
}

/**
 * The color a chart is drawn on: its background, or under a transparent
 * one, black for light text and white for dark, as the page likely is.
 */
export function surface(theme: Pick<Theme, "background" | "text">): string {
  if (theme.background !== "transparent") return theme.background;
  return isLightColor(theme.text) ? "#000000" : "#ffffff";
}
