// Tracks: the room kept along a chart's sides for what stands outside its
// plots (a title, a legend), measured first and stacked from each side's
// edge inward, outermost first; the panels take what is left.

import type { Side } from "../spec/place.ts";

/** Room asked for along a side of the chart, measured before the panels are placed. */
export interface TrackRequest {
  /** Who asks: a guide's key, such as "title" or "legend". */
  readonly key: string;
  readonly side: Side;
  /** How thick it is across its side, in pixels. */
  readonly size: number;
  /** Pixels kept between it and the next track inward, or the panels. */
  readonly gap: number;
}

/**
 * Stacks `requests` on each side inward from that side's edge in `edges`
 * (measured from the chart's top for top and bottom, from its left for
 * left and right), in the order given. Returns each track's top edge (top
 * and bottom tracks) or left edge (left and right ones), and each side's
 * edge after its tracks, where the panels' room begins.
 */
export function stackTracks(
  requests: readonly TrackRequest[],
  edges: Readonly<Record<Side, number>>,
): { tracks: ReadonlyMap<string, number>; edges: Record<Side, number> } {
  const tracks = new Map<string, number>();
  const at = { ...edges };
  for (const { key, side, size, gap } of requests) {
    if (side === "top" || side === "left") {
      tracks.set(key, at[side]);
      at[side] += size + gap;
    } else {
      at[side] -= size;
      tracks.set(key, at[side]);
      at[side] -= gap;
    }
  }
  return { tracks, edges: at };
}
