import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";
import { browsers } from "../../scripts/browser/browsers.ts";

export default defineConfig({
  plugins: [svelte({ configFile: false })],
  // Discovering dependencies mid-test can reload the page and lose module mocks.
  // The Svelte plugin also includes the compiler's svelte/* runtime imports.
  optimizeDeps: { include: ["svelte"] },
  resolve: { alias: { herceg: new URL("../herceg/src/index.ts", import.meta.url).pathname } },
  test: {
    // Test files use runes, which Svelte compiles only in `.svelte.ts` modules.
    include: ["test/**/*.test.svelte.ts"],
    browser: {
      enabled: true,
      headless: true,
      instances: browsers,
    },
  },
});
