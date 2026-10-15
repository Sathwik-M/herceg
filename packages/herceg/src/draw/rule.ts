import type { Drawing, RuleGeometry } from "../scene/scene.ts";
import { dashAttribute, escapeXml, n } from "./markup.ts";

/**
 * Where a rule's label goes, on its alphabetic baseline: inside the top of
 * a vertical rule, above the right end of a horizontal one.
 */
export function ruleLabel(
  rule: RuleGeometry,
  fontSize: number,
): { x: number; y: number; anchor: "start" | "end" } {
  return rule.x1 === rule.x2
    ? { x: rule.x1 + 4, y: rule.y1 + fontSize, anchor: "start" }
    : { x: rule.x2 - 4, y: rule.y1 - 4, anchor: "end" };
}

/** Reference lines, with their label at the top (vertical) or right end (horizontal). */
export const ruleDrawing: Drawing<RuleGeometry> = {
  guide: true,
  size: () => 0,
  svg(rule, { theme }) {
    const opacity = rule.opacity === undefined ? "" : ` stroke-opacity="${rule.opacity}"`;
    let out = `<line x1="${n(rule.x1)}" y1="${n(rule.y1)}" x2="${n(rule.x2)}" y2="${n(rule.y2)}" stroke="${escapeXml(rule.stroke)}" stroke-width="${rule.strokeWidth}"${dashAttribute(rule.dash)}${opacity}/>`;
    if (rule.label) {
      const { x, y, anchor } = ruleLabel(rule, theme.fontSize);
      out += `<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" fill="${escapeXml(theme.muted)}">${escapeXml(rule.label)}</text>`;
    }
    return out;
  },
};
