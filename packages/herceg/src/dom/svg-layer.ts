import { canvasRasterUrl } from "../render/canvas.ts";
import { cutToChart, guidesMarkup, underMarkup } from "../render/svg.ts";
import {
  clipOf,
  type Geometry,
  type Panel,
  type Scene,
  type SvgContext,
  type SvgElement,
} from "../scene/scene.ts";

const NS = "http://www.w3.org/2000/svg";

function element<K extends keyof SVGElementTagNameMap>(
  document: Document,
  name: K,
  attributes: Record<string, string> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function set(node: Element, name: string, value: string): void {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/**
 * What the layer keeps for one geometry: its elements, updated in place,
 * or for drawings without elements, one group and a hash of its markup.
 */
export interface Retained {
  kind: string;
  nodes: Element[];
  /** Hash of the group's markup; undefined for elements. */
  hash: number | undefined;
  /** Attribute names last set on each element, to remove ones no longer set. */
  names: string[][];
}

/**
 * A 53-bit hash of a string (cyrb53). Groups remember the hash of their
 * markup rather than the markup itself, which for path data would keep a
 * second copy of every drawn path in memory; a collision, which would skip
 * one update, is vanishingly unlikely at 53 bits.
 */
export function hash(text: string): number {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** What the layer keeps for one panel: its clip, and its data and annotation groups. */
export interface PanelNodes {
  clip: SVGClipPathElement;
  clipRect: SVGRectElement;
  /** Data, clipped to the panel's plot. */
  marks: SVGGElement;
  /**
   * Above the data: data its marks do not cut to the plot, then rules and
   * text, each cut as its mark says.
   */
  annotations: SVGGElement;
  markNodes: Map<string, Retained>;
  annotationNodes: Map<string, Retained>;
}

/**
 * What a layer is made of: its elements, what it drew, and the hashes of
 * the markup its groups hold. A layer makes its own, or takes those of a
 * chart's server markup (dom/adopt.ts).
 */
export interface LayerParts {
  svg: SVGSVGElement;
  defs: SVGDefsElement;
  under: SVGGElement;
  guides: SVGGElement;
  overlay: SVGGElement;
  panels: Map<string, PanelNodes>;
  underHash: number;
  guidesHash: number;
  /** Clip paths made so far, for unique ids. */
  clips: number;
  chartClip: SVGRectElement | undefined;
}

/** The parts of a new, empty layer. */
function newParts(document: Document): LayerParts {
  const svg = element(document, "svg", { "aria-hidden": "true" });
  svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible";
  const parts: LayerParts = {
    svg,
    defs: element(document, "defs"),
    under: element(document, "g"),
    guides: element(document, "g"),
    overlay: element(document, "g", { "pointer-events": "none" }),
    panels: new Map(),
    underHash: hash(""),
    guidesHash: hash(""),
    clips: 0,
    chartClip: undefined,
  };
  svg.append(parts.defs, parts.under, parts.guides, parts.overlay);
  return parts;
}

/**
 * What the layer draws of a panel, in order: the data cut to its plot (with
 * `marks`, else the canvas draws it), then above it the data its marks do
 * not cut to the plot and the guide drawings (rules, text).
 */
export function panelDrawing(
  panel: Panel,
  marks: boolean,
): { data: readonly Geometry[]; above: readonly Geometry[] } {
  const cut = (mark: Geometry) => clipOf(mark) === "plot";
  const drawn = marks ? panel.marks.filter((mark) => !mark.draw.guide) : [];
  return {
    data: drawn.filter(cut),
    above: [
      ...drawn.filter((mark) => !cut(mark)),
      ...panel.marks.filter((mark) => mark.draw.guide),
    ],
  };
}

/** A geometry's elements, cut to `clip` (a clip path's `url(...)`), for drawings that have them. */
export function elementsOf(
  mark: Geometry,
  context: SvgContext,
  clip: string | undefined,
): SvgElement[] | undefined {
  const elements = mark.draw.elements?.(mark, context);
  return elements && clip
    ? elements.map(({ tag, attributes }) => ({
        tag,
        attributes: { ...attributes, "clip-path": clip },
      }))
    : elements;
}

/**
 * Retained SVG output. Each geometry is a group per key whose markup (from
 * the geometry's drawing) is rewritten only when it changes; axes and grid
 * are rebuilt only when their markup changes. The overlay group belongs to
 * the pointer layer.
 */
export class SvgLayer {
  readonly svg: SVGSVGElement;
  readonly overlay: SVGGElement;
  readonly #document: Document;
  readonly #defs: SVGDefsElement;
  /**
   * The chart's and plots' backgrounds and the grid lines; followed by each
   * panel's data group, then each panel's annotation group.
   */
  readonly #under: SVGGElement;
  /** Hashes of the markup the under and guides groups hold. */
  #underHash: number;
  #guidesHash: number;
  /** Axes, title, and color legend. */
  readonly #guides: SVGGElement;
  readonly #panels: Map<string, PanelNodes>;
  readonly #id: string;
  /** Clip paths made so far, for unique ids. */
  #clips: number;
  /** The chart's own clip, for marks cut to the chart; made when first needed. */
  #chartClip: SVGRectElement | undefined;

  constructor(document: Document, id: string, adopted?: LayerParts) {
    this.#document = document;
    this.#id = id;
    ({
      svg: this.svg,
      overlay: this.overlay,
      defs: this.#defs,
      under: this.#under,
      guides: this.#guides,
      panels: this.#panels,
      underHash: this.#underHash,
      guidesHash: this.#guidesHash,
      clips: this.#clips,
      chartClip: this.#chartClip,
    } = adopted ?? newParts(document));
  }

  #panelNodes(key: string): PanelNodes {
    let nodes = this.#panels.get(key);
    if (nodes) return nodes;
    const document = this.#document;
    const id = `${this.#id}-clip-${this.#clips++}`;
    const clipRect = this.#clipPath(id);
    nodes = {
      clip: clipRect.parentNode as SVGClipPathElement,
      clipRect,
      marks: element(document, "g", { "clip-path": `url(#${id})` }),
      annotations: element(document, "g"),
      markNodes: new Map(),
      annotationNodes: new Map(),
    };
    this.#panels.set(key, nodes);
    return nodes;
  }

  /**
   * Draws the scene. With `marks: false` the canvas owns grid and data.
   * Images (heatmaps) are encoded on a canvas unless `encodeRaster` says how.
   */
  render(
    scene: Scene,
    options: { marks: boolean; encodeRaster?: SvgContext["encodeRaster"] },
  ): void {
    const { svg } = this;
    const { width, height, theme } = scene;
    set(svg, "width", String(width));
    set(svg, "height", String(height));
    set(svg, "viewBox", `0 0 ${width} ${height}`);
    set(svg, "font-family", theme.font);
    set(svg, "font-size", String(theme.fontSize));
    set(svg, "fill", theme.muted);

    // Backgrounds and grid lines are the canvas' when it draws the marks.
    const under = options.marks ? underMarkup(scene) : "";
    const underHash = hash(under);
    if (underHash !== this.#underHash) {
      this.#under.innerHTML = under;
      this.#underHash = underHash;
    }

    const document = this.#document;
    const context: SvgContext = {
      theme,
      encodeRaster: options.encodeRaster ?? ((raster) => canvasRasterUrl(raster, document)),
    };
    const seen = new Set<string>();
    if (cutToChart(scene)) {
      this.#chartClip ??= this.#clipPath(`${this.#id}-clip-chart`);
      set(this.#chartClip, "width", String(width));
      set(this.#chartClip, "height", String(height));
    }
    const panels = scene.panels.map((panel) => {
      seen.add(panel.key);
      const nodes = this.#panelNodes(panel.key);
      this.#renderPanel(nodes, panel, options.marks, context);
      return nodes;
    });
    // Data groups follow the grid in panel order, annotation groups follow them.
    let previous: Element = this.#under;
    for (const nodes of panels) previous = keepOrder(svg, nodes.marks, previous);
    for (const nodes of panels) previous = keepOrder(svg, nodes.annotations, previous);
    for (const [key, nodes] of this.#panels) {
      if (seen.has(key)) continue;
      nodes.clip.remove();
      nodes.marks.remove();
      nodes.annotations.remove();
      this.#panels.delete(key);
    }
    // The series legend is the chart's HTML buttons.
    const markup = guidesMarkup(scene, this.#id, false);
    const guidesHash = hash(markup);
    if (guidesHash !== this.#guidesHash) {
      this.#guides.innerHTML = markup;
      this.#guidesHash = guidesHash;
    }
  }

  #renderPanel(nodes: PanelNodes, panel: Panel, marks: boolean, context: SvgContext): void {
    const { plot } = panel;
    set(nodes.clipRect, "x", String(plot.x));
    set(nodes.clipRect, "y", String(plot.y));
    set(nodes.clipRect, "width", String(plot.width));
    set(nodes.clipRect, "height", String(plot.height));
    const { data, above } = panelDrawing(panel, marks);
    this.#renderKeyed(nodes.marks, nodes.markNodes, data, context);
    const plotClip = `url(#${nodes.clip.id})`;
    const chartClip = `url(#${this.#id}-clip-chart)`;
    this.#renderKeyed(nodes.annotations, nodes.annotationNodes, above, context, (mark) => {
      const clip = clipOf(mark);
      return clip === "plot" ? plotClip : clip === "chart" ? chartClip : undefined;
    });
  }

  /** A new clip path of id `id`, and the rectangle that sets it. */
  #clipPath(id: string): SVGRectElement {
    const clip = element(this.#document, "clipPath", { id });
    const rect = element(this.#document, "rect");
    clip.append(rect);
    this.#defs.append(clip);
    return rect;
  }

  /**
   * Each geometry's nodes, in scene order, cut to the clip path `clipOf`
   * names, if any; nodes of geometry no longer drawn go.
   */
  #renderKeyed(
    parent: SVGGElement,
    retained: Map<string, Retained>,
    geometry: readonly Geometry[],
    context: SvgContext,
    clipOf?: (mark: Geometry) => string | undefined,
  ) {
    const seen = new Set<string>();
    let previous: Element | null = null;
    for (const mark of geometry) {
      seen.add(mark.key);
      const old = retained.get(mark.key);
      const clip = clipOf?.(mark);
      const elements = elementsOf(mark, context, clip);
      const entry = elements
        ? this.#updateElements(old, mark.kind, elements)
        : this.#updateMarkup(old, mark.kind, mark.draw.svg(mark, context));
      if (!elements) {
        const group = entry.nodes[0]!;
        if (clip) set(group, "clip-path", clip);
        else group.removeAttribute("clip-path");
      }
      if (entry !== old) {
        for (const node of old?.nodes ?? []) node.remove();
        retained.set(mark.key, entry);
      }
      for (const node of entry.nodes) previous = keepOrder(parent, node, previous);
    }
    for (const [key, entry] of retained) {
      if (seen.has(key)) continue;
      for (const node of entry.nodes) node.remove();
      retained.delete(key);
    }
  }

  /** Updates elements in place; a different kind or set of elements starts from fresh nodes. */
  #updateElements(old: Retained | undefined, kind: string, elements: SvgElement[]): Retained {
    const reuse =
      old?.hash === undefined &&
      old?.kind === kind &&
      old.nodes.length === elements.length &&
      old.nodes.every((node, i) => node.tagName === elements[i]!.tag);
    const entry: Retained = reuse
      ? old
      : {
          kind,
          nodes: elements.map(({ tag }) =>
            element(this.#document, tag as keyof SVGElementTagNameMap, { "data-kind": kind }),
          ),
          hash: undefined,
          names: elements.map(() => []),
        };
    elements.forEach(({ attributes }, i) => {
      const node = entry.nodes[i]!;
      const names = Object.keys(attributes);
      for (const name of entry.names[i]!) if (!(name in attributes)) node.removeAttribute(name);
      for (const name of names) set(node, name, attributes[name]!);
      entry.names[i] = names;
      // The layer's own attribute: drawings cannot change or remove it.
      set(node, "data-kind", kind);
    });
    return entry;
  }

  /** Rewrites a group's markup when it changes. */
  #updateMarkup(old: Retained | undefined, kind: string, markup: string): Retained {
    const reuse = old?.hash !== undefined && old.kind === kind;
    const entry: Retained = reuse
      ? old
      : { kind, nodes: [element(this.#document, "g", { "data-kind": kind })], hash: -1, names: [] };
    const markupHash = hash(markup);
    if (markupHash !== entry.hash) {
      entry.nodes[0]!.innerHTML = markup;
      entry.hash = markupHash;
    }
    return entry;
  }
}

/** Places `node` right after `previous` (first when null), keeping document order equal to scene order. */
function keepOrder(parent: Element, node: Element, previous: Element | null): Element {
  const expected = previous ? previous.nextSibling : parent.firstChild;
  if (node !== expected) parent.insertBefore(node, expected);
  return node;
}

export { element as svgElement };
