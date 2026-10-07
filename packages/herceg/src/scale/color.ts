// Sequential color: maps numbers onto a ramp of colors through a 256-entry
// lookup table, so coloring many cells costs one table read each.

const LUT_SIZE = 256;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

/**
 * Checks that every stop of a color ramp is a `#rgb` or `#rrggbb` color, the
 * syntax both the raster painter and the legend read the same way.
 */
export function checkRamp(stops: readonly string[], what: string): void {
  if (stops.length < 2) throw new RangeError(`${what} needs at least two colors`);
  const bad = stops.find((stop) => !HEX.test(stop));
  if (bad !== undefined) {
    throw new TypeError(`${what} must be hex colors such as "#08306b"; got ${JSON.stringify(bad)}`);
  }
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
  /** RGBA bytes, LUT_SIZE entries. */
  readonly #lut: Uint8ClampedArray;
  readonly #low: number;
  readonly #scale: number;

  constructor(domain: readonly [number, number], stops: readonly string[]) {
    checkRamp(stops, "A sequential scale");
    this.domain = domain;
    this.stops = stops;
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
    const span = domain[1] - domain[0];
    this.#low = domain[0];
    this.#scale = span > 0 ? (LUT_SIZE - 1) / span : 0;
  }

  /** Lookup-table index for a value; -1 for missing values. */
  index(value: number): number {
    if (!Number.isFinite(value)) return -1;
    const i = Math.round((value - this.#low) * this.#scale);
    return i < 0 ? 0 : i >= LUT_SIZE ? LUT_SIZE - 1 : i;
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
    const i = Math.max(0, this.index(value));
    const r = this.#lut[i * 4]!;
    const g = this.#lut[i * 4 + 1]!;
    const b = this.#lut[i * 4 + 2]!;
    return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
  }
}
