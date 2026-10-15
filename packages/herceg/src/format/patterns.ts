// Portable format patterns, which specs and Python carry as strings: numbers
// in a subset of d3-format (`{ number: ",.2f" }`) and times in a subset of
// strftime (`{ time: "%b %d %H:%M" }`). Digits, separators, and names are
// the chart locale's, written with Intl; times are written in the scale's
// time zone. The patterns used last are kept compiled. They write with the
// chart's formatters and zone arithmetic, handed in (see `GuideKit`).

import type { GuideKit } from "../model/guides.ts";
import type { Formatter } from "./format.ts";
import type { TimeZone } from "./zone.ts";

/** How many compiled patterns are kept: the ones used last, as a page's charts use a few. */
const KEPT = 64;
const compiled = new Map<string, Formatter>();

function cached(key: string, make: () => Formatter): Formatter {
  let formatter = compiled.get(key);
  if (formatter) compiled.delete(key);
  else formatter = make();
  // The Map's order is the order of use: the first key was used longest ago.
  compiled.set(key, formatter);
  if (compiled.size > KEPT) compiled.delete(compiled.keys().next().value!);
  return formatter;
}

// [sign][,][.precision][~][type]
const NUMBER = /^([-+( ])?(,)?(?:\.(\d{1,2}))?(~)?([defgs%]?)$/;
const PREFIXES = [
  "y",
  "z",
  "a",
  "f",
  "p",
  "n",
  "µ",
  "m",
  "",
  "k",
  "M",
  "G",
  "T",
  "P",
  "E",
  "Z",
  "Y",
];

/**
 * Writes numbers as a d3-format pattern says: a sign ("-" for negative
 * numbers only, the default; "+" for both; "(" for parentheses around
 * negative ones; " " for a space before positive ones), "," to group
 * thousands, ".precision", "~" to trim trailing zeros, and a type: d
 * (whole numbers), f (fixed decimals), e (exponent), g (significant
 * digits), s (significant digits with an SI prefix), % (percent), or none
 * (as "~g" with 12 digits). Throws, naming `where`, for other patterns.
 */
export function numberPattern(
  kit: GuideKit,
  pattern: string,
  locale: string | undefined,
  where: string,
): Formatter {
  return cached(`n|${locale}|${pattern}`, () => {
    const match = NUMBER.exec(pattern);
    if (!match)
      throw new Error(
        `${where}: "${pattern}" is not a number pattern herceg reads; write [sign][,][.precision][~][type] with type d, f, e, g, s, or %, such as ",.2f" or ".1%"`,
      );
    const [, sign = "-", comma, given, tilde, kind] = match;
    const type = kind || "g";
    const trim = tilde !== undefined || !kind;
    const precision = given !== undefined ? Number(given) : kind ? 6 : 12;
    if ((type === "g" || type === "s") && precision === 0)
      throw new Error(`${where}: "${pattern}" asks for 0 significant digits; give 1 or more`);
    const digits = (value: number, options: Intl.NumberFormatOptions) =>
      kit.numberFormatter({ useGrouping: !!comma, ...options }, locale)(value);
    const significant = {
      minimumSignificantDigits: trim ? 1 : precision,
      maximumSignificantDigits: precision,
    };
    const fixed = (p: number) => ({
      minimumFractionDigits: trim ? 0 : p,
      maximumFractionDigits: p,
    });
    /** A mantissa and exponent as toExponential writes them, the mantissa in the locale ("1.2e+4"). */
    const exponential = (text: string) => {
      const [mantissa, exponent] = text.split("e");
      const decimals = mantissa!.split(".")[1]?.length ?? 0;
      return `${digits(Number(mantissa), fixed(decimals))}e${exponent}`;
    };
    /** |value| as the type writes it, and the value its digits show (for the sign). */
    const body = (x: number): [string, number] => {
      switch (type) {
        case "d":
          return [digits(Math.round(x), { maximumFractionDigits: 0 }), Math.round(x)];
        case "f":
          return [digits(x, fixed(precision)), Number(x.toFixed(precision))];
        case "%":
          return [`${digits(x * 100, fixed(precision))}%`, Number((x * 100).toFixed(precision))];
        case "e": {
          const text = x.toExponential(precision);
          return [exponential(text), Number(text)];
        }
        case "s": {
          const shown = x === 0 ? 0 : Number(x.toPrecision(precision));
          const k = shown === 0 ? 0 : Math.max(-8, Math.min(8, Math.floor(Math.log10(shown) / 3)));
          return [digits(shown / 10 ** (3 * k), significant) + PREFIXES[k + 8]!, shown];
        }
        default: {
          // Exponential where toPrecision writes one, as d3-format does.
          const text = x.toPrecision(precision);
          const shown = Number(text);
          return [text.includes("e") ? exponential(text) : digits(shown, significant), shown];
        }
      }
    };
    const minus = minusSign(locale);
    return (value) => {
      if (!Number.isFinite(value)) return digits(value, {});
      const [text, shown] = body(Math.abs(value));
      // Values that round to zero are written without a minus sign.
      if (value < 0 && shown !== 0) return sign === "(" ? `(${text})` : minus + text;
      return (sign === "+" ? "+" : sign === " " ? " " : "") + text;
    };
  });
}

/** The locale's minus sign, as Intl writes negative numbers. */
function minusSign(locale: string | undefined): string {
  const parts = new Intl.NumberFormat(locale).formatToParts(-1);
  return parts.find((part) => part.type === "minusSign")?.value ?? "-";
}

const DIRECTIVE = /%(-?)(.?)/g;
const NAMES = "aAbBp";
const NUMBERS = "YymdeHIMSL";

/**
 * Writes times as a strftime pattern says, in `zone`: %Y %y %m %d %e %H %I
 * %M %S %L (milliseconds), %p, %a %A %b %B (names in the chart's locale), %z
 * (the zone's offset, +hhmm), and %% for "%"; "-" after % drops a number's
 * padding ("%-d"). Throws, naming `where` and the directive's place, for
 * anything else.
 */
export function timePattern(
  kit: GuideKit,
  pattern: string,
  zone: TimeZone,
  locale: string | undefined,
  where: string,
): Formatter {
  return cached(`t|${locale}|${zone}|${pattern}`, () => {
    for (const { 0: whole, 1: flag, 2: directive = "", index } of pattern.matchAll(DIRECTIVE)) {
      const number = directive !== "" && NUMBERS.includes(directive);
      const known = number || (directive !== "" && `${NAMES}z%`.includes(directive));
      if (!known || (flag && !number))
        throw new Error(
          `${where}: "${whole}" at character ${index + 1} of "${pattern}" is not a time directive herceg reads; use %Y %y %m %d %e %H %I %M %S %L %p %a %A %b %B %z, "-" for no padding (%-d), and %% for "%"`,
        );
    }
    // Names read the wall time as if it were UTC, as calendar math does;
    // only the formatters the pattern uses are made.
    const used = (directive: string) => pattern.includes(`%${directive}`);
    const named = (directive: string, options: Intl.DateTimeFormatOptions) => {
      if (!used(directive)) return undefined;
      const format = new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" });
      return (wall: number) => format.format(wall);
    };
    const period = used("p")
      ? new Intl.DateTimeFormat(locale, { hour: "numeric", hour12: true, timeZone: "UTC" })
      : undefined;
    const names: Record<string, ((wall: number) => string) | undefined> = {
      a: named("a", { weekday: "short" }),
      A: named("A", { weekday: "long" }),
      b: named("b", { month: "short" }),
      B: named("B", { month: "long" }),
      p:
        period &&
        ((wall) =>
          period.formatToParts(wall).find((part) => part.type === "dayPeriod")?.value ?? ""),
    };
    return (t) => {
      if (!Number.isFinite(t)) return "";
      const wall = kit.toWall(zone, t);
      const date = new Date(wall);
      const hours = date.getUTCHours();
      // Each number and the width it is padded to.
      const numbers: Record<string, [number, number]> = {
        Y: [date.getUTCFullYear(), 0],
        y: [date.getUTCFullYear() % 100, 2],
        m: [date.getUTCMonth() + 1, 2],
        d: [date.getUTCDate(), 2],
        e: [date.getUTCDate(), 2],
        H: [hours, 2],
        I: [hours % 12 || 12, 2],
        M: [date.getUTCMinutes(), 2],
        S: [date.getUTCSeconds(), 2],
        L: [date.getUTCMilliseconds(), 3],
      };
      return pattern.replace(DIRECTIVE, (_, flag: string, directive: string) => {
        if (directive === "%") return "%";
        if (directive === "z") {
          const minutes = Math.round((wall - t) / 60_000);
          const at = Math.abs(minutes);
          return `${minutes < 0 ? "-" : "+"}${pad(Math.floor(at / 60), 2, "0")}${pad(at % 60, 2, "0")}`;
        }
        const number = numbers[directive];
        if (!number) return names[directive]!(wall);
        return flag ? String(number[0]) : pad(number[0], number[1], directive === "e" ? " " : "0");
      });
    };
  });
}

function pad(value: number, width: number, filler: string): string {
  const text = String(value);
  return text.length >= width ? text : filler.repeat(width - text.length) + text;
}
