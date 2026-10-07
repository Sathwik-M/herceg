import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { herceg: new URL("../herceg/src/index.ts", import.meta.url).pathname } },
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
