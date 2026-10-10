import { defineConfig } from "vitest/config";
import { browsers } from "../../scripts/browser/browsers.ts";
import { commands } from "../../scripts/browser/commands.ts";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/browser/**"],
          environment: "node",
        },
      },
      {
        test: {
          name: "browser",
          include: ["test/browser/**/*.test.ts"],
          setupFiles: ["../../scripts/browser/setup.ts"],
          browser: {
            enabled: true,
            headless: true,
            instances: browsers,
            commands,
          },
        },
      },
    ],
  },
});
