// Renders committed benchmark results as Markdown tables and writes them into
// docs/comparison.md between `<!-- results:NAME -->` and `<!-- /results:NAME -->`.
//
//   npm run report

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gridSection } from "./grid/report.ts";
import { ROOT } from "./runner/build.ts";

interface Summary {
  n?: number;
  median: number;
  mad: number;
  p95: number;
}
interface Row {
  scenario: string;
  library: string;
  supported: boolean;
  reason?: string;
  metrics: Record<string, { unit: string; summary: Summary }>;
}
interface BrowserResults {
  date: string;
  commit: { sha: string; dirty: boolean };
  environment: Record<string, unknown> & { viewport: { width: number; height: number } };
  libraries: Record<
    string,
    {
      version: string;
      renderer: { normal: string; large: string };
      runtime?: Record<string, string>;
    }
  >;
  scenarios: Record<string, { description: string; large: boolean }>;
  results: Row[];
}
interface SizeResults {
  date: string;
  results: {
    entry: string;
    version: string;
    minified: number;
    gzip: number;
    brotli: number;
    css: { gzip: number } | null;
    deferred?: { gzip: number } | null;
    lazy?: { gzip: number } | null;
  }[];
}

const RESULTS = join(ROOT, "results");
const DOC = join(ROOT, "..", "docs", "comparison.md");

const browser: BrowserResults = JSON.parse(readFileSync(join(RESULTS, "browser.json"), "utf8"));
const size: SizeResults = JSON.parse(readFileSync(join(RESULTS, "size.json"), "utf8"));

const ms = (s: Summary) =>
  s.median >= 100 ? s.median.toFixed(0) : s.median.toFixed(s.median >= 10 ? 1 : 2);
const mb = (bytes: number) => (bytes / 1e6).toFixed(bytes >= 1e7 ? 0 : 1);
const kib = (bytes: number) => (bytes / 1024).toFixed(1);

function find(scenario: string, library: string, results = browser): Row | undefined {
  return results.results.find((row) => row.scenario === scenario && row.library === library);
}

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(header),
    line(header.map((_, i) => (i === 0 ? "---" : "---:"))),
    ...rows.map(line),
  ].join("\n");
}

/** One row per scenario, one column per library: median ± MAD of `metric`. */
function timingTable(scenarios: string[], metric: string, results = browser): string {
  const libraries = Object.keys(results.libraries);
  const rows = scenarios.map((id) => [
    `${id} (${results.scenarios[id]?.description})`,
    ...libraries.map((library) => {
      const row = find(id, library, results);
      if (!row) return "";
      if (!row.supported) return row.reason?.startsWith("error") ? "error" : "n/a";
      const s = row.metrics[metric]?.summary;
      if (!s) return "";
      const cell = `${ms(s)} ± ${ms({ ...s, median: s.mad })}`;
      // Progressive renderers show a partial chart well before they finish.
      const first = row.metrics.firstFrame?.summary;
      return first && first.median < 0.8 * s.median ? `${cell} (first frame ${ms(first)})` : cell;
    }),
  ]);
  return table(["Scenario (ms, median ± MAD)", ...libraries], rows);
}

/** Turning a 3D chart every frame with vsync on: frame intervals and frames that missed the refresh. */
function orbitTable(results: BrowserResults): string {
  const libraries = Object.keys(results.libraries);
  const scenarios = Object.keys(results.scenarios).filter((id) => id.startsWith("orbit-"));
  const rows = scenarios.map((id) => [
    `${id} (${results.scenarios[id]?.description})`,
    ...libraries.map((library) => {
      const row = find(id, library, results);
      if (!row?.supported) return row?.reason?.startsWith("error") ? "error" : "n/a";
      const frames = row.metrics.frameInterval!;
      const missed = row.metrics.missedFrames!.summary.median;
      const late = `${missed} of ${frames.summary.n} late`;
      return `${ms(frames.summary)} (p95 ${ms({ ...frames.summary, median: frames.summary.p95 })}), ${late}`;
    }),
  ]);
  return table(["Frame interval (ms, median)", ...libraries], rows);
}

/** Paced ingestion: frame interval percentiles, dropped frames, achieved rate. */
function ingestTable(results = browser): string {
  const libraries = Object.keys(results.libraries);
  const scenarios = Object.keys(results.scenarios).filter((id) => id.startsWith("ingest-"));
  const rows = scenarios.map((id) => [
    `${id} (${results.scenarios[id]?.description})`,
    ...libraries.map((library) => {
      const row = find(id, library, results);
      if (!row?.supported) return "n/a";
      const frames = row.metrics.frameInterval!.summary as Summary & { p99: number };
      const dropped = row.metrics.droppedFrames!.summary.median;
      const rate = row.metrics.achievedRate!.summary.median;
      return `${ms(frames)} / ${ms({ ...frames, median: frames.p95 })} / ${ms({ ...frames, median: frames.p99 })} ms, ${dropped} dropped, ${rate.toFixed(0)} Hz`;
    }),
  ]);
  return table(
    [
      "Scenario (frame interval p50 / p95 / p99, dropped frames, achieved ingest rate)",
      ...libraries,
    ],
    rows,
  );
}

function memoryTable(results = browser): string {
  const libraries = Object.keys(results.libraries);
  const scenarios = Object.keys(results.scenarios).filter((id) => id.startsWith("memory-"));
  const rows: string[][] = [];
  for (const id of scenarios) {
    const source = find(id, libraries[0]!, results)?.metrics.sourceBytes?.summary.median ?? 0;
    rows.push([
      `${id} (${results.scenarios[id]?.description}; source ${mb(source)} MB)`,
      ...libraries.map((library) => {
        const row = find(id, library, results);
        if (!row?.supported) return row?.reason?.startsWith("error") ? "error" : "n/a";
        const retained = row.metrics.retainedBytes!.summary.median;
        const canvas = row.metrics.canvasBytes!.summary.median;
        const nodes = row.metrics.domNodes!.summary.median;
        return `${mb(retained)} MB heap, ${mb(canvas)} MB canvas, ${nodes} nodes`;
      }),
    ]);
  }
  return table(["Scenario", ...libraries], rows);
}

function sizeTable(): string {
  return table(
    [
      "Entry",
      "Version",
      "Minified KiB",
      "Gzip KiB",
      "Brotli KiB",
      "Required CSS, gzip KiB",
      "After the first frame, gzip KiB",
      "Optional chunks, gzip KiB",
    ],
    size.results.map((r) => [
      r.entry,
      r.version,
      kib(r.minified),
      kib(r.gzip),
      kib(r.brotli),
      r.css ? kib(r.css.gzip) : "-",
      r.deferred ? kib(r.deferred.gzip) : "-",
      r.lazy ? kib(r.lazy.gzip) : "-",
    ]),
  );
}

function environment(results = browser): string {
  const env = results.environment;
  const libraries = Object.keys(results.libraries);
  const versions = libraries.map((id) => `${id} ${results.libraries[id]!.version}`).join(", ");
  const driver = env.playwright
    ? ` through Playwright ${env.playwright} (${env.browserBuild})`
    : "";
  const cadence =
    typeof env.frameCadence === "number"
      ? `, idle frames every ${ms({ median: env.frameCadence, mad: 0, p95: 0 })} ms`
      : "";
  return [
    `- Date: ${results.date.slice(0, 10)}, commit ${results.commit.sha}${results.commit.dirty ? " (uncommitted changes)" : ""}`,
    `- Machine: ${env.cpu}, ${env.cores} cores, ${env.memoryGB} GB, ${env.os}`,
    `- Browser: ${env.browser}${driver}, GPU ${env.gpu}, ${env.headless ? "headless" : "headed"}${cadence}`,
    `- Viewport ${env.viewport.width}x${env.viewport.height}, device pixel ratio ${env.deviceScaleFactor}`,
    `- Libraries: ${versions}`,
    `- Renderers (normal / large config): ${libraries.map((id) => `${id}: ${results.libraries[id]!.renderer.normal} / ${results.libraries[id]!.renderer.large}`).join("; ")}`,
  ].join("\n");
}

/**
 * The suite in another browser (`results/browser-NAME.json`): its environment
 * and every timing table, without memory, which only Chrome measures.
 */
function browserSection(results: BrowserResults): string {
  const ids = Object.keys(results.scenarios);
  const timing = (filter: (id: string) => boolean, metric: string) =>
    timingTable(ids.filter(filter), metric, results);
  return [
    environment(results),
    "",
    timing((id) => id.endsWith("-init"), "timeToFrame"),
    "",
    timing((id) => id.endsWith("-update"), "timeToFrame"),
    "",
    timing((id) => id.startsWith("stream-"), "tickToFrame"),
    "",
    ingestTable(results),
    "",
    timing((id) => id.startsWith("hover-"), "pointerToFrame"),
    "",
    timing((id) => id.startsWith("zoom-"), "viewportToFrame"),
    "",
    timing((id) => id.startsWith("resize-"), "resizeToFrame"),
    "",
    timing((id) => id === "dashboard", "initAllToFrame").replace(
      "Scenario (ms",
      "Mount all charts (ms",
    ),
    "",
    timing((id) => id === "dashboard", "updateAllToFrame").replace(
      "Scenario (ms",
      "Refresh all charts (ms",
    ),
  ].join("\n");
}

/**
 * 3D charts (`results/three.json`, a run of the 3D scenarios alone): the
 * environment, mounting, turning the camera, turning it every frame, and memory.
 */
function threeSection(results: BrowserResults): string {
  const ids = Object.keys(results.scenarios);
  return [
    environment(results),
    "",
    timingTable(
      ids.filter((id) => id.endsWith("-init")),
      "timeToFrame",
      results,
    ),
    "",
    timingTable(
      ids.filter((id) => id.startsWith("rotate-")),
      "cameraToFrame",
      results,
    ),
    "",
    orbitTable(results),
    "",
    memoryTable(results),
  ].join("\n");
}

/**
 * Herceg through @herceg/react next to plain herceg, measured in one session
 * (`results/react.json`), for every scenario the React adapter supports.
 */
function reactTable(react: BrowserResults): string {
  const failed = (row: Row | undefined) => row?.reason?.startsWith("error") ?? false;
  const cell = (row: Row | undefined): string => {
    if (failed(row)) return row!.reason!;
    if (!row?.supported) return "n/a";
    const m = row.metrics;
    if (m.retainedBytes) {
      return `${mb(m.retainedBytes.summary.median)} MB heap, ${m.domNodes!.summary.median} nodes`;
    }
    if (m.droppedFrames) {
      return `${m.droppedFrames.summary.median} dropped, ${m.achievedRate!.summary.median.toFixed(0)} Hz`;
    }
    const timing = [
      "timeToFrame",
      "tickToFrame",
      "pointerToFrame",
      "viewportToFrame",
      "resizeToFrame",
    ]
      .map((name) => m[name])
      .find((metric) => metric !== undefined);
    if (timing)
      return `${ms(timing.summary)} ± ${ms({ ...timing.summary, median: timing.summary.mad })} ms`;
    const mount = m.initAllToFrame!.summary;
    const refresh = m.updateAllToFrame!.summary;
    return `mount ${ms(mount)} ms, refresh ${ms(refresh)} ms`;
  };
  // Scenarios the adapter supports, including any that failed.
  const rows = Object.keys(react.scenarios)
    .filter((id) => {
      const row = find(id, "herceg-react", react);
      return row?.supported || failed(row);
    })
    .map((id) => [
      `${id} (${react.scenarios[id]?.description})`,
      cell(find(id, "herceg", react)),
      cell(find(id, "herceg-react", react)),
    ]);
  const { sha, dirty } = react.commit;
  const runtime = Object.entries(react.libraries["herceg-react"]?.runtime ?? {})
    .map(([name, version]) => `${name} ${version}`)
    .join(", ");
  return [
    `Measured ${react.date.slice(0, 10)} at commit ${sha}${dirty ? " (uncommitted changes)" : ""} with ${runtime || "unrecorded React versions"}, same environment as above.`,
    "",
    table(["Scenario (median)", "herceg", "herceg via @herceg/react"], rows),
  ].join("\n");
}

const ids = Object.keys(browser.scenarios);
const sections: Record<string, string> = {
  environment: environment(),
  size: sizeTable(),
  init: timingTable(
    ids.filter((id) => id.endsWith("-init")),
    "timeToFrame",
  ),
  update: timingTable(
    ids.filter((id) => id.endsWith("-update")),
    "timeToFrame",
  ),
  ingest: ingestTable(),
  stream: timingTable(
    ids.filter((id) => id.startsWith("stream-")),
    "tickToFrame",
  ),
  interaction: [
    timingTable(
      ids.filter((id) => id.startsWith("hover-")),
      "pointerToFrame",
    ),
    "",
    timingTable(
      ids.filter((id) => id.startsWith("zoom-")),
      "viewportToFrame",
    ),
    "",
    timingTable(
      ids.filter((id) => id.startsWith("resize-")),
      "resizeToFrame",
    ),
  ].join("\n"),
  dashboard: [
    timingTable(["dashboard"], "initAllToFrame").replace("Scenario (ms", "Mount all charts (ms"),
    "",
    timingTable(["dashboard"], "updateAllToFrame").replace(
      "Scenario (ms",
      "Refresh all charts (ms",
    ),
  ].join("\n"),
  memory: memoryTable(),
};
const webkitResults = join(RESULTS, "browser-webkit.json");
if (existsSync(webkitResults)) {
  sections.webkit = browserSection(JSON.parse(readFileSync(webkitResults, "utf8")));
}
const threeResults = join(RESULTS, "three.json");
if (existsSync(threeResults)) {
  sections.three = threeSection(JSON.parse(readFileSync(threeResults, "utf8")));
}
const gridResults = join(RESULTS, "grid.json");
if (existsSync(gridResults)) {
  sections.grid = gridSection(JSON.parse(readFileSync(gridResults, "utf8")));
}
const reactResults = join(RESULTS, "react.json");
if (existsSync(reactResults)) {
  sections.react = reactTable(JSON.parse(readFileSync(reactResults, "utf8")));
}

let doc = readFileSync(DOC, "utf8");
for (const [name, content] of Object.entries(sections)) {
  const pattern = new RegExp(`(<!-- results:${name} -->)[\\s\\S]*?(<!-- /results:${name} -->)`);
  if (!pattern.test(doc)) throw new Error(`docs/comparison.md has no results:${name} block`);
  doc = doc.replace(pattern, (_, open, close) => `${open}\n${content}\n${close}`);
}
writeFileSync(DOC, doc);
console.log(`Updated ${DOC}`);
