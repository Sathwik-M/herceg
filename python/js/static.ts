// Static SVG rendering inside an embedded JavaScript engine (no DOM): the
// Python package calls `hercegStatic.svg(specJson, base64Buffers)`.

import { type ChartSpec, specToSVG } from "herceg/spec";
import { decodeBase64 } from "./buffers.ts";

(globalThis as { hercegStatic?: unknown }).hercegStatic = {
  svg(spec: string, buffers: string[]): string {
    return specToSVG(JSON.parse(spec) as ChartSpec, buffers.map(decodeBase64));
  },
};
