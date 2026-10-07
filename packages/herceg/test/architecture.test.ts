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
