// PNG export in the browser, loaded by `chart.toPNG()`: the chart's SVG
// export drawn on a canvas, which the browser encodes.

import type { FontSource } from "../fonts/registry.ts";

/**
 * A chart's SVG export as a PNG at `scale` times its size in CSS pixels.
 * An SVG drawn as an image sees none of the page's fonts, so the chart's
 * own `faces` go in it.
 */
export async function svgToPng(
  svg: string,
  width: number,
  height: number,
  document: Document,
  { scale = 2 }: { scale?: number } = {},
  faces: readonly FontSource[] = [],
): Promise<Blob> {
  if (!(scale > 0 && scale < Infinity))
    throw new RangeError(`toPNG scale: expected a positive number; received ${scale}`);
  if (faces.length) svg = svg.replace(/^<svg[^>]*>/, (root) => `${root}${fontFaces(faces)}`);
  const image = document.createElement("img");
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    image.src = url;
    await image.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("toPNG: the browser gave no 2D canvas to draw the chart on");
  // A transparent background stays transparent.
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("toPNG: the browser could not encode the PNG")),
      "image/png",
    ),
  );
}

/** CSS rules giving an SVG image `faces`, as data URLs. */
function fontFaces(faces: readonly FontSource[]): string {
  let rules = "";
  for (const { family, weight, data } of faces) {
    let binary = "";
    for (let i = 0; i < data.length; i += 0x8000)
      binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
    const name = family
      .trim()
      .replace(/^["']|["']$/g, "")
      .replace(/["\\]/g, "\\$&");
    rules += `@font-face{font-family:"${name}";font-weight:${weight === "bold" ? 700 : 400};src:url(data:font/ttf;base64,${btoa(binary)})}`;
  }
  // Markup inside the SVG's style element: its own characters escaped.
  return `<style>${rules.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</style>`;
}
