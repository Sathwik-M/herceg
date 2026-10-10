import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = dirname(dirname(fileURLToPath(import.meta.url)));
export const npm = process.platform === "win32" ? "npm.cmd" : "npm";

export function writeJSON(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function run(command, args, options = {}) {
  // npm.cmd needs a shell on Windows; npm run supplies its JavaScript CLI path.
  if (command === npm && process.env.npm_execpath) {
    args = [process.env.npm_execpath, ...args];
    command = process.execPath;
  }
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}\n${result.stdout ?? ""}${result.stderr ?? ""}`,
      { cause: result.error },
    );
  }
  return result.stdout;
}

export async function withTempProject(name, check) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log(`Usage: npm run ${name} -- [--keep-on-failure]`);
    return;
  }
  if (args.some((arg) => arg !== "--keep-on-failure")) {
    throw new Error(`Unknown option: ${args.join(" ")}`);
  }
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), `herceg-${name.replaceAll(":", "-")}-`)),
  );
  const started = performance.now();
  let passed = false;
  const step = async (label, action) => {
    console.log(`${label}…`);
    const start = performance.now();
    const result = await action();
    const status = result === false ? "skipped" : "passed";
    console.log(`  ${status} (${((performance.now() - start) / 1000).toFixed(2)}s)`);
  };
  try {
    await check(directory, step);
    passed = true;
    console.log(`${name}: passed in ${((performance.now() - started) / 1000).toFixed(2)}s`);
  } catch (error) {
    console.error(`${name}: FAILED\n${error.message}`);
    process.exitCode = 1;
  } finally {
    if (!passed && args.includes("--keep-on-failure")) {
      console.log(`Kept consumer project: ${directory}`);
    } else {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}
