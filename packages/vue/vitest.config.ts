import { defineConfig } from "vitest/config";
import { browsers } from "../../scripts/browser/browsers.ts";

export default defineConfig({
  resolve: {
    alias: [
      { find: "herceg", replacement: new URL("../herceg/src/index.ts", import.meta.url).pathname },
      // Vue's full build compiles the tests' inline templates at runtime, as
      // an SFC compiler would at build time.
      { find: /^vue$/, replacement: "vue/dist/vue.esm-browser.js" },
    ],
  },
  test: {
    include: ["test/**/*.test.ts"],
    browser: {
      enabled: true,
      headless: true,
      instances: browsers,
    },
  },
});
