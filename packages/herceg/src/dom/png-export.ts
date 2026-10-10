// PNG export in the browser, loaded by `chart.toPNG()`: the chart's SVG
// export drawn on a canvas, which the browser encodes.

/** A chart's SVG export as a PNG at `scale` times its size in CSS pixels. */
export async function svgToPng(
  svg: string,
  width: number,
  height: number,
  document: Document,
  { scale = 2 }: { scale?: number } = {},
): Promise<Blob> {
  if (!(scale > 0 && scale < Infinity))
    throw new RangeError(`toPNG scale: expected a positive number; received ${scale}`);
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
