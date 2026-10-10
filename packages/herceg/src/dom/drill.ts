// Drilling into treemaps and sunbursts with `interaction.zoom`: a click on a
// node with nodes under it (unless the chart's row selection takes clicks,
// which then select its rows) and Enter on the node the keyboard reads
// show the subtree under it; a click on a sunburst's middle, Backspace,
// and the toolbar's buttons go back up, and 0 to the whole tree. The path
// the tree draws above itself is the breadcrumbs: native buttons lie over
// each step but the last, invisible until focused, so the pointer, the Tab
// key, and screen readers reach the steps the drawing shows. Each change
// is reported as a `drill` event; it is made on the tree drawn, and a node
// a change of data not drawn yet takes gives way to its nearest ancestor.

import type { Drill } from "../marks/tree-data.ts";
import type { ChartConfig } from "../model/model.ts";
import type { Scene } from "../scene/scene.ts";
import type { Controls as ChartControls, ControlsHost } from "./controls.ts";
import { RESET_GLYPH, Toolbar } from "./toolbar.ts";

export class Controls implements ChartControls {
  readonly busy = false;
  readonly #host: ControlsHost;
  readonly #root: HTMLElement;
  readonly #toolbar: Toolbar;
  /** The breadcrumbs' buttons, over the steps the tree draws. */
  readonly #path: HTMLElement;
  /** What the buttons were made for, so a frame that changes nothing keeps them (and focus). */
  #crumbs = "";
  readonly #stop: (() => void)[] = [];

  constructor(host: ControlsHost) {
    this.#host = host;
    const root = host.chart.root;
    this.#root = root;
    const document = root.ownerDocument;
    this.#path = document.createElement("nav");
    this.#path.setAttribute("aria-label", "Path");
    this.#path.style.cssText = "position:absolute;left:0;top:0";
    root.append(this.#path);
    this.#toolbar = new Toolbar(root, "Tree", [
      { label: "Up one level", glyph: "M4 9l4-4 4 4M8 5v7", act: () => this.#up() },
      { label: "Show the whole tree", glyph: RESET_GLYPH, act: () => this.#open(null) },
    ]);
    const keys = (event: KeyboardEvent) => this.#key(event);
    // Ahead of the chart's keys, which read the nodes with the arrows.
    root.addEventListener("keydown", keys, { capture: true });
    this.#stop.push(() => root.removeEventListener("keydown", keys, { capture: true }));
    // A click that selects no rows (no row selection of the chart takes clicks) drills.
    this.#stop.push(
      host.chart.on("click", ({ inspection, rows }) => {
        if (!rows && inspection?.axis === "item") this.#clicked(inspection.key);
      }),
    );
  }

  /** Charts load these controls only while `interaction.zoom` is on: nothing changes here. */
  update(_config: ChartConfig): void {}

  draw(scene: Scene): void {
    this.#toolbar.style(scene.theme);
    const drill = this.#drill();
    this.#toolbar.shown = drill?.key != null;
    this.#placeCrumbs(drill, scene);
  }

  #clicked(key: string): void {
    const drill = this.#drill();
    if (!drill) return;
    // A sunburst's middle is its root: a click there goes up.
    if (key === drill.key) this.#up();
    else if (drill.opens(key)) this.#open(key);
  }

  dispose(): void {
    for (const stop of this.#stop.splice(0)) stop();
    this.#toolbar.dispose();
    this.#path.remove();
  }

  #drill(): Drill | undefined {
    return this.#host.model.items?.result()?.drill;
  }

  /** Drills into the node keyed `key` (null: the whole tree), and says where the chart is now. */
  #open(key: string | null): void {
    const { chart, model } = this.#host;
    this.#host.itemsChanged("drill", model.items?.setDrillRoot(key));
    // Drawn now, so what is said is what the chart shows.
    chart.render();
    const path = chart.drillRoot?.path ?? [];
    const where = path.length > 0 ? path.map(({ label }) => label).join(" / ") : "The whole tree";
    this.#host.announce(`${where}. ${this.#host.model.layoutSummary() ?? ""}`.trim());
  }

  /** Goes up a level from the root set, which a frame may not have drawn yet. */
  #up(): void {
    const root = this.#host.model.items?.drillRoot();
    if (root?.key == null) return;
    this.#open(root.path.at(-2)?.key ?? null);
  }

  /** Enter opens the node read, Backspace goes up, and 0 shows the whole tree. */
  #key(event: KeyboardEvent): void {
    const drill = this.#drill();
    if (!drill || event.target !== this.#root) return;
    // Backspace and 0 go from the root set, though a frame may not have drawn it yet.
    const drilled = this.#host.model.items?.drillRoot()?.key != null;
    if (event.key === "Enter") {
      const key = this.#host.cursor();
      if (key === undefined) return;
      if (key === drill.key) this.#up();
      else if (drill.opens(key)) this.#open(key);
      else this.#host.announce("Nothing is under this node.");
    } else if (event.key === "Backspace" && drilled) this.#up();
    else if (event.key === "0" && drilled) this.#open(null);
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /** A button over each step of the path but the last, which names where the chart is. */
  #placeCrumbs(drill: Drill | undefined, scene: Scene): void {
    const crumbs = drill?.crumbs ?? [];
    const made = JSON.stringify(crumbs);
    if (made === this.#crumbs) return;
    this.#crumbs = made;
    const document = this.#root.ownerDocument;
    const { theme } = scene;
    const font = `${theme.fontSize}px ${theme.font}`;
    const parts = crumbs.map(({ key, label, x, y, width, height }, i) => {
      const last = i === crumbs.length - 1;
      const part = document.createElement(last ? "span" : "button");
      part.textContent = label;
      // The drawing shows the text; the element is there to be pressed, focused, and read.
      part.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;padding:0;margin:0;border:0;background:transparent;color:transparent;font:${font};white-space:nowrap;overflow:hidden;cursor:${last ? "default" : "pointer"}`;
      if (last) part.setAttribute("aria-current", "location");
      else {
        (part as HTMLButtonElement).type = "button";
        part.addEventListener("click", () => this.#open(key));
      }
      return part;
    });
    // A step pressed from the keyboard goes; focus stays in the chart.
    const focused = this.#path.contains(document.activeElement);
    this.#path.replaceChildren(...parts);
    if (focused) this.#root.focus();
  }
}
