// Fonts, imported as `herceg/fonts`: TrueType faces for charts to measure
// their text with and every output to draw it in. A separate entry point,
// so charts that use the viewer's fonts carry no font parser.

export {
  type FontOptions,
  type FontSource,
  type Fonts,
  prepareFonts,
} from "./fonts/registry.ts";
