// What a chart's layout marks (pies, treemaps, maps, ...) drew in its last
// scene, panel by panel, and how tooltips, the keyboard, and the chart's
// description read their items; and what a chart of layout marks without
// facets or panels may have. A chart reaches this module through its
// layout marks (`LayoutMark.views`), so charts without any never load it.

import type { MovedNodes } from "../marks/graph.ts";
import type {
  LayoutControls,
  LayoutFrame,
  LayoutItem,
  LayoutMark,
  LayoutResult,
} from "../marks/layout-mark.ts";
import type { ChartMark } from "../marks/mark.ts";
import type { DrillRoot } from "../marks/tree-data.ts";
import type { Panel, Rect, Scene } from "../scene/scene.ts";
import type { ItemInspection } from "./inspect.ts";
import { EDGE } from "./legend.ts";
import type { ChartConfig, ChartModel } from "./model.ts";
import type { PanelItem } from "./panel-layout.ts";

/** Changes of layout items, reported by mounted charts through their matching events. */
export interface ItemChanges {
  drill: DrillRoot;
  itemMove: { key: string; position: { x: number; y: number } | null };
}

/** Optional navigation attached to layout items by an interactive runtime. */
export interface Controls {
  update(config: ChartConfig): void;
  draw(scene: Scene): void;
  readonly busy: boolean;
  dispose(): void;
}

/** A panel a layout mark drew in, and what it drew there. */
interface ItemView extends ItemPanel {
  /** Tells these panels from those with marks along axes, among a scene's. */
  items: true;
  result: LayoutResult;
  /** The mark's index among the chart's marks (a map's or a 3D box's first layer's). */
  index: number;
  measure: string;
  /** The chart's marks then, which items of a map's or a 3D box's layers name by index. */
  marks: readonly ChartMark[];
}

/** A panel of a scene: its key, its name, and its room. */
export interface ItemPanel {
  /** "" in a chart without facets or panels. */
  key: string;
  /** What names the panel for people: its facet values, or its subplot's title. */
  label: string;
  plot: Rect;
}

/** What a layout mark draws with besides its room, identity, and rows. */
export type ItemFrame = Omit<LayoutFrame, "bounds" | "id" | "rows">;

/** The title and legends above a chart, and where the room below them starts. */
export type Header = Pick<Scene, "title" | "legend" | "colorLegends" | "glyphLegends"> & {
  top: number;
};

/** One chart's record of what its layout marks drew; layout marks give charts the class. */
export class ItemViews {
  /** Optional sink for item changes; model-only consumers keep the returned values. */
  declare changed:
    | ((
        ...change:
          | [type: "drill", change: ItemChanges["drill"]]
          | [type: "itemMove", change: ItemChanges["itemMove"]]
      ) => void)
    | undefined;
  /**
   * Checks the layout marks of a chart without facets or panels, which has
   * them to itself (`marks` along axes are refused), and returns the one
   * mark that draws them: a map's or a 3D box's layers joined, or the one.
   */
  static alone(
    layouts: readonly LayoutMark[],
    marks: readonly unknown[],
    config: ChartConfig,
  ): LayoutMark[] {
    const [layout] = layouts as [LayoutMark];
    const { type } = layout.spec;
    // Layers of a map share its chart; they are drawn as one mark.
    const drawn = layout.join ? [layout.join(layouts, config)] : [...layouts];
    if (drawn.length > 1 || marks.length > 0)
      throw new Error(`${type}: has its chart to itself; draw other marks in another chart`);
    // Each mark takes what its controls do (see `LayoutMark.interactions`).
    const takes: readonly string[] = drawn[0]!.interactions ?? [];
    const { zoom, brush, drag, sync } = config.interaction ?? {};
    const plane = takes.includes("plane");
    if (zoom && !(zoom === true ? plane || takes.includes("zoom") : plane && zoom === "xy"))
      throw new Error(
        plane
          ? `${type} zoom: expected interaction.zoom true or "xy"; received ${JSON.stringify(zoom)}`
          : takes.includes("zoom")
            ? `${type} zoom: expected interaction.zoom true; received ${JSON.stringify(zoom)}`
            : `${type} zoom: no axes to zoom; drop interaction.zoom`,
      );
    if (brush && !(brush === "lasso" && takes.includes("lasso")))
      throw new Error(
        takes.includes("lasso")
          ? `${type} brush: expected interaction.brush "lasso"; received ${JSON.stringify(brush)}`
          : `${type} brush: no axes to brush; drop interaction.brush`,
      );
    if (drag && !takes.includes("drag"))
      throw new Error(`${type} drag: no nodes to drag; drop interaction.drag`);
    if (sync) throw new Error(`${type} sync: no axes to sync; drop interaction.sync`);
    if (config.x?.seams) throw new Error(`${type} seams: no x axis to mark seams on; drop x.seams`);
    return drawn;
  }

  #views: ItemView[] = [];
  /** Whether the panels are facets or subplots, whose inspections name them, not a chart's one. */
  #named = true;
  /**
   * The node a chart of one tree is drilled into, as set and then as drawn,
   * and the path to it: a node the data lost gives way to its nearest
   * ancestor that remains, which `reconciled` reports once.
   */
  #root: DrillRoot = { key: null, path: [] };
  #reconciled: DrillRoot | undefined;
  /** A network's nodes moved, in the layout they were moved in, and the one being dragged. */
  #moved: { layout: object; at: Map<string, readonly [number, number]> } | undefined;
  #dragged: { key: string; at: readonly [number, number]; layout: object } | undefined;

  /** Controls attached by the DOM runtime; absent for model-only consumers. */
  controls: Controls | null | undefined;
  controlsLoading: Promise<void> | undefined;
  #controlsKind: LayoutControls["kind"] | undefined;
  #controlsScene: Scene | undefined;
  #controlsDisposed = false;

  /** Follows the requested family, rejecting obsolete imports by promise identity. */
  updateControls(
    model: ChartModel,
    mount: (kind: LayoutControls["kind"]) => Promise<Controls>,
  ): void {
    if (this.#controlsDisposed) return;
    const kind = model.controls?.kind;
    if (kind === this.#controlsKind) {
      this.controls?.update(model.config);
      return;
    }
    this.controls?.dispose();
    this.controls = undefined;
    this.#controlsKind = kind;
    if (!kind) {
      this.controlsLoading = undefined;
      return;
    }
    const loading = mount(kind)
      .catch(() => null)
      .then((controls) => {
        if (this.#controlsDisposed || this.controlsLoading !== loading) {
          controls?.dispose();
          return;
        }
        this.controlsLoading = undefined;
        this.controls = controls;
        controls?.update(model.config);
        if (this.#controlsScene) controls?.draw(this.#controlsScene);
      });
    this.controlsLoading = loading;
  }

  drawControls(scene: Scene): void {
    this.#controlsScene = scene;
    this.controls?.draw(scene);
  }

  disposeControls(): void {
    this.#controlsDisposed = true;
    this.controls?.dispose();
    this.controls = undefined;
    this.#controlsScene = undefined;
    this.controlsLoading = undefined;
    this.changed = undefined;
  }

  /** Whether the last scene was of one layout mark, without facets or panels. */
  get alone(): boolean {
    return !this.#named;
  }

  /** Starts a scene of facet panels or subplots. */
  clear(): void {
    this.#views = [];
    this.#named = true;
  }

  /**
   * The scene of a chart of one layout mark, the chart's `index`th of
   * `marks`: `header` (its title and legends) above, and the mark in the
   * room below, drawn with `frame` and the model's viewport (a map's) and
   * highlighted rows.
   */
  scene(
    model: ChartModel,
    header: Header,
    mark: LayoutMark,
    marks: readonly ChartMark[],
    frame: ItemFrame,
  ): Scene {
    const { width, height, pixelRatio } = model;
    // Of the layout drawn last, before it goes.
    const moved = this.#movedNow();
    this.#views = [];
    this.#named = false;
    const plot: Rect = {
      x: EDGE,
      y: header.top,
      width: Math.max(0, width - 2 * EDGE),
      height: Math.max(0, height - header.top - EDGE),
    };
    const viewport = { x: model.viewport, y: model.yViewport.y };
    const drawn = {
      ...frame,
      viewport,
      selected: model.layoutHighlight,
      // The root, then its ancestors nearest first, for a root the data lost.
      root: [this.#root.key, ...this.#root.path.map(({ key }) => key).reverse()].filter(
        (key) => key !== null,
      ),
      drillable: !!model.config.interaction?.zoom,
      moved,
    };
    const panel = this.#draw({ key: "", label: "", plot }, mark, 0, marks, drawn, undefined);
    const result = this.#views[0]?.result;
    const drill = result?.drill;
    if (drill && drill.key !== this.#root.key)
      this.#reconciled = { key: drill.key, path: drill.path };
    this.#root = drill ? { key: drill.key, path: drill.path } : { key: null, path: [] };
    // Moves made in a layout the network no longer has (its data changed) go,
    // and those of a mark with another identity.
    const moves = result?.moves;
    if (this.#moved && moves?.layout !== this.#moved.layout) this.#moved = undefined;
    if (this.#dragged && moves?.layout !== this.#dragged.layout) this.#dragged = undefined;
    for (const key of this.#moved?.at.keys() ?? [])
      if (!moves?.owns(key)) this.#moved!.at.delete(key);
    let vertices = 0;
    for (const item of panel.marks) vertices += item.draw.size(item);
    const { title, legend, colorLegends, glyphLegends } = header;
    const { theme } = frame;
    const panels = [panel];
    return {
      width,
      height,
      pixelRatio,
      theme,
      title,
      headers: [],
      panels,
      legend,
      colorLegends,
      glyphLegends,
      vertices,
    };
  }

  /** Draws the layout mark `item` names, the chart's `index`th of `marks`, in `panel` of a scene. */
  panel(panel: ItemPanel, item: PanelItem, marks: readonly ChartMark[], frame: ItemFrame): Panel {
    return this.#draw(panel, item.mark, item.index, marks, frame, item.rows);
  }

  #draw(
    panel: ItemPanel,
    mark: LayoutMark,
    index: number,
    marks: readonly ChartMark[],
    frame: ItemFrame,
    rows: Uint32Array | undefined,
  ): Panel {
    const { key, plot } = panel;
    const result = mark.draw({ ...frame, id: mark.spec.id ?? index, bounds: plot, rows });
    this.#views.push({ ...panel, items: true, result, index, measure: mark.measure, marks });
    return { key, plot, grid: { x: [], y: [] }, axes: [], marks: result.geometry };
  }

  /** What the layout mark drew in `panel` (the first by default). */
  result(panel?: string): LayoutResult | undefined {
    return this.#view(panel)?.result;
  }

  /** The node a chart of one tree is drilled into (see `Chart.drillRoot`); undefined for other charts. */
  drillRoot(): DrillRoot | undefined {
    const drill = this.#named ? undefined : this.#views[0]?.result.drill;
    // As set, though not drawn yet.
    return drill && this.#root;
  }

  /** The drill root the data changed since last asked (a node it lost), once. */
  reconciled(): DrillRoot | undefined {
    const root = this.#reconciled;
    this.#reconciled = undefined;
    return root;
  }

  /** Reports a root the data changed before the frame's hover and render listeners run. */
  finishFrame(): void {
    const root = this.reconciled();
    if (root) this.changed?.("drill", root);
  }

  /**
   * Drills a chart of one tree into a node, named by its item key or its
   * names from the top level down, or with null back out to the whole tree;
   * the drill root then, or undefined when it did not change. Throws for a
   * node the tree does not have, and for other charts.
   */
  setDrillRoot(node: string | readonly string[] | null): DrillRoot | undefined {
    const drill = this.#named ? undefined : this.#views[0]?.result.drill;
    if (!drill) throw new Error("setDrillRoot: only charts of one treemap or sunburst drill");
    const key = node === null ? null : drill.find(node);
    if (key === undefined)
      throw new RangeError(`setDrillRoot: no node ${JSON.stringify(node)} in the tree`);
    // Against the root set, though a frame may not have drawn it yet.
    if (key === this.#root.key) return undefined;
    const root = { key, path: key === null ? [] : drill.pathTo(key) };
    this.#root = root;
    // A change the data made before this one is no longer the chart's to report.
    this.#reconciled = undefined;
    this.changed?.("drill", root);
    return root;
  }

  /**
   * Moves a network's node, keyed as its items are, to a place in layout
   * units, or with null back to where the layout puts it; what changed, or
   * undefined for nothing. Throws for a key of no node drawn, unless the
   * move is one made in `layout` (a drag's), which then lands only in that
   * layout, and in no other the network's data has changed it to.
   */
  setItemPosition(
    key: string,
    position: { x: number; y: number } | null,
    layout?: object,
  ): { key: string; position: { x: number; y: number } | null } | undefined {
    const moves = this.#views[0]?.result.moves;
    if (!moves || this.#named) throw new Error("setItemPosition: only networks have items to move");
    this.#dragged = undefined;
    // A node moved before its group was hidden can go back all the same.
    if (position === null && this.#moved?.at.delete(key))
      return this.#itemMoved({ key, position: null });
    if (layout && (layout !== moves.layout || !moves.current() || !moves.movable(key)))
      return undefined;
    if (!moves.movable(key))
      throw new RangeError(`setItemPosition: no node ${JSON.stringify(key)} in the network`);
    if (this.#moved?.layout !== moves.layout) this.#moved = { layout: moves.layout, at: new Map() };
    const { at } = this.#moved;
    if (position === null) return undefined;
    const { x, y } = position;
    if (!(Number.isFinite(x) && Number.isFinite(y)))
      throw new RangeError(
        `setItemPosition position: expected finite x and y; received x ${x}, y ${y}`,
      );
    const [px, py] = at.get(key) ?? [];
    if (px === x && py === y) return undefined;
    at.set(key, [x, y]);
    return this.#itemMoved({ key, position: { x, y } });
  }

  #itemMoved(change: ItemChanges["itemMove"]): ItemChanges["itemMove"] {
    this.changed?.("itemMove", change);
    return change;
  }

  /** The nodes moved so far, in layout units. */
  get movedItems(): ReadonlyMap<string, readonly [number, number]> {
    return this.#moved?.at ?? new Map();
  }

  /** Shows a node being dragged at a place in layout units, or none (null), without making it a move. */
  drag(key: string | null, at?: readonly [number, number]): void {
    // In the layout drawn now, which a change of the network's data replaces.
    const layout = this.#views[0]?.result.moves?.layout;
    this.#dragged = key === null || !at || !layout ? undefined : { key, at, layout };
  }

  /** The moves to draw: those made, and the node being dragged, in one layout. */
  #movedNow(): MovedNodes | undefined {
    const dragged = this.#dragged;
    const layout = this.#moved?.layout ?? dragged?.layout;
    if (!layout) return undefined;
    const at = new Map(this.#moved?.at);
    if (dragged && dragged.layout === layout) at.set(dragged.key, dragged.at);
    return { layout, at };
  }

  /** The panels drawn, in order. */
  get panels(): readonly (ItemPanel & { items: true })[] {
    return this.#views;
  }

  /** The view of panel `key`; the first without one. */
  #view(key: string | undefined): ItemView | undefined {
    return key === undefined ? this.#views[0] : this.#views.find((view) => view.key === key);
  }

  /**
   * The item under a pixel: in the panel holding it, or in `panel`. In a
   * chart of one layout mark, wherever the pixel is.
   */
  inspect(px: number, py: number, panel?: string): ItemInspection | undefined {
    const view =
      panel !== undefined
        ? this.#view(panel)
        : this.#views.find(({ plot }) => !this.#named || inside(plot, px, py));
    return view && this.#inspection(view, view.result.itemAt(px, py));
  }

  /** The item keyed `key` in `panel` (the first panel by default). */
  inspectItem(key: string, panel?: string): ItemInspection | undefined {
    const view = this.#view(panel);
    const at = view?.result.indexOf(key) ?? -1;
    return at < 0 ? undefined : this.#inspection(view!, view!.result.item(at));
  }

  /**
   * In `panel` (the first by default), the key of the item `step` items
   * after the one keyed `key` (before, for negative steps), stopping at the
   * ends. Without a current item, steps count from before the first item,
   * or after the last for negative ones.
   */
  stepItem(key: string | undefined, step: number, panel?: string): string | undefined {
    const result = this.#view(panel)?.result;
    if (!result || result.count === 0) return undefined;
    const at = key === undefined ? -1 : result.indexOf(key);
    const from = at >= 0 ? at : step > 0 ? -1 : result.count;
    return result.item(Math.min(result.count - 1, Math.max(0, from + step))).key;
  }

  /**
   * What was drawn, for screen readers: `panel`'s summary; without one, the
   * chart's one panel's, or each panel's after its name, up to `max` panels.
   */
  summary(panel?: string, max = Number.POSITIVE_INFINITY): string | undefined {
    if (panel !== undefined || !this.#named) return this.#view(panel)?.result.summary();
    const views = this.#views;
    const parts = views.slice(0, max).map(({ label, result }) => `${label}: ${result.summary()}`);
    if (views.length > max) parts.push(`${views.length - max} more panels.`);
    return parts.join(" ") || undefined;
  }

  #inspection(view: ItemView, item: LayoutItem | undefined): ItemInspection | undefined {
    if (!item) return undefined;
    const { key, label, color, text, value, px, py, outline, values } = item;
    // A map's or a 3D box's items name their layer among the chart's marks.
    const mark = item.layer ?? view.index;
    return {
      axis: "item",
      key,
      value,
      label: item.measure ?? view.measure,
      points: [
        {
          mark,
          markId: view.marks[mark]?.spec.id,
          key,
          label,
          row: item.row,
          color,
          text,
          value,
          px,
          py,
        },
      ],
      outline,
      ...(values && { values }),
      ...(this.#named && { panel: view.key }),
    };
  }
}

function inside(plot: Rect, px: number, py: number): boolean {
  return px >= plot.x && px <= plot.x + plot.width && py >= plot.y && py <= plot.y + plot.height;
}
