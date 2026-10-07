import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cpus, release, totalmem, type } from "node:os";
import { join } from "node:path";
import { ROOT } from "./build.ts";

/** npm package measured for each adapter id. */
export const PACKAGES: Record<string, string> = {
  herceg: "herceg",
  echarts: "echarts",
  chartjs: "chart.js",
  plotly: "plotly.js-dist-min",
  tanstack: "@tanstack/charts",
  uplot: "uplot",
};

export function packageVersion(name: string): string {
  if (name === "herceg")
    return `${readVersion(join(ROOT, "..", "packages", "herceg"))} (${commit().sha})`;
  for (const base of [join(ROOT, "node_modules"), join(ROOT, "..", "node_modules")]) {
    try {
      return JSON.parse(readFileSync(join(base, name, "package.json"), "utf8")).version;
    } catch {}
  }
  return "unknown";
}

function readVersion(directory: string): string {
  return JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).version;
}

function git(command: string): string {
  try {
    return execSync(`git ${command}`, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "";
  }
}

export function commit(): { sha: string; dirty: boolean } {
  return { sha: git("rev-parse --short HEAD") || "none", dirty: git("status --porcelain") !== "" };
}

export function machine() {
  return {
    os: `${type()} ${release()}`,
    cpu: cpus()[0]?.model ?? "unknown",
    cores: cpus().length,
    memoryGB: Math.round(totalmem() / 2 ** 30),
    node: process.version,
  };
}
