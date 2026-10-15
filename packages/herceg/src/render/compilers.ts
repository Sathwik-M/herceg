// The compilers static output draws with: what a live chart loads when its
// options need it, imported here, since static output is drawn at once.

import { guideCompiler } from "../guides/compile.ts";
import { featureCompiler } from "../marks/features/compile.ts";
import type { FeatureCompiler } from "../model/features.ts";
import { GUIDE_KIT, type GuideCompiler } from "../model/guides.ts";
import { cssColor } from "../scale/css-color.ts";

let made: [GuideCompiler, FeatureCompiler] | undefined;

/**
 * Colors static output reads: hex, `rgb()`, `hsl()`, and CSS's names, which
 * it can draw in PDF, and other functions (`color-mix()`, `var()`) and
 * `currentColor`, which SVG passes on.
 */
const isColor = (value: string) =>
  cssColor(value) !== undefined ||
  /^[a-z-]+\(.*\)$/i.test(value.trim()) ||
  value === "currentColor";

/** The guide compiler and the feature compiler, made on first use. */
export function staticCompilers(): [GuideCompiler, FeatureCompiler] {
  made ??= [guideCompiler(GUIDE_KIT), featureCompiler({ ...GUIDE_KIT, isColor })];
  return made;
}
