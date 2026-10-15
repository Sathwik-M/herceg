import { defineConfig } from "vitest/config";
import { browsers } from "../../scripts/browser/browsers.ts";

export default defineConfig({
  // Discovering dependencies mid-test can reload the page and lose module mocks.
  optimizeDeps: { include: ["vue", "vue/server-renderer"] },
  resolve: {
    alias: [
      { find: "herceg", replacement: new URL("../herceg/src/index.ts", import.meta.url).pathname },
      // Vue's full build compiles the tests' inline templates at runtime, as
      // an SFC compiler would at build time.
      { find: /^vue$/, replacement: "vue/dist/vue.esm-browser.js" },
      // The server renderer of the SSR tests renders with that same runtime.
      { find: /^@vue\/runtime-dom$/, replacement: "vue/dist/vue.esm-browser.js" },
    ],
  },
  // The flags the server renderer's bundler build reads, as a bundler defines them.
  define: {
    __VUE_OPTIONS_API__: "true",
    __VUE_PROD_DEVTOOLS__: "false",
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: "true",
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
