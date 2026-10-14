// Paper sizing and fitting in the page's chart coordinate system.
import { num, PdfPage } from "./pdf-document.ts";
import type { PdfFontResolver } from "./pdf-font-resolver.ts";

/** Paper sizes and uniform margins, in PDF points (72 per inch). */
export interface PdfPageOptions {
  pageSize?: "A4" | "Letter";
  orientation?: "portrait" | "landscape";
  /** Default 36 points on named paper, zero on chart-sized pages. */
  margin?: number;
}

export function paperPage(
  width: number,
  height: number,
  options: PdfPageOptions,
  resolver?: PdfFontResolver,
): PdfPage {
  const { pageSize, orientation } = options;
  const margin = options.margin ?? (pageSize ? 36 : 0);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1)
    throw new RangeError(
      "renderToPDF size: expected finite chart dimensions of at least one pixel; supply width and height above zero",
    );
  if (pageSize !== undefined && pageSize !== "A4" && pageSize !== "Letter")
    throw new TypeError(
      'renderToPDF pageSize: expected "A4" or "Letter"; omit it for chart-sized pages',
    );
  if (orientation !== undefined && (!pageSize || !["portrait", "landscape"].includes(orientation)))
    throw new TypeError(
      'renderToPDF orientation: expected "portrait" or "landscape" with pageSize; supply a named paper size',
    );
  if (!Number.isFinite(margin) || margin < 0)
    throw new RangeError(
      "renderToPDF margin: expected finite nonnegative points; supply zero or a positive margin",
    );
  let w = pageSize === "A4" ? 595.28 : pageSize === "Letter" ? 612 : width * 0.75 + 2 * margin;
  let h = pageSize === "A4" ? 841.89 : pageSize === "Letter" ? 792 : height * 0.75 + 2 * margin;
  if (orientation === "landscape") [w, h] = [h, w];
  const scale = pageSize ? Math.min((w - 2 * margin) / width, (h - 2 * margin) / height) : 0.75;
  if (scale <= 0 || !Number.isFinite(w) || !Number.isFinite(h))
    throw new RangeError("renderToPDF margin: no usable page area; reduce the margin");
  const factor = num(scale / 0.75, 12);
  if (Number(factor) <= 0)
    throw new RangeError(
      "renderToPDF scale: fitting scale rounds to zero; reduce chart dimensions or margins",
    );
  const page = new PdfPage(w / 0.75, h / 0.75, resolver);
  // Place chart pixels inside the page's existing CSS-pixel coordinate system.
  if (pageSize || margin)
    page.write(
      `${factor} 0 0 ${factor} ${num((w - width * scale) / 1.5)} ${num((h - height * scale) / 1.5)} cm\n0 0 ${num(width)} ${num(height)} re W n\n`,
    );
  return page;
}
