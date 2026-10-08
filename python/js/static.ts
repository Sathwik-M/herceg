// Static rendering inside an embedded JavaScript engine (no DOM): the Python
// package calls `hercegStatic.svg(specJson, base64Buffers)`, and `pdf`, which
// returns the document as base64.

import { type ChartSpec, specToPDF, specToSVG } from "herceg/spec";
import { decodeBase64, encodeBase64 } from "./buffers.ts";

(globalThis as { hercegStatic?: unknown }).hercegStatic = {
  svg(spec: string, buffers: string[]): string {
    return specToSVG(JSON.parse(spec) as ChartSpec, buffers.map(decodeBase64));
  },
  pdf(spec: string, buffers: string[]): string {
    return encodeBase64(specToPDF(JSON.parse(spec) as ChartSpec, buffers.map(decodeBase64)));
  },
};
