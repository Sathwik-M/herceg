// What series stand for where the chart's options say more than the core's
// default (model/identity.ts: a series field's values, or value fields): a
// scale they are colored through, declared in `scales` (by a channel naming
// it, or "color" for every mark when the chart declares it), and lines and
// areas colored by a field other than their series field, which stand for
// that field's values. Marks coloring rows by such a field (bars with
// `series: false`, points) keep their series' identities, and their rows
// take that field's colors (`rows`).

import type { Mark } from "../mark.ts";

/** What a mark's series and rows stand for, as prefixes of identity keys. */
export interface MarkScope {
  /** What the series' colors and legend entries follow. */
  readonly color: string;
  /** The declared scale the series' colors follow, if any. */
  readonly scale?: string | undefined;
  /** The option naming `scale` (`encode.stroke.scale`); undefined for the chart's "color". */
  readonly option?: string | undefined;
  /** What the colors of rows follow, for marks coloring rows by another field. */
  readonly rows?: string | undefined;
  /** What marks dodging by the same field place series by. */
  readonly partition?: string | undefined;
  /** The series stand for their names through a scale (`{ series: true, scale }`). */
  readonly named?: boolean | undefined;
  /** The field whose values color the series or rows, which a declared scale reads. */
  readonly field?: string | undefined;
}

/** The prefix of identity keys of a scale's values. */
export function scalePrefix(scale: string): string {
  return `${JSON.stringify({ scale }).slice(0, -1)},"value":`;
}

/**
 * A mark's scope, from what the core gives its series (`own`, undefined
 * for marks whose series stand for nothing) and the prefix of a field's
 * values in its table (`by`).
 */
export function scopeOfMark(
  mark: Mark,
  own: string | undefined,
  by: (field: string) => string,
  declared: boolean,
): MarkScope | undefined {
  const identity = mark.identity;
  if (own === undefined || !identity || !mark.table) return undefined;
  const field = identity.field;
  type Channel = { field?: string; scale?: string; series?: boolean };
  const spec = mark.spec as {
    color?: string;
    stroke?: string;
    fill?: string;
    encode?: { color?: Channel; stroke?: Channel; fill?: Channel };
  };
  const { encode } = spec;
  // What paints the series: the mark's own paint (a line's stroke, an area's
  // or bar's fill), flat or as a channel, wins over its color.
  const { type } = mark.spec;
  const primary =
    type === "line" ? "stroke" : type === "area" || type === "bar" ? "fill" : undefined;
  const painted = primary !== undefined && spec[primary] !== undefined;
  // Series named through a scale stand for their names whatever paints them.
  const named = encode?.color?.series ? encode.color : undefined;
  const paint = named ?? ((primary && encode?.[primary]) || encode?.color);
  const channel = painted && !named ? undefined : paint;
  const color = named || painted || (primary && encode?.[primary]) ? undefined : spec.color;
  const scale = channel?.scale ?? (declared ? "color" : undefined);
  const option =
    channel?.scale === undefined
      ? undefined
      : `encode.${channel === encode?.color ? "color" : primary}.scale`;
  const scaled = scale === undefined ? undefined : scalePrefix(scale);
  const colored =
    channel?.field ?? (color !== undefined && mark.table.has(color) ? color : undefined);
  const partition = channel?.series ? scaled : field === undefined ? undefined : own;
  if (colored === undefined || colored === field) {
    const named = channel?.series;
    return {
      color: scaled ?? own,
      scale,
      option,
      partition,
      named,
      field: named ? undefined : field,
    };
  }
  // Lines and areas take one color per series; other marks color each row.
  const connected = mark.spec.type === "line" || mark.spec.type === "area";
  return connected
    ? { color: scaled ?? by(colored), scale, option, partition, field: colored }
    : { color: own, rows: scaled ?? by(colored), partition, field: colored };
}
