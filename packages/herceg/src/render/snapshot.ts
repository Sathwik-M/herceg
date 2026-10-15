// Server rendering: a chart's element as the browser runtime builds it, for
// pages to show before their scripts run and for `hydrateChart` (or the
// adapters' `initial`) to take over without drawing it again. The runtime's
// own SVG layer and legend write the markup, over a small DOM of plain
// objects here, so the server's nodes are the ones the browser would make.

import { entryId, Legend } from "../dom/legend.ts";
import { hash, panelDrawing, SvgLayer } from "../dom/svg-layer.ts";
import { checkFonts } from "../fonts/prepared.ts";
import type { Fonts } from "../fonts/registry.ts";
import { estimateText } from "../layout/text.ts";
import { chartDescription } from "../model/describe.ts";
import { type ChartConfig, ChartModel } from "../model/model.ts";
import { titleText } from "../model/titles.ts";
import {
  type Geometry,
  guidesOf,
  type LegendGuide,
  type Scene,
  type SvgContext,
} from "../scene/scene.ts";
import { staticCompilers } from "./compilers.ts";
import { NO_PAGE } from "./fallbacks.ts";
import { pngDataUrl } from "./png.ts";
import {
  type ChartSnapshot,
  fontsFingerprint,
  SNAPSHOT_VERSION,
  type SnapshotGeometry,
  type SnapshotState,
} from "./snapshot-format.ts";
import { cutToChart, guidesMarkup, underMarkup } from "./svg.ts";

export type { ChartSnapshot, SnapshotGeometry, SnapshotState } from "./snapshot-format.ts";

/** Where a snapshot is drawn: its size, its ids, and what it measures and writes with. */
export interface SnapshotOptions {
  width: number;
  height: number;
  /**
   * What the element's ids begin with: unique in the page, and the same each
   * time the page is made, so the server's markup and the browser's agree.
   */
  idPrefix: string;
  /** Fonts to measure with, the same the browser's chart is given; Helvetica estimates by default. */
  fonts?: Fonts;
  /** When the chart's options set none: "en-US" and "UTC" by default ("local" is the server's own zone). */
  locale?: string;
  timeZone?: string;
}

/** The style of the chart's live region, visually hidden (as chart.ts writes it). */
const HIDDEN_TEXT =
  "position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0";

/**
 * Renders a chart on a server, without a DOM: its element as the browser
 * runtime builds it (`html`), with what hydrating it needs. Give the
 * browser's chart the same options; it keeps the snapshot's locale, time
 * zone, and measurement (fonts, or Helvetica estimates) until its options or
 * size change.
 *
 * ```ts
 * const initial = renderToSnapshot(options, { width: 640, height: 320, idPrefix: "latency" });
 * // In the page: initial.html; in the browser: hydrateChart(host, options, initial).
 * ```
 */
export function renderToSnapshot(options: ChartConfig, env: SnapshotOptions): ChartSnapshot {
  const { width, height, idPrefix, fonts } = env;
  for (const [name, value] of [
    ["width", width],
    ["height", height],
  ] as const)
    if (!(typeof value === "number" && value > 0 && Number.isFinite(value)))
      throw new TypeError(
        `renderToSnapshot ${name}: expected a size in CSS pixels; received ${String(value)}`,
      );
  if (typeof idPrefix !== "string" || !/^[A-Za-z][\w-]*$/.test(idPrefix))
    throw new TypeError(
      `renderToSnapshot idPrefix: expected a name that starts ids, unique in the page ("latency"); received ${JSON.stringify(idPrefix)}`,
    );
  checkFonts(fonts, "renderToSnapshot");
  const locale = options.locale ?? env.locale ?? "en-US";
  const timeZone = options.timeZone ?? env.timeZone ?? "UTC";
  if (timeZone === "local")
    throw new TypeError(
      'renderToSnapshot timeZone: "local" is the server\'s zone, which browsers may not share; give an IANA zone or "UTC"',
    );
  const model = new ChartModel({ ...options, locale, timeZone }, NO_PAGE, ...staticCompilers());
  model.setSize(width, height, 1);
  // What the bound stores hold now is drawn as a mounted chart draws it.
  options.rowSelection?.highlight(model);
  const scene = model.scene(fonts?.measure ?? estimateText);
  const document = new ShimDocument();
  const encodeRaster: SvgContext["encodeRaster"] = (raster) =>
    pngDataUrl(raster.columns, raster.rows, raster.pixels);
  const layer = new SvgLayer(document as unknown as Document, idPrefix);
  layer.render(scene, { marks: true, encodeRaster });
  const legend = new Legend(document as unknown as Document, () => {});
  const legends = guidesOf(scene, "legend");
  legend.update(legends, scene.theme);
  const root = document.createElement("div");
  root.setAttribute("data-herceg", idPrefix);
  const kerning = fonts ? ";font-kerning:none;font-variant-ligatures:none" : "";
  root.setAttribute(
    "style",
    `position:relative;overflow:hidden;outline-offset:2px;width:${scene.width}px;height:${scene.height}px${kerning}`,
  );
  root.setAttribute("tabindex", "0");
  root.setAttribute("role", "figure");
  root.setAttribute("aria-label", titleText(options.title) ?? "Chart");
  root.setAttribute("aria-describedby", `${idPrefix}-description`);
  const description = document.createElement("div");
  description.setAttribute("id", `${idPrefix}-description`);
  description.setAttribute("hidden", "");
  description.textContent = chartDescription(model);
  const live = document.createElement("div");
  live.setAttribute("aria-live", "polite");
  live.setAttribute("aria-atomic", "true");
  live.setAttribute("style", HIDDEN_TEXT);
  root.append(
    layer.svg as unknown as ShimElement,
    legend.element as unknown as ShimElement,
    description,
    live,
  );
  return {
    version: SNAPSHOT_VERSION,
    html: root.outerHTML,
    width: scene.width,
    height: scene.height,
    idPrefix,
    locale,
    timeZone,
    measure: fonts ? fontsFingerprint(fonts) : "estimate",
    state: stateOf(scene, idPrefix, legends, { theme: scene.theme, encodeRaster }),
  };
}

/** What the layer and the legend drew, in their order: see `SnapshotState`. */
function stateOf(
  scene: Scene,
  idPrefix: string,
  legends: readonly LegendGuide[],
  context: SvgContext,
): SnapshotState {
  const geometry = (marks: readonly Geometry[]) =>
    marks.map((mark): SnapshotGeometry => {
      const elements = mark.draw.elements?.(mark, context);
      return elements
        ? [mark.key, mark.kind, elements.length]
        : [mark.key, mark.kind, -1, hash(mark.draw.svg(mark, context))];
    });
  return {
    panels: scene.panels.map((panel) => {
      const { data, above } = panelDrawing(panel, true);
      return [panel.key, geometry(data), geometry(above)];
    }),
    under: hash(underMarkup(scene)),
    guides: hash(guidesMarkup(scene, idPrefix, false)),
    chartClip: cutToChart(scene),
    legend: legends.flatMap((legend) =>
      legend.entries.map((item): [string, string | readonly string[]] => [
        entryId(legends, legend, item),
        item.targets ?? item.key,
      ]),
    ),
  };
}

const XHTML = "http://www.w3.org/1999/xhtml";

/**
 * Just enough of a DOM for the SVG layer and the legend to build their
 * nodes on a server: elements with attributes, styles, children, and raw
 * markup, written out as HTML.
 */
class ShimDocument {
  createElement(tag: string): ShimElement {
    return new ShimElement(this, tag, XHTML);
  }

  createElementNS(namespace: string, tag: string): ShimElement {
    return new ShimElement(this, tag, namespace);
  }
}

class ShimElement {
  readonly ownerDocument: ShimDocument;
  readonly tagName: string;
  readonly #html: boolean;
  parentNode: ShimElement | null = null;
  readonly #attributes = new Map<string, string>();
  #children: ShimElement[] = [];
  /** Text or markup set as a whole, written out as given; null when the element has children. */
  #content: string | null = null;
  readonly style: Record<string, string>;

  constructor(document: ShimDocument, tag: string, namespace: string) {
    this.ownerDocument = document;
    this.tagName = tag;
    this.#html = namespace === XHTML;
    const declarations = new Map<string, string>();
    const write = () => [...declarations].map(([name, value]) => `${name}:${value}`).join(";");
    const element = this;
    this.style = new Proxy({} as Record<string, string>, {
      set(_, property: string, value: string) {
        if (property === "cssText") {
          declarations.clear();
          for (const declaration of value.split(";")) {
            const colon = declaration.indexOf(":");
            if (colon > 0)
              declarations.set(
                declaration.slice(0, colon).trim(),
                declaration.slice(colon + 1).trim(),
              );
          }
        } else {
          const name = property.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
          if (value === "") declarations.delete(name);
          else declarations.set(name, value);
        }
        const css = write();
        if (css) element.#attributes.set("style", css);
        else element.#attributes.delete("style");
        return true;
      },
      get(_, property: string) {
        return property === "cssText" ? write() : (declarations.get(property) ?? "");
      },
    });
  }

  setAttribute(name: string, value: string): void {
    this.#attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.#attributes.get(name) ?? null;
  }

  removeAttribute(name: string): void {
    this.#attributes.delete(name);
  }

  get id(): string {
    return this.getAttribute("id") ?? "";
  }

  set title(value: string) {
    this.setAttribute("title", value);
  }

  set type(value: string) {
    this.setAttribute("type", value);
  }

  set hidden(value: boolean) {
    if (value) this.setAttribute("hidden", "");
    else this.removeAttribute("hidden");
  }

  set innerHTML(markup: string) {
    for (const child of this.#children) child.parentNode = null;
    this.#children = [];
    this.#content = markup;
  }

  set textContent(text: string) {
    this.innerHTML = text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
  }

  get firstChild(): ShimElement | null {
    return this.#children[0] ?? null;
  }

  get firstElementChild(): ShimElement | null {
    return this.firstChild;
  }

  get nextSibling(): ShimElement | null {
    const parent = this.parentNode;
    if (!parent) return null;
    const siblings = parent.#children;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }

  get nextElementSibling(): ShimElement | null {
    return this.nextSibling;
  }

  append(...nodes: ShimElement[]): void {
    for (const node of nodes) this.insertBefore(node, null);
  }

  appendChild(node: ShimElement): ShimElement {
    this.insertBefore(node, null);
    return node;
  }

  insertBefore(node: ShimElement, before: ShimElement | null): void {
    node.remove();
    this.#content = null;
    const at = before ? this.#children.indexOf(before) : -1;
    this.#children.splice(at < 0 ? this.#children.length : at, 0, node);
    node.parentNode = this;
  }

  remove(): void {
    const parent = this.parentNode;
    if (!parent) return;
    parent.#children.splice(parent.#children.indexOf(this), 1);
    this.parentNode = null;
  }

  contains(): boolean {
    return false;
  }

  addEventListener(): void {}

  get outerHTML(): string {
    let attributes = "";
    for (const [name, value] of this.#attributes)
      attributes +=
        value === "" && this.#html ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`;
    const inner = this.#content ?? this.#children.map((child) => child.outerHTML).join("");
    return `<${this.tagName}${attributes}>${inner}</${this.tagName}>`;
  }
}

function escapeAttribute(value: string): string {
  return value.replace(/[&"<]/g, (c) => `&#${c.charCodeAt(0)};`);
}
