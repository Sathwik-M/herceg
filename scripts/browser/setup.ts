// Runs in the browser before each test file of the suites that make up
// pointer events. Firefox lets a page capture its mouse pointer only once
// the mouse has been over it, so in Firefox the mouse moves over the page
// first; see `MOUSE` in mouse.ts.

import { beforeAll } from "vitest";
import { server, userEvent } from "vitest/browser";

if (server.browser === "firefox") beforeAll(() => userEvent.hover(document.documentElement));
