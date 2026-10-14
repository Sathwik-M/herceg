// CSS colors as numbers, for output formats that cannot pass a CSS color
// through to a browser (PDF), and for text halo contrast. Mark colors may be any color a browser reads;
// this covers hex (with or without alpha), rgb(), hsl(), and the named
// colors. It is separate from the lenient light/dark color reader so that
// charts without text halos or PDF output do not carry its parser and names.

const NAMES =
  "aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff " +
  "beige f5f5dc bisque ffe4c4 black 000000 blanchedalmond ffebcd blue 0000ff " +
  "blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0 chartreuse 7fff00 " +
  "chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c " +
  "cyan 00ffff darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 " +
  "darkgreen 006400 darkgrey a9a9a9 darkkhaki bdb76b darkmagenta 8b008b darkolivegreen 556b2f " +
  "darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a darkseagreen 8fbc8f " +
  "darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1 " +
  "darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 " +
  "dodgerblue 1e90ff firebrick b22222 floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff " +
  "gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520 gray 808080 green 008000 " +
  "greenyellow adff2f grey 808080 honeydew f0fff0 hotpink ff69b4 indianred cd5c5c " +
  "indigo 4b0082 ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 " +
  "lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6 lightcoral f08080 lightcyan e0ffff " +
  "lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgreen 90ee90 lightgrey d3d3d3 " +
  "lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa " +
  "lightslategray 778899 lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 " +
  "lime 00ff00 limegreen 32cd32 linen faf0e6 magenta ff00ff maroon 800000 " +
  "mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db " +
  "mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a " +
  "mediumturquoise 48d1cc mediumvioletred c71585 midnightblue 191970 mintcream f5fffa " +
  "mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6 " +
  "olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 " +
  "palegoldenrod eee8aa palegreen 98fb98 paleturquoise afeeee palevioletred db7093 " +
  "papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd powderblue b0e0e6 " +
  "purple 800080 rebeccapurple 663399 red ff0000 rosybrown bc8f8f royalblue 4169e1 " +
  "saddlebrown 8b4513 salmon fa8072 sandybrown f4a460 seagreen 2e8b57 seashell fff5ee " +
  "sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd slategray 708090 " +
  "slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 " +
  "thistle d8bfd8 tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff " +
  "whitesmoke f5f5f5 yellow ffff00 yellowgreen 9acd32";

let names: Map<string, string> | undefined;

/** The hex color a CSS color name such as "yellow" names; undefined for other colors. */
export function named(name: string): string | undefined {
  if (!names) {
    names = new Map();
    const parts = NAMES.split(" ");
    for (let i = 0; i < parts.length; i += 2) names.set(parts[i]!, `#${parts[i + 1]}`);
  }
  return names.get(name);
}

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/;

/** A CSS number, or a percentage of `scale`; NaN for other syntax. */
function amount(part: string, scale: number): number {
  const percent = part.endsWith("%");
  const text = percent ? part.slice(0, -1) : part;
  if (!NUMBER.test(text)) return Number.NaN;
  return percent ? (Number(text) / 100) * scale : Number(text);
}

const DEGREES: Record<string, number> = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };

/** A CSS hue in degrees, from 0 up to 360; NaN for other syntax. */
function hue(part: string): number {
  const [, text, unit] = /^(.*?)(deg|grad|rad|turn)?$/.exec(part)!;
  if (!NUMBER.test(text!)) return Number.NaN;
  const degrees = Number(text) * (unit ? DEGREES[unit]! : 1);
  return ((degrees % 360) + 360) % 360;
}

/** Out-of-range values are clamped, as CSS does. */
function clamp(value: number, max: number): number {
  return Math.min(max, Math.max(0, value));
}

/**
 * Red, green, and blue from 0 to 255 and alpha from 0 to 1, or undefined for
 * syntax this does not read (such as `var()` or `color-mix()`).
 */
export function cssColor(color: string): [number, number, number, number] | undefined {
  const c = color.trim().toLowerCase();
  if (c === "transparent") return [0, 0, 0, 0];
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(named(c) ?? c)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const channel = (i: number) => Number.parseInt(full.slice(i * 2, i * 2 + 2), 16);
    return [channel(0), channel(1), channel(2), full.length === 8 ? channel(3) / 255 : 1];
  }
  const match = /^(rgb|hsl)a?\(([^)]*)\)$/.exec(c);
  if (!match) return undefined;
  const parts = match[2]!.split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return undefined;
  const alpha = clamp(parts[3] === undefined ? 1 : amount(parts[3], 1), 1);
  let rgb: number[];
  if (match[1] === "rgb") {
    rgb = parts.slice(0, 3).map((part) => clamp(amount(part, 255), 255));
  } else {
    // Saturation and lightness are percentages, with or without the sign.
    const h = hue(parts[0]!);
    const s = clamp(amount(parts[1]!, 100) / 100, 1);
    const l = clamp(amount(parts[2]!, 100) / 100, 1);
    // HSL to RGB, per CSS Color 4.
    rgb = [0, 8, 4].map((n) => {
      const k = (n + h / 30) % 12;
      return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
    });
  }
  const [r, g, b] = rgb as [number, number, number];
  return [r, g, b, alpha].every(Number.isFinite) ? [r, g, b, alpha] : undefined;
}
