import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
// The chart engine must run without a DOM (servers, workers, Python exports).
const CORE = ["data", "scale", "format", "lod", "marks", "model", "scene", "spec"];
const DOM = /\b(document|window|HTMLElement|SVGElement|requestAnimationFrame|getComputedStyle)\b/;

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

describe("architecture", () => {
  // Marks import their drawings, so drawings must load and write SVG without
  // a DOM. Canvas painting reaches the DOM only through the canvas it is
  // handed (rasters fall back to creating a canvas in its document).
  it("src/draw renders SVG without a DOM and paints only through its canvas", () => {
    for (const file of files(join(SRC, "draw"))) {
      const source = readFileSync(file, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
      expect(DOM.test(source), `${file} uses a DOM global`).toBe(false);
      expect(/from "\.\.\/(dom|render)\//.test(source), `${file} imports browser code`).toBe(false);
      const reaches = source.match(/[\w.]*ownerDocument/g) ?? [];
      for (const reach of reaches)
        expect(reach, `${file} reaches the DOM other than through its canvas`).toBe(
          "context.canvas.ownerDocument",
        );
    }
  });

  for (const directory of CORE) {
    it(`src/${directory} does not use the DOM or import browser code`, () => {
      for (const file of files(join(SRC, directory))) {
        const source = readFileSync(file, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
        expect(DOM.test(source), `${file} uses a DOM API`).toBe(false);
        expect(/from "\.\.\/(dom|render)\//.test(source), `${file} imports browser code`).toBe(
          false,
        );
      }
    });
  }
});
