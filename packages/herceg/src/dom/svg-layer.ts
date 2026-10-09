import { canvasRasterUrl } from "../render/canvas.ts";
import { axisElements, gridPath, headerElements, titleElement } from "../render/svg.ts";
import type { Geometry, Panel, Scene, SvgContext, SvgElement } from "../scene/scene.ts";

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
interface Retained {
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
function hash(text: string): number {
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
interface PanelNodes {
  clip: SVGClipPathElement;
  clipRect: SVGRectElement;
  /** Data, clipped to the panel's plot. */
  marks: SVGGElement;
  /** Rules and text, above the data and unclipped. */
  annotations: SVGGElement;
  markNodes: Map<string, Retained>;
  annotationNodes: Map<string, Retained>;
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
  readonly #background: SVGRectElement;
  /** Followed by each panel's data group, then each panel's annotation group. */
  readonly #grid: SVGPathElement;
  /** Axes, title, and color legend. */
  readonly #guides: SVGGElement;
  readonly #panels = new Map<string, PanelNodes>();
  readonly #id: string;
  /** Clip paths made so far, for unique ids. */
  #clips = 0;
  #guideMarkup = "";

  constructor(document: Document, id: string) {
    this.#document = document;
    this.#id = id;
    this.svg = element(document, "svg", { "aria-hidden": "true" });
    this.svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible";
    this.#defs = element(document, "defs");
    this.#background = element(document, "rect", { fill: "none" });
    this.#grid = element(document, "path", { fill: "none" });
    this.#guides = element(document, "g");
    this.overlay = element(document, "g", { "pointer-events": "none" });
    this.svg.append(this.#defs, this.#background, this.#grid, this.#guides, this.overlay);
  }

  #panelNodes(key: string): PanelNodes {
    let nodes = this.#panels.get(key);
    if (nodes) return nodes;
    const document = this.#document;
    const id = `${this.#id}-clip-${this.#clips++}`;
    const clip = element(document, "clipPath", { id });
    const clipRect = element(document, "rect");
    clip.append(clipRect);
    this.#defs.append(clip);
    nodes = {
      clip,
      clipRect,
      marks: element(document, "g", { "clip-path": `url(#${id})` }),
      annotations: element(document, "g"),
      markNodes: new Map(),
      annotationNodes: new Map(),
    };
    this.#panels.set(key, nodes);
    return nodes;
  }

  /** Draws the scene. With `marks: false` the canvas owns grid and data. */
  render(scene: Scene, options: { marks: boolean }): void {
    const { svg } = this;
    const { width, height, theme } = scene;
    set(svg, "width", String(width));
    set(svg, "height", String(height));
    set(svg, "viewBox", `0 0 ${width} ${height}`);
    set(svg, "font-family", theme.font);
    set(svg, "font-size", String(theme.fontSize));
    set(svg, "fill", theme.muted);

    const background = options.marks && theme.background !== "transparent";
    set(this.#background, "width", background ? String(width) : "0");
    set(this.#background, "height", background ? String(height) : "0");
    set(this.#background, "fill", background ? theme.background : "none");
    set(this.#grid, "d", options.marks ? scene.panels.map(gridPath).join("") : "");
    set(this.#grid, "stroke", theme.grid);
    set(this.#grid, "stroke-dasharray", theme.gridDash.join(" "));

    const document = this.#document;
    const context: SvgContext = {
      theme,
      encodeRaster: (raster) => canvasRasterUrl(raster, document),
    };
    const seen = new Set<string>();
    const panels = scene.panels.map((panel) => {
      seen.add(panel.key);
      const nodes = this.#panelNodes(panel.key);
      this.#renderPanel(nodes, panel, options.marks, context);
      return nodes;
    });
    // Data groups follow the grid in panel order, annotation groups follow them.
    let previous: Element = this.#grid;
    for (const nodes of panels) previous = keepOrder(svg, nodes.marks, previous);
    for (const nodes of panels) previous = keepOrder(svg, nodes.annotations, previous);
    for (const [key, nodes] of this.#panels) {
      if (seen.has(key)) continue;
      nodes.clip.remove();
      nodes.marks.remove();
      nodes.annotations.remove();
      this.#panels.delete(key);
    }
    const axes = scene.panels.flatMap((panel) => panel.axes);
    let markup = `<g style="font-variant-numeric:tabular-nums">${axisElements(axes, theme)}</g>`;
    markup += headerElements(scene.headers, theme);
    markup += titleElement(scene);
    scene.colorLegends.forEach((legend, i) => {
      markup += legend.draw.svg(legend, theme, `${this.#id}-ramp-${i}`);
    });
    for (const legend of scene.glyphLegends) markup += legend.draw.svg(legend, theme, this.#id);
    if (markup !== this.#guideMarkup) {
      this.#guides.innerHTML = markup;
      this.#guideMarkup = markup;
    }
  }

  #renderPanel(nodes: PanelNodes, panel: Panel, marks: boolean, context: SvgContext): void {
    const { plot } = panel;
    set(nodes.clipRect, "x", String(plot.x));
    set(nodes.clipRect, "y", String(plot.y));
    set(nodes.clipRect, "width", String(plot.width));
    set(nodes.clipRect, "height", String(plot.height));
    const data = marks ? panel.marks.filter((mark) => !mark.draw.guide) : [];
    this.#renderKeyed(nodes.marks, nodes.markNodes, data, context);
    const guides = panel.marks.filter((mark) => mark.draw.guide);
    this.#renderKeyed(nodes.annotations, nodes.annotationNodes, guides, context);
  }

  /** Each geometry's nodes, in scene order; nodes of geometry no longer drawn go. */
  #renderKeyed(
    parent: SVGGElement,
    retained: Map<string, Retained>,
    geometry: readonly Geometry[],
    context: SvgContext,
  ) {
    const seen = new Set<string>();
    let previous: Element | null = null;
    for (const mark of geometry) {
      seen.add(mark.key);
      const old = retained.get(mark.key);
      const elements = mark.draw.elements?.(mark, context);
      const entry = elements
        ? this.#updateElements(old, mark.kind, elements)
        : this.#updateMarkup(old, mark.kind, mark.draw.svg(mark, context));
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
