import { checkRamp } from "./scale/color.ts";
import type { ThemeName, ThemeSpec } from "./spec/spec.ts";

export interface Theme {
  background: string;
  text: string;
  muted: string;
  grid: string;
  axis: string;
  font: string;
  fontSize: number;
  palette: readonly string[];
  /** Ramp for continuous color, from low to high values. */
  sequential: readonly string[];
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

// Categorical colors in a fixed order chosen so adjacent series stay
// distinguishable under common color-vision deficiencies; each mode has its
// own steps of the same eight hues. Charts with more than eight series reuse
// colors from the start. Continuous color uses one hue, from near the
// background (low) to strong (high).
const BLUE = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
export const LIGHT: Theme = {
  background: "transparent",
  text: "#0b0b0b",
  muted: "#52514e",
  grid: "#e1e0d9",
  axis: "#c3c2b7",
  font: FONT,
  fontSize: 12,
  palette: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  sequential: BLUE,
};

export const DARK: Theme = {
  background: "transparent",
  text: "#ffffff",
  muted: "#c3c2b7",
  grid: "#2c2c2a",
  axis: "#383835",
  font: FONT,
  fontSize: 12,
  palette: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  sequential: [...BLUE].reverse(),
};

export function resolveTheme(theme: ThemeName | ThemeSpec | undefined): Theme {
  if (theme === undefined || theme === "light") return LIGHT;
  if (theme === "dark") return DARK;
  const base = theme.extends === "dark" ? DARK : LIGHT;
  const resolved: Theme = { ...base };
  for (const key of Object.keys(base) as (keyof Theme)[]) {
    const value = theme[key];
    if (value !== undefined) (resolved as unknown as Record<string, unknown>)[key] = value;
  }
  checkRamp(resolved.sequential, "theme.sequential");
  return resolved;
}

export function paletteColor(theme: Theme, index: number): string {
  return theme.palette[index % theme.palette.length]!;
}
