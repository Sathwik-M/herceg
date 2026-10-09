import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const engine = (file: string) => new URL(`../herceg/src/${file}`, import.meta.url).pathname;

export default defineConfig({
  resolve: {
    // Exact matches, so "herceg" does not also rewrite "herceg/grid".
    alias: [
      { find: /^herceg$/, replacement: engine("index.ts") },
      { find: /^herceg\/grid$/, replacement: engine("grid.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      provider: playwright({ launchOptions: { channel: "chrome" } }),
      instances: [{ browser: "chromium" }],
    },
  },
});
