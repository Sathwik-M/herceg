import type { Drawing, RuleGeometry } from "../scene/scene.ts";
import { dashAttribute, escapeXml, n } from "./markup.ts";

/** Reference lines, with their label at the top (vertical) or right end (horizontal). */
export const ruleDrawing: Drawing<RuleGeometry> = {
  guide: true,
  size: () => 0,
  svg(rule, { theme }) {
    let out = `<line x1="${n(rule.x1)}" y1="${n(rule.y1)}" x2="${n(rule.x2)}" y2="${n(rule.y2)}" stroke="${escapeXml(rule.stroke)}" stroke-width="${rule.strokeWidth}"${dashAttribute(rule.dash)}/>`;
    if (rule.label) {
      const vertical = rule.x1 === rule.x2;
      const x = vertical ? rule.x1 + 4 : rule.x2 - 4;
      const y = vertical ? rule.y1 + theme.fontSize : rule.y1 - 4;
      const anchor = vertical ? "start" : "end";
      out += `<text x="${n(x)}" y="${n(y)}" text-anchor="${anchor}" fill="${escapeXml(theme.muted)}">${escapeXml(rule.label)}</text>`;
    }
    return out;
  },
};
