// The TypeScript forms of marks' encoding options: the portable types of
// spec/encoding.ts with field names checked against the table's schema and
// expressions built with `col`. Types only; the feature compiler reads the
// specs these become (see model/features.ts).

import type { Expr } from "../data/expr.ts";
import type { Expression } from "../data/expression.ts";
import type { CategoryField, Schema } from "../data/table.ts";
import type {
  BarLabelPlaceSpec,
  CalendarBreak,
  MarkerStyle,
  SeriesStyle,
  SymbolName,
} from "../spec/encoding.ts";
import type { FormatSpec } from "../spec/guides.ts";
import type { Dash } from "../spec/spec.ts";
import type { StrokeStyle, TextStyle } from "../spec/style.ts";

/** An expression: one built with `col`, or its JSON form. */
export type Condition = Expr<"boolean"> | Expression;

/** A CSS color: hex, `rgb()`, `hsl()`, a variable, or a name. */
export type CssColor =
  | `#${string}`
  | `rgb${string}`
  | `hsl${string}`
  | `var(${string})`
  | "transparent"
  | "currentColor"
  | NamedColor;

/**
 * A channel: a category field's values through a scale (`scale` names one of
 * the chart's `scales`; colors take "color" by default), a constant, or a
 * condition on each row.
 */
export type Channel<V, S extends Schema> =
  | { field: CategoryField<S>; scale?: string }
  | { value: V }
  | { condition: { when: Condition; then: V; otherwise: V } };

/** A mark's channels (each mark takes those it draws). */
export interface Encodings<S extends Schema> {
  color?: Channel<string, S>;
  fill?: Channel<string, S>;
  stroke?: Channel<string, S>;
  dash?: Channel<Dash, S>;
  symbol?: Channel<SymbolName, S>;
  strokeWidth?: Channel<number, S>;
  size?: Channel<number, S>;
  opacity?: Channel<number, S>;
}

/** Looks by value: by a field's value, or without `field`, by series (see `StyleMapSpec`). */
export interface StyleMap<S extends Schema> {
  field?: CategoryField<S>;
  map: Readonly<Record<string, SeriesStyle>>;
}

/** How a mark's parts look, and looks mapped by value (see `MarkStyleSpec`). */
export interface MarkStyle<S extends Schema> {
  by?: StyleMap<S>;
  marker?: MarkerStyle;
  leader?: StrokeStyle;
}

/** Which observations a line or area connects (see `ContinuitySpec`). */
export interface Continuity<S extends Schema> {
  defined?: Condition;
  maxGap?: number | { milliseconds: number };
  breakBy?: CalendarBreak | { field: CategoryField<S> };
}

/** A bar's value label (see `BarLabelsSpec`). */
export interface BarLabels<S extends Schema> {
  field?: CategoryField<S> | string;
  format?: FormatSpec;
  style?: TextStyle;
  minLength?: number;
  place?: BarLabelPlaceSpec;
}

/** CSS's named colors. */
export type NamedColor =
  | "aliceblue"
  | "antiquewhite"
  | "aqua"
  | "aquamarine"
  | "azure"
  | "beige"
  | "bisque"
  | "black"
  | "blanchedalmond"
  | "blue"
  | "blueviolet"
  | "brown"
  | "burlywood"
  | "cadetblue"
  | "chartreuse"
  | "chocolate"
  | "coral"
  | "cornflowerblue"
  | "cornsilk"
  | "crimson"
  | "cyan"
  | "darkblue"
  | "darkcyan"
  | "darkgoldenrod"
  | "darkgray"
  | "darkgreen"
  | "darkgrey"
  | "darkkhaki"
  | "darkmagenta"
  | "darkolivegreen"
  | "darkorange"
  | "darkorchid"
  | "darkred"
  | "darksalmon"
  | "darkseagreen"
  | "darkslateblue"
  | "darkslategray"
  | "darkslategrey"
  | "darkturquoise"
  | "darkviolet"
  | "deeppink"
  | "deepskyblue"
  | "dimgray"
  | "dimgrey"
  | "dodgerblue"
  | "firebrick"
  | "floralwhite"
  | "forestgreen"
  | "fuchsia"
  | "gainsboro"
  | "ghostwhite"
  | "gold"
  | "goldenrod"
  | "gray"
  | "green"
  | "greenyellow"
  | "grey"
  | "honeydew"
  | "hotpink"
  | "indianred"
  | "indigo"
  | "ivory"
  | "khaki"
  | "lavender"
  | "lavenderblush"
  | "lawngreen"
  | "lemonchiffon"
  | "lightblue"
  | "lightcoral"
  | "lightcyan"
  | "lightgoldenrodyellow"
  | "lightgray"
  | "lightgreen"
  | "lightgrey"
  | "lightpink"
  | "lightsalmon"
  | "lightseagreen"
  | "lightskyblue"
  | "lightslategray"
  | "lightslategrey"
  | "lightsteelblue"
  | "lightyellow"
  | "lime"
  | "limegreen"
  | "linen"
  | "magenta"
  | "maroon"
  | "mediumaquamarine"
  | "mediumblue"
  | "mediumorchid"
  | "mediumpurple"
  | "mediumseagreen"
  | "mediumslateblue"
  | "mediumspringgreen"
  | "mediumturquoise"
  | "mediumvioletred"
  | "midnightblue"
  | "mintcream"
  | "mistyrose"
  | "moccasin"
  | "navajowhite"
  | "navy"
  | "oldlace"
  | "olive"
  | "olivedrab"
  | "orange"
  | "orangered"
  | "orchid"
  | "palegoldenrod"
  | "palegreen"
  | "paleturquoise"
  | "palevioletred"
  | "papayawhip"
  | "peachpuff"
  | "peru"
  | "pink"
  | "plum"
  | "powderblue"
  | "purple"
  | "rebeccapurple"
  | "red"
  | "rosybrown"
  | "royalblue"
  | "saddlebrown"
  | "salmon"
  | "sandybrown"
  | "seagreen"
  | "seashell"
  | "sienna"
  | "silver"
  | "skyblue"
  | "slateblue"
  | "slategray"
  | "slategrey"
  | "snow"
  | "springgreen"
  | "steelblue"
  | "tan"
  | "teal"
  | "thistle"
  | "tomato"
  | "turquoise"
  | "violet"
  | "wheat"
  | "white"
  | "whitesmoke"
  | "yellow"
  | "yellowgreen";
