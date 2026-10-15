import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");
// The chart engine must run without a DOM (servers, workers, Python exports).
const CORE = [
  "data",
  "geo",
  "grid",
  "scale",
  "format",
  "lod",
  "marks",
  "model",
  "scene",
  "spec",
  "three",
];
const DOM = /\b(document|window|HTMLElement|SVGElement|requestAnimationFrame|getComputedStyle)\b/;

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );
}

describe("architecture", () => {
  // A live chart loads the guide compiler when a configuration needs it. A
  // module both imported would move out of the chart's first chunk into a
  // chunk of its own (esbuild's splitting), so the compiler is handed what
  // it uses of the chart's code (GUIDE_KIT) and imports only types from it.
  it("the guide compiler imports only types from the chart's modules", () => {
    const own = (path: string) =>
      path.startsWith(join(SRC, "guides")) || path === join(SRC, "format/patterns.ts");
    for (const file of [...files(join(SRC, "guides")), join(SRC, "format/patterns.ts")]) {
      const source = readFileSync(file, "utf8");
      for (const [, path] of source.matchAll(/^import (?!type )[^;]*?from "([^"]+)"/gm))
        expect(own(resolve(dirname(file), path!)), `${file} imports ${path}`).toBe(true);
    }
  });

  // The feature compiler follows the same rule. What it imports besides its
  // own modules no line chart's module imports: expression compilation (the
  // builders `col` and `when` are data/expr.ts), symbols' shapes, and the
  // guide compiler's pattern formats. Charts that import these themselves
  // (grids the first, points the second) get them in a chunk of their own.
  // Colors are told from names through the kit (FeatureKit.isColor).
  it("the feature compiler imports only types from the line chart's modules", () => {
    const features = join(SRC, "marks/features");
    const allowed = ["data/expression.ts", "draw/symbol-shapes.ts", "format/patterns.ts"].map(
      (path) => join(SRC, path),
    );
    for (const file of files(features)) {
      const source = readFileSync(file, "utf8");
      for (const [, path] of source.matchAll(/^import (?!type )[^;]*?from "([^"]+)"/gm)) {
        const target = resolve(dirname(file), path!);
        expect(
          target.startsWith(features) || allowed.includes(target),
          `${file} imports ${path}`,
        ).toBe(true);
      }
    }
    const runtime = (file: string) =>
      [
        ...readFileSync(join(SRC, file), "utf8").matchAll(
          /^(?:import|export) (?!type )[^;]*?from "([^"]+)"/gm,
        ),
      ].map(([, path]) => resolve(dirname(join(SRC, file)), path!));
    for (const file of ["index.ts", "draw/text.ts", "draw/symbols.ts"])
      expect(
        runtime(file).filter(
          (path) => allowed.includes(path) && !path.endsWith("symbol-shapes.ts"),
        ),
        file,
      ).toEqual([]);
  });

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
      "pdf-paper.ts",
      "pdf-fonts.ts",
      "deflate.ts",
      "svg-path.ts",
    ];
    for (const file of [
      join(SRC, "pdf.ts"),
      join(SRC, "scale/css-color.ts"),
      ...modules.map((name) => join(render, name)),
    ]) {
      const source = readFileSync(file, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
      // Types (the chart handle a mounted chart's export takes) load no code.
      const imports = [...source.matchAll(/^import (?!type )[^;]*?from "([^"]+)"/gm)].map(
        ([, path]) => path!,
      );
      const code = source.replace(/from "[^"]+"/g, "");
      expect(DOM.test(code), `${file} uses a DOM API`).toBe(false);
      expect(/\b(TextEncoder|btoa|atob|Blob|CompressionStream)\b/.test(code), file).toBe(false);
      for (const path of imports)
        expect(path, `${file} imports browser code`).not.toMatch(/\/dom\//);
    }
  });

  // `herceg/grid/model` runs without a DOM (servers, workers, tests in Node):
  // nothing it imports, however indirectly, may reach browser code.
  it("herceg/grid/model imports only DOM-free modules", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
      for (const [, path] of source.matchAll(/from "(\.[^"]+)"/g))
        visit(resolve(dirname(file), path!));
    };
    visit(join(SRC, "grid", "model.ts"));
    for (const file of seen) {
      const directory = file.slice(SRC.length + 1).split("/")[0]!;
      expect(CORE, `herceg/grid/model reaches ${file}`).toContain(directory);
    }
  });

  // `herceg/pivot` is data: charts read its tables, and grids load it only to show one.
  it("herceg/pivot imports only the data layer", () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = readFileSync(file, "utf8").replace(/\/\/.*$|\/\*[\s\S]*?\*\//gm, "");
      for (const [, path] of source.matchAll(/from "(\.[^"]+)"/g))
        visit(resolve(dirname(file), path!));
    };
    visit(join(SRC, "pivot.ts"));
    for (const file of seen) {
      const directory = file.slice(SRC.length + 1).split("/")[0]!;
      expect(["pivot.ts", "data", "lod"], `herceg/pivot reaches ${file}`).toContain(directory);
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
