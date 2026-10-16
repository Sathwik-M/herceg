import { defineConfig } from "vitest/config";
import { browsers } from "../../scripts/browser/browsers.ts";

const engine = (file: string) => new URL(`../herceg/src/${file}`, import.meta.url).pathname;

export default defineConfig({
  // Prebundle every entry used by the tests, including the JSX transform.
  // Discovering dependencies mid-test can reload the page and lose module mocks.
  optimizeDeps: {
    include: ["react", "react/jsx-runtime", "react-dom", "react-dom/client", "react-dom/server"],
  },
  resolve: {
    // Exact matches, so "herceg" does not also rewrite "herceg/grid".
    alias: [
      { find: /^herceg$/, replacement: engine("index.ts") },
      { find: /^herceg\/grid$/, replacement: engine("grid.ts") },
      { find: /^herceg\/layout$/, replacement: engine("layout.ts") },
    ],
  },
  test: {
    include: ["test/**/*.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      instances: browsers,
    },
  },
});
