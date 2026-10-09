// Markdown tables for grid results, used by src/report.ts for the "Grids"
// section of docs/comparison.md. Run alone to print the tables of any
// results file:
//
//   node --experimental-strip-types src/grid/report.ts tmp/benchmarks/grid-....json

import { readFileSync } from "node:fs";

interface Summary {
  median: number;
  mad: number;
  p95: number;
  p99: number;
  max: number;
}
interface Row {
  scenario: string;
  library: string;
  status: "measured" | "unsupported" | "incorrect" | "error";
  reason?: string;
  metrics: Record<string, { unit: string; summary: Summary }>;
}
export interface GridResults {
  date: string;
  commit: { sha: string; dirty: boolean };
  complete: boolean;
  environment: Record<string, unknown> & {
    viewport: { width: number; height: number };
    deviceScaleFactor: number;
  };
  libraries: Record<
    string,
    {
      version: string;
      renderer?: string;
      processing?: { sort: string; filter: string };
      runtime?: Record<string, string>;
    }
  >;
  scenarios: Record<string, { description: string }>;
  results: Row[];
}

const SIZES = ["10k", "100k", "1m", "1m-wide"];
const SIZE_LABEL: Record<string, string> = {
  "10k": "10k x 20",
  "100k": "100k x 20",
  "1m": "1M x 20",
  "1m-wide": "1M x 100",
};
const ORDER = ["herceg", "herceg-react", "tanstack-table", "ag-grid", "glide"];

/** A distribution without samples has a null (JSON) or NaN median; it reads as a dash. */
const known = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);
const ms = (value: number | null | undefined) =>
  !known(value) ? "–" : value >= 100 ? value.toFixed(0) : value.toFixed(value >= 10 ? 1 : 2);
const mb = (bytes: number | null | undefined) =>
  !known(bytes) ? "–" : (bytes / 1e6).toFixed(Math.abs(bytes) >= 1e7 ? 0 : 1);

function table(header: string[], rows: string[][]): string {
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  return [
    line(header),
    line(header.map((_, i) => (i === 0 ? "---" : "---:"))),
    ...rows.map(line),
  ].join("\n");
}

export function gridSection(results: GridResults): string {
  const libraries = ORDER.filter((id) => id in results.libraries);
  const find = (scenario: string, library: string) =>
    results.results.find((row) => row.scenario === scenario && row.library === library);
  const notes: string[] = [];
  /** A cell: the row's value, or why there is none (with a numbered note, one per row). */
  const cell = (row: Row | undefined, value: (metrics: Row["metrics"]) => string): string => {
    if (!row) return "";
    if (row.status === "measured") return value(row.metrics);
    if (row.status === "unsupported") return "n/a";
    const note = `${row.library}, ${row.scenario}: ${row.reason}`;
    if (!notes.includes(note)) notes.push(note);
    return `${row.status} [${notes.indexOf(note) + 1}]`;
  };
  const median = (metrics: Row["metrics"], name: string) =>
    metrics[name]?.summary.median ?? Number.NaN;
  const timing = (name: string) => (metrics: Row["metrics"]) => {
    const s = metrics[name]!.summary;
    return `${ms(s.median)} ± ${ms(s.mad)}`;
  };
  /** One table: a row per size and case, a column per library. */
  const grid = (
    title: string,
    cases: [suffix: string, label: string, value: (m: Row["metrics"]) => string][],
  ) => {
    const rows: string[][] = [];
    for (const size of SIZES) {
      for (const [suffix, label, value] of cases) {
        const id = `grid-${size}-${suffix}`;
        if (!results.results.some((row) => row.scenario === id)) continue;
        rows.push([
          `${SIZE_LABEL[size]}: ${label}`,
          ...libraries.map((library) => cell(find(id, library), value)),
        ]);
      }
    }
    return rows.length > 0 ? table([title, ...libraries], rows) : "";
  };

  /** A timing, with how many frames it took when more than one and any frames the harness could not observe. */
  const withFrames = (name: string) => (m: Row["metrics"]) => {
    const frames = median(m, "frames");
    const unobserved = m.unobservedFrames?.summary.max ?? 0;
    const notes = [
      ...(frames > 1 ? [`${frames} frames`] : []),
      ...(unobserved > 0 ? [`up to ${unobserved} unobserved`] : []),
    ];
    return `${timing(name)(m)}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`;
  };
  const withProcessing = (m: Row["metrics"]) =>
    `${withFrames("toFrame")(m)}; ${ms(median(m, "processing"))} in call`;
  const trace = (m: Row["metrics"]) => {
    const s = m.frameInterval!.summary;
    const unobserved = m.unobservedFrames?.summary.max ?? 0;
    const wheel = m.wheelEvents
      ? `; ${median(m, "wheelEvents")} wheel events, ${(median(m, "scrolled") / 1000).toFixed(1)}k px`
      : "";
    return [
      `${ms(s.median)} / ${ms(s.p95)} / ${ms(s.p99)}`,
      `${median(m, "droppedFrames")} dropped`,
      `${median(m, "incompleteFrames")} of ${median(m, "frames")} incomplete${unobserved > 0 ? ` (up to ${unobserved} unobserved)` : ""}${wheel}`,
    ].join("; ");
  };
  const stream = (m: Row["metrics"]) => {
    const tick = m.tickToFrame!.summary;
    const unresolved = median(m, "unresolvedTicks");
    const drain = median(m, "drainTime");
    const latency = known(tick.median)
      ? `${ms(tick.median)} / ${ms(tick.p95)}`
      : "no tick after the first showed";
    return [
      `${latency} (first ${ms(median(m, "firstTickToFrame"))})`,
      `${ms(median(m, "processing"))} in call`,
      ...(median(m, "lateness") > 5 ? [`ticks ${ms(median(m, "lateness"))} late`] : []),
      `${median(m, "droppedFrames")} dropped`,
      `${median(m, "deliveredTicks")}/${median(m, "offeredTicks")} delivered${unresolved > 0 ? `, ${unresolved} unresolved` : ""}`,
      ...(drain > 50 ? [`${ms(drain)} ms to drain`] : []),
      ...((m.unobservedFrames?.summary.max ?? 0) > 0
        ? [`up to ${m.unobservedFrames!.summary.max} frames unobserved`]
        : []),
    ].join("; ");
  };
  const memory = (m: Row["metrics"]) =>
    `${mb(median(m, "retainedBytes"))} MB (reserved +${mb(median(m, "mountReservedBytes"))}); input ${mb(median(m, "inputBytes"))} MB; ${median(m, "domNodes")} nodes${median(m, "canvasBytes") > 0 ? `; canvas ${mb(median(m, "canvasBytes"))} MB` : ""}`;
  const lifecycle = (m: Row["metrics"]) =>
    `${mb(median(m, "destroyLeakBytes"))} / ${mb(median(m, "cycleRetainedBytes"))} MB; ${mb(median(m, "cycleGrowthBytes"))} MB per mount; ${mb(median(m, "leakedBytes"))} MB after release`;

  const sections = [
    grid("Mount (ms, median ± MAD)", [
      ["mount", "from native input", withFrames("fromNative")],
      [
        "mount",
        "from the columns, conversion included",
        (m) =>
          `${timing("fromColumnar")(m)}${(m.columnarUnobservedFrames?.summary.max ?? 0) > 0 ? " (with unobserved frames)" : ""}`,
      ],
      ["mount", "conversion alone", timing("conversion")],
      ["mount", "destroy", timing("destroy")],
    ]),
    grid("Scroll a step to its correct frame (ms)", [
      ["scroll-vertical", "a screen down", withFrames("stepToFrame")],
      ["scroll-horizontal", "three columns across", withFrames("stepToFrame")],
      ["scroll-diagonal", "both", withFrames("stepToFrame")],
      ["scroll-end", "to the last row and back", withFrames("stepToFrame")],
    ]),
    grid(
      "Continuous scrolling for 3 s with vsync (frame interval p50 / p95 / p99 ms; dropped frames; incomplete frames)",
      [
        ["trace-vertical", "down, offset set every frame", trace],
        ["trace-diagonal", "down and across, offset set every frame", trace],
        ["trace-wheel", "down, browser wheel events", trace],
      ],
    ),
    grid("Sort and filter to the correct frame (ms; time inside the call)", [
      ["sort-number-asc", "sort a number ascending", withProcessing],
      ["sort-number-desc", "sort a number descending", withProcessing],
      ["sort-category-number", "sort by category, then number", withProcessing],
      ["filter-range-1", "number range, ~1% kept", withProcessing],
      ["filter-range-50", "number range, ~50% kept", withProcessing],
      ["filter-range-99", "number range, ~99% kept", withProcessing],
      ["filter-category-1", "category membership, ~1% kept", withProcessing],
      ["filter-category-50", "category membership, ~50% kept", withProcessing],
      ["filter-category-99", "category membership, ~99% kept", withProcessing],
    ]),
    grid("Select rows, sorted (ms to the correct frame)", [
      ["select-row", "one row", withFrames("toFrame")],
      ["select-range", "half the rows in display order", withFrames("toFrame")],
      ["select-range", "read the selection back", timing("readSelection")],
    ]),
    grid(
      "Streaming: ticks offered at 10 Hz for 5 s with vsync (tick to correct frame p50 / p95 ms, first tick; time in call; dropped frames; ticks delivered of those offered)",
      [
        ["append", "append 1,000 rows", stream],
        ["append-sorted", "append 1,000 rows, sorted", stream],
        ["append-rolling", "append 1,000, evict 1,000", stream],
        ["append-rolling-sorted", "append 1,000, evict 1,000, sorted", stream],
        ["update", "change 100 rows, display field", stream],
        ["update-sorted", "change 100 rows, sort key", stream],
        ["update-filtered", "change 100 rows, filtered field", stream],
      ],
    ),
    grid(
      "Memory with the grid mounted (retained heap, and growth of the reserved heap while mounting; native input; DOM nodes; canvas)",
      [["memory", "mounted", memory]],
    ),
    grid(
      "Heap kept 1 s after destroying the grid (after one mount / after five more); growth per further mount; kept after releasing the data too",
      [["memory", "destroy and remount", lifecycle]],
    ),
  ].filter((section) => section !== "");

  const env = results.environment;
  const versions = libraries
    .map((id) => {
      const library = results.libraries[id]!;
      const runtime = Object.entries(library.runtime ?? {})
        .map(([name, version]) => `${name} ${version}`)
        .join(", ");
      return `${id} ${library.version}${runtime ? ` (${runtime})` : ""}`;
    })
    .join("; ");
  const configurations = libraries.map((id) => {
    const library = results.libraries[id]!;
    return `- ${id}: ${library.renderer}; sort ${library.processing?.sort}; filter ${library.processing?.filter}`;
  });
  return [
    `- Date: ${results.date.slice(0, 10)}, commit ${results.commit.sha}${results.commit.dirty ? " (uncommitted changes)" : ""}${results.complete ? "" : ", incomplete run"}`,
    `- Machine: ${env.cpu}, ${env.cores} cores, ${env.memoryGB} GB, ${env.os}`,
    `- Browser: ${env.browser}, GPU ${env.gpu}, ${env.headless ? "headless" : "headed"}, viewport ${env.viewport.width}x${env.viewport.height}, device pixel ratio ${env.deviceScaleFactor}`,
    `- Libraries: ${versions}`,
    ...configurations,
    "",
    sections.join("\n\n"),
    ...(notes.length > 0 ? ["", ...notes.map((note, i) => `${i + 1}. ${note}`)] : []),
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2];
  if (!file) throw new Error("usage: report.ts <grid results file>");
  console.log(gridSection(JSON.parse(readFileSync(file, "utf8"))));
}
