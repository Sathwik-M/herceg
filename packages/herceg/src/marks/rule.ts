import type { NumericField, Schema, Table } from "../data/table.ts";
import { ruleDrawing } from "../draw/rule.ts";
import type { MeasureText } from "../layout/text.ts";
import type { CompiledFeatures } from "../model/features.ts";
import type { Geometry, RuleGeometry } from "../scene/scene.ts";
import type { LabelPlaceSpec, LabelSpec } from "../spec/encoding.ts";
import type { Coordinate } from "../spec/place.ts";
import type {
  AnnotationPosition,
  Clip,
  Dash,
  Frozen,
  RulePosition,
  RuleSpec,
} from "../spec/spec.ts";
import type { TextStyle } from "../spec/style.ts";
import { dashPattern } from "../style/style.ts";
import type { Theme } from "../theme.ts";
import {
  AnnotationData,
  type Label,
  labelOf,
  type PlaceOption,
  position,
  readsTable,
  type TextField,
  valueAt,
} from "./annotation.ts";
import { labelPaint, labelsGeometry, type PlacedLabel } from "./labels.ts";
import { definedFields } from "./line.ts";
import type { AxisFormat, ChartMark, Frame, MARK, Mark, MarkKey, RowParts } from "./mark.ts";
import { frozen } from "./mark.ts";

/** A rule's label: its text, or each row's `field`; where it goes and how it looks. */
export type RuleLabel<F extends string = string> =
  | string
  | (({ text: string; field?: never } | { field: F; text?: never }) & {
      format?: LabelSpec["format"];
      style?: TextStyle;
      place?: LabelPlaceSpec;
    });

interface RuleStyle {
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** What the rules are cut to: "plot", "chart", or false (the default: rules outside the plot are left out). */
  clip?: Clip;
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  stroke?: string;
  strokeWidth?: number;
  /** Pixel dash array, or a matplotlib style scaled by strokeWidth (default 1). */
  dash?: Dash;
  /** From 0 to 1. */
  strokeOpacity?: number;
  /** Where along the other axis the rule runs; the plot's whole extent by default. */
  span?: readonly [Coordinate, Coordinate];
  /** Whether the rule's value counts toward its axis' domain; false by default. */
  contributeDomain?: boolean;
  id?: string;
}

/** A rule at a constant place: `y` for a horizontal rule, `x` for a vertical one. */
export type RuleOptions = RuleStyle &
  RulePosition<PlaceOption<never>> & {
    /** Text drawn by the rule: its text, or a label object (place, style). */
    label?: RuleLabel<never>;
  };

/** Rules from a table, one per row; places may also be constants. */
export type RuleDataOptions<S extends Schema> = RuleStyle &
  RulePosition<PlaceOption<NumericField<S>>> & {
    /** Text drawn by every rule: constant, or each row's `field`. */
    label?: RuleLabel<TextField<S>>;
  };

/** Why a rule spec has no single position, if it has neither or both of x and y. */
export function ruleFormError(spec: { x?: unknown; y?: unknown }): string | undefined {
  return (spec.x === undefined) === (spec.y === undefined)
    ? "rule: needs exactly one of x and y"
    : undefined;
}

/** Pixels between a rule and its label, and between an outside label and the axis' labels. */
const LABEL_GAP = 4;

/**
 * Reference lines, horizontal at `y` or vertical at `x`, across the plot or
 * along `span`. Their values count toward the axis domain when they say so
 * (`contributeDomain`), so thresholds meant to show stay in view.
 */
export class RuleMark implements Mark<Frozen<RuleSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<RuleSpec>;
  readonly tooltip = "x";
  readonly featured: boolean;
  readonly domainFallback: boolean;
  readonly #data: AnnotationData;
  /** The label drawn as rules always draw theirs: plain text, in the default place. */
  readonly #plain: boolean;

  constructor(input: RuleSpec, table?: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    this.domainFallback = spec.contributeDomain !== true;
    const problem = ruleFormError(spec);
    if (problem) throw new Error(problem);
    const label = labelOf(spec.label);
    const [from, to] = spec.span ?? [];
    this.#data = new AnnotationData(
      table,
      { x: spec.x, y: spec.y, "span[0]": from, "span[1]": to },
      label,
      "rule",
      { x: "x", y: spec.axis === "right" ? "yRight" : "y" },
      spec.x !== undefined ? "y" : "x",
    );
    this.#plain =
      typeof spec.label === "string" ||
      (label !== undefined && !label.style && !label.place && !label.format);
    const format = label?.format as { number?: unknown; time?: unknown } | undefined;
    this.featured = format?.number !== undefined || format?.time !== undefined;
    const vertical = spec.x !== undefined;
    const place = label?.place;
    if (place?.outside && place.attachment === "center")
      throw new Error(
        `rule label.place: a label outside the plot goes at the rule's start or end; give attachment "start" or "end"`,
      );
    if (vertical && place?.outside && place.reserve)
      throw new Error(
        "rule label.place.reserve: room is kept beside the plots, for horizontal rules' labels; drop reserve",
      );
    if (spec.strokeOpacity !== undefined && !(spec.strokeOpacity >= 0 && spec.strokeOpacity <= 1))
      throw new RangeError(
        `rule strokeOpacity: expected a number from 0 to 1; received ${spec.strokeOpacity}`,
      );
  }

  get table(): Table | undefined {
    return this.#data.table;
  }

  channelKind(axis: "x" | "y") {
    const own = axis === "x" ? this.spec.x : this.spec.y;
    // Along the other axis, a span of fields says what that axis holds.
    if (own !== undefined) return this.#data.kind(own);
    const [from, to] = this.spec.span ?? [];
    return this.#data.kind(from) ?? this.#data.kind(to);
  }

  series() {
    return [];
  }

  describe(format: AxisFormat, locale: string | undefined, rows?: RowParts): string | undefined {
    const vertical = this.spec.x !== undefined;
    const place = this.#data.place(vertical ? this.spec.x! : this.spec.y!);
    const f = vertical ? format.x : format.y;
    return this.#data.summary(
      ["Rule", "Rules"],
      locale,
      (i) => {
        if (place.kind === "category") return `${vertical ? "x" : "y"} ${place.value}`;
        if (place.kind !== "value")
          return place.kind === "frame" ? (vertical ? "x" : "y") : undefined;
        const value = valueAt(place.channel, i);
        return Number.isFinite(value) ? `${vertical ? "x" : "y"} ${f(value)}` : undefined;
      },
      rows,
    );
  }

  /** A rule's place on its axis, and its span's on the other. */
  #along(axis: "x" | "y"): readonly (Frozen<AnnotationPosition> | undefined)[] {
    const own = axis === "x" ? this.spec.x : this.spec.y;
    return own !== undefined ? [own] : (this.spec.span ?? []);
  }

  xExtent(_series: unknown, log: boolean, _breaks?: unknown, rows?: RowParts) {
    return this.#data.extent(this.#along("x"), log, undefined, rows);
  }

  yExtent(
    _series: unknown,
    _x0: number,
    _x1: number,
    log: boolean,
    _breaks?: unknown,
    rows?: RowParts,
  ) {
    return this.#data.extent(this.#along("y"), log, undefined, rows);
  }

  /** The labels' paint: muted text, the label's style over it. */
  #paint(theme: Theme) {
    return labelPaint(theme, theme.muted, this.#data.label?.style);
  }

  /**
   * Room the rules' labels outside the plot keep beside it, in pixels: the
   * widest label at each side's end of horizontal rules.
   */
  room(
    measure: MeasureText,
    theme: Theme,
    locale: string | undefined,
    features: CompiledFeatures | undefined,
  ): [number, number] {
    const label = this.#data.label;
    const place = label?.place;
    if (!label || this.spec.y === undefined || !place?.outside || place.reserve === false)
      return [0, 0];
    // As the labels are drawn: written by their format, in their boxes, moved by their offset.
    const paint = this.#paint(theme);
    const write = this.#data.writer(locale, features?.of(this)?.format);
    let widest = 0;
    this.#data.each(undefined, (i) => {
      widest = Math.max(widest, measure(this.#data.text(i, locale, write), paint.css));
    });
    const [, right, , left] = paint.background ? paint.padding : [0, 0, 0, 0];
    const room = Math.ceil(widest + left + right + (place.offset ?? 0));
    return (place.attachment ?? "end") === "end" ? [0, room] : [room, 0];
  }

  geometry(_series: unknown, frame: Frame, key: MarkKey, rows?: RowParts): Geometry[] {
    const { spec } = this;
    const { plot } = frame;
    const data = this.#data;
    const vertical = spec.x !== undefined;
    const scale = vertical ? frame.x : frame.y;
    const place = data.place(vertical ? spec.x! : spec.y!);
    const across = vertical ? frame.y : frame.x;
    const span = spec.span?.map((c) => data.place(c));
    const strokeWidth = spec.strokeWidth ?? 1;
    const dash = dashPattern(spec.dash, strokeWidth) ?? [4, 4];
    const label = data.label;
    const write = data.writer(frame.locale, frame.features?.of(this)?.format);
    const out: Geometry[] = [];
    const placed: PlacedLabel[] = [];
    const [lo, hi] = vertical ? [plot.y, plot.y + plot.height] : [plot.x, plot.x + plot.width];
    data.each(rows, (i) => {
      const at = data.pixel(place, vertical ? "x" : "y", i, scale, frame);
      // Rules are drawn unclipped, so ones outside the plot are skipped.
      const [start, end] = vertical
        ? [plot.x, plot.x + plot.width]
        : [plot.y, plot.y + plot.height];
      if (at === undefined || at < start - 0.5 || at > end + 0.5) return;
      let a = lo;
      let b = hi;
      if (span) {
        const p = data.pixel(span[0]!, vertical ? "y" : "x", i, across, frame);
        const q = data.pixel(span[1]!, vertical ? "y" : "x", i, across, frame);
        if (p === undefined || q === undefined) return;
        [a, b] = [Math.min(p, q), Math.max(p, q)];
      }
      const text = label ? data.text(i, frame.locale, write) : undefined;
      const rule: RuleGeometry = {
        kind: "rule",
        draw: ruleDrawing,
        key: `${JSON.stringify(key)}:${i}`,
        stroke: spec.stroke ?? frame.theme.muted,
        strokeWidth,
        dash,
        x1: vertical ? at : a,
        x2: vertical ? at : b,
        y1: vertical ? a : at,
        y2: vertical ? b : at,
        label: this.#plain ? text : undefined,
      };
      if (spec.strokeOpacity !== undefined) rule.opacity = spec.strokeOpacity;
      out.push(rule);
      if (text && !this.#plain) placed.push(this.#place(text, rule, frame));
    });
    if (placed.length > 0)
      out.push(
        labelsGeometry(
          `${JSON.stringify(key)}|labels`,
          placed,
          this.#paint(frame.theme),
          label?.style?.halo ?? false,
          frame,
        ),
      );
    return out;
  }

  /**
   * Where a rule's label goes: at the rule's start, middle, or end (left to
   * right, top to bottom), above a horizontal rule and beside a vertical
   * one; outside, beyond the axis' labels at that end of the plot.
   */
  #place(text: string, rule: RuleGeometry, frame: Frame): PlacedLabel {
    const place: Frozen<LabelPlaceSpec> = this.#data.label?.place ?? {};
    const vertical = rule.x1 === rule.x2;
    const attachment = place.attachment ?? (vertical ? "start" : "end");
    const offset = place.offset ?? 0;
    const size = this.#paint(frame.theme).size;
    if (vertical) {
      const x = rule.x1;
      if (place.outside)
        return attachment === "start"
          ? {
              text,
              x,
              y: frame.plot.y - LABEL_GAP - offset - size / 2,
              anchor: "middle",
              baseline: "middle",
            }
          : {
              text,
              x,
              y: frame.plot.y + frame.plot.height + LABEL_GAP + offset,
              anchor: "middle",
              baseline: "hanging",
            };
      const y =
        attachment === "start"
          ? rule.y1 + LABEL_GAP + offset + size / 2
          : attachment === "end"
            ? rule.y2 - LABEL_GAP - offset - size / 2
            : (rule.y1 + rule.y2) / 2;
      return { text, x: x + LABEL_GAP, y, anchor: "start", baseline: "middle" };
    }
    const y = rule.y1;
    if (place.outside) {
      // Right-aligned where the labels left of the plot end, or from where those right of it start.
      const edges = frame.outside;
      return attachment === "start"
        ? {
            text,
            x: (edges?.[0] ?? frame.plot.x - LABEL_GAP) - offset,
            y,
            anchor: "end",
            baseline: "middle",
          }
        : {
            text,
            x: (edges?.[1] ?? frame.plot.x + frame.plot.width + LABEL_GAP) + offset,
            y,
            anchor: "start",
            baseline: "middle",
          };
    }
    const above = y - LABEL_GAP - offset - size / 2;
    return attachment === "start"
      ? { text, x: rule.x1 + LABEL_GAP, y: above, anchor: "start", baseline: "middle" }
      : attachment === "end"
        ? { text, x: rule.x2 - LABEL_GAP, y: above, anchor: "end", baseline: "middle" }
        : { text, x: (rule.x1 + rule.x2) / 2, y: above, anchor: "middle", baseline: "middle" };
  }
}

/** A label option as specs take it: plain text stays a string. */
function labelSpec(label: RuleLabel | undefined): string | LabelSpec | undefined {
  return label as string | LabelSpec | undefined;
}

/**
 * Horizontal rules at `y` or vertical rules at `x`: one at a constant value,
 * or one per row of a table.
 *
 * ```ts
 * rule({ y: 250, label: "SLO" })
 * rule({ y: 250, label: { text: "SLO", place: { attachment: "start", outside: true } } })
 * rule(deploys, { x: "time", label: { field: "version" } })
 * ```
 */
export function rule(options: RuleOptions): ChartMark<Frozen<RuleSpec>>;
export function rule<S extends Schema>(
  table: Table<S>,
  options: RuleDataOptions<S>,
): ChartMark<Frozen<RuleSpec>>;
export function rule<S extends Schema>(
  first: Table<S> | RuleOptions,
  second?: RuleDataOptions<S>,
): ChartMark<Frozen<RuleSpec>> {
  const table = second ? (first as Table<S>) : undefined;
  const options = (second ?? first) as RuleDataOptions<S>;
  const spec = {
    type: "rule",
    ...definedFields(
      {
        ...options,
        x: position(options.x),
        y: position(options.y),
        label: labelSpec(options.label as RuleLabel | undefined),
      },
      [
        "id",
        "x",
        "y",
        "stroke",
        "strokeWidth",
        "dash",
        "strokeOpacity",
        "span",
        "label",
        "contributeDomain",
        "axis",
        "facet",
        "panel",
        "clip",
      ],
    ),
  } as unknown as RuleSpec;
  const field = typeof spec.label === "object" ? spec.label.field : undefined;
  if (table?.name !== undefined && readsTable([spec.x, spec.y, ...(spec.span ?? [])], field))
    spec.data = table.name;
  return new RuleMark(spec, table as unknown as Table | undefined);
}

export type { Label };
