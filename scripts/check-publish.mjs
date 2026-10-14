import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const directory = process.cwd();
const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
function check(value) {
  if (typeof value === "string") {
    let present = false;
    if (value.startsWith("./") && !value.includes("*")) {
      try {
        present = statSync(join(directory, value)).isFile();
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    if (!present)
      throw new Error(
        `${manifest.name}: missing exports target ${value}; run npm ci, npm run build, and npm run test:package from the repository root before publishing`,
      );
  } else if (value !== null) {
    for (const target of Object.values(value)) check(target);
  }
}
check(manifest.exports);
console.log(`${manifest.name}: all exports targets exist`);
