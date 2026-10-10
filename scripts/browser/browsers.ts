/// <reference types="node" />
// The engines every browser test suite runs in: the installed Google Chrome,
// and Playwright's Firefox and WebKit builds (`npx playwright install firefox
// webkit`). `HERCEG_BROWSERS=chromium` (or a list, `firefox,webkit`) runs
// only those.

import { join } from "node:path";
import { playwright } from "@vitest/browser-playwright";
import type { BrowserInstanceOption } from "vitest/node";
import { createFirefoxAppData } from "./firefox.ts";

const firefoxData = createFirefoxAppData();

/** Where Firefox's remote debugging protocol listens, for what Juggler does not offer. */
export const firefoxDevTools = join(firefoxData.directory, "devtools.sock");

const engines: BrowserInstanceOption[] = [
  { browser: "chromium", provider: playwright({ launchOptions: { channel: "chrome" } }) },
  {
    browser: "firefox",
    // Its pages share one mouse: real input in test files running at once
    // lands in each other's drags.
    fileParallelism: false,
    provider: playwright({
      launchOptions: {
        env: firefoxData.env,
        args: ["-start-debugger-server", firefoxDevTools],
        firefoxUserPrefs: {
          "devtools.debugger.remote-enabled": true,
          "devtools.chrome.enabled": true,
          "devtools.debugger.prompt-connection": false,
        },
      },
    }),
  },
  { browser: "webkit", provider: playwright() },
];

const chosen = process.env.HERCEG_BROWSERS?.split(",").map((name) => name.trim());
for (const name of chosen ?? [])
  if (!engines.some(({ browser }) => browser === name))
    throw new Error(
      `HERCEG_BROWSERS: no browser "${name}"; name chromium, firefox, or webkit, comma-separated`,
    );

export const browsers = engines.filter(({ browser }) => !chosen || chosen.includes(browser));
