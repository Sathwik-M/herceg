// Continuous color: maps numbers onto a ramp of colors through a 255-entry
// lookup table, so coloring many cells costs one table read each. A
// diverging ramp maps a midpoint to its middle color, and each side of the
// midpoint onto its own half of the ramp.

import { cssColor } from "./css-color.ts";

/** Odd, so one entry is the ramp's exact middle, and below 256, so an index fits a byte. */
const LUT_SIZE = 255;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Checks that every stop of a color ramp is a `#rgb` or `#rrggbb` color, the
 * syntax both the raster painter and the legend read the same way.
 */
export function checkRamp(stops: readonly string[], what: string): void {
  if (stops.length < 2) throw new RangeError(`${what}: expected at least two colors`);
  const bad = stops.find((stop) => !HEX.test(stop));
  if (bad !== undefined) {
    throw new TypeError(`${what}: expected "#rrggbb" colors; received ${JSON.stringify(bad)}`);
  }
}

/**
 * Checks a mark's fixed color domain and midpoint: finite numbers, the
 * domain ascending, and the midpoint inside it.
 */
export function checkColorScale(
  domain: readonly [number, number] | undefined,
  midpoint: number | undefined,
  what: string,
): void {
  if (
    domain &&
    !(Number.isFinite(domain[0]) && Number.isFinite(domain[1]) && domain[0] < domain[1])
  )
    throw new RangeError(
      `${what} colorDomain: expected two finite numbers, ascending; received [${domain}]`,
    );
  if (midpoint === undefined) return;
  if (!Number.isFinite(midpoint))
    throw new RangeError(`${what} colorMidpoint: expected a finite number; received ${midpoint}`);
  if (domain && !(midpoint >= domain[0] && midpoint <= domain[1]))
    throw new RangeError(`${what} colorMidpoint: ${midpoint} is outside colorDomain [${domain}]`);
}

/**
 * A ramp from a mark's colors, or `fallback`. Scheme names in specs are
 * resolved by the spec loader, which keeps the scheme table out of charts
 * that do not load specs.
 */
export function rampOf(
  colors: string | readonly string[] | undefined,
  fallback: readonly string[],
): readonly string[] {
  if (typeof colors === "string") {
    throw new TypeError(
      `colors: scheme "${colors}" is unresolved; load the spec with loadSpec, or pass its colors (import { ${colors} } from "herceg")`,
    );
  }
  return colors ?? fallback;
}

/**
 * Whether a CSS color is certainly opaque: hex without alpha, `rgb()` or
 * `hsl()` without an alpha part, or a named color. Anything else may be
 * translucent.
 */
export function isOpaqueColor(color: string): boolean {
  const c = color.trim().toLowerCase();
  if (HEX.test(c)) return true;
  if (/^(rgb|hsl)\(/.test(c)) return !c.includes("/") && c.split(",").length < 4;
  return /^[a-z]+$/.test(c) && c !== "transparent" && c !== "currentcolor";
}

/**
 * Whether a color is light: black text on it contrasts more than white
 * (WCAG relative luminance above 0.179). Reads hex, `rgb()`, and `hsl()`
 * colors; undefined for other syntaxes such as names, which would need the
 * full CSS color table.
 */
export function isLightColor(color: string): boolean | undefined {
  const rgba = parseColor(color.trim().toLowerCase());
  return rgba && luminance([rgba[0], rgba[1], rgba[2]]) > 0.179;
}

/** WCAG contrast of a color over an opaque surface; undefined for unreadable colors. */
export function colorContrast(fill: string, backdrop: string): number | undefined {
  const top = cssColor(fill);
  const bottom = cssColor(backdrop);
  if (!top || !bottom || bottom[3] < 1) return undefined;
  const mixed = top.slice(0, 3).map((c, i) => c * top[3] + bottom[i]! * (1 - top[3]));
  const a = luminance(mixed as [number, number, number]) + 0.05;
  const b = luminance([bottom[0], bottom[1], bottom[2]]) + 0.05;
  return Math.max(a, b) / Math.min(a, b);
}

/**
 * Black or white text, whichever contrasts more with `fill` painted at
 * `opacity` (times the color's own alpha) over `backdrop`; undefined when
 * either color cannot be read or the backdrop is translucent.
 */
export function contrastingText(
  fill: string,
  opacity: number,
  backdrop: string,
): "#000000" | "#ffffff" | undefined {
  const top = parseColor(fill.trim().toLowerCase());
  const bottom = parseColor(backdrop.trim().toLowerCase());
  if (!top || !bottom || bottom[3] < 1) return undefined;
  const alpha = opacity * top[3];
  const mixed = [0, 1, 2].map((i) => top[i]! * alpha + bottom[i]! * (1 - alpha));
  return luminance(mixed as [number, number, number]) > 0.179 ? "#000000" : "#ffffff";
}

/** WCAG relative luminance of an sRGB color with channels from 0 to 255. */
function luminance([r, g, b]: [number, number, number]): number {
  const linear = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** Channels from 0 to 255 and alpha from 0 to 1 of a hex, `rgb()`, or `hsl()` color. */
function parseColor(c: string): [number, number, number, number] | undefined {
  if (HEX.test(c)) return [...parseHex(c), 1];
  const match = /^(rgb|hsl)a?\(([^)]*)\)$/.exec(c);
  if (!match) return undefined;
  const parts = match[2]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return undefined;
  const value = (part: string, scale: number) =>
    part.endsWith("%") ? (Number.parseFloat(part) / 100) * scale : Number.parseFloat(part);
  const alpha = parts[3] === undefined ? 1 : value(parts[3], 1);
  if (!(alpha >= 0 && alpha <= 1)) return undefined;
  if (match[1] === "rgb") {
    const rgb = parts.slice(0, 3).map((part) => value(part, 255));
    return rgb.every(Number.isFinite) ? [rgb[0]!, rgb[1]!, rgb[2]!, alpha] : undefined;
  }
  const h = Number.parseFloat(parts[0]!);
  const s = value(parts[1]!, 1);
  const l = value(parts[2]!, 1);
  if (![h, s, l].every(Number.isFinite)) return undefined;
  // HSL to RGB, per CSS Color 4.
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [channel(0), channel(8), channel(4), alpha];
}

function parseHex(hex: string): [number, number, number] {
  const value = hex.slice(1);
  const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value;
  const n = Number.parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export class SequentialScale {
  readonly domain: readonly [number, number];
  readonly stops: readonly string[];
  /** The value at the ramp's middle color, for diverging ramps. */
  readonly midpoint: number | undefined;
  /** RGBA bytes, LUT_SIZE entries. */
  readonly #lut: Uint8ClampedArray;
  readonly #lo: number;
  readonly #hi: number;
  readonly #mid: number;

  /**
   * A scale over `domain`, widened to include `midpoint` when the midpoint
   * lies outside it, so values on each side keep their half of the ramp.
   */
  constructor(domain: readonly [number, number], stops: readonly string[], midpoint?: number) {
    checkRamp(stops, "color scale");
    this.domain =
      midpoint === undefined || (midpoint >= domain[0] && midpoint <= domain[1])
        ? domain
        : [Math.min(domain[0], midpoint), Math.max(domain[1], midpoint)];
    const [lo, hi] = this.domain;
    this.stops = stops;
    this.midpoint = midpoint;
    const rgb = stops.map(parseHex);
    this.#lut = new Uint8ClampedArray(LUT_SIZE * 4);
    for (let i = 0; i < LUT_SIZE; i++) {
      const position = (i / (LUT_SIZE - 1)) * (rgb.length - 1);
      const index = Math.min(rgb.length - 2, Math.floor(position));
      const t = position - index;
      const a = rgb[index]!;
      const b = rgb[index + 1]!;
      for (let c = 0; c < 3; c++) this.#lut[i * 4 + c] = Math.round(a[c]! + (b[c]! - a[c]!) * t);
      this.#lut[i * 4 + 3] = 255;
    }
    this.#lo = lo;
    this.#hi = hi;
    this.#mid = midpoint ?? 0;
  }

  /** Lookup-table index for a value; -1 for missing values. */
  index(value: number): number {
    if (!Number.isFinite(value)) return -1;
    const v = value;
    const last = LUT_SIZE - 1;
    let position: number;
    if (this.midpoint === undefined) {
      position = fraction(v, this.#lo, this.#hi) * last;
    } else {
      // Each side of the midpoint takes its half of the table; the midpoint
      // itself, the middle entry.
      const [lo, mid, hi] = [this.#lo, this.#mid, this.#hi];
      const t = v < mid ? fraction(v, lo, mid) - 1 : hi > mid ? fraction(v, mid, hi) : 0;
      position = ((1 + t) * last) / 2;
    }
    const i = Math.round(position);
    return i < 0 ? 0 : i > last ? last : i;
  }

  /**
   * The ramp's stops for a legend gradient that places the middle color at
   * the midpoint. With an even number of stops there is no middle stop, so
   * the blend of each neighboring pair is added between them, keeping the
   * stops evenly spaced with the middle color, as the lookup table blends
   * it, among them.
   */
  legendStops(): readonly string[] {
    const { stops } = this;
    if (this.midpoint === undefined || stops.length % 2 === 1) return stops;
    const out = [stops[0]!];
    for (let i = 1; i < stops.length; i++) out.push(blend(stops[i - 1]!, stops[i]!), stops[i]!);
    return out;
  }

  /** The CSS color of each lookup-table entry, for drawing points of many colors. */
  colors(): string[] {
    return Array.from({ length: LUT_SIZE }, (_, i) => hexOf(this.#lut, i));
  }

  /** Writes the RGBA color of `value` into `out` at byte offset `at` (transparent when missing). */
  write(value: number, out: Uint8ClampedArray, at: number): void {
    const i = this.index(value);
    if (i < 0) {
      out[at + 3] = 0;
      return;
    }
    out[at] = this.#lut[i * 4]!;
    out[at + 1] = this.#lut[i * 4 + 1]!;
    out[at + 2] = this.#lut[i * 4 + 2]!;
    out[at + 3] = 255;
  }

  /** CSS color of `value`. */
  color(value: number): string {
    return hexOf(this.#lut, Math.max(0, this.index(value)));
  }
}

/**
 * Where `value` lies from lo (0) to hi (1); 1 when they are equal, so a
 * domain of one value takes the high end. Spans too wide for a double are
 * measured in halves; dividing by the span, rather than multiplying by its
 * reciprocal, keeps tiny (subnormal) spans exact.
 */
export function fraction(value: number, lo: number, hi: number): number {
  if (!(hi > lo)) return 1;
  const span = hi - lo;
  return Number.isFinite(span) ? (value - lo) / span : (value / 2 - lo / 2) / (hi / 2 - lo / 2);
}

/** The color halfway between two hex colors. */
function blend(a: string, b: string): string {
  const [x, y] = [parseHex(a), parseHex(b)];
  const mixed = new Uint8ClampedArray(
    [0, 1, 2, 3].map((c) => (c < 3 ? Math.round((x[c]! + y[c]!) / 2) : 255)),
  );
  return hexOf(mixed, 0);
}

function hexOf(lut: Uint8ClampedArray, i: number): string {
  const r = lut[i * 4]!;
  const g = lut[i * 4 + 1]!;
  const b = lut[i * 4 + 2]!;
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}
