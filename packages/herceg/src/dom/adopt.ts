// Taking over a chart's server markup (`renderToSnapshot`): its element and
// nodes become the runtime's, which draws again only what differs from
// them. The markup is checked against the snapshot's, node for node, before
// anything changes, so markup it does not match is left as it is.

import type { Fonts } from "../fonts/registry.ts";
import { estimateText, type MeasureText } from "../layout/text.ts";
import {
  type ChartSnapshot,
  fontsFingerprint,
  SNAPSHOT_VERSION,
  type SnapshotGeometry,
} from "../render/snapshot-format.ts";
import type { Entry } from "./legend.ts";
import type { LayerParts, PanelNodes, Retained } from "./svg-layer.ts";

/** What a chart takes over of its server markup. */
export interface AdoptedChart {
  /** What its ids begin with. */
  id: string;
  root: HTMLDivElement;
  layer: LayerParts;
  legend: { element: HTMLDivElement; entries: Map<string, Entry> };
  description: HTMLDivElement;
  live: HTMLDivElement;
  /** How the markup measured its text. */
  measure: MeasureText;
  /** The size it was laid out at, which the chart's first frame keeps; resizing follows. */
  size: { width: number; height: number };
}

const SVG = "http://www.w3.org/2000/svg";

/**
 * The parts of the chart `snapshot` describes, found in `host`: its
 * element, holding the markup `snapshot.html` wrote, and the nodes in it.
 * Throws, changing nothing, for markup or fonts the snapshot does not match.
 */
export function adopt(host: Element, snapshot: ChartSnapshot, fonts?: Fonts): AdoptedChart {
  if (snapshot?.version !== SNAPSHOT_VERSION)
    throw new TypeError(
      `hydrateChart initial: a snapshot of another herceg (version ${String(snapshot?.version)}); render it again with this one`,
    );
  const { idPrefix: id, state } = snapshot;
  const measure =
    snapshot.measure === "estimate"
      ? estimateText
      : fonts && fontsFingerprint(fonts) === snapshot.measure
        ? fonts.measure
        : undefined;
  if (!measure)
    throw new TypeError(
      "hydrateChart fonts: the snapshot measured its text with other fonts; give the chart the fonts it was rendered with",
    );
  const unlike = () =>
    new TypeError(
      `hydrateChart initial: the markup of "${id}" in the host is not the snapshot's; put initial.html in the host as it is`,
    );
  const root = [...host.querySelectorAll<HTMLDivElement>("[data-herceg]")].find(
    (element) => element.getAttribute("data-herceg") === id,
  );
  // What the layers would keep is what the snapshot says they drew: the
  // markup must be the snapshot's as written, its text and attributes too,
  // which the snapshot's own, parsed inertly, tells.
  const written = host.ownerDocument.createElement("template");
  written.innerHTML = snapshot.html;
  if (!root?.isEqualNode(written.content.firstElementChild)) throw unlike();
  const [svg, legend, description, live, ...rest] = root.children;
  if (!(svg instanceof SVGSVGElement) || rest.length) throw unlike();
  const count = state.panels.length;
  const [defs, under, ...groups] = svg.children;
  const overlay = groups.pop();
  const guides = groups.pop();
  // Defs hold the chart's clip, when it has one, then each panel's.
  const clips = [...(defs?.children ?? [])];
  const chartClip = state.chartClip ? clips.shift() : undefined;
  if (
    defs?.tagName !== "defs" ||
    groups.length !== 2 * count ||
    clips.length !== count ||
    !overlay ||
    !guides ||
    !(legend instanceof HTMLDivElement) ||
    !(description instanceof HTMLDivElement) ||
    !(live instanceof HTMLDivElement)
  )
    throw unlike();
  const panels = new Map<string, PanelNodes>();
  state.panels.forEach(([key, data, above], i) => {
    const clip = clips[i] as SVGClipPathElement;
    const clipRect = clip.firstElementChild as SVGRectElement | null;
    if (clip.tagName !== "clipPath" || !clipRect) throw unlike();
    panels.set(key, {
      clip,
      clipRect,
      marks: groups[i] as SVGGElement,
      annotations: groups[count + i] as SVGGElement,
      markNodes: retained(groups[i]!, data, unlike),
      annotationNodes: retained(groups[count + i]!, above, unlike),
    });
  });
  const buttons = [...legend.children];
  if (buttons.length !== state.legend.length) throw unlike();
  const entries = new Map<string, Entry>();
  state.legend.forEach(([key, targets], i) => {
    const button = buttons[i] as HTMLButtonElement;
    const [swatch, label] = button.children as unknown as [HTMLSpanElement, HTMLSpanElement];
    if (button.tagName !== "BUTTON" || !swatch || !label) throw unlike();
    // A label in a box holds its text in an element of its own.
    const text = (label.firstElementChild as HTMLSpanElement | null) ?? label;
    entries.set(key, { button, swatch, label, text, shown: "", targets });
  });
  return {
    id,
    root,
    layer: {
      svg,
      defs: defs as SVGDefsElement,
      under: under as SVGGElement,
      guides: guides as SVGGElement,
      overlay: overlay as SVGGElement,
      panels,
      underHash: state.under,
      guidesHash: state.guides,
      clips: count,
      chartClip: chartClip?.firstElementChild as SVGRectElement | undefined,
    },
    legend: { element: legend, entries },
    description,
    live,
    measure,
    size: { width: snapshot.width, height: snapshot.height },
  };
}

/** What a panel's group holds, by geometry, as the layer keeps it (see `Retained`). */
function retained(
  group: Element,
  geometry: readonly SnapshotGeometry[],
  unlike: () => Error,
): Map<string, Retained> {
  const nodes = [...group.children];
  const kept = new Map<string, Retained>();
  let at = 0;
  for (const [key, kind, elements, hash] of geometry) {
    const length = elements < 0 ? 1 : elements;
    const taken = nodes.slice(at, at + length);
    at += length;
    if (
      taken.length !== length ||
      taken.some((node) => node.namespaceURI !== SVG || node.getAttribute("data-kind") !== kind)
    )
      throw unlike();
    kept.set(key, {
      kind,
      nodes: taken,
      hash,
      // The attributes the drawing set; the layer's own `data-kind` is not one.
      names: taken.map((node) => node.getAttributeNames().filter((name) => name !== "data-kind")),
    });
  }
  if (at !== nodes.length) throw unlike();
  return kept;
}
