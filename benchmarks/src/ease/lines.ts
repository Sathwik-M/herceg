// Lines of code of the common-task samples, as docs/comparison.md
// ("Common tasks") reports them: lines that are not blank, not comments, and
// not the import of the shared data, after formatting (biome for TypeScript,
// ruff for Python).
//
//   node --experimental-strip-types benchmarks/src/ease/lines.ts

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dirname;
const data = /^(import .* from "\.\.\/data\.ts";|from data import .*)$/;

for (const task of readdirSync(root).filter((name) => /^\d\d-/.test(name))) {
  const counts = readdirSync(join(root, task))
    .filter((file) => /\.(tsx?|py)$/.test(file))
    .map((file) => {
      const lines = readFileSync(join(root, task, file), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) => line && !line.startsWith("//") && !line.startsWith("#") && !data.test(line),
        );
      return `${file} ${lines.length}`;
    });
  console.log(`${task}: ${counts.join(", ")}`);
}
