// Sync between charts that share no module: made by two copies of herceg on
// one page (a notebook's widgets each load their own), or in sandboxed
// frames of their own (static notebook outputs), which a relay links.

import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";
import "./helpers.ts";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const added: Element[] = [];

afterEach(() => {
  for (const element of added.splice(0)) element.remove();
});

function host(): HTMLDivElement {
  const element = document.createElement("div");
  element.style.cssText = "width:400px;height:200px";
  document.body.append(element);
  added.push(element);
  return element;
}

type Herceg = typeof import("../../src/index.ts");

describe("sync across copies of herceg", () => {
  it("links charts that two copies of the engine made, cursor and view", async () => {
    const code = await commands.bundleHerceg("esm");
    const [a, b] = (await Promise.all(
      [0, 1].map(
        (_) =>
          import(
            /* @vite-ignore */ URL.createObjectURL(new Blob([code], { type: "text/javascript" }))
          ),
      ),
    )) as [Herceg, Herceg];
    expect(a.createChart).not.toBe(b.createChart);
    const chart = (h: Herceg) =>
      h.createChart(host(), {
        marks: [h.line(h.table({ x: [0, 1, 2, 3], y: [1, 2, 3, 4] }), { x: "x", y: "y" })],
        interaction: { zoom: "x", sync: "copies" },
      });
    const [one, two] = [chart(a), chart(b)];
    const hovers: unknown[] = [];
    two.on("hover", ({ inspection }) => hovers.push(inspection?.value));
    one.showCursor({ x: 2 });
    await two.loading;
    await frame();
    expect(hovers.at(-1)).toBe(2);
    one.setViewport([1, 2]);
    expect(two.getViewport().x).toEqual([1, 2]);
    one.destroy();
    two.destroy();
  });
});

describe("the frame relay", () => {
  it("takes part in groups while its frame's charts do, then leaves and stops", async () => {
    const { relay } = await import("../../src/dom/relay.ts");
    const entered: string[][] = [];
    const left: string[][] = [];
    const kit = {
      enter: (keys: readonly string[]) => {
        entered.push([...keys]);
        return () => left.push([...keys]);
      },
      broadcast: () => {},
    };
    const slot = Symbol.for("herceg.relay/1");
    const page = globalThis as unknown as Record<symbol, unknown>;
    const one = relay(["cursor ops"], kit);
    const two = relay(["cursor ops", "viewport ops"], kit);
    // One member per group, whichever charts ask.
    expect(entered).toEqual([["cursor ops"], ["viewport ops"]]);
    one();
    expect(left).toEqual([]);
    two();
    expect(left).toEqual([["cursor ops"], ["viewport ops"]]);
    expect(page[slot]).toBeUndefined();
  });
});

describe("sync across sandboxed frames", () => {
  /** A page of one chart syncing its cursor in group "frames", which reports to its parent. */
  const page = (code: string, script: string) =>
    `<!doctype html><body style="margin:0"><div id="chart" style="width:400px;height:200px"></div>` +
    `<script>${code.replaceAll("</script", "<\\/script")}</script><script>${script}</script></body>`;
  const chart = `
    const data = herceg.table({ x: [0, 1, 2, 3], y: [1, 2, 3, 4] });
    const chart = herceg.createChart(document.getElementById("chart"), {
      marks: [herceg.line(data, { x: "x", y: "y" })],
      interaction: { sync: { cursor: "frames" } },
    });`;
  const sender = `${chart}
    let echoes = 0;
    addEventListener("message", (event) => {
      if (event.data?.herceg && event.data.channel) echoes++;
      if (event.data?.test === "go") chart.showCursor({ x: event.data.x });
      if (event.data?.test === "count") parent.postMessage({ test: "echoes", value: echoes }, "*");
    });
    parent.postMessage({ test: "ready" }, "*");`;
  const receiver = `${chart}
    chart.on("hover", ({ inspection }) =>
      parent.postMessage({ test: "hover", value: inspection ? inspection.value : null }, "*"));
    parent.postMessage({ test: "ready" }, "*");`;
  /** A frame holding another, which passes its child's reports up. */
  const nesting = (inner: string) =>
    `<!doctype html><body style="margin:0"><script>
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.style.cssText = "width:420px;height:220px;border:0";
      frame.srcdoc = ${JSON.stringify(inner).replaceAll("</script", "<\\/script")};
      document.body.append(frame);
      addEventListener("message", (event) => {
        if (event.data?.test) parent.postMessage(event.data, "*");
      });
    </script></body>`;

  function sandboxed(html: string): HTMLIFrameElement {
    const element = document.createElement("iframe");
    element.setAttribute("sandbox", "allow-scripts");
    element.style.cssText = "width:440px;height:240px;border:0;display:block";
    element.srcdoc = html;
    document.body.append(element);
    added.push(element);
    return element;
  }

  it("relays a cursor to a chart in another frame, nested too, and not back", async () => {
    const code = await commands.bundleHerceg("iife");
    const heard: { test: string; value?: unknown }[] = [];
    const listen = (event: MessageEvent) => {
      if (event.data?.test) heard.push(event.data);
    };
    addEventListener("message", listen);
    try {
      const from = sandboxed(page(code, sender));
      sandboxed(nesting(page(code, receiver)));
      // Each frame loads and runs the whole bundle, which takes a while on slow machines.
      await expect
        .poll(() => heard.filter(({ test }) => test === "ready").length, { timeout: 10_000 })
        .toBe(2);
      // The relays find each other as they start; a cursor shown before then is
      // not relayed, so it is shown again until the receiver hears it.
      await expect
        .poll(
          () => {
            from.contentWindow!.postMessage({ test: "go", x: 2 }, "*");
            return heard.filter(({ test }) => test === "hover").at(-1)?.value;
          },
          { timeout: 10_000 },
        )
        .toBe(2);
      // What the receiver heard, it shared in its frame alone: nothing came back.
      for (let i = 0; i < 5; i++) await frame();
      from.contentWindow!.postMessage({ test: "count" }, "*");
      await expect
        .poll(() => heard.find(({ test }) => test === "echoes")?.value, { timeout: 5_000 })
        .toBe(0);
    } finally {
      removeEventListener("message", listen);
    }
  });
});
