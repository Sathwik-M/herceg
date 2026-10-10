// For browser tests that make up pointer events.

import { server } from "vitest/browser";

/**
 * The mouse's pointer id: an id of no pointer makes `setPointerCapture`
 * throw. Firefox numbers the mouse 0 (and lets a page capture it once the
 * mouse has been over the page, which setup.ts sees to), Chrome and WebKit 1.
 */
export const MOUSE = server.browser === "firefox" ? 0 : 1;
