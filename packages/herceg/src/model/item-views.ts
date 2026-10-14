// What a chart's layout marks (pies, treemaps, maps, ...) drew in its last
// scene, panel by panel, and how tooltips, the keyboard, and the chart's
// description read their items; what the chart's user changed of them (a
// tree's drill root, a map's or network's view, moved nodes); and what a
// chart of layout marks may have. A chart reaches this module through its
// layout marks (`LayoutMark.views`), so charts without any never load it.
//
// What the user changes is kept per state: facet panels show one mark's
// rows split by a field, so they share one state, as panels share a scale;
// subplots draw marks of their own, so each has its own, keyed by its id; a
// chart of one layout mark has one. Panels' drawings are rebuilt every
// scene; states stay while their panels do.

import type { Table } from "../data/table.ts";
import type { MovedNodes } from "../marks/graph.ts";
import type {
  LayoutControls,
  LayoutFrame,
  LayoutItem,
  LayoutMark,
  LayoutResult,
  Viewport as PlaneViewport,
} from "../marks/layout-mark.ts";
import type { ChartMark } from "../marks/mark.ts";
import type { LayoutClock, NodePositions } from "../marks/node-positions.ts";
import type { FieldReader } from "../marks/tooltip-fields.ts";
import type { DrillRoot } from "../marks/tree-data.ts";
import type { Guide, Panel, Rect, Scene } from "../scene/scene.ts";
import type { CameraSpec } from "../spec/spec.ts";
import type { Camera } from "../three/camera.ts";
import type { ItemInspection } from "./inspect.ts";
import type { LegendPart } from "./legend.ts";
import type { ChartConfig, ChartModel, Viewport } from "./model.ts";
import type { LayoutConfig, LayoutOptions, PanelItem } from "./panel-layout.ts";
import type { SelectionOwner } from "./selected-rows.ts";

/**
 * Changes of layout items, reported by mounted charts through their matching
 * events; `panels` names the subplot a change belongs to, when it is not the
 * chart's. Written out in each, so adapters' declarations can name them.
 */
export interface ItemChanges {
  camera: { camera: Camera; panels?: readonly string[] };
  drill: DrillRoot & { panels?: readonly string[] };
  itemMove: {
    key: string;
    position: { x: number; y: number } | null;
    panels?: readonly string[];
  };
  viewport: Viewport & { panels?: readonly string[] };
}

/** Optional navigation attached to layout items by an interactive runtime. */
export interface Controls {
  update(config: ChartConfig): void;
  draw(scene: Scene): void;
  readonly busy: boolean;
  dispose(): void;
}

/** What the chart's user changed of the layout marks drawn with one state. */
interface ItemState {
  camera?: { current: Camera; configured: Camera; mark: LayoutMark; pending: boolean } | undefined;
  /**
   * The node a tree is drilled into, as set and then as drawn, and the
   * path to it: a node the data lost gives way to its nearest ancestor
   * that remains, which `reconciled` reports once.
   */
  root: DrillRoot;
  reconciled: DrillRoot | undefined;
  /** A network's nodes moved, by key, in layout units, and the one being dragged. */
  moved: Map<string, readonly [number, number]>;
  dragged: { key: string; at: readonly [number, number] } | undefined;
  /** Where a network's nodes are, which its mark keeps here (see `NodePositions`). */
  positions: { current: NodePositions | undefined };
  /** The part of a map's or network's plane shown, in its units; null ranges fit it. */
  view: PlaneViewport;
}

/** A panel a layout mark drew in, and what it drew there. */
interface ItemView extends ItemPanel {
  /** Tells these panels from those with marks along axes, among a scene's. */
  items: true;
  result: LayoutResult;
  /** The camera used for this scene, so descriptions follow what was drawn. */
  camera: Camera | undefined;
  /** The mark's index among the chart's marks (a map's or a 3D box's first layer's). */
  index: number;
  /** For a map: each layer's index among the chart's marks. */
  indices: readonly number[] | undefined;
  measure: string;
  /** The chart's marks then, which items of a map's or a 3D box's layers name by index. */
  marks: readonly ChartMark[];
  /** The key of the panel's state: "" for the chart's one, a subplot's id for its own. */
  state: string;
}

/** A panel of a scene: its key, its name, and its room. */
export interface ItemPanel {
  /** "" in a chart without facets or panels. */
  key: string;
  /** What names the panel for people: its facet values, or its subplot's title. */
  label: string;
  plot: Rect;
}

/** What a layout mark draws with besides its room, identity, rows, and the user's changes. */
export type ItemFrame = Omit<
  LayoutFrame,
  "bounds" | "id" | "rows" | "root" | "moved" | "viewport" | "nodePositions" | "clock"
>;

/** The title and legends around a chart, and the room they leave for its mark. */
export interface Header {
  guides: Guide[];
  box: Rect;
  /** The legend inside the mark's room, placed once it is known. */
  inside: ((box: Rect) => Guide[]) | undefined;
}

/** What a layout mark has that a method needs: a tree to drill, nodes to move, a plane to view. */
type Has = "drill" | "moves" | "plane";
const WHAT: Record<Has, string> = {
  drill: "treemap or sunburst",
  moves: "network",
  plane: "map or network",
};

const NO_ROOT: DrillRoot = { key: null, path: [] };

/** Milliseconds of a frame layout work may take, leaving the rest for drawing. */
const LAYOUT_BUDGET = 12;

/**
 * Whether a panel's view is of a map's or a network's plane, drawn or not
 * (a network too large to lay out keeps its view for when it is drawn).
 */
const planar = ({ marks, index }: ItemView) =>
  ["graph", "geoshape", "geopoint"].includes(marks[index]!.spec.type);

/** Steps for the keys that move through the items of a layout mark. */
const ITEM_STEPS: Record<string, number> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
  PageDown: 5,
  PageUp: -5,
  Home: -Infinity,
  End: Infinity,
};

/** One chart's record of what its layout marks drew; layout marks give charts the class. */
export class ItemViews {
  /** Reads the fields tooltips show of items' rows (`tooltip.fields`); set by the model. */
  declare fields: FieldReader | undefined;
  /** Optional sink for item changes; model-only consumers keep the returned values. */
  declare changed:
    | ((
        ...change:
          | [type: "camera", change: ItemChanges["camera"]]
          | [type: "drill", change: ItemChanges["drill"]]
          | [type: "itemMove", change: ItemChanges["itemMove"]]
          | [type: "viewport", change: ItemChanges["viewport"]]
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
    // Layers of a map share its chart; they are drawn as one mark.
    const drawn = layout.join ? [layout.join(layouts, config)] : [...layouts];
    if (drawn.length > 1 || marks.length > 0)
      throw new Error(
        `${layout.spec.type}: has its chart to itself; draw other marks in another chart`,
      );
    ItemViews.interactions(drawn, config, false, layout.spec.type);
    return drawn;
  }

  /**
   * The marks that draw a chart's layout marks in panels: the layers of a
   * map joined, those naming one subplot (`subplots`) or, in facets, all of
   * them; other layout marks as they are.
   */
  static inPanels(
    layouts: readonly LayoutMark[],
    config: LayoutConfig,
    subplots: boolean,
  ): LayoutMark[] {
    const joined = new Map<string | undefined, LayoutMark[]>();
    const drawn: (LayoutMark | LayoutMark[])[] = [];
    for (const mark of layouts) {
      if (!mark.join) {
        drawn.push(mark);
        continue;
      }
      const panel = `${mark.camera || ["point3d", "line3d", "surface"].includes(mark.spec.type) ? "3d" : "map"}:${subplots ? mark.spec.panel : ""}`;
      let layers = joined.get(panel);
      if (!layers) {
        layers = [];
        joined.set(panel, layers);
        drawn.push(layers);
      }
      layers.push(mark);
    }
    return drawn.map((entry) =>
      Array.isArray(entry)
        ? entry[0]!.join!(
            entry,
            config as ChartConfig,
            config.marks.flatMap((mark, i) => (entry.includes(mark as LayoutMark) ? [i] : [])),
            subplots ? entry[0]!.spec.panel : undefined,
          )
        : entry,
    );
  }

  /**
   * Refuses `interaction` options none of `drawn` (layout marks in panels
   * without axes, or a chart's one) takes (see `LayoutMark.interactions`),
   * naming the marks `type`; with `axes`, panels with axes take zoom,
   * brushes, and sync too.
   */
  static interactions(
    drawn: readonly LayoutMark[],
    config: LayoutOptions,
    axes: boolean,
    type: string,
  ): void {
    const takes = new Set(drawn.flatMap((mark) => mark.interactions ?? []));
    const { zoom, brush, drag, sync } = config.interaction ?? {};
    const plane = takes.has("plane");
    if (zoom && !axes && !(zoom === true ? plane || takes.has("zoom") : plane && zoom === "xy"))
      throw new Error(
        plane
          ? `${type} zoom: expected interaction.zoom true or "xy"; received ${JSON.stringify(zoom)}`
          : takes.has("zoom")
            ? `${type} zoom: expected interaction.zoom true; received ${JSON.stringify(zoom)}`
            : `${type} zoom: no axes to zoom; drop interaction.zoom`,
      );
    if (brush && !axes && !(brush === "lasso" && takes.has("lasso")))
      throw new Error(
        takes.has("lasso")
          ? `${type} brush: expected interaction.brush "lasso"; received ${JSON.stringify(brush)}`
          : `${type} brush: no axes to brush; drop interaction.brush`,
      );
    if (drag && !takes.has("drag"))
      throw new Error(`${type} drag: no nodes to drag; drop interaction.drag`);
    if (axes) return;
    if (sync) throw new Error(`${type} sync: no axes to sync; drop interaction.sync`);
    if (config.x?.seams) throw new Error(`${type} seams: no x axis to mark seams on; drop x.seams`);
    // Shared, as panels' scales would be, is no change.
    for (const axis of ["x", "y", "yRight"] as const) {
      const scope = config[axis]?.scope;
      if (scope !== undefined && scope !== "chart")
        throw new Error(`${type} ${axis}.scope: its panels have no scales to share; drop scope`);
    }
  }

  /** The chart whose layout marks these are. */
  readonly #model: ChartModel;
  #views: ItemView[] = [];
  /** Whether the panels are facets or subplots, whose inspections name them, not a chart's one. */
  #named = true;
  /** What the user changed, by state (see `ItemView.state`). */
  readonly #states = new Map<string, ItemState>();

  /** Controls attached by the DOM runtime, by family; absent for model-only consumers. */
  readonly #controls = new Map<
    LayoutControls["kind"],
    { controls: Controls | null | undefined; loading: Promise<void> | undefined }
  >();
  #controlsScene: Scene | undefined;
  #controlsDisposed = false;
  /** How much layout work this scene allows: set once a chart mounts these, for every scene. */
  #clock: LayoutClock | undefined;
  #mounted = false;
  #reducedMotion: MediaQueryList | undefined;
  /** Settles once a frame drew no layout work left; renewed while some is. */
  #settled: { promise: Promise<void>; resolve: () => void } | undefined;

  constructor(model: ChartModel) {
    this.#model = model;
    this.configureCameras();
  }

  #cameraConfig: ChartConfig | undefined;

  /** Reconciles cameras before use; changes to defaults reset only their own state. */
  configureCameras(): void {
    const { config, layouts } = this.#model;
    if (config === this.#cameraConfig) return;
    this.#cameraConfig = config;
    const owners = new Set<string>();
    for (const mark of layouts) {
      if (!mark.camera) continue;
      const key = mark.spec.panel ?? "";
      owners.add(key);
      const panel = config.panels?.list.find(({ id }) => id === key);
      const spec = panel?.camera ? { ...config.camera, ...panel.camera } : config.camera;
      const configured = mark.camera(spec);
      const state = this.#state(key);
      const held = state.camera;
      const same = held && JSON.stringify(held.configured) === JSON.stringify(configured);
      state.camera = {
        mark,
        configured,
        current: same ? held.current : configured,
        pending: held?.pending ?? false,
      };
    }
    for (const [key, state] of this.#states) if (!owners.has(key)) state.camera = undefined;
  }

  #cameraOwner(
    panel: string | undefined,
    method: string,
  ): [string, NonNullable<ItemState["camera"]>] | undefined {
    this.configureCameras();
    const owners = [...this.#states].flatMap(([key, state]) =>
      state.camera ? [[key, state.camera] as const] : [],
    );
    if (panel === undefined && owners.length === 0) return undefined;
    const owner =
      panel === undefined
        ? owners.length === 1
          ? owners[0]
          : undefined
        : owners.find(([key]) => key === panel);
    if (owner) return [owner[0], owner[1]];
    const names = owners.map(([key]) => JSON.stringify(key)).join(", ") || "none";
    throw new Error(
      panel === undefined
        ? `${method}: panel is required; name one of the 3D panels ${names}`
        : `${method} panel: ${JSON.stringify(panel)} has no 3D camera; name one of ${names}`,
    );
  }

  camera(panel?: string): Camera | undefined {
    const owner = this.#cameraOwner(panel, "getCamera");
    return owner && { ...owner[1].current };
  }

  setCamera(spec: CameraSpec | null, panel?: string): boolean {
    const owner = this.#cameraOwner(panel, "setCamera");
    if (!owner) throw new Error("setCamera: no 3D camera; add a 3D mark");
    const camera = owner[1];
    const next = spec === null ? camera.configured : camera.mark.camera!(spec, camera.current);
    if (JSON.stringify(next) === JSON.stringify(camera.current)) return false;
    camera.current = next;
    camera.pending = true;
    return true;
  }

  /** Reports each camera once per frame; reentrant setters remain pending for the next frame. */
  finishCameras(): void {
    const changes = [...this.#states].flatMap(([key, state]) => {
      const camera = state.camera;
      if (!camera?.pending) return [];
      camera.pending = false;
      return [{ camera: { ...camera.current }, ...(key && { panels: [key] }) }];
    });
    for (const change of changes) this.changed?.("camera", change);
  }

  /**
   * Follows the families the chart's layout marks ask for, loading each
   * once and disposing those no longer asked for; rejects obsolete imports
   * by promise identity. `changed` hears of the items' changes from then on.
   */
  updateControls(
    mount: (kind: LayoutControls["kind"]) => Promise<Controls>,
    changed?: ItemViews["changed"],
  ): void {
    if (this.#controlsDisposed) return;
    this.configureCameras();
    this.changed ??= changed;
    // In the browser, layouts spread over frames, and `loading` waits for them.
    if (!this.#mounted) {
      this.#mounted = true;
      this.#reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
      if (this.#model.layouts.some((mark) => mark.spec.type === "graph")) this.#unsettle();
    }
    const model = this.#model;
    const kinds = new Set(this.asked().map(({ kind }) => kind));
    for (const [kind, slot] of this.#controls) {
      if (kinds.has(kind)) continue;
      slot.controls?.dispose();
      this.#controls.delete(kind);
    }
    for (const kind of kinds) {
      const kept = this.#controls.get(kind);
      if (kept) {
        kept.controls?.update(model.config);
        continue;
      }
      const slot: { controls: Controls | null | undefined; loading: Promise<void> | undefined } = {
        controls: undefined,
        loading: undefined,
      };
      const loading = mount(kind)
        .catch(() => null)
        .then((controls) => {
          if (this.#controlsDisposed || this.#controls.get(kind) !== slot) {
            controls?.dispose();
            return;
          }
          slot.loading = undefined;
          slot.controls = controls;
          controls?.update(model.config);
          if (this.#controlsScene) controls?.draw(this.#controlsScene);
        });
      slot.loading = loading;
      this.#controls.set(kind, slot);
    }
  }

  /** The controls of a family: undefined while loading or not asked for, null when they failed to load. */
  controls(kind: LayoutControls["kind"]): Controls | null | undefined {
    return this.#controls.get(kind)?.controls;
  }

  /** Pending while controls load, and while a network's layout has work left. */
  get controlsLoading(): Promise<void> | undefined {
    const pending = [...this.#controls.values()].flatMap(({ loading }) => loading ?? []);
    if (this.#settled) pending.push(this.#settled.promise);
    return pending.length > 1 ? Promise.all(pending).then(() => {}) : pending[0];
  }

  /** Whether a panel last drawn has layout work left, for the next frame. */
  get pending(): boolean {
    return this.#views.some(({ result }) => result.pending);
  }

  /**
   * Works on networks' layouts for a frame's share of time, between frames
   * that draw them; whether a frame should draw now, to show how far they
   * have come (see `NodePositions.due`).
   */
  workLayouts(): boolean {
    const now = performance.now();
    const clock = { deadline: now + LAYOUT_BUDGET, animate: !this.#reducedMotion?.matches, now };
    let due = false;
    for (const { positions } of this.#states.values()) {
      const current = positions.current;
      if (!current?.pending) continue;
      current.work(clock);
      due ||= current.due(performance.now(), clock.animate);
    }
    return due;
  }

  #unsettle(): void {
    if (this.#settled) return;
    let resolve = () => {};
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    this.#settled = { promise, resolve };
  }

  /** Whether controls are in a gesture (a drag turning, panning, or moving): no tooltip shows. */
  get busy(): boolean {
    return [...this.#controls.values()].some(({ controls }) => controls?.busy);
  }

  drawControls(scene: Scene): void {
    this.#controlsScene = scene;
    if (this.pending) this.#unsettle();
    else {
      this.#settled?.resolve();
      this.#settled = undefined;
    }
    for (const { controls } of this.#controls.values()) controls?.draw(scene);
  }

  disposeControls(): void {
    this.#controlsDisposed = true;
    for (const { controls } of this.#controls.values()) controls?.dispose();
    this.#controls.clear();
    this.#controlsScene = undefined;
    this.changed = undefined;
    // Whoever waits for a layout the chart will not finish hears it is over.
    this.#settled?.resolve();
    this.#settled = undefined;
  }

  /** Whether the last scene was of one layout mark, without facets or panels. */
  get alone(): boolean {
    return !this.#named;
  }

  /** Starts a scene of facet panels or subplots. */
  clear(): void {
    this.#begin(true);
  }

  /**
   * Starts a scene: the states of panels the last one drew stay; those of
   * subplots it left out go, so a subplot that comes back starts afresh.
   */
  #begin(named: boolean): void {
    this.configureCameras();
    const used = new Set(this.#views.map(({ state }) => state));
    for (const state of this.#states.keys())
      if (!used.has(state) && !this.#states.get(state)?.camera) this.#states.delete(state);
    this.#views = [];
    this.#named = named;
    // A mounted chart's scenes share a frame's time with drawing; others
    // (exports without a DOM, where there may be no clock) lay out at once.
    if (!this.#mounted) this.#clock = undefined;
    else {
      const now = performance.now();
      this.#clock = { deadline: now + LAYOUT_BUDGET, animate: !this.#reducedMotion?.matches, now };
    }
  }

  /**
   * The scene of a chart of one layout mark, the chart's `index`th of
   * `marks`: `header` (its title and legends) above, and the mark in the
   * room below, drawn with `frame` and the user's changes.
   */
  scene(header: Header, mark: LayoutMark, marks: readonly ChartMark[], frame: ItemFrame): Scene {
    const { width, height, pixelRatio } = this.#model;
    this.#begin(false);
    const plot = header.box;
    const panel = this.#draw({ key: "", label: "", plot }, mark, 0, marks, frame, {}, "");
    let vertices = 0;
    for (const item of panel.marks) vertices += item.draw.size(item);
    const { theme } = frame;
    const guides = [...header.guides, ...(header.inside?.(plot) ?? [])];
    return { width, height, pixelRatio, theme, panels: [panel], guides, vertices };
  }

  /**
   * Draws the layout mark `item` names in `panel` of a scene, with the
   * state the facet's panels share, or a subplot's own.
   */
  panel(panel: ItemPanel, item: PanelItem, frame: ItemFrame): Panel {
    const { marks, panels } = this.#model.config;
    const state = panels ? panel.key : "";
    return this.#draw(
      panel,
      item.mark,
      item.index,
      marks,
      { ...frame, inPanel: true },
      item,
      state,
    );
  }

  #draw(
    panel: ItemPanel,
    mark: LayoutMark,
    index: number,
    marks: readonly ChartMark[],
    frame: ItemFrame,
    { rows, layerRows, fitRows }: Partial<PanelItem>,
    key: string,
  ): Panel {
    const { plot } = panel;
    const state = this.#state(key);
    const model = this.#model;
    const camera = state.camera?.current;
    const result = mark.draw({
      ...frame,
      selected: model.layoutHighlight,
      drillable: !!model.config.interaction?.zoom,
      id: mark.spec.id ?? index,
      bounds: plot,
      rows,
      layerRows,
      fitRows,
      // The root, then its ancestors nearest first, for a root the data lost.
      root: [state.root.key, ...state.root.path.map((step) => step.key).reverse()].filter(
        (step) => step !== null,
      ),
      moved: movedNow(state),
      nodePositions: state.positions,
      clock: this.#clock,
      viewport: state.view,
      camera,
    });
    const { indices } = mark;
    this.#views.push({
      ...panel,
      items: true,
      result,
      camera,
      index,
      indices,
      measure: mark.measure,
      marks,
      state: key,
    });
    // Every panel of a state draws the same root and layout: the first says what they are.
    if (this.#views.findIndex((view) => view.state === key) === this.#views.length - 1)
      settle(state, result);
    return { key: panel.key, plot, grid: { x: [], y: [] }, axes: [], marks: result.geometry };
  }

  #state(key: string): ItemState {
    let state = this.#states.get(key);
    if (!state) {
      state = {
        root: NO_ROOT,
        reconciled: undefined,
        moved: new Map(),
        dragged: undefined,
        positions: { current: undefined },
        view: { x: null, y: null },
      };
      this.#states.set(key, state);
    }
    return state;
  }

  /** What the layout mark drew in `panel` (the first by default). */
  result(panel?: string): LayoutResult | undefined {
    return this.#view(panel)?.result;
  }

  /**
   * The panel keyed `panel`, when it has what a method needs (`has`);
   * without `panel`, the first that has it, all of them sharing one state.
   * Throws, naming `method`, for a panel without it, for a chart without
   * any, and for several states without `panel`.
   */
  #owner(has: Has, panel: string | undefined, method: string): ItemView {
    const views = this.#views.filter((view) => (has === "plane" ? planar(view) : view.result[has]));
    const what = WHAT[has];
    const names = () => views.map(({ key }) => JSON.stringify(key)).join(", ");
    if (views.length === 0) throw new Error(`${method}: the chart has no ${what}`);
    const view =
      panel === undefined
        ? views.find(({ state }) => state !== views[0]!.state)
          ? undefined
          : views[0]
        : views.find(({ key }) => key === panel);
    if (view) return view;
    throw new Error(
      panel === undefined
        ? `${method}: panel is required; the ${what} panels are ${names()}`
        : `${method}: panel ${JSON.stringify(panel)} has no ${what}; name one of ${names()}`,
    );
  }

  /** The panels a change of a state belongs to, when they are a subplot's. */
  #scope(view: ItemView): { panels?: readonly string[] } {
    return view.state === "" ? {} : { panels: [view.key] };
  }

  /**
   * The node a tree is drilled into (see `Chart.getDrillRoot`), as set
   * though not drawn yet: in `panel`'s state, or the chart's one; undefined
   * for charts without trees.
   */
  drillRoot(panel?: string): DrillRoot | undefined {
    if (!this.#views.some(({ result }) => result.drill)) return undefined;
    return this.#state(this.#owner("drill", panel, "getDrillRoot").state).root;
  }

  /** A drill root the data changed since last asked (a node it lost), once, with its scope. */
  reconciled(): ItemChanges["drill"] | undefined {
    for (const view of this.#views) {
      const state = this.#states.get(view.state);
      const root = state?.reconciled;
      if (!root) continue;
      state.reconciled = undefined;
      return { ...root, ...this.#scope(view) };
    }
    return undefined;
  }

  /** Reports reconciled roots and cameras before the frame's hover and render listeners run. */
  finishFrame(): void {
    for (let root = this.reconciled(); root; root = this.reconciled())
      this.changed?.("drill", root);
    this.finishCameras();
  }

  /**
   * Drills the tree of `panel` (or the chart's one) into a node, named by
   * its item key or its names from the top level down, or with null back
   * out to the whole tree; the drill root then, or undefined when it did
   * not change. Throws for a node the tree does not have, and for charts
   * without trees. In facets, every panel shares the root.
   */
  setDrillRoot(
    node: string | readonly string[] | null,
    panel?: string,
  ): ItemChanges["drill"] | undefined {
    const view = this.#owner("drill", panel, "setDrillRoot");
    const drill = view.result.drill!;
    const key = node === null ? null : drill.find(node);
    if (key === undefined)
      throw new RangeError(`setDrillRoot: no node ${JSON.stringify(node)} in the tree`);
    const state = this.#state(view.state);
    // Against the root set, though a frame may not have drawn it yet.
    if (key === state.root.key) return undefined;
    const root = { key, path: key === null ? [] : drill.pathTo(key) };
    state.root = root;
    // A change the data made before this one is no longer the chart's to report.
    state.reconciled = undefined;
    const change = { ...root, ...this.#scope(view) };
    this.changed?.("drill", change);
    return change;
  }

  /**
   * Moves a network's node, keyed as its items are, to a place in layout
   * units, or with null back to the layout, in `panel`'s network (or the
   * chart's one); what changed, or undefined for nothing. Throws for a key
   * of no node of the network (a hidden group's are). In a force layout
   * that settles, the nodes near it settle around it once the chart draws.
   */
  setItemPosition(
    key: string,
    position: { x: number; y: number } | null,
    panel?: string,
  ): ItemChanges["itemMove"] | undefined {
    const owner = this.#owner("moves", panel, "setItemPosition");
    // Facet panels share one network, a node drawn in any of them.
    const view =
      (panel === undefined &&
        (this.#views.find(
          ({ state, result }) => state === owner.state && result.moves?.movable(key),
        ) ??
          this.#views.find(
            ({ state, result }) => state === owner.state && result.moves?.inPanel(key),
          ))) ||
      owner;
    const moves = view.result.moves!;
    const state = this.#state(view.state);
    state.dragged = undefined;
    const report = (change: ItemChanges["itemMove"]) => {
      const scoped = { ...change, ...this.#scope(view) };
      this.changed?.("itemMove", scoped);
      return scoped;
    };
    // A node moved before its group was hidden can go back all the same.
    if (position === null)
      return state.moved.delete(key) ? report({ key, position: null }) : undefined;
    // A hidden group's node too: it is drawn there once shown.
    if (!moves.inPanel(key))
      throw new RangeError(`setItemPosition: no node ${JSON.stringify(key)} in the network`);
    const { x, y } = position;
    if (!(Number.isFinite(x) && Number.isFinite(y)))
      throw new RangeError(
        `setItemPosition position: expected finite x and y; received x ${x}, y ${y}`,
      );
    const [px, py] = state.moved.get(key) ?? [];
    if (px === x && py === y) return undefined;
    state.moved.set(key, [x, y]);
    return report({ key, position: { x, y } });
  }

  /**
   * Puts every moved node of `panel`'s network (or the chart's one) back
   * where the layout puts them, reporting each: the toolbar's and the
   * keyboard's reset.
   */
  resetItemPositions(panel?: string): void {
    const view = this.#owner("moves", panel, "resetItemPositions");
    const state = this.#state(view.state);
    state.dragged = undefined;
    for (const key of [...state.moved.keys()])
      this.setItemPosition(key, null, view.key || undefined);
  }

  /**
   * Takes over where the networks of `other` (a chart this one replaces)
   * have their nodes, state by state; they lay out from there once drawn.
   */
  adoptPositions(other: ItemViews): void {
    for (const [key, state] of other.#states) {
      const positions = state.positions.current;
      if (positions) this.#state(key).positions.current = positions;
    }
  }

  /** The nodes moved so far in `panel`'s network (or the chart's one), in layout units. */
  movedItems(panel?: string): ReadonlyMap<string, readonly [number, number]> {
    if (!this.#views.some(({ result }) => result.moves)) return new Map();
    return this.#state(this.#owner("moves", panel, "getItemPositions").state).moved;
  }

  /** `movedItems`, as `Chart.getItemPositions` gives them. */
  positions(panel?: string): Record<string, { x: number; y: number }> {
    const out: Record<string, { x: number; y: number }> = {};
    for (const [key, [x, y]] of this.movedItems(panel)) out[key] = { x, y };
    return out;
  }

  /** The controls the chart's layout marks ask for with its options (see `LayoutMark.controls`). */
  asked(): LayoutControls[] {
    const { layouts, config } = this.#model;
    return layouts.flatMap((mark) => mark.controls?.(config) ?? []);
  }

  /** What the chart's description adds about the keys of its layout marks' controls. */
  get hint(): string | undefined {
    const hints = new Set(
      this.asked()
        .map(({ hint }) => hint)
        .filter(Boolean),
    );
    return [...hints].join(" ") || undefined;
  }

  /** What layout marks' summaries say beyond their data and hidden keys: the roots and cameras drawn. */
  get summaryKey(): string {
    return JSON.stringify(this.#views.map(({ result, camera }) => [result.drill?.key, camera]));
  }

  /** The legends of the color scales and size keys of layout marks drawn in panels, by key. */
  legends(): (readonly [string, LegendPart])[] {
    const model = this.#model;
    const { theme, config } = model;
    if (config.legend === false) return [];
    return model.layouts.flatMap((mark) =>
      (mark.legends?.(theme, config.locale) ?? []).map((part) => [part.key, part] as const),
    );
  }

  /**
   * Shows a node of `panel`'s network being dragged at a place in layout
   * units, or none (null), without making it a move.
   */
  drag(key: string | null, at?: readonly [number, number], panel?: string): void {
    // Without a panel, null ends every drag.
    if (key === null && panel === undefined) {
      for (const state of this.#states.values()) state.dragged = undefined;
      return;
    }
    const view = this.#owner("moves", panel, "drag");
    const state = this.#state(view.state);
    state.dragged = key === null || !at ? undefined : { key, at };
  }

  /**
   * Whether the chart's view of `panel` is a plane's (a map's or a
   * network's), which `view` and `setView` change; without `panel`,
   * whether the chart's one is, having no panels with axes.
   */
  ownsView(panel: string | undefined): boolean {
    const planes = this.#views.filter(planar);
    return panel === undefined
      ? planes.length > 0 && this.#model.panels().length === 0
      : planes.some(({ key }) => key === panel);
  }

  /**
   * The panels a lasso drawn on the plane of `panel` (or the chart's one,
   * without panels with axes) belongs to: those of its state, as they are
   * drawn; undefined where the view is not a plane's (see `ownsView`).
   */
  select(panel: string | undefined): SelectionOwner | undefined {
    if (!this.ownsView(panel)) return undefined;
    const { state } = this.#owner("plane", panel, "select");
    const views = () => this.#views;
    return {
      x: state,
      plane: true,
      get panels() {
        return views().flatMap(({ key, result, ...view }) =>
          view.state === state && result.plane ? [key] : [],
        );
      },
    };
  }

  /**
   * The part of the plane of `panel` (or the chart's one) shown, as the
   * chart's viewport; when `checked`, undefined unless the chart's view
   * is a plane's (see `ownsView`).
   */
  view(panel?: string, checked = false): Viewport | undefined {
    if (checked && !this.ownsView(panel)) return undefined;
    const { x, y } = this.#state(this.#owner("plane", panel, "getViewport").state).view;
    return { x, y, yRight: null };
  }

  /**
   * Shows a part of the plane of `panel` (or the chart's one, or with null
   * and no panel every plane's whole), as `Chart.setViewport` does: x and
   * y ranges in its units, a pair an x range, null the whole plane; ranges
   * left out keep their view. Reports each change as a `viewport` event.
   * When `checked`, only where the chart's view is a plane's (see
   * `ownsView`); whether it was, so the chart's axes have nothing to show.
   */
  setView(
    view: Partial<Viewport> | readonly [number, number] | null,
    panel: string | undefined,
    checked = false,
  ): boolean {
    const all = view === null && panel === undefined;
    const owns = !checked || this.ownsView(panel);
    if (!owns && !all) return false;
    const owners = all
      ? this.#views.filter(
          (view, i) =>
            planar(view) && this.#views.findIndex((other) => other.state === view.state) === i,
        )
      : [this.#owner("plane", panel, "setViewport")];
    const change: Partial<Viewport> = Array.isArray(view)
      ? { x: view as readonly [number, number] }
      : ((view as Partial<Viewport> | null) ?? { x: null, y: null });
    if (change.yRight)
      throw new Error("setViewport yRight: a map or network has no right axis; drop yRight");
    for (const owner of owners) {
      const state = this.#state(owner.state);
      const next = {
        x: change.x === undefined ? state.view.x : ascending(change.x),
        y: change.y === undefined ? state.view.y : ascending(change.y),
      };
      if (same(next.x, state.view.x) && same(next.y, state.view.y)) continue;
      state.view = next;
      this.changed?.("viewport", { ...next, yRight: null, ...this.#scope(owner) });
    }
    return owns;
  }

  /** The panels drawn, in order, with what was drawn there and the key of their state. */
  get panels(): readonly (ItemPanel & {
    items: true;
    result: LayoutResult;
    state: string;
    camera?: Camera | undefined;
  })[] {
    return this.#views.map((view) => ({
      ...view,
      camera: this.#states.get(view.state)?.camera?.current,
    }));
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
   * Where a key moves the keyboard cursor among the items of panel `panel`
   * from `from` (the cursor, perhaps in another panel; `enters` arriving at
   * the panel's first item): on the item there, keyed "" in a panel with
   * nothing to read (still a stop, which says so); null for Escape, which
   * leaves the items; undefined for keys that do nothing here.
   */
  step(
    key: string,
    from: { panel: string; key: string } | null,
    panel: string,
    enters: boolean,
  ): { panel: string; key: string; position: number } | null | undefined {
    if (key === "Escape") return null;
    const step = enters ? 1 : ITEM_STEPS[key];
    if (step === undefined) return undefined;
    // Steps go from the item the cursor is on; arriving, or when that item
    // went (hidden, or the panel drawn anew), from the panel's first or last.
    const on = from?.panel === panel && this.inspectItem(from.key, panel) !== undefined;
    const at = this.stepItem(on ? from!.key : undefined, step, panel) ?? "";
    return { panel, key: at, position: 0 };
  }

  /**
   * What the keyboard cursor says in panel `panel`: the item it is on
   * (`item`, described), or the panel's summary; arriving (`arrives`) in a
   * facet panel or subplot, the panel's name first.
   */
  said(item: string | undefined, panel: string, arrives: boolean): string {
    const text = item ?? this.summary(panel);
    const name = this.#views.find(({ key }) => key === panel)?.label;
    return arrives && name ? `${name}: ${text}` : (text ?? "");
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
    const { key, label, color, text, value, px, py, outline, values, row } = item;
    // A map's or a 3D box's items name their layer among its layers.
    const mark = item.layer === undefined ? view.index : (view.indices?.[item.layer] ?? item.layer);
    const owner = view.marks[mark] as (ChartMark & { table?: Table }) | undefined;
    const fields =
      row === undefined ? undefined : this.fields?.(owner?.table, owner?.spec.tooltip, row);
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
          row,
          color,
          text,
          value,
          px,
          py,
          ...(fields && { fields }),
        },
      ],
      outline,
      ...(values && { values }),
      ...(this.#named && { panel: view.key }),
    };
  }
}

/**
 * Takes what a state's first panel drew as the state's: the drill root as
 * drawn (a node the data lost gives way to an ancestor, reported once), and
 * moves of nodes its network still has, drawn or not (too large, or
 * still being arranged).
 */
function settle(state: ItemState, result: LayoutResult): void {
  const { drill, moves } = result;
  if (drill && drill.key !== state.root.key)
    state.reconciled = { key: drill.key, path: drill.path };
  state.root = drill ? { key: drill.key, path: drill.path } : NO_ROOT;
  if (!moves) return;
  for (const key of state.moved.keys()) if (!moves.owns(key)) state.moved.delete(key);
  if (state.dragged && !moves.owns(state.dragged.key)) state.dragged = undefined;
}

/** The moves to draw: those made, and the node being dragged, which is no move yet. */
function movedNow(state: ItemState): MovedNodes | undefined {
  const dragged = state.dragged;
  if (state.moved.size === 0 && !dragged) return undefined;
  const at = new Map(state.moved);
  if (dragged) at.set(dragged.key, dragged.at);
  return { at, held: state.moved };
}

/** An ascending range, or null for none or an empty one. */
function ascending(range: readonly [number, number] | null): readonly [number, number] | null {
  return range && range[0] !== range[1] ? [Math.min(...range), Math.max(...range)] : null;
}

function same(a: readonly [number, number] | null, b: readonly [number, number] | null): boolean {
  return a === b || (a !== null && b !== null && a[0] === b[0] && a[1] === b[1]);
}

function inside(plot: Rect, px: number, py: number): boolean {
  return px >= plot.x && px <= plot.x + plot.width && py >= plot.y && py <= plot.y + plot.height;
}
