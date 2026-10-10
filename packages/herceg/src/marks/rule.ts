import type { NumericField, Schema, Table } from "../data/table.ts";
import { ruleDrawing } from "../draw/rule.ts";
import type { RuleGeometry } from "../scene/scene.ts";
import type { Frozen, RulePosition, RuleSpec } from "../spec/spec.ts";
import { AnnotationData, position, readsTable, type TextField, valueAt } from "./annotation.ts";
import { definedFields } from "./line.ts";
import type { AxisFormat, ChartMark, Frame, MARK, Mark, MarkKey, RowParts } from "./mark.ts";
import { frozen } from "./mark.ts";

interface RuleStyle {
  /** The y axis the values are on: "left" (default) or "right", the chart's `yRight`. */
  axis?: "left" | "right";
  /** With the chart's `facet`, draw all rows in every panel instead of splitting them. */
  facet?: "repeat";
  /** With the chart's `panels`, the id of the panel to draw in, or "*" for every panel. */
  panel?: string;
  stroke?: string;
  strokeWidth?: number;
  dash?: readonly number[];
  /** Text drawn by every rule. */
  label?: string;
  id?: string;
}

/** A rule at a constant value: `y` for a horizontal rule, `x` for a vertical one. */
export type RuleOptions = RuleStyle & RulePosition<number | Date>;

/** Rules from a table, one per row; positions may also be constants. */
export type RuleDataOptions<S extends Schema> = RuleStyle &
  RulePosition<NumericField<S> | number | Date> & {
    /** Category or number field with each rule's text. */
    textField?: TextField<S>;
  };

/** Why a rule spec has no single position, if it has neither or both of x and y. */
export function ruleFormError(spec: { x?: unknown; y?: unknown }): string | undefined {
  return (spec.x === undefined) === (spec.y === undefined)
    ? "rule: needs exactly one of x and y"
    : undefined;
}

/**
 * Reference lines. Their values are included in the axis domain so
 * thresholds and events stay visible.
 */
export class RuleMark implements Mark<Frozen<RuleSpec>> {
  declare readonly [MARK]: true;
  readonly spec: Frozen<RuleSpec>;
  readonly tooltip = "x";
  readonly #data: AnnotationData;

  constructor(input: RuleSpec, table?: Table) {
    this.spec = frozen(input);
    // Read from the copy: the caller may change what it passed.
    const spec = this.spec;
    const problem = ruleFormError(spec);
    if (problem) throw new Error(problem);
    this.#data = new AnnotationData(
      table,
      { x: spec.x, y: spec.y },
      spec.label,
      spec.textField,
      "rule",
    );
  }

  get table(): Table | undefined {
    return this.#data.table;
  }

  channelKind(axis: "x" | "y") {
    return this.#data.kind(axis === "x" ? this.spec.x : this.spec.y);
  }

  series() {
    return [];
  }

  describe(format: AxisFormat, locale: string | undefined, rows?: RowParts): string | undefined {
    const vertical = this.spec.x !== undefined;
    const channel = this.#data.channel(vertical ? this.spec.x! : this.spec.y!);
    const f = vertical ? format.x : format.y;
    return this.#data.summary(
      ["Rule", "Rules"],
      locale,
      (i) => {
        const value = valueAt(channel, i);
        return Number.isFinite(value) ? `${vertical ? "x" : "y"} ${f(value)}` : undefined;
      },
      rows,
    );
  }

  xExtent(_series: unknown, log: boolean, _breaks?: unknown, rows?: RowParts) {
    return this.#data.extent([this.spec.x], log, undefined, rows);
  }

  yExtent(
    _series: unknown,
    _x0: number,
    _x1: number,
    log: boolean,
    _breaks?: unknown,
    rows?: RowParts,
  ) {
    return this.#data.extent([this.spec.y], log, undefined, rows);
  }

  geometry(_series: unknown, frame: Frame, key: MarkKey, rows?: RowParts): RuleGeometry[] {
    const { spec } = this;
    const { plot } = frame;
    const vertical = spec.x !== undefined;
    const scale = vertical ? frame.x : frame.y;
    const channel = this.#data.channel(vertical ? spec.x! : spec.y!);
    const lo = Math.min(scale.domain[0], scale.domain[1]);
    const hi = Math.max(scale.domain[0], scale.domain[1]);
    const out: RuleGeometry[] = [];
    this.#data.each(rows, (i) => {
      const value = valueAt(channel, i);
      // Rules are drawn unclipped, so ones outside the visible range are skipped.
      if (!(value >= lo && value <= hi)) return;
      const at = scale.map(value);
      if (!Number.isFinite(at)) return;
      out.push({
        kind: "rule",
        draw: ruleDrawing,
        key: `${JSON.stringify(key)}:${i}`,
        stroke: spec.stroke ?? frame.theme.muted,
        strokeWidth: spec.strokeWidth ?? 1,
        dash: spec.dash ?? [4, 4],
        x1: vertical ? at : plot.x,
        x2: vertical ? at : plot.x + plot.width,
        y1: vertical ? plot.y : at,
        y2: vertical ? plot.y + plot.height : at,
        label: this.#data.labeled ? this.#data.text(i, frame.locale) : undefined,
      });
    });
    return out;
  }
}

/**
 * Horizontal rules at `y` or vertical rules at `x`: one at a constant value,
 * or one per row of a table.
 *
 * ```ts
 * rule({ y: 250, label: "SLO" })
 * rule(deploys, { x: "time", textField: "version" })
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
        dash: options.dash && [...options.dash],
      },
      [
        "id",
        "x",
        "y",
        "stroke",
        "strokeWidth",
        "dash",
        "label",
        "textField",
        "axis",
        "facet",
        "panel",
      ],
    ),
  } as unknown as RuleSpec;
  if (table?.name !== undefined && readsTable([spec.x, spec.y], spec.textField))
    spec.data = table.name;
  return new RuleMark(spec, table as unknown as Table | undefined);
}
