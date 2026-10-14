// Events a chart emits to the application.

import type { ItemChanges } from "../model/item-views.ts";
import type { Inspection, Viewport } from "../model/model.ts";
import type { RowSelectionChange } from "../model/row-selection.ts";
import type { Selection } from "./brushed.ts";
import { report } from "./scheduler.ts";

/** The panel a view or selection is set in, for charts whose panels have scales of their own. */
export interface PanelTarget {
  /** A panel's key: its facet value (both, in a grid, as a JSON array) or subplot id. */
  panel?: string;
}

/** Chart events by name, with what their listeners receive. */
export interface ChartEvents {
  /**
   * The view changed (zoom, pan, reset, `setViewport`, or a synced chart):
   * the x range and the left and right y axes' ranges, each null when that
   * axis is not zoomed. One event reports a change of several axes.
   */
  viewport: Viewport & {
    /**
     * In charts whose panels have x scales of their own, the keys of the
     * panels whose x range `x` is; a change for several reports each.
     */
    panels?: readonly string[];
  };
  /**
   * The selection changed: its x and y ranges and a lasso's outline, all
   * null when the selection was cleared.
   */
  select: Selection & {
    /**
     * In charts whose panels have x scales of their own, the keys of the
     * panels sharing the selection's x scale; for a cleared selection, those
     * it belonged to.
     */
    panels?: readonly string[];
    /**
     * With `rowSelection`, what the selection wrote to the channels it
     * binds: per table, the rows it covers (a condition for brushes, rows
     * for lassos), or null where clearing it cleared them. Selections from
     * synced charts write nothing.
     */
    rows?: readonly RowSelectionChange[];
  };
  /** The data under the pointer or cursor changed; undefined when there is none. */
  hover: { inspection: Inspection | undefined };
  /**
   * The plot was clicked (not dragged), with the data under the pointer and,
   * with `rowSelection` taking clicks, what the click wrote to the channels
   * (the rows clicked, or null where a click off the data cleared them).
   */
  click: { inspection: Inspection | undefined; rows?: readonly RowSelectionChange[] };
  /**
   * A channel `rowSelection` binds changed, whoever changed it (this chart,
   * another, a grid): its table, its name, and what it holds now.
   */
  rowSelection: RowSelectionChange;
  /**
   * A 3D chart's camera moved: dragged, zoomed, reset, turned by keys or
   * buttons, or set with `setCamera`; once per camera per frame at most.
   * Subplot changes name their owner in `panels`; standalone changes omit it.
   */
  camera: ItemChanges["camera"];
  /**
   * A treemap or sunburst was drilled into a node or back out (a click,
   * Enter, Backspace, a breadcrumb, or `setDrillRoot`): the node's item key,
   * null for the whole tree, and the path to it.
   */
  drill: ItemChanges["drill"];
  /**
   * A network's node was moved (dragged, Shift with the arrow keys, or
   * `setItemPosition`), or put back where the layout puts it (null): its
   * item key and where it is now, in the network's layout units.
   */
  itemMove: ItemChanges["itemMove"];
  /**
   * Series or items were hidden or shown: through the legend,
   * `setVisibility` or `setHiddenKeys`, or as marks the chart no longer
   * has took their keys along. The keys now hidden.
   */
  visibility: { hiddenKeys: readonly string[] };
  /**
   * The chart drew a frame of its data, axes, and legend (a cursor or
   * tooltip moving alone draws none): panels, pixel mapping, and the legend
   * now describe it, for overlays drawn over the chart.
   */
  render: Record<string, never>;
}

export type ChartListener<K extends keyof ChartEvents> = (event: ChartEvents[K]) => void;

/** Listeners by event. A listener that throws is reported; the others still run. */
export class Emitter {
  readonly #listeners = new Map<keyof ChartEvents, Set<(event: never) => void>>();

  on<K extends keyof ChartEvents>(type: K, listener: ChartListener<K>): () => void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /** Whether anyone listens, so payloads nobody reads need not be computed. */
  has(type: keyof ChartEvents): boolean {
    return (this.#listeners.get(type)?.size ?? 0) > 0;
  }

  emit<K extends keyof ChartEvents>(type: K, event: ChartEvents[K]): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      try {
        (listener as ChartListener<K>)(event);
      } catch (error) {
        report(error);
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
