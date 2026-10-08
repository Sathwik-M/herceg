import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

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
    browser: {
      enabled: true,
      headless: true,
      // The locally installed Chrome; no browser download needed.
      provider: playwright({ launchOptions: { channel: "chrome" } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
