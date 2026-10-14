/// <reference types="node" />
// Commands browser tests run in Node, through each engine's own protocol
// where Playwright has nothing for all three. Tests call them as
// `commands.name(...)` from "vitest/browser"; their types are in
// packages/herceg/test/browser/helpers.ts.

import type { BrowserCommand } from "vitest/node";
import { accessibilityTree } from "./accessibility.ts";
import { firefoxDevTools } from "./browsers.ts";
import { DevTools } from "./firefox-devtools.ts";
import { inspectorSession } from "./webkit-inspector.ts";

/** A real mouse event at a point of the page (not of the test's frame), as a person makes it. */
export interface MouseInput {
  type: "move" | "press" | "release" | "wheel";
  x: number;
  y: number;
  /** For presses and releases: 2 for the second of a double click. */
  clickCount?: number;
  deltaY?: number;
  shift?: boolean;
}

/** The event each input makes, which Firefox's input waits for. */
const EVENTS = { move: "pointermove", press: "pointerdown", release: "pointerup", wheel: "wheel" };

/** How many events of `type` the test's frame has seen, counting from the first ask. */
function seen(type: string): number {
  const counts = window as unknown as { hercegEvents?: Record<string, number> };
  counts.hercegEvents ??= {};
  const events = counts.hercegEvents;
  if (events[type] === undefined) {
    events[type] = 0;
    addEventListener(type, () => events[type]!++, { capture: true });
  }
  return events[type];
}

const mouse: BrowserCommand<[MouseInput]> = async (context, input) => {
  const { page } = context;
  // Firefox's protocol answers before the page has the event, and the page
  // gets one move a frame, the last, as a person's; WebKit's, on Linux, may
  // answer before the page has the event too. Each input waits until its
  // event has come, so that it lands before the next and before what the
  // test does after it, as Chrome's does. It asks again and again: a page
  // waiting on the protocol gets no input.
  const frame = context.project.config.browser.name !== "chromium" && (await context.frame());
  const type = EVENTS[input.type];
  const before = frame ? await frame.evaluate(seen, type) : 0;
  if (input.shift) await page.keyboard.down("Shift");
  try {
    await page.mouse.move(input.x, input.y);
    const clickCount = input.clickCount ?? 1;
    if (input.type === "press") await page.mouse.down({ clickCount });
    else if (input.type === "release") await page.mouse.up({ clickCount });
    else if (input.type === "wheel") await page.mouse.wheel(0, input.deltaY ?? 0);
    for (const start = Date.now(); frame && (await frame.evaluate(seen, type)) === before; )
      if (Date.now() - start > 2000)
        throw new Error(`mouse: no ${type} reached the test's frame at (${input.x}, ${input.y})`);
  } finally {
    if (input.shift) await page.keyboard.up("Shift");
  }
};

/** Collects the garbage of the test's page, cycles between the DOM and JavaScript too. */
const collectGarbage: BrowserCommand<[]> = async (context) => {
  const engine = context.project.config.browser.name;
  if (engine === "chromium") {
    const session = await context.page.context().newCDPSession(context.page);
    await session.send("HeapProfiler.collectGarbage");
    await session.detach();
  } else if (engine === "webkit") {
    // JavaScriptCore scans the stack conservatively: a pointer earlier calls
    // left there keeps its object. Deep calls write over them first.
    await (await context.frame()).evaluate(() => {
      const deep = (n: number): number => (n === 0 ? 0 : deep(n - 1) + 1);
      return deep(2000);
    });
    await inspectorSession(context.page).send("Heap.gc");
  } else {
    const devtools = await DevTools.connect(firefoxDevTools);
    try {
      const { memoryActor } = await devtools.target(context.page.url());
      await devtools.request(memoryActor!, "forceCycleCollection");
      await devtools.request(memoryActor!, "forceGarbageCollection");
    } finally {
      devtools.close();
    }
  }
};

export const commands = {
  accessibilityTree: accessibilityTree as BrowserCommand<[string, readonly string[]]>,
  collectGarbage,
  mouse,
};
