import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Application data for one Firefox process, shared by tests and benchmarks. */
export function createFirefoxAppData() {
  // Firefox keeps its list of profiles here even when given a profile. macOS
  // 27 refuses to create ~/Library/Application Support/Firefox, preventing
  // startup. A writable folder also keeps runs out of the user's Firefox.
  const directory = mkdtempSync(join(tmpdir(), "herceg-firefox-"));
  process.on("exit", () => rmSync(directory, { recursive: true, force: true }));
  return {
    directory,
    env: { ...process.env, MOZ_APP_DATA: directory, MOZ_LOCAL_APP_DATA: directory },
  };
}
