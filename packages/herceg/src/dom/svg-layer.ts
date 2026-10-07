import { canvasRasterUrl } from "../render/canvas.ts";
import {
  areaPath,
  axisElements,
  colorLegendElement,
  gridPath,
  linePath,
  pointCircles,
  pointPath,
  rectPath,
  ruleElement,
  textElements,
  titleElement,
} from "../render/svg.ts";
import {
  isGuide,
  type MarkGeometry,
  type RuleGeometry,
  type Scene,
  type TextGeometry,
} from "../scene/scene.ts";
import type { Theme } from "../theme.ts";

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

function set(node: Element, name: string, value: string) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}

/**
 * Retained SVG output. Mark paths are kept per geometry key and only their
 * attributes change between frames; axes and grid are rebuilt only when their
 * markup changes. The overlay group belongs to the pointer layer.
 */
export class SvgLayer {
  readonly svg: SVGSVGElement;
  readonly overlay: SVGGElement;
  readonly #document: Document;
  readonly #clipRect: SVGRectElement;
  readonly #background: SVGRectElement;
  readonly #grid: SVGPathElement;
  readonly #marks: SVGGElement;
  /**
   * Rules and text, one group per geometry key, each rewritten only when its
   * markup changes: labels may change every frame.
   */
  readonly #annotations: SVGGElement;
  readonly #annotationNodes = new Map<string, { node: SVGGElement; markup: string }>();
  /** Axes, title, and color legend. */
  readonly #guides: SVGGElement;
  readonly #nodes = new Map<string, SVGElement[]>();
  readonly #id: string;
  #guideMarkup = "";

  constructor(document: Document, id: string) {
    this.#document = document;
    this.#id = id;
    this.svg = element(document, "svg", { "aria-hidden": "true" });
    this.svg.style.cssText = "position:absolute;left:0;top:0;overflow:visible";
    const defs = element(document, "defs");
    const clip = element(document, "clipPath", { id: `${id}-clip` });
    this.#clipRect = element(document, "rect");
    clip.append(this.#clipRect);
    defs.append(clip);
    this.#background = element(document, "rect", { fill: "none" });
    this.#grid = element(document, "path", { fill: "none" });
    this.#marks = element(document, "g", { "clip-path": `url(#${id}-clip)` });
    this.#annotations = element(document, "g");
    this.#guides = element(document, "g");
    this.overlay = element(document, "g", { "pointer-events": "none" });
    this.svg.append(
      defs,
      this.#background,
      this.#grid,
      this.#marks,
      this.#annotations,
      this.#guides,
      this.overlay,
    );
  }

  /** Draws the scene. With `marks: false` the canvas owns grid and data. */
  render(scene: Scene, options: { marks: boolean }): void {
    const { svg } = this;
    const { width, height, plot, theme } = scene;
    set(svg, "width", String(width));
    set(svg, "height", String(height));
    set(svg, "viewBox", `0 0 ${width} ${height}`);
    set(svg, "font-family", theme.font);
    set(svg, "font-size", String(theme.fontSize));
    set(svg, "fill", theme.muted);
    set(this.#clipRect, "x", String(plot.x));
    set(this.#clipRect, "y", String(plot.y));
    set(this.#clipRect, "width", String(plot.width));
    set(this.#clipRect, "height", String(plot.height));

    const background = options.marks && theme.background !== "transparent";
    set(this.#background, "width", background ? String(width) : "0");
    set(this.#background, "height", background ? String(height) : "0");
    set(this.#background, "fill", background ? theme.background : "none");
    set(this.#grid, "d", options.marks ? gridPath(scene) : "");
    set(this.#grid, "stroke", theme.grid);

    this.#renderMarks(options.marks ? scene.marks.filter((mark) => !isGuide(mark)) : []);

    this.#renderAnnotations(scene.marks.filter(isGuide), theme);
    let markup = `<g style="font-variant-numeric:tabular-nums">${axisElements(scene.axes, theme)}</g>`;
    markup += titleElement(scene);
    if (scene.colorLegend)
      markup += colorLegendElement(scene.colorLegend, theme, `${this.#id}-ramp`);
    if (markup !== this.#guideMarkup) {
      this.#guides.innerHTML = markup;
      this.#guideMarkup = markup;
    }
  }

  #renderAnnotations(guides: readonly (RuleGeometry | TextGeometry)[], theme: Theme) {
    const seen = new Set<string>();
    let previous: Element | null = null;
    for (const guide of guides) {
      seen.add(guide.key);
      let entry = this.#annotationNodes.get(guide.key);
      if (!entry) {
        entry = { node: element(this.#document, "g"), markup: "" };
        this.#annotationNodes.set(guide.key, entry);
      }
      const markup = guide.kind === "rule" ? ruleElement(guide, theme) : textElements(guide, theme);
      if (markup !== entry.markup) {
        entry.node.innerHTML = markup;
        entry.markup = markup;
      }
      previous = keepOrder(this.#annotations, entry.node, previous);
    }
    for (const [key, entry] of this.#annotationNodes) {
      if (seen.has(key)) continue;
      entry.node.remove();
      this.#annotationNodes.delete(key);
    }
  }

  #renderMarks(marks: readonly MarkGeometry[]) {
    const seen = new Set<string>();
    let previous: Element | null = null;
    for (const mark of marks) {
      seen.add(mark.key);
      const tag = elementTag(mark);
      const count = mark.kind === "area" && mark.stroke ? 2 : 1;
      let nodes = this.#nodes.get(mark.key);
      // A different element (or a different kind of mark reusing the key)
      // starts from fresh nodes, so no attributes carry over.
      if (
        !nodes ||
        nodes.length !== count ||
        nodes[0]!.tagName !== tag ||
        nodes[0]!.dataset.kind !== mark.kind
      ) {
        for (const node of nodes ?? []) node.remove();
        nodes = Array.from({ length: count }, () =>
          element(this.#document, tag, { "data-kind": mark.kind }),
        );
        this.#nodes.set(mark.key, nodes);
      }
      updateMark(mark, nodes);
      for (const node of nodes) previous = keepOrder(this.#marks, node, previous);
    }
    for (const [key, nodes] of this.#nodes) {
      if (seen.has(key)) continue;
      for (const node of nodes) node.remove();
      this.#nodes.delete(key);
    }
  }
}

/** Places `node` right after `previous` (first when null), keeping document order equal to scene order. */
function keepOrder(parent: Element, node: Element, previous: Element | null): Element {
  const expected = previous ? previous.nextSibling : parent.firstChild;
  if (node !== expected) parent.insertBefore(node, expected);
  return node;
}

function elementTag(mark: MarkGeometry): "path" | "image" | "g" {
  if (mark.kind === "raster") return "image";
  if (mark.kind === "point" && !mark.opaque) return "g";
  return "path";
}

function updateMark(mark: MarkGeometry, nodes: SVGElement[]): void {
  const [first, second] = nodes as [SVGElement, SVGElement | undefined];
  switch (mark.kind) {
    case "line":
      set(first, "d", linePath(mark.path));
      set(first, "fill", "none");
      set(first, "stroke", mark.stroke);
      set(first, "stroke-width", String(mark.strokeWidth));
      set(first, "stroke-linejoin", "round");
      set(first, "stroke-linecap", "round");
      set(first, "stroke-dasharray", mark.dash?.join(" ") ?? "none");
      return;
    case "area":
      set(first, "d", areaPath(mark));
      set(first, "fill", mark.fill);
      set(first, "fill-opacity", String(mark.fillOpacity));
      set(first, "stroke", "none");
      if (second && mark.stroke) {
        set(second, "d", linePath(mark.upper));
        set(second, "fill", "none");
        set(second, "stroke", mark.stroke);
        set(second, "stroke-width", String(mark.strokeWidth));
        set(second, "stroke-linejoin", "round");
      }
      return;
    case "rect":
      set(first, "d", rectPath(mark));
      set(first, "fill", mark.fill);
      set(first, "fill-opacity", String(mark.fillOpacity));
      return;
    case "point":
      set(first, "fill", mark.fill);
      set(first, "fill-opacity", String(mark.fillOpacity));
      if (!mark.opaque) first.innerHTML = pointCircles(mark);
      else set(first, "d", pointPath(mark));
      return;
    case "raster":
      set(first, "x", String(mark.x));
      set(first, "y", String(mark.y));
      set(first, "width", String(mark.width));
      set(first, "height", String(mark.height));
      set(first, "preserveAspectRatio", "none");
      set(first, "style", "image-rendering:pixelated");
      set(first, "href", canvasRasterUrl(mark, first.ownerDocument));
      return;
    case "rule":
    case "text":
      return;
  }
}

export { element as svgElement };
