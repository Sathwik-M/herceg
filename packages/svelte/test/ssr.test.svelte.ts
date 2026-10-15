// Server rendering: Svelte's server output, made in Node as SvelteKit makes
// it, hydrated in the browser without a mismatch, the chart adopting its nodes.

import type { ChartSnapshot, Chart as HercegChart } from "herceg";
import { flushSync, hydrate, unmount } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import Hydrated from "./Hydrated.svelte";

declare module "vitest/browser" {
  interface BrowserCommands {
    renderOnServer(fixture: string): Promise<{ body: string; initial: ChartSnapshot }>;
  }
}

let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  host.style.width = "600px";
  document.body.append(host);
});

afterEach(() => {
  host.remove();
});

describe("server rendering", () => {
  it("hydrates without a mismatch, and the chart takes the server's nodes over", async () => {
    const { body, initial } = await commands.renderOnServer("/test/Hydrated.svelte");
    host.innerHTML = body;
    const figure = host.querySelector("[role=figure]")!;
    const nodes = [...host.querySelectorAll("svg [data-kind]")];
    expect(nodes.length).toBeGreaterThan(0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const props = $state<{ initial: ChartSnapshot; chart: HercegChart | null }>({
      initial,
      chart: null,
    });
    const app = hydrate(Hydrated, { target: host, props, recover: false });
    flushSync();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    expect(props.chart!.root).toBe(figure);
    // The mark component was there when the chart took the markup over.
    expect([...host.querySelectorAll("svg [data-kind]")]).toEqual(nodes);
    expect(props.chart!.getLegend()).toHaveLength(1);
    unmount(app);
  });
});
