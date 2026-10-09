import type { Adapter } from "../page/adapter.ts";
import { adapter as herceg } from "./herceg.ts";

// Herceg with WebGL2 unavailable, so every chart is drawn on the CPU (SVG,
// or Canvas 2D for large charts): the baseline its GPU paths are measured
// against. The page's canvases refuse WebGL2 before any chart asks for one.
for (const prototype of [HTMLCanvasElement.prototype, globalThis.OffscreenCanvas?.prototype]) {
  if (!prototype) continue;
  const getContext = prototype.getContext as (this: unknown, ...args: unknown[]) => unknown;
  prototype.getContext = function (this: unknown, ...args: unknown[]) {
    return args[0] === "webgl2" ? null : getContext.apply(this, args);
  } as typeof prototype.getContext;
}

export const adapter: Adapter = {
  ...herceg,
  id: "herceg-cpu",
  renderer: {
    normal: "auto without WebGL2 (svg below 4,000 drawn points, canvas above)",
    large: "auto without WebGL2",
  },
};
