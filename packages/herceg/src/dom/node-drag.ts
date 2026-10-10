// Moving a network's nodes with `interaction.drag`: dragging a node moves
// it, its links following, and it stays where it is dropped (nothing else
// moves: the layout is not run again); Shift with the arrow keys moves the
// node the keyboard reads, and 0 and the toolbar's button put moved nodes
// back. A drag draws the node where the pointer is each frame and makes it
// a move once dropped, reported as an `itemMove` event. Moves are made on
// what the chart drew, in the layout the user sees: a change of the
// network's data not drawn yet lays it out again, which drops them.

import type { NodeMoves } from "../marks/graph.ts";
import type { ChartConfig } from "../model/model.ts";
import type { Scene } from "../scene/scene.ts";
import { DRAG_THRESHOLD } from "./brushed.ts";
import type { Controls as ChartControls, ControlsHost } from "./controls.ts";
import { RESET_GLYPH, Toolbar } from "./toolbar.ts";

/** Pixels a key press moves a node. */
const STEP = 10;

const WAYS: Record<string, [number, number, string]> = {
  ArrowLeft: [-1, 0, "left"],
  ArrowRight: [1, 0, "right"],
  ArrowUp: [0, -1, "up"],
  ArrowDown: [0, 1, "down"],
};

export class Controls implements ChartControls {
  readonly #host: ControlsHost;
  readonly #root: HTMLElement;
  readonly #toolbar: Toolbar;
  readonly #stop: (() => void)[] = [];
  #drags = false;
  /** A press on a node: its pointer and key, where the press and the node started. */
  #press: {
    pointer: number;
    key: string;
    x: number;
    y: number;
    from: [number, number];
    moves: NodeMoves;
    moved: boolean;
  } | null = null;

  constructor(host: ControlsHost) {
    this.#host = host;
    const root = host.chart.root;
    this.#root = root;
    this.#toolbar = new Toolbar(root, "Network", [
      { label: "Put moved nodes back", glyph: RESET_GLYPH, act: () => this.#reset() },
    ]);
    this.#listen();
  }

  get busy(): boolean {
    return this.#press?.moved ?? false;
  }

  update(config: ChartConfig): void {
    this.#drags = !!config.interaction?.drag;
    // Touches drag nodes rather than scroll the page.
    this.#root.style.touchAction = this.#drags ? "none" : "";
  }

  draw(scene: Scene): void {
    this.#toolbar.style(scene.theme);
    this.#toolbar.shown = this.#drags && (this.#host.model.items?.movedItems.size ?? 0) > 0;
  }

  dispose(): void {
    for (const stop of this.#stop.splice(0)) stop();
    this.#toolbar.dispose();
    this.#cancel();
  }

  #moves(): NodeMoves | undefined {
    return this.#host.model.items?.result()?.moves;
  }

  /** Whether the node a press is on is still drawn in the layout it was pressed in. */
  #still(press: { key: string; moves: NodeMoves }): boolean {
    const moves = this.#moves();
    return moves?.layout === press.moves.layout && moves.current() && moves.movable(press.key);
  }

  #point(event: MouseEvent): [number, number] {
    const rect = this.#root.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  /** Moves the node keyed `key` to a place in layout units, in the layout `moves` drew. */
  #moveTo(key: string, moves: NodeMoves, [x, y]: readonly [number, number]): void {
    const items = this.#host.model.items;
    items?.setItemPosition(key, { x, y }, moves.layout);
  }

  #reset(): void {
    const items = this.#host.model.items;
    if (!items) return;
    for (const key of [...items.movedItems.keys()]) items.setItemPosition(key, null);
    this.#host.announce("Put the moved nodes back.");
  }

  /** Ends a drag that did not drop its node: it shows where it was. */
  #cancel(): void {
    if (!this.#press) return;
    this.#press = null;
    this.#host.model.items?.drag(null);
    this.#host.invalidate();
  }

  #listen(): void {
    const root = this.#root;
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      handler: (event: HTMLElementEventMap[K]) => void,
      options?: AddEventListenerOptions,
    ) => {
      root.addEventListener(type, handler, options);
      this.#stop.push(() => root.removeEventListener(type, handler, options));
    };
    on("pointerdown", (event) => {
      if (!this.#drags || this.#press || event.button !== 0) return;
      if (this.#toolbar.contains(event.target) || !this.#host.onPlot(event.target)) return;
      const moves = this.#moves();
      const [x, y] = this.#point(event);
      const inspection = this.#host.model.inspect(x, y);
      const key = inspection?.axis === "item" ? inspection.key : undefined;
      const from = key !== undefined && moves?.movable(key) ? moves.pixelOf(key) : undefined;
      if (!from || !moves) return;
      this.#press = { pointer: event.pointerId, key: key!, x, y, from, moves, moved: false };
      root.setPointerCapture?.(event.pointerId);
    });
    on("pointermove", (event) => {
      const press = this.#press;
      if (!press || event.pointerId !== press.pointer) return;
      const [x, y] = this.#point(event);
      press.moved ||= Math.hypot(x - press.x, y - press.y) >= DRAG_THRESHOLD;
      if (!press.moved) return;
      // The network's data changed under the drag: it ends without a move.
      if (!this.#still(press)) {
        this.#cancel();
        return;
      }
      const at = press.moves.toLayout(
        press.key,
        press.from[0] + x - press.x,
        press.from[1] + y - press.y,
      );
      this.#host.model.items?.drag(press.key, at);
      this.#host.invalidate();
    });
    on("pointerup", (event) => {
      const press = this.#press;
      if (!press || event.pointerId !== press.pointer) return;
      this.#press = null;
      if (!press.moved) return;
      if (!this.#still(press)) {
        this.#host.model.items?.drag(null);
        this.#host.invalidate();
        return;
      }
      const [x, y] = this.#point(event);
      const at = press.moves.toLayout(
        press.key,
        press.from[0] + x - press.x,
        press.from[1] + y - press.y,
      );
      this.#moveTo(press.key, press.moves, at);
      this.#host.announce(`Moved ${nameOf(press.key)}.`);
    });
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === this.#press?.pointer) this.#cancel();
    };
    on("pointercancel", cancel);
    on("lostpointercapture", cancel);
    // Ahead of the chart's keys, which read the nodes and links with the arrows.
    on("keydown", (event) => this.#key(event), { capture: true });
  }

  /** Shift with an arrow key moves the node read; 0 puts every moved node back. */
  #key(event: KeyboardEvent): void {
    if (!this.#drags || event.target !== this.#root) return;
    const way = event.shiftKey ? WAYS[event.key] : undefined;
    if (way) {
      const key = this.#host.cursor();
      const moves = this.#moves();
      // A step from where the node is, or was last moved to though not drawn there yet.
      const moved = key === undefined ? undefined : this.#host.model.items?.movedItems.get(key);
      const pixel =
        key !== undefined && moves?.movable(key) ? moves.pixelOf(key, moved) : undefined;
      if (!pixel) return;
      const [px, py] = pixel;
      this.#moveTo(key!, moves!, moves!.toLayout(key!, px + way[0] * STEP, py + way[1] * STEP));
      this.#host.announce(`Moved ${nameOf(key!)} ${way[2]}.`);
    } else if (event.key === "0") this.#reset();
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

/** A node's name, from its item key (its mark's id and its name). */
function nameOf(key: string): string {
  return String((JSON.parse(key) as unknown[])[1]);
}
