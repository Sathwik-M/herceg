import { isLightColor } from "../scale/color.ts";
import type { ThemeEnvironment } from "../theme.ts";

let swatch: CanvasRenderingContext2D | null | undefined;

/** Channels (0 to 255) and alpha of a computed CSS color. */
function rgba(color: string): [number, number, number, number] {
  const legacy = /^rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)$/.exec(color);
  if (legacy) {
    return [Number(legacy[1]), Number(legacy[2]), Number(legacy[3]), Number(legacy[4] ?? 1)];
  }
  // Colors in other spaces (oklch, display-p3) become sRGB by painting them.
  swatch ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  if (!swatch) return [0, 0, 0, 1];
  swatch.clearRect(0, 0, 1, 1);
  swatch.fillStyle = color;
  swatch.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = swatch.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!, Math.round((a! / 255) * 1000) / 1000];
}

/** A computed CSS color as the renderers read it: hex when opaque, `rgba()` otherwise. */
function portable(color: string): string {
  const [r, g, b, a] = rgba(color);
  if (a === 0) return "transparent";
  if (a < 1) return `rgba(${r}, ${g}, ${b}, ${a})`;
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * What is drawn behind `element`: its parent, across slots and shadow roots.
 * The walk ends at the document; a chart in a frame judges the frame's page.
 */
function behind(element: Element): Element | null {
  if (element.assignedSlot) return element.assignedSlot;
  if (element.parentElement) return element.parentElement;
  const root = element.getRootNode();
  return "host" in root ? (root as ShadowRoot).host : null;
}

/**
 * Whether `element` sits on a dark surface: the background colors behind it,
 * composited over the page's canvas, which is dark when the page allows a
 * dark color scheme and the user prefers one.
 */
function onDarkSurface(element: HTMLElement): boolean {
  const layers: [number, number, number, number][] = [];
  let last: Element = element;
  for (let at: Element | null = element; at; at = behind(at)) {
    last = at;
    const view = at.ownerDocument.defaultView;
    if (!view) break;
    const layer = rgba(view.getComputedStyle(at).backgroundColor);
    if (layer[3] > 0) layers.push(layer);
    if (layer[3] >= 1) break;
  }
  // Browsers paint dark canvases a near-black gray.
  let color: [number, number, number] = darkCanvas(last.ownerDocument)
    ? [18, 18, 18]
    : [255, 255, 255];
  for (let i = layers.length - 1; i >= 0; i--) {
    const [r, g, b, a] = layers[i]!;
    color = [r * a + color[0] * (1 - a), g * a + color[1] * (1 - a), b * a + color[2] * (1 - a)];
  }
  return isLightColor(`rgb(${color.map(Math.round).join(", ")})`) === false;
}

/** Whether a document's canvas, under all its elements, is dark. */
function darkCanvas(document: Document): boolean {
  const view = document.defaultView;
  const scheme = view?.getComputedStyle(document.documentElement).colorScheme ?? "";
  if (!scheme.includes("dark")) return false;
  return (
    !scheme.includes("light") ||
    (view?.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false)
  );
}

/**
 * Calls `use` with what themes that follow the page read: whether the chart
 * sits on a dark surface, and CSS values as they compute inside `element`.
 * CSS variables that are not set fall back as in CSS: to their fallback,
 * else to the inherited value.
 */
export function readPage<T>(element: HTMLElement, use: (page: ThemeEnvironment) => T): T {
  const document = element.ownerDocument;
  let probe: HTMLElement | undefined;
  // Themes repeat values (a variable in several tokens); each is read once.
  const read = new Map<string, string>();
  const computed = (property: "color" | "fontFamily", value: string) => {
    const key = `${property}:${value}`;
    let result = read.get(key);
    if (result !== undefined) return result;
    if (!probe) {
      probe = document.createElement("span");
      probe.style.display = "none";
      element.append(probe);
    }
    probe.style[property] = "";
    probe.style[property] = value;
    result = getComputedStyle(probe)[property];
    if (property === "color") result = portable(result);
    read.set(key, result);
    return result;
  };
  try {
    return use({
      get dark() {
        return onDarkSurface(element);
      },
      color: (value) => computed("color", value),
      font: (value) => computed("fontFamily", value),
    });
  } finally {
    probe?.remove();
  }
}

/**
 * Calls `changed` when the page may have switched themes: its preferred
 * color scheme changed, or an attribute (a class, style, or data attribute)
 * of its root or body did.
 */
export function watchPage(document: Document, changed: () => void): () => void {
  const scheme = document.defaultView?.matchMedia?.("(prefers-color-scheme: dark)");
  scheme?.addEventListener("change", changed);
  const observer =
    typeof MutationObserver === "undefined" ? undefined : new MutationObserver(changed);
  for (const element of [document.documentElement, document.body])
    if (element) observer?.observe(element, { attributes: true });
  return () => {
    scheme?.removeEventListener("change", changed);
    observer?.disconnect();
  };
}
