// Helpers shared by the browser tests.

import "./interactive.ts";
import { commands } from "vitest/browser";
import type { MouseInput } from "../../../../scripts/browser/commands.ts";

export { MOUSE } from "../../../../scripts/browser/mouse.ts";

import { type Chart, MountedChart } from "../../src/dom/chart.ts";
import type { ChartModel } from "../../src/model/model.ts";

declare module "vitest/browser" {
  interface BrowserCommands {
    accessibilityTree(root: string, states: readonly string[]): Promise<string[]>;
    bundleHerceg(format: "esm" | "iife"): Promise<string>;
    collectGarbage(): Promise<void>;
    mouse(input: MouseInput): Promise<void>;
  }
}

/** The x and width of a brush outline drawn as a rectangle, "M x0 y0 H x1 V y1 H x0 Z". */
export function bandBox(outline: Element): { x: number; width: number } {
  const [x0, , x1] = (outline.getAttribute("d") ?? "").match(/-?[\d.]+/g)!.map(Number);
  return { x: x0!, width: x1! - x0! };
}

/**
 * The accessibility tree the engine gives screen readers under the one node
 * of role `root`, one node a line: `role "name"`, then its description and
 * the `states` it has, indented by depth (scripts/browser/accessibility.ts).
 * Nodes assistive technology ignores are left out.
 */
export function accessibilityTree(root: string, states: readonly string[]): Promise<string[]> {
  return commands.accessibilityTree(root, states);
}

/**
 * Collects garbage in the page, so that what nothing holds is gone from weak
 * references; throws if an object nothing holds survives, so that a
 * collection that did not happen is not taken for a leak.
 */
export async function collectGarbage(): Promise<void> {
  const control = new WeakRef({});
  await commands.collectGarbage();
  if (control.deref()) throw new Error("collectGarbage: the engine collected nothing");
}

/**
 * Real mouse input, at a point of the page the browser's input lands on
 * (the test's frame is inside it).
 */
export function realMouse(input: MouseInput): Promise<void> {
  return commands.mouse(input);
}

/** Where `element` is in the page real input lands on. */
export function pageOrigin(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  const frame = window.frameElement?.getBoundingClientRect() ?? { left: 0, top: 0 };
  return { x: frame.left + rect.left, y: frame.top + rect.top };
}

/**
 * `text` with dates and times as Chrome's and Firefox's `Intl` write them,
 * "Jan 1, 2026, 00:00": WebKit's joins them with "at".
 */
export const dateTimes = (text: string) => text.replace(/(\d{4}) at (\d)/g, "$1, $2");

/** The model a chart draws from, for what no public method reports. */
export function modelOf(chart: Chart): ChartModel {
  return MountedChart.modelOf(chart);
}
