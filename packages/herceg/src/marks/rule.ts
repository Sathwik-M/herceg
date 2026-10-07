import type { RuleGeometry } from "../scene/scene.ts";
import type { RuleSpec } from "../spec/spec.ts";
import { definedFields } from "./line.ts";
import type { Frame, Mark } from "./mark.ts";

export type RuleOptions = Omit<RuleSpec, "type">;

/**
 * A reference line at a constant value. Its value is included in the axis
 * domain so thresholds stay visible.
 */
export class RuleMark implements Mark<RuleSpec> {
  readonly spec: RuleSpec;
  readonly table = undefined;
  readonly zero = false;
  readonly tooltip = "x";

  constructor(spec: RuleSpec) {
    this.spec = spec;
    if ((spec.x === undefined) === (spec.y === undefined))
      throw new Error("A rule needs exactly one of x or y");
  }

  channelKind() {
    return undefined;
  }

  series() {
    return [];
  }

  xExtent(): [number, number] | undefined {
    return this.spec.x === undefined ? undefined : [this.spec.x, this.spec.x];
  }

  yExtent(): [number, number] | undefined {
    return this.spec.y === undefined ? undefined : [this.spec.y, this.spec.y];
  }

  geometry(_series: unknown, frame: Frame): RuleGeometry[] {
    const { spec } = this;
    const { plot } = frame;
    const vertical = spec.x !== undefined;
    const value = vertical ? spec.x! : spec.y!;
    const [d0, d1] = (vertical ? frame.x : frame.y).domain;
    // Rules are drawn unclipped, so ones outside the visible range are skipped.
    if (!(value >= Math.min(d0, d1) && value <= Math.max(d0, d1))) return [];
    const at = vertical ? frame.x.map(value) : frame.y.map(value);
    if (!Number.isFinite(at)) return [];
    return [
      {
        kind: "rule",
        key: spec.id ?? `rule:${vertical ? "x" : "y"}:${vertical ? spec.x : spec.y}`,
        stroke: spec.stroke ?? frame.theme.muted,
        strokeWidth: spec.strokeWidth ?? 1,
        dash: spec.dash ?? [4, 4],
        x1: vertical ? at : plot.x,
        x2: vertical ? at : plot.x + plot.width,
        y1: vertical ? plot.y : at,
        y2: vertical ? plot.y + plot.height : at,
        label: spec.label,
      },
    ];
  }
}

/** A horizontal rule at `y` or a vertical rule at `x` (time values in epoch ms). */
export function rule(options: RuleOptions): RuleMark {
  return new RuleMark({
    type: "rule",
    ...definedFields(options, ["id", "x", "y", "stroke", "strokeWidth", "dash", "label"]),
  });
}
