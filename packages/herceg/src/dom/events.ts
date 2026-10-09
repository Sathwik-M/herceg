// Events a chart emits to the application.

import type { Inspection, Viewport } from "../model/model.ts";
import type { Selection } from "./brush.ts";
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
  };
  /** The data under the pointer or cursor changed; undefined when there is none. */
  hover: { inspection: Inspection | undefined };
  /** The plot was clicked (not dragged), with the data under the pointer. */
  click: { inspection: Inspection | undefined };
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
