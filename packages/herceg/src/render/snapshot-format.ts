// What `renderToSnapshot` writes and `hydrateChart` reads: a chart's
// markup as the browser runtime builds it, and what the runtime needs to
// take its nodes over without drawing them again.

import type { Fonts } from "../fonts/registry.ts";

/** The snapshot format this herceg writes and reads. */
export const SNAPSHOT_VERSION = 1;

/**
 * A chart rendered on a server, to show before its scripts run and to
 * hydrate (`hydrateChart`, or the adapters' `initial`). Plain JSON: it
 * travels with the page.
 */
export interface ChartSnapshot {
  version: typeof SNAPSHOT_VERSION;
  /** The chart's element, as the browser runtime builds it: what the page shows first. */
  html: string;
  width: number;
  height: number;
  /** What its element's ids begin with; unique in the page. */
  idPrefix: string;
  /** The locale and time zone it was written in, which the chart keeps unless its options say otherwise. */
  locale: string;
  timeZone: string;
  /** How its text was measured: "estimate" (Helvetica metrics), or the fonts' fingerprint. */
  measure: string;
  /** What the runtime takes the nodes over with. */
  state: SnapshotState;
}

/** A geometry's nodes: its key and kind, and the count of its elements, or its group's markup hash. */
export type SnapshotGeometry =
  | [key: string, kind: string, elements: number]
  | [key: string, kind: string, elements: -1, hash: number];

/** What the runtime's layers drew, in their order, for taking their nodes over. */
export interface SnapshotState {
  /** Each panel's key and the geometry of its data group and of its drawings above. */
  /** Each panel's drawings, and an inset's the hash of the markup of its box, plot, and grid under them. */
  panels: [key: string, data: SnapshotGeometry[], above: SnapshotGeometry[], cover?: number][];
  /** Hashes of the markup under the data (backgrounds, grid) and of the guides. */
  under: number;
  guides: number;
  /** Whether the layer made the chart's own clip path, for marks cut to the chart. */
  chartClip: boolean;
  /** Each legend button's key, the keys it hides and shows, and for a panel's legend, there. */
  legend: [id: string, targets: string | readonly string[], panel?: string][];
}

/**
 * A name of `fonts` that is the same wherever the same faces are prepared:
 * their families, weights, and bytes.
 */
export function fontsFingerprint(fonts: Fonts): string {
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  for (const { family, weight = "normal", data } of fonts.faces) {
    const name = `${family}|${weight}|${data.byteLength}`;
    for (let i = 0; i < name.length; i++) {
      h1 = Math.imul(h1 ^ name.charCodeAt(i), 2654435761);
      h2 = Math.imul(h2 ^ name.charCodeAt(i), 1597334677);
    }
    for (let i = 0; i < data.length; i++) {
      h1 = Math.imul(h1 ^ data[i]!, 2654435761);
      h2 = Math.imul(h2 ^ data[i]!, 1597334677);
    }
  }
  return `fonts ${(h1 >>> 0).toString(16)}${(h2 >>> 0).toString(16)}`;
}
