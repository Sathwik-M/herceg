// Halos of marks' labels, resolved with the CSS color table, which only
// marks that draw labels over data carry (see draw/text.ts for drawing them).

import { cssColor } from "../scale/css-color.ts";
import type { Halo } from "../spec/style.ts";
import { haloOf, type ResolvedHalo } from "../style/style.ts";
import type { Theme } from "../theme.ts";

/**
 * The halo that keeps a mark's labels colored `fill` readable over lines
 * and fills, as the mark's `halo` asks ("auto" when left out; see
 * `haloOf`), over what its frame draws on: the plot's fill, or the chart's
 * background. Colors given by name are read with the CSS color table.
 */
export function labelHalo(
  halo: Halo | undefined,
  fill: string,
  frame: { theme: Theme; surface?: string | undefined },
): ResolvedHalo | undefined {
  const { theme } = frame;
  return haloOf(halo ?? "auto", fill, frame.surface ?? theme.background, theme.text, cssColor);
}
