import { svelte } from "@sveltejs/vite-plugin-svelte";
import { createServer, type ViteDevServer } from "vite";
import { defineConfig } from "vitest/config";
import type { BrowserCommand } from "vitest/node";
import { browsers } from "../../scripts/browser/browsers.ts";

// Exact matches, so "herceg" does not also rewrite "herceg/layout".
const herceg = [
  { find: /^herceg$/, replacement: new URL("../herceg/src/index.ts", import.meta.url).pathname },
  {
    find: /^herceg\/layout$/,
    replacement: new URL("../herceg/src/layout.ts", import.meta.url).pathname,
  },
];

/**
 * Renders a test fixture on a server, as SvelteKit does: in Node, compiled
 * for Svelte's server output. The fixture's module script makes the chart's
 * snapshot, which the browser hydrates with the markup.
 */
const renderOnServer: BrowserCommand<[fixture: string]> = async (_context, fixture) => {
  const vite: ViteDevServer = await createServer({
    configFile: false,
    root: new URL(".", import.meta.url).pathname,
    plugins: [svelte({ configFile: false })],
    resolve: { alias: herceg },
    server: { middlewareMode: true, hmr: false, ws: false },
    appType: "custom",
    logLevel: "error",
  });
  try {
    const module = (await vite.ssrLoadModule(fixture)) as {
      default: never;
      snapshot(): unknown;
    };
    const { render } = (await vite.ssrLoadModule(
      "svelte/server",
    )) as typeof import("svelte/server");
    const initial = module.snapshot();
    const { body } = render(module.default, { props: { initial } as never });
    return { body, initial };
  } finally {
    await vite.close();
  }
};

export default defineConfig({
  plugins: [svelte({ configFile: false })],
  // Discovering dependencies mid-test can reload the page and lose module mocks.
  // The Svelte plugin also includes the compiler's svelte/* runtime imports.
  optimizeDeps: { include: ["svelte"] },
  resolve: { alias: herceg },
  test: {
    // Test files use runes, which Svelte compiles only in `.svelte.ts` modules.
    include: ["test/**/*.test.svelte.ts"],
    browser: {
      enabled: true,
      headless: true,
      instances: browsers,
      commands: { renderOnServer },
    },
  },
});
