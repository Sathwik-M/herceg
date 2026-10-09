import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Herceg is bundled from source so benchmarks always measure the working tree. */
export const HERCEG_ALIAS = {
  herceg: join(ROOT, "..", "packages", "herceg", "src", "index.ts"),
  "herceg/grid": join(ROOT, "..", "packages", "herceg", "src", "grid.ts"),
  "herceg/grid/pivot": join(ROOT, "..", "packages", "herceg", "src", "grid-pivot.ts"),
  "herceg/pivot": join(ROOT, "..", "packages", "herceg", "src", "pivot.ts"),
  "@herceg/react": join(ROOT, "..", "packages", "react", "src", "index.ts"),
  "@herceg/react/grid": join(ROOT, "..", "packages", "react", "src", "grid.tsx"),
  "@herceg/vue": join(ROOT, "..", "packages", "vue", "src", "index.ts"),
  "@herceg/svelte": join(ROOT, "..", "packages", "svelte", "src", "index.ts"),
};
const OUT = join(ROOT, ".build");

/** The chart harness and adapters, or the grid harness and grid adapters. */
const SUITES = {
  charts: {
    adapters: "./src/adapters",
    harness: "./src/page/harness.ts",
    install: "installHarness",
  },
  grid: {
    adapters: "./src/grid/adapters",
    harness: "./src/grid/harness.ts",
    install: "installGridHarness",
  },
};

/**
 * Production bundle of a harness plus one adapter, so each page loads one
 * library. Grid pages are named `grid-<library>`.
 */
export async function buildPage(
  library: string,
  suite: keyof typeof SUITES = "charts",
): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const { adapters, harness, install } = SUITES[suite];
  const name = suite === "grid" ? `grid-${library}` : library;
  await esbuild.build({
    stdin: {
      contents: [
        `import { adapter } from "${adapters}/${library}";`,
        `import { ${install} } from "${harness}";`,
        `${install}(adapter);`,
      ].join("\n"),
      resolveDir: ROOT,
      sourcefile: `${name}-entry.ts`,
      loader: "ts",
    },
    bundle: true,
    minify: true,
    format: "esm",
    target: "es2022",
    outfile: join(OUT, `${name}.js`),
    define: { "process.env.NODE_ENV": '"production"' },
    jsx: "automatic",
    alias: HERCEG_ALIAS,
    logLevel: "warning",
  });
}

function page(library: string): string {
  const css = existsSync(join(OUT, `${library}.css`))
    ? `<link rel="stylesheet" href="/${library}.css">`
    : "";
  return `<!doctype html>
<html><head><meta charset="utf-8">${css}
<style>body{margin:0;font:14px system-ui,sans-serif}#stage{line-height:0}</style>
</head><body><div id="stage"></div><script type="module" src="/${library}.js"></script></body></html>`;
}

// Cross-origin isolation raises performance.now() resolution from 100 µs to 5 µs.
const ISOLATION = {
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-embedder-policy": "require-corp",
};

const TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
};

export function serve(): Promise<{ server: Server; origin: string }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const html = /^\/([\w-]+)\.html$/.exec(path);
    if (html) {
      response.writeHead(200, { "content-type": "text/html", ...ISOLATION });
      response.end(page(html[1]!));
      return;
    }
    const file = join(OUT, path.replace(/^\//, ""));
    if (!file.startsWith(OUT) || !existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream",
      ...ISOLATION,
    });
    response.end(readFileSync(file));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, origin: `http://127.0.0.1:${port}` });
    });
  });
}
