import { checkRamp, isLightColor } from "./scale/color.ts";
import type { ThemeName, ThemeSpec } from "./spec/spec.ts";

export interface Theme {
  background: string;
  text: string;
  muted: string;
  grid: string;
  axis: string;
  font: string;
  fontSize: number;
  /** Size of the chart's title, in pixels. */
  titleSize: number;
  /** Dash pattern of grid lines, in pixels; empty for solid lines. */
  gridDash: readonly number[];
  /** Width of lines and area outlines that do not set one. */
  lineWidth: number;
  /** Radius of the corners at the value end of unstacked bars; 0 for square bars. */
  barRadius: number;
  /** Tooltip background and border colors; its text is `text`. */
  tooltipBackground: string;
  tooltipBorder: string;
  palette: readonly string[];
  /** Ramp for continuous color, from low to high values. */
  sequential: readonly string[];
  /** Ramp for values on either side of a midpoint, through a neutral middle. */
  diverging: readonly string[];
  /** Candlesticks closing at or above their open, and below it. */
  rise: string;
  fall: string;
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
export const LIGHT: Theme = {
  background: "transparent",
  text: "#1c2333",
  muted: "#5d6677",
  grid: "#e8ebf0",
  axis: "#cfd5de",
  font: FONT,
  fontSize: 12,
  titleSize: 15,
  gridDash: [],
  lineWidth: 2,
  barRadius: 4,
  tooltipBackground: "#ffffff",
  tooltipBorder: "#dfe3ea",
  palette: ["#3266d6", "#ec6a2c", "#109e7f", "#7651d8", "#e0464f", "#1f8fc8", "#c18300", "#c4489b"],
  sequential: SEQUENTIAL,
  diverging: DIVERGING,
  rise: "#109e7f",
  fall: "#e0464f",
};

export const DARK: Theme = {
  ...LIGHT,
  text: "#e8ebf1",
  muted: "#9aa3b4",
  grid: "#252a34",
  axis: "#3a4150",
  tooltipBackground: "#1b1f28",
  tooltipBorder: "#303643",
  palette: ["#5b8def", "#dc6f3a", "#20a181", "#9478ec", "#e0555d", "#3497cd", "#bf8a12", "#cb5da3"],
  sequential: SEQUENTIAL_DARK,
  rise: "#20a181",
  fall: "#e0555d",
};

// High contrast: a surface of its own, so contrast does not depend on the
// page; text and axes in black or white, grid lines at 4.5:1, wider
// lines, larger text, and categorical colors each at least 4.5:1 against the
// page (checked with OKLab color-vision simulation for adjacent series).
export const HIGH_CONTRAST: Theme = {
  ...LIGHT,
  background: "#ffffff",
  text: "#000000",
  muted: "#1f1f1f",
  grid: "#767676",
  axis: "#000000",
  fontSize: 13,
  titleSize: 16,
  lineWidth: 2.5,
  tooltipBorder: "#000000",
  palette: ["#0057b8", "#b84a00", "#b3176f", "#7a5c00", "#007c99", "#c41e2a", "#6a3fc0", "#007a4d"],
  sequential: ["#7d9ee6", "#4a76d6", "#2d58b6", "#20438d", "#152f66", "#0b1c40"],
  rise: "#007a4d",
  fall: "#c41e2a",
};

export const HIGH_CONTRAST_DARK: Theme = {
  ...HIGH_CONTRAST,
  background: "#000000",
  text: "#ffffff",
  muted: "#e6e6e6",
  grid: "#8c8c8c",
  axis: "#ffffff",
  tooltipBackground: "#000000",
  tooltipBorder: "#ffffff",
  palette: ["#6cb6ff", "#4fd18b", "#b49cff", "#ff9a4d", "#42d6e8", "#ff6b6b", "#e8c547", "#ff7ac6"],
  sequential: ["#3561ad", "#4f82d9", "#7ca3ea", "#a1bdf2", "#c6d8f8", "#f2f6fe"],
  rise: "#4fd18b",
  fall: "#ff6b6b",
};

const THEMES: Record<Exclude<ThemeName, "auto">, Theme> = {
  light: LIGHT,
  dark: DARK,
  "high-contrast": HIGH_CONTRAST,
  "high-contrast-dark": HIGH_CONTRAST_DARK,
};

/**
 * Where a theme is shown: whether the page prefers dark colors (for
 * "auto"), and how to read CSS colors and fonts such as `var(--accent)`.
 * The DOM runtime supplies one; without it, "auto" is light and a CSS
 * variable takes its fallback (`var(--accent, #2a78d6)`).
 */
/** What themes that follow the page ("auto", CSS variables) read from it. */
export interface ThemeEnvironment {
  /** Whether the chart sits on a dark surface, which "auto" follows. */
  dark?: boolean;
  /** A CSS color value, from the token `key`, as a color the renderers read. */
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

/** Whether a theme reads the page: "auto", or CSS variables in its colors or font. */
export function themeReadsPage(theme: ThemeName | ThemeSpec | undefined): boolean {
  if (theme === "auto") return true;
  if (theme === undefined || typeof theme === "string") return false;
  if (theme.extends === "auto" || (theme.font !== undefined && VARIABLE.test(theme.font)))
    return true;
  const colors = [
    ...COLORS.map((key) => theme[key]),
    ...(theme.palette ?? []),
    ...(theme.sequential ?? []),
    ...(theme.diverging ?? []),
  ];
  return colors.some((color) => typeof color === "string" && PAGE_COLOR.test(color));
}

export function resolveTheme(
  theme: ThemeName | ThemeSpec | undefined,
  environment: ThemeEnvironment = {},
): Theme {
  const named = (name: ThemeName | undefined, role: string) => {
    if (name === undefined) return LIGHT;
    if (name === "auto") return environment.dark ? DARK : LIGHT;
    if (!Object.hasOwn(THEMES, name))
      throw new Error(
        `${role}: no theme "${name}"; use "${[...Object.keys(THEMES), "auto"].join('", "')}"`,
      );
    return THEMES[name];
  };
  if (theme === undefined || typeof theme === "string") return named(theme, "theme");
  const base = named(theme.extends, "theme.extends");
  const resolved: Theme = { ...base };
  for (const key of Object.keys(base) as (keyof Theme)[]) {
    const value = theme[key];
    if (value !== undefined) (resolved as unknown as Record<string, unknown>)[key] = value;
  }
  // In a page, colors in any CSS syntax become hex (or rgba()), which ramps,
  // contrast checks, and PDF output read. Without an environment, values
  // are used as given.
  const color = (value: string, key: string) =>
    HEX.test(value) || value === "transparent" || !environment.color
      ? value
      : environment.color(value, key);
  for (const key of COLORS)
    (resolved as unknown as Record<string, string>)[key] = color(resolved[key], key);
  for (const key of ["palette", "sequential", "diverging"] as const) {
    (resolved as unknown as Record<string, string[]>)[key] = resolved[key].map((value, i) =>
      color(value, `${key}[${i}]`),
    );
  }
  if (environment.font && VARIABLE.test(resolved.font))
    resolved.font = environment.font(resolved.font);
  // Text turned light on a light base (or dark on a dark one) without a
  // tooltip of its own gets the tooltip of the other kind of theme.
  const light = isLightColor(resolved.text);
  if (
    theme.tooltipBackground === undefined &&
    light !== undefined &&
    light !== isLightColor(base.text)
  ) {
    const other = light ? DARK : LIGHT;
    resolved.tooltipBackground = other.tooltipBackground;
    if (theme.tooltipBorder === undefined) resolved.tooltipBorder = other.tooltipBorder;
  }
  checkRamp(resolved.sequential, "theme.sequential");
  checkRamp(resolved.diverging, "theme.diverging");
  return resolved;
}

/** Theme tokens that are single colors. */
const COLORS = [
  "background",
  "text",
  "muted",
  "grid",
  "axis",
  "tooltipBackground",
  "tooltipBorder",
  "rise",
  "fall",
] as const;

export function paletteColor(theme: Theme, index: number): string {
  return theme.palette[index % theme.palette.length]!;
}

/**
 * The color a chart is drawn on: its background, or under a transparent
 * one, black for light text and white for dark, as the page likely is.
 */
export function surface(theme: Theme): string {
  if (theme.background !== "transparent") return theme.background;
  return isLightColor(theme.text) ? "#000000" : "#ffffff";
}
