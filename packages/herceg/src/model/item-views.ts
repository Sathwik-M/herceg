// What a chart's layout marks (pies, treemaps, maps, ...) drew in its last
// scene, panel by panel, and how tooltips, the keyboard, and the chart's
// description read their items; and what a chart of layout marks without
// facets or panels may have. A chart reaches this module through its
// layout marks (`LayoutMark.views`), so charts without any never load it.

import type { LayoutFrame, LayoutItem, LayoutMark, LayoutResult } from "../marks/layout-mark.ts";
import type { ChartMark } from "../marks/mark.ts";
import type { Panel, Rect, Scene } from "../scene/scene.ts";
import type { ItemInspection } from "./inspect.ts";
import { EDGE } from "./legend.ts";
import type { ChartConfig } from "./model.ts";
import type { PanelItem } from "./panel-layout.ts";

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
      throw new Error(`A ${type} mark has its chart to itself; draw other marks in another chart`);
    const interaction = config.interaction;
    // 3D charts zoom their camera.
    const zooms = interaction?.zoom && !drawn[0]!.camera;
    if (zooms || interaction?.brush || interaction?.sync || config.x?.seams)
      throw new Error(
        `Charts of a ${type} mark have no x axis to zoom, brush, sync, or mark seams on`,
      );
    return drawn;
  }

  #views: ItemView[] = [];
  /** Whether the panels are facets or subplots, whose inspections name them, not a chart's one. */
  #named = true;

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
   * room below, drawn with `frame`.
   */
  scene(
    size: { width: number; height: number; pixelRatio: number },
    header: Header,
    mark: LayoutMark,
    marks: readonly ChartMark[],
    frame: ItemFrame,
  ): Scene {
    const { width, height, pixelRatio } = size;
    this.#views = [];
    this.#named = false;
    const plot: Rect = {
      x: EDGE,
      y: header.top,
      width: Math.max(0, width - 2 * EDGE),
      height: Math.max(0, height - header.top - EDGE),
    };
    const panel = this.#draw({ key: "", label: "", plot }, mark, 0, marks, frame, undefined);
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
