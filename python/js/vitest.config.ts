import { defineConfig } from "vitest/config";
import { browsers } from "../../scripts/browser/browsers.ts";

const engine = (file: string) =>
  new URL(`../../packages/herceg/src/${file}`, import.meta.url).pathname;

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  resolve: {
    // Exact matches, so "herceg" does not also rewrite "herceg/spec".
    alias: [
      { find: /^herceg$/, replacement: engine("index.ts") },
      { find: /^herceg\/spec$/, replacement: engine("from-spec.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    setupFiles: ["../../scripts/browser/setup.ts"],
    browser: {
      enabled: true,
      headless: true,
      instances: browsers,
    },
  },
});
