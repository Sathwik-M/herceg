// Events a chart emits to the application.

import type { Inspection } from "../model/model.ts";
import { report } from "./scheduler.ts";

/** Chart events by name, with what their listeners receive. */
export interface ChartEvents {
  /**
   * The visible x range changed: zoom, pan, reset, `setViewport`, or a
   * synced chart. `domain` is null when the chart fits its data.
   */
  viewport: { domain: readonly [number, number] | null };
  /** The brushed x range changed; `x` is null when the selection was cleared. */
  select: { x: readonly [number, number] | null };
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
