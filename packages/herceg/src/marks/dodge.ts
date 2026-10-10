// Where series stand within the bands of a category axis (or the bins of a
// histogram): dodged, side by side, as grouped bars are (marks/bar.ts), and
// jittered, each point moved across its share by a hash of its row's
// identity, so redrawing, resizing, and streaming leave it where it was.

import type { Frame } from "./mark.ts";
import type { Series } from "./series.ts";

/** A series' slot in each band: its place among `count` side by side. */
export interface Slot {
  index: number;
  count: number;
}

const WHOLE: Slot = { index: 0, count: 1 };

/** No displacement: a row drawn where its values place it. */
export const STILL: readonly [number, number] = [0, 0];

/**
 * The slots of a mark's visible series, in order: each its own, or, for a
 * mark in a legend group, its name's place among the group's visible series
 * (`Frame.groups`), so marks of one group dodge alike whatever series each
 * has. Undefined for a hidden series.
 */
export function slotsOf(
  series: readonly Series[],
  frame: Pick<Frame, "hidden" | "groups">,
  group: string | undefined,
): Map<Series, Slot> {
  const visible = series.filter((s) => !frame.hidden.has(s.key));
  const roster = group === undefined ? undefined : frame.groups?.get(group);
  const out = new Map<Series, Slot>();
  visible.forEach((s, i) => {
    const at = roster?.indexOf(s.label) ?? -1;
    out.set(
      s,
      at >= 0 ? { index: at, count: roster!.length } : { index: i, count: visible.length },
    );
  });
  return out;
}

/**
 * The slots of a mark's series as it last drew them, which its picking and
 * inspection read back: slots, not pixels, since one series may be drawn
 * in panels of different sizes.
 */
export class BandShares {
  readonly #slots = new WeakMap<Series, Slot>();

  /**
   * Records the slots of the visible `series`, dodged or each across the
   * whole band, and returns the dodged ones.
   */
  split(
    series: readonly Series[],
    frame: Pick<Frame, "hidden" | "groups">,
    group: string | undefined,
    dodge: boolean,
  ): Map<Series, Slot> {
    const slots = slotsOf(series, frame, group);
    // Parts of a series (highlighted rows) place it, as inspection reads it.
    for (const [s, slot] of slots) this.#slots.set(s.whole ?? s, dodge ? slot : WHOLE);
    return slots;
  }

  /** A series' slot as last split, or the whole band. */
  slotOf(s: Series): Slot {
    return this.#slots.get(s.whole ?? s) ?? WHOLE;
  }

  /**
   * A series' share of bands `bandwidth` pixels wide: its center's offset
   * from the band's, and its width, as grouped bars split a band.
   */
  of(s: Series, bandwidth: number): { center: number; width: number } {
    const { index, count } = this.slotOf(s);
    const slot = Math.abs(bandwidth);
    const width = slot / count;
    return { center: -slot / 2 + width * (index + 0.5), width };
  }
}

/**
 * A number in [0, 1) from a row's identity (`rowOffset + row`, which
 * survives rows dropped before it) and a seed: the same every time, and
 * spread evenly over rows (a 32-bit integer hash, murmur3's finalizer).
 */
export function jitterOf(identity: number, seed: number): number {
  const high = Math.floor(identity / 4294967296);
  let h = (Math.imul(identity >>> 0, 0x9e3779b1) ^ Math.imul(high | 0, 0x85ebca77) ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
