// Moving a network's nodes with `interaction.drag`: dragging a node moves
// it, its links following, and it stays where it is dropped (nothing else
// moves: the layout is not run again); Shift with the arrow keys moves the
// node the keyboard reads (Alt+Shift when zoom is on); 0 without zoom
// and the toolbar's button put moved nodes
// back. A drag draws the node where the pointer is each frame and makes it
// a move once dropped, reported as an `itemMove` event. Moves are made on
// what the chart drew, in the layout the user sees: a change of the
// network's data not drawn yet lays it out again, which drops them. Facet
// panels' networks share one layout, so a node moved in one moves in all;
// a subplot's network has moves of its own.

import type { NodeMoves } from "../marks/graph.ts";
import type { ChartConfig } from "../model/model.ts";
import type { Scene } from "../scene/scene.ts";
import { DRAG_THRESHOLD } from "./brushed.ts";
import { type Controls as ChartControls, type ControlsHost, PointerOwnership } from "./controls.ts";
import { Controls as PlaneControls } from "./map-controls.ts";
import { RESET_GLYPH } from "./toolbar.ts";

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
  readonly #navigation: PlaneControls;
  readonly #pointer = new PointerOwnership();
  readonly #stop: (() => void)[] = [];
  #drags = false;
  /** A press on a node: its pointer, panel, and key, where the press and the node started. */
  #press: {
    pointer: number;
    panel: string;
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
    const moved = (panel: string) => this.#drags && this.#moved(panel) > 0;
    this.#navigation = new PlaneControls(
      host,
      "network",
      (event, panel) => this.#onNode(event, panel),
      (panel) => [
        {
          label: "Put moved nodes back",
          glyph: RESET_GLYPH,
          act: () => this.#reset(panel()),
          hidden: () => !moved(panel()),
        },
      ],
      moved,
      this.#pointer,
    );
    // A drag maps the pointer through its plane's view: a change of that view ends it.
    this.#stop.push(
      host.chart.on("viewport", ({ panels }) => {
        const press = this.#press;
        const state = host.model.items?.panels.find(({ key }) => key === press?.panel)?.state;
        if (state === (panels?.[0] ?? "")) this.#cancel();
      }),
    );
    this.#listen();
  }

  get busy(): boolean {
    return this.#navigation.busy || (this.#press?.moved ?? false);
  }

  update(config: ChartConfig): void {
    this.#drags = !!config.interaction?.drag;
    this.#navigation.update(config);
    if (this.#drags) this.#root.style.touchAction = "none";
    if (!this.#drags) this.#cancel();
  }

  draw(scene: Scene): void {
    this.#navigation.draw(scene);
  }

  dispose(): void {
    for (const stop of this.#stop.splice(0)) stop();
    this.#navigation.dispose();
    this.#cancel();
  }

  /** How many nodes the network of panel `panel` has moved. */
  #moved(panel: string): number {
    return this.#host.model.items?.movedItems(panel).size ?? 0;
  }

  /** What moving nodes of panel `panel`'s network needs, as last drawn. */
  #moves(panel: string): NodeMoves | undefined {
    return this.#host.model.items?.result(panel)?.moves;
  }

  /** Whether the node a press is on is still drawn in the layout it was pressed in. */
  #still(press: { panel: string; key: string; moves: NodeMoves }): boolean {
    const moves = this.#moves(press.panel);
    return moves?.layout === press.moves.layout && moves.current() && moves.movable(press.key);
  }

  #onNode(event: PointerEvent, panel: string): boolean {
    if (
      !this.#drags ||
      this.#navigation.lassoing ||
      (event.shiftKey && this.#host.model.config.interaction?.zoom)
    )
      return false;
    const [x, y] = this.#point(event);
    const inspection = this.#host.model.inspect(x, y);
    return inspection?.axis === "item" && !!this.#moves(panel)?.movable(inspection.key);
  }

  #point(event: MouseEvent): [number, number] {
    const rect = this.#root.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }

  /** Moves the node keyed `key` to a place in layout units, in the layout `moves` drew in panel `panel`. */
  #moveTo(panel: string, key: string, moves: NodeMoves, [x, y]: readonly [number, number]): void {
    this.#host.model.items?.setItemPosition(key, { x, y }, panel, moves.layout);
  }

  #reset(panel: string): void {
    const items = this.#host.model.items;
    if (!items) return;
    for (const key of [...items.movedItems(panel).keys()]) items.setItemPosition(key, null, panel);
    this.#host.announce("Put the moved nodes back.");
  }

  /** Ends a drag that did not drop its node: it shows where it was. */
  #cancel(): void {
    if (!this.#press) return;
    this.#pointer.release(this.#press.pointer);
    this.#press = null;
    this.#host.model.items?.drag(null);
    this.#host.invalidate();
  }

  /** The panel drawing a network that holds a pixel of the chart. */
  #panelAt(x: number, y: number): string | undefined {
    return this.#host.model.items?.panels.find(
      ({ plot, result }) =>
        result.moves &&
        x >= plot.x &&
        x <= plot.x + plot.width &&
        y >= plot.y &&
        y <= plot.y + plot.height,
    )?.key;
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
      if (this.#press || event.button !== 0) return;
      if (this.#navigation.contains(event.target) || !this.#host.onPlot(event.target)) return;
      const [x, y] = this.#point(event);
      const panel = this.#panelAt(x, y);
      if (panel === undefined || !this.#onNode(event, panel)) return;
      const moves = this.#moves(panel);
      const inspection = this.#host.model.inspect(x, y);
      const key = inspection?.axis === "item" ? inspection.key : undefined;
      const from = key !== undefined && moves?.movable(key) ? moves.pixelOf(key) : undefined;
      if (!from || !moves) return;
      if (!this.#pointer.acquire(event.pointerId)) return;
      this.#press = { pointer: event.pointerId, panel, key: key!, x, y, from, moves, moved: false };
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
      this.#host.model.items?.drag(press.key, at, press.panel);
      this.#host.invalidate();
    });
    on("pointerup", (event) => {
      const press = this.#press;
      if (!press || event.pointerId !== press.pointer) return;
      this.#pointer.release(press.pointer);
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
      this.#moveTo(press.panel, press.key, press.moves, at);
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

  /**
   * Shift with an arrow key moves the node read; 0 puts every moved node
   * back, in the panel the keyboard reads (or the chart's one network).
   */
  #key(event: KeyboardEvent): void {
    if (!this.#drags || event.target !== this.#root) return;
    const zooms = !!this.#host.model.config.interaction?.zoom;
    const cursor = this.#host.cursor();
    const networks = this.#host.model.items?.panels.filter(({ result }) => result.moves) ?? [];
    const panel = cursor
      ? cursor.panel
      : networks.every(({ state }) => state === networks[0]?.state)
        ? networks[0]?.key
        : undefined;
    const moves = panel === undefined ? undefined : this.#moves(panel);
    if (!moves) return;
    const way = event.shiftKey && (!zooms || event.altKey) ? WAYS[event.key] : undefined;
    if (way) {
      const key = cursor?.key;
      // A step from where the node is, or was last moved to though not drawn there yet.
      const moved =
        key === undefined ? undefined : this.#host.model.items?.movedItems(panel).get(key);
      const pixel = key !== undefined && moves.movable(key) ? moves.pixelOf(key, moved) : undefined;
      if (!pixel) return;
      const [px, py] = pixel;
      this.#moveTo(
        panel!,
        key!,
        moves,
        moves.toLayout(key!, px + way[0] * STEP, py + way[1] * STEP),
      );
      this.#host.announce(`Moved ${nameOf(key!)} ${way[2]}.`);
    } else if (event.key === "0" && !zooms) this.#reset(panel!);
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}

/** A node's name, from its item key (its mark's id and its name). */
function nameOf(key: string): string {
  return String((JSON.parse(key) as unknown[])[1]);
}
