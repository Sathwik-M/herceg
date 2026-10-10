import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const source = (path: string) => new URL(`../packages/${path}`, import.meta.url).pathname;

export default defineConfig({
  root: new URL(".", import.meta.url).pathname,
  resolve: {
    // Exact matches, so "herceg" does not also rewrite "herceg/pdf".
    alias: [
      { find: /^herceg$/, replacement: source("herceg/src/index.ts") },
      { find: /^herceg\/pdf$/, replacement: source("herceg/src/pdf.ts") },
      { find: /^@herceg\/react$/, replacement: source("react/src/index.ts") },
    ],
  },
  // Prebundled up front: discovered mid-run, they would reload the page under the tests.
  optimizeDeps: {
    include: [
      "echarts",
      "chart.js/auto",
      "chartjs-adapter-date-fns",
      "plotly.js-dist-min",
      "d3-scale",
      "react",
      "react-dom/client",
      "@tanstack/charts",
      "@tanstack/charts/canvas",
      "@tanstack/charts/cursor",
      "@tanstack/charts/export",
      "@tanstack/charts/interaction/signal",
      "@tanstack/charts/interaction/zoom",
      "@tanstack/charts/react",
      "@tanstack/charts/react/tooltip",
      "@tanstack/charts/scales/band",
      "@tanstack/charts/scales/linear",
      "@tanstack/charts/tooltip",
    ],
  },
  test: {
    // The common-task samples (src/ease): each one mounts and draws.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    browser: {
      enabled: true,
      headless: true,
      // The locally installed Chrome; no browser download needed.
      provider: playwright({ launchOptions: { channel: "chrome" } }),
      instances: [{ browser: "chromium" }],
      // Room for the 640 px charts, which the default 414 px viewport would cut off.
      viewport: { width: 1024, height: 900 },
    },
  },
});
