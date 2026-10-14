// The style cascade: theme -> chart -> panel -> mark -> series -> element.
// Each level is a partial style; later levels win property by property,
// `false` turns a feature off, and arrays replace rather than concatenate.
// Resolving a role's levels gives a paint: plain values renderers read,
// made once per configuration and shared by every element of the role.

import { type ColorReader, colorContrast, readsLight } from "../scale/color.ts";
import type { Dash } from "../spec/spec.ts";
import type { Halo, Insets, PlotStyle, StrokeStyle, TextBox, TextStyle } from "../spec/style.ts";

/** Text as resolved: what layout measures and renderers draw with. */
export interface TextPaint {
  /** A CSS font family list. */
  readonly font: string;
  readonly size: number;
  readonly weight: number;
  readonly italic: boolean;
  readonly color: string;
  readonly opacity: number;
  /** Pixels from one line's baseline to the next. */
  readonly lineHeight: number;
  /** Undefined: the text's own natural alignment. */
  readonly align: "start" | "center" | "end" | undefined;
  /** Resolved against the surface under the text where it is drawn (see `haloOf`). */
  readonly halo: Halo;
  readonly background: TextBox | undefined;
  /** Room inside the background box: top, right, bottom, left. */
  readonly padding: readonly [number, number, number, number];
  /** The CSS font shorthand measuring uses, such as "600 12px Inter". */
  readonly css: string;
}

/** A halo as drawn: an outline of the text's glyphs under them. */
export interface ResolvedHalo {
  readonly color: string;
  readonly width: number;
  readonly opacity: number;
}

/** How wide halos are by default, in pixels: they reach half of it around each glyph. */
export const HALO_WIDTH = 3;

/**
 * The halo of text colored `color` over `surface`, as `halo` asks; none
 * for false. "auto" takes the surface where the text contrasts with it at
 * 3:1 or more, else white behind dark text and black behind light text,
 * at 0.85 (by `text`, the theme's text color, for colors `read` cannot read).
 */
export function haloOf(
  halo: Halo,
  color: string,
  surface: string,
  text: string,
  read: ColorReader,
): ResolvedHalo | undefined {
  if (halo === false) return undefined;
  if (halo !== "auto")
    return { color: halo.color, width: halo.width ?? HALO_WIDTH, opacity: halo.opacity ?? 1 };
  if ((colorContrast(color, surface, read) ?? 0) >= 3)
    return { color: surface, width: HALO_WIDTH, opacity: 1 };
  const light = readsLight(color, read) ?? readsLight(text, read);
  return { color: light ? "#000000" : "#ffffff", width: HALO_WIDTH, opacity: 0.85 };
}

/** A line as resolved. */
export interface StrokePaint {
  readonly stroke: string;
  readonly strokeWidth: number;
  /** Pixel dash pattern; empty for solid lines. */
  readonly dash: readonly number[];
  readonly opacity: number;
}

/** Levels of one role's style, lowest first; undefined levels are skipped. */
export type Levels<T> = readonly (T | undefined)[];

/** One style from its levels, later ones winning property by property. */
export function cascade<T extends object>(levels: Levels<T>): Partial<T> {
  const out: Partial<T> = {};
  for (const level of levels) {
    if (!level) continue;
    for (const key of Object.keys(level) as (keyof T)[]) {
      const value = level[key];
      if (value !== undefined) out[key] = value;
    }
  }
  return out;
}

/** Each side of `insets`: top, right, bottom, left. */
export function insets(value: Insets | undefined): [number, number, number, number] {
  if (value === undefined) return [0, 0, 0, 0];
  if (typeof value === "number") return [value, value, value, value];
  return [value.top ?? 0, value.right ?? 0, value.bottom ?? 0, value.left ?? 0];
}

/** The CSS font shorthand of a family, size, weight, and slant. */
export function cssFont(font: string, size: number, weight = 400, italic = false): string {
  return `${italic ? "italic " : ""}${weight !== 400 ? `${weight} ` : ""}${size}px ${font}`;
}

/**
 * A text role's paint from its levels, the first of which (the theme's
 * base text) gives every property.
 */
export function textPaint(levels: Levels<TextStyle>): TextPaint {
  const style = cascade(levels);
  const font = style.font ?? "sans-serif";
  const size = style.fontSize ?? 12;
  const weight = style.fontWeight ?? 400;
  const italic = style.fontStyle === "italic";
  const background = style.background || undefined;
  return {
    font,
    size,
    weight,
    italic,
    color: style.color ?? "#000000",
    opacity: style.opacity ?? 1,
    lineHeight: Math.round(size * (style.lineHeight ?? 1.25)),
    align: style.align,
    halo: style.halo ?? false,
    background,
    padding: insets(style.padding),
    css: cssFont(font, size, weight, italic),
  };
}

/** A line role's paint from its levels, the first of which gives every property. */
export function strokePaint(levels: Levels<StrokeStyle>): StrokePaint {
  const style = cascade(levels);
  const strokeWidth = style.strokeWidth ?? 1;
  return {
    stroke: style.stroke ?? "#000000",
    strokeWidth,
    dash: dashPattern(style.dash, strokeWidth) ?? [],
    opacity: style.opacity ?? 1,
  };
}

/** A plot's background and border, as resolved. */
export interface PlotPaint {
  readonly fill: string | undefined;
  readonly stroke: string | undefined;
  readonly strokeWidth: number;
}

/** A plot's paint from its levels; undefined when it has neither a background nor a border. */
export function plotPaint(levels: Levels<PlotStyle>): PlotPaint | undefined {
  const { fill, stroke, strokeWidth = 1 } = cascade(levels);
  return fill || stroke ? { fill, stroke, strokeWidth } : undefined;
}

/** A dash pattern in pixels: arrays as they are, matplotlib's styles scaled by the stroke width. */
export function dashPattern(value: Dash | undefined, width: number): readonly number[] | undefined {
  if (typeof value !== "string") return value;
  switch (value) {
    case "-":
      return [];
    case "--":
      return [3.7 * width, 1.6 * width];
    case ":":
      return [width, 1.65 * width];
    case "-.":
      return [6.4 * width, 1.6 * width, width, 1.6 * width];
  }
  throw new Error("dash: expected -, --, :, -.");
}
