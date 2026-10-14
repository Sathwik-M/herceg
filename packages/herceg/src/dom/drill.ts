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
//
// Trees in facet panels share one root: every panel draws the path, the
// first panel's buttons are the ones the Tab key and screen readers reach
// (the others take the pointer only), and one toolbar in the chart's
// corner goes up in all of them. A subplot's tree has a root, a path, and
// a toolbar in its corner of its own. Clicks act in the panel clicked, keys
// in the panel the keyboard reads.

import type { Drill } from "../marks/tree-data.ts";
import type { ItemPanel } from "../model/item-views.ts";
import type { ChartConfig } from "../model/model.ts";
import type { Scene } from "../scene/scene.ts";
import type { Controls as ChartControls, ControlsHost } from "./controls.ts";
import { RESET_GLYPH, Toolbar } from "./toolbar.ts";

/** A panel drawing a tree, with the key of its state and the tree's drill. */
type TreePanel = ItemPanel & { state: string; drill: Drill };

export class Controls implements ChartControls {
  readonly busy = false;
  readonly #host: ControlsHost;
  readonly #root: HTMLElement;
  /** A toolbar per state: "" for the chart's one (or every facet panel's), a subplot's id for its own. */
  readonly #toolbars = new Map<string, Toolbar>();
  /** The breadcrumbs' buttons, over the steps each tree draws. */
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
    const keys = (event: KeyboardEvent) => this.#key(event);
    // Ahead of the chart's keys, which read the nodes with the arrows.
    root.addEventListener("keydown", keys, { capture: true });
    this.#stop.push(() => root.removeEventListener("keydown", keys, { capture: true }));
    // A click that selects no rows (no row selection of the chart takes clicks) drills.
    this.#stop.push(
      host.chart.on("click", ({ inspection, rows }) => {
        if (!rows && inspection?.axis === "item") this.#clicked(inspection.key, inspection.panel);
      }),
    );
  }

  /** Charts load these controls only while `interaction.zoom` is on: nothing changes here. */
  update(_config: ChartConfig): void {}

  draw(scene: Scene): void {
    const trees = this.#trees();
    const states = new Map<string, TreePanel>();
    for (const tree of trees) if (!states.has(tree.state)) states.set(tree.state, tree);
    for (const [state, toolbar] of this.#toolbars)
      if (!states.has(state)) {
        toolbar.dispose();
        this.#toolbars.delete(state);
      }
    for (const [state, { key, label, plot }] of states) {
      let toolbar = this.#toolbars.get(state);
      if (!toolbar) {
        // Its buttons act in the first panel drawn with the state, whichever facet panels are drawn now.
        const panel = () => this.#trees().find((tree) => tree.state === state)?.key;
        toolbar = new Toolbar(this.#root, state === "" ? "Tree" : `Tree, ${label}`, [
          { label: "Up one level", glyph: "M4 9l4-4 4 4M8 5v7", act: () => this.#up(panel()) },
          {
            label: "Show the whole tree",
            glyph: RESET_GLYPH,
            act: () => this.#open(null, panel()),
          },
        ]);
        this.#toolbars.set(state, toolbar);
      }
      toolbar.style(scene.theme);
      if (state !== "") toolbar.place(plot, scene.width, scene.height);
      toolbar.shown = this.#host.model.items?.drillRoot(key)?.key != null;
    }
    this.#placeCrumbs(trees, scene);
  }

  dispose(): void {
    for (const stop of this.#stop.splice(0)) stop();
    for (const toolbar of this.#toolbars.values()) toolbar.dispose();
    this.#toolbars.clear();
    this.#path.remove();
  }

  /** The panels drawing trees, in order, with their states and drills. */
  #trees(): TreePanel[] {
    return (this.#host.model.items?.panels ?? []).flatMap((panel) => {
      const drill = panel.result.drill;
      return drill ? [{ ...panel, drill }] : [];
    });
  }

  /** The tree drawn in panel `panel` (the chart's one by default). */
  #drill(panel?: string): Drill | undefined {
    return this.#host.model.items?.result(panel)?.drill;
  }

  #clicked(key: string, panel: string | undefined): void {
    const drill = this.#drill(panel);
    if (!drill) return;
    // A sunburst's middle is its root: a click there goes up.
    if (key === drill.key) this.#up(panel);
    else if (drill.opens(key)) this.#open(key, panel);
  }

  /** Drills panel `panel`'s tree into the node keyed `key` (null: the whole tree), and says where it is now. */
  #open(key: string | null, panel: string | undefined): void {
    const { chart, model } = this.#host;
    model.items?.setDrillRoot(key, panel);
    // Drawn now, so what is said is what the chart shows.
    chart.render();
    const path = model.items?.drillRoot(panel)?.path ?? [];
    const where = path.length > 0 ? path.map(({ label }) => label).join(" / ") : "The whole tree";
    // Facet panels share the root: one goes, they all go.
    const shared = model.config.facet ? ", in every panel" : "";
    this.#host.announce(`${where}${shared}. ${model.layoutSummary(panel) ?? ""}`.trim());
  }

  /** Goes up a level from the root set in panel `panel`, which a frame may not have drawn yet. */
  #up(panel: string | undefined): void {
    const root = this.#host.model.items?.drillRoot(panel);
    if (root?.key == null) return;
    this.#open(root.path.at(-2)?.key ?? null, panel);
  }

  /** Enter opens the node read, Backspace goes up, and 0 shows the whole tree, in the panel read. */
  #key(event: KeyboardEvent): void {
    if (event.target !== this.#root) return;
    // The panel the keyboard reads; without a cursor, the chart's one tree, if it has one.
    const cursor = this.#host.cursor();
    const [first] = this.#trees();
    const panel = cursor ? cursor.panel : first?.state === "" ? first.key : undefined;
    const drill = panel === undefined ? undefined : this.#drill(panel);
    if (!drill) return;
    // Backspace and 0 go from the root set, though a frame may not have drawn it yet.
    const drilled = this.#host.model.items?.drillRoot(panel)?.key != null;
    if (event.key === "Enter") {
      const key = cursor?.key;
      if (key === undefined) return;
      if (key === drill.key) this.#up(panel);
      else if (drill.opens(key)) this.#open(key, panel);
      else this.#host.announce("Nothing is under this node.");
    } else if (event.key === "Backspace" && drilled) this.#up(panel);
    else if (event.key === "0" && drilled) this.#open(null, panel);
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  /**
   * A button over each step of each tree's path but the last, which names
   * where the tree is; of trees sharing a root, those of the first take the
   * Tab key and screen readers, the others the pointer only.
   */
  #placeCrumbs(trees: readonly TreePanel[], scene: Scene): void {
    const made = JSON.stringify(trees.map(({ key, label, drill }) => [key, label, drill.crumbs]));
    if (made === this.#crumbs) return;
    this.#crumbs = made;
    const document = this.#root.ownerDocument;
    // A step pressed from the keyboard goes; focus stays in the chart.
    const focused = this.#path.contains(document.activeElement);
    const { theme } = scene;
    const font = `${theme.fontSize}px ${theme.font}`;
    const reached = new Set<string>();
    const navs = trees.map(({ key, label, state, drill }) => {
      // Inside a chart of one tree, the chart's nav is the tree's.
      const nav = trees.length === 1 ? this.#path : document.createElement("nav");
      const read = !reached.has(state);
      reached.add(state);
      if (nav !== this.#path) {
        nav.setAttribute("aria-label", state === "" ? "Path" : `Path, ${label}`);
        if (!read) nav.setAttribute("aria-hidden", "true");
      }
      const parts = drill.crumbs.map(({ key: node, label: name, x, y, width, height }, i) => {
        const last = i === drill.crumbs.length - 1;
        const part = document.createElement(last ? "span" : "button");
        part.textContent = name;
        // The drawing shows the text; the element is there to be pressed, focused, and read.
        part.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${width}px;height:${height}px;padding:0;margin:0;border:0;background:transparent;color:transparent;font:${font};white-space:nowrap;overflow:hidden;cursor:${last ? "default" : "pointer"}`;
        if (last) part.setAttribute("aria-current", "location");
        else {
          (part as HTMLButtonElement).type = "button";
          if (!read) part.tabIndex = -1;
          part.addEventListener("click", () => this.#open(node, key));
        }
        return part;
      });
      nav.replaceChildren(...parts);
      return nav;
    });
    if (trees.length !== 1) this.#path.replaceChildren(...navs);
    if (focused) this.#root.focus();
  }
}
