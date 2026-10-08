import type { NumericField, Schema, Table } from "../data/table.ts";
import { ruleDrawing } from "../draw/rule.ts";
import type { RuleGeometry } from "../scene/scene.ts";
import type { RuleSpec } from "../spec/spec.ts";
import { AnnotationData, position, readsTable, type TextField, valueAt } from "./annotation.ts";
import { definedFields } from "./line.ts";
import type { AxisFormat, Frame, Mark, MarkKey } from "./mark.ts";

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
export interface RuleOptions extends RuleStyle {
  x?: number | Date;
  y?: number | Date;
}

/** Rules from a table, one per row; positions may also be constants. */
export interface RuleDataOptions<S extends Schema> extends RuleStyle {
  x?: NumericField<S> | number | Date;
  y?: NumericField<S> | number | Date;
  /** Field with each rule's text. */
  text?: TextField<S>;
}

/**
 * Reference lines. Their values are included in the axis domain so
 * thresholds and events stay visible.
 */
export class RuleMark implements Mark<RuleSpec> {
  readonly spec: RuleSpec;
  readonly tooltip = "x";
  readonly #data: AnnotationData;

  constructor(spec: RuleSpec, table?: Table) {
    this.spec = spec;
    if ((spec.x === undefined) === (spec.y === undefined))
      throw new Error("A rule needs exactly one of x or y");
    this.#data = new AnnotationData(table, { x: spec.x, y: spec.y }, spec.label, spec.text, "rule");
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

  describe(format: AxisFormat, locale: string | undefined): string | undefined {
    const vertical = this.spec.x !== undefined;
    const channel = this.#data.channel(vertical ? this.spec.x! : this.spec.y!);
    const f = vertical ? format.x : format.y;
    return this.#data.summary(["Rule", "Rules"], locale, (i) => {
      const value = valueAt(channel, i);
      return Number.isFinite(value) ? `${vertical ? "x" : "y"} ${f(value)}` : undefined;
    });
  }

  xExtent(_series: unknown, log: boolean): [number, number] | undefined {
    return this.#data.extent([this.spec.x], log);
  }

  yExtent(_series: unknown, _x0: number, _x1: number, log: boolean): [number, number] | undefined {
    return this.#data.extent([this.spec.y], log);
  }

  geometry(_series: unknown, frame: Frame, key: MarkKey): RuleGeometry[] {
    const { spec } = this;
    const { plot } = frame;
    const vertical = spec.x !== undefined;
    const scale = vertical ? frame.x : frame.y;
    const channel = this.#data.channel(vertical ? spec.x! : spec.y!);
    const lo = Math.min(scale.domain[0], scale.domain[1]);
    const hi = Math.max(scale.domain[0], scale.domain[1]);
    const out: RuleGeometry[] = [];
    for (let i = 0; i < this.#data.count; i++) {
      const value = valueAt(channel, i);
      // Rules are drawn unclipped, so ones outside the visible range are skipped.
      if (!(value >= lo && value <= hi)) continue;
      const at = scale.map(value);
      if (!Number.isFinite(at)) continue;
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
    }
    return out;
  }
}

/**
 * Horizontal rules at `y` or vertical rules at `x`: one at a constant value,
 * or one per row of a table.
 *
 * ```ts
 * rule({ y: 250, label: "SLO" })
 * rule(deploys, { x: "time", text: "version" })
 * ```
 */
export function rule(options: RuleOptions): RuleMark;
export function rule<S extends Schema>(table: Table<S>, options: RuleDataOptions<S>): RuleMark;
export function rule<S extends Schema>(
  first: Table<S> | RuleOptions,
  second?: RuleDataOptions<S>,
): RuleMark {
  const table = second ? (first as Table<S>) : undefined;
  const options = (second ?? first) as RuleDataOptions<S>;
  const spec: RuleSpec = {
    type: "rule",
    ...(definedFields(
      {
        ...options,
        x: position(options.x),
        y: position(options.y),
        dash: options.dash && [...options.dash],
      },
      ["id", "x", "y", "stroke", "strokeWidth", "dash", "label", "text", "axis", "facet", "panel"],
    ) as Omit<RuleSpec, "type">),
  };
  if (table?.name !== undefined && readsTable([spec.x, spec.y], spec.text)) spec.data = table.name;
  return new RuleMark(spec, table as unknown as Table | undefined);
}
