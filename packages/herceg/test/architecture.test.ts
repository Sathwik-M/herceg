import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
// The chart engine must run without a DOM (servers, workers, Python exports).
const CORE = ["data", "geo", "scale", "format", "lod", "marks", "model", "scene", "spec", "three"];
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

  // PDF export runs wherever the engine does, including the JavaScript engine
  // embedded in Python, which has no DOM or web APIs such as TextEncoder.
  it("PDF export uses no DOM or web APIs", () => {
    const render = join(SRC, "render");
    const modules = [
      "pdf.ts",
      "pdf-document.ts",
      "pdf-fonts.ts",
      "deflate.ts",
      "css-color.ts",
      "svg-path.ts",
    ];
    for (const file of [join(SRC, "pdf.ts"), ...modules.map((name) => join(render, name))]) {
      const source = readFileSync(file, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
      const imports = [...source.matchAll(/from "([^"]+)"/g)].map(([, path]) => path!);
      const code = source.replace(/from "[^"]+"/g, "");
      expect(DOM.test(code), `${file} uses a DOM API`).toBe(false);
      expect(/\b(TextEncoder|btoa|atob|Blob|CompressionStream)\b/.test(code), file).toBe(false);
      for (const path of imports)
        expect(path, `${file} imports browser code`).not.toMatch(/\/dom\//);
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
