// The PDF file format (version 1.4): pages, the resources their content
// uses (fonts, opacities, images, gradients), and the cross-reference table
// readers use to find each object. Streams are Flate-compressed.

import { zlibCompress } from "./deflate.ts";
import type { PdfFace, PdfFontResolver } from "./pdf-font-embed.ts";
import type { PdfFont } from "./pdf-fonts.ts";

/** Points per CSS pixel: CSS has 96 pixels to the inch, PDF 72 points. */
const POINTS_PER_PIXEL = 0.75;

/**
 * A number for PDF syntax: at most two decimals (enough for CSS pixels) or
 * `decimals`, and never exponent notation.
 */
export function num(value: number, decimals = 2): string {
  const scale = 10 ** decimals;
  const rounded = Math.round(value * scale) / scale;
  // Beyond 1e15 pixels nothing is visible; String() would switch to
  // exponents (which PDF lacks) at 1e21.
  return (Math.abs(rounded) < 1e15 ? rounded : Math.sign(rounded) * 1e15)
    .toFixed(decimals)
    .replace(/(\.\d*?)0+$/, "$1")
    .replace(/\.$/, "");
}

/** A literal string of bytes (characters 0 to 255), in printable ASCII. */
export function literal(bytes: string): string {
  let out = "(";
  for (let i = 0; i < bytes.length; i++) {
    const code = bytes.charCodeAt(i);
    if (code === 40 || code === 41 || code === 92) out += `\\${bytes[i]}`;
    else if (code >= 32 && code < 127) out += bytes[i];
    else out += `\\${code.toString(8).padStart(3, "0")}`;
  }
  return `${out})`;
}

/** A text string of any characters, as UTF-16BE with a byte order mark. */
function textString(text: string): string {
  let out = "<FEFF";
  for (let i = 0; i < text.length; i++)
    out += text.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `${out}>`;
}

function latin1(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** The object operations an embedded font needs from the document writer. */
export interface PdfObjectWriter {
  reserve(): number;
  object(id: number, body: string): void;
  stream(id: number, entries: string, data: Uint8Array): void;
}

export interface DocumentInfo {
  title?: string | undefined;
  subject?: string | undefined;
  /** Text alternative for the chart figure, including its title and summary. */
  alt?: string | undefined;
  /** BCP 47 language tag of the visible text. */
  language?: string | undefined;
  /** Language override for the Figure's alternative text. */
  altLanguage?: string | undefined;
}

interface Image {
  name: string;
  columns: number;
  rows: number;
  pixels: Uint8ClampedArray | Uint8Array;
  /** Times each pixel is repeated across and down. */
  repeat: [number, number];
}

interface Shading {
  name: string;
  coords: [number, number, number, number];
  /** Colors, channels from 0 to 1. */
  stops: [number, number, number][];
  /** Where each stop sits, ascending from 0 to 1; evenly spaced without. */
  offsets?: readonly number[] | undefined;
}

/** A chart's content in CSS pixels, with y pointing down. */
export class PdfPage {
  readonly width: number;
  readonly height: number;
  #content: string;
  #fonts = new Map<PdfFont | PdfFace, string>();
  #states = new Map<string, string>();
  #images: Image[] = [];
  #shadings: Shading[] = [];

  readonly resolver: PdfFontResolver | undefined;
  constructor(width: number, height: number, resolver?: PdfFontResolver) {
    this.resolver = resolver;
    this.width = width * POINTS_PER_PIXEL;
    this.height = height * POINTS_PER_PIXEL;
    this.#content = `${POINTS_PER_PIXEL} 0 0 ${-POINTS_PER_PIXEL} 0 ${num(height * POINTS_PER_PIXEL)} cm\n`;
  }

  /** Appends content stream operators. */
  write(operators: string): void {
    this.#content += operators;
  }

  /** The resource name of a font. */
  font(font: PdfFont | PdfFace): string {
    return named(this.#fonts, font, "F");
  }

  /** The resource name of a graphics state with these fill and stroke opacities. */
  opacity(fill: number, stroke: number): string {
    return named(this.#states, `/ca ${num(fill, 3)} /CA ${num(stroke, 3)}`, "GS");
  }

  /**
   * The resource name of an image of `columns x rows` RGBA pixels, row 0 at
   * the top, with each pixel repeated `repeat` times across and down.
   */
  image(
    columns: number,
    rows: number,
    pixels: Uint8ClampedArray | Uint8Array,
    repeat: [number, number] = [1, 1],
  ): string {
    const name = `Im${this.#images.length + 1}`;
    this.#images.push({ name, columns, rows, pixels, repeat });
    return name;
  }

  /** The resource name of a linear gradient through evenly spaced colors. */
  gradient(
    coords: Shading["coords"],
    stops: Shading["stops"],
    offsets?: readonly number[],
  ): string {
    const name = `Sh${this.#shadings.length + 1}`;
    this.#shadings.push({ name, coords, stops, offsets });
    return name;
  }

  /** Writes a completed page; font objects are finalized after all pages. */
  writeTo(
    file: PdfObjectWriter,
    fonts: Map<PdfFont | PdfFace, number>,
    pages: number,
    index: number,
  ): number {
    const page = file.reserve();
    const content = file.reserve();
    let resources = "";
    if (this.#fonts.size > 0) {
      resources += "/Font <<";
      for (const [font, name] of this.#fonts) {
        const id = fonts.get(font) ?? file.reserve();
        fonts.set(font, id);
        resources += ` /${name} ${id} 0 R`;
      }
      resources += " >> ";
    }
    if (this.#states.size > 0) {
      resources += "/ExtGState <<";
      for (const [state, name] of this.#states) resources += ` /${name} << ${state} >>`;
      resources += " >> ";
    }
    if (this.#images.length > 0) {
      resources += "/XObject <<";
      for (const image of this.#images)
        resources += ` /${image.name} ${writeImage(file, image)} 0 R`;
      resources += " >> ";
    }
    if (this.#shadings.length > 0) {
      resources += "/Shading <<";
      for (const shading of this.#shadings) {
        const id = file.reserve();
        file.object(id, shadingDictionary(shading));
        resources += ` /${shading.name} ${id} 0 R`;
      }
      resources += " >> ";
    }

    file.stream(content, "", latin1(this.#content));
    const box = `[0 0 ${num(this.width)} ${num(this.height)}]`;
    file.object(
      page,
      `<< /Type /Page /Parent ${pages} 0 R /MediaBox ${box} /Resources << ${resources}>> /Contents ${content} 0 R /StructParents ${index} >>`,
    );
    return page;
  }
}

export function language(tag: string | undefined): string {
  return tag && /^[A-Za-z0-9-]+$/.test(tag) ? ` /Lang ${literal(tag)}` : "";
}

/** The resource name for `key`, numbered in order of first use. */
function named<K>(names: Map<K, string>, key: K, prefix: string): string {
  let name = names.get(key);
  if (name === undefined) {
    name = `${prefix}${names.size + 1}`;
    names.set(key, name);
  }
  return name;
}

/** Writes an image XObject, with a soft mask when it has transparent pixels; returns its id. */
function writeImage(file: PdfObjectWriter, { columns, rows, pixels, repeat }: Image): number {
  const [across, down] = repeat;
  const width = columns * across;
  const height = rows * down;
  const rgb = new Uint8Array(width * height * 3);
  const alpha = new Uint8Array(width * height);
  let opaque = true;
  for (let row = 0; row < rows; row++) {
    // Writes the row once, then copies it down.
    const top = row * down * width;
    for (let column = 0; column < columns; column++) {
      const from = (row * columns + column) * 4;
      if (pixels[from + 3] !== 255) opaque = false;
      for (let k = 0; k < across; k++) {
        const to = top + column * across + k;
        rgb[to * 3] = pixels[from]!;
        rgb[to * 3 + 1] = pixels[from + 1]!;
        rgb[to * 3 + 2] = pixels[from + 2]!;
        alpha[to] = pixels[from + 3]!;
      }
    }
    for (let k = 1; k < down; k++) {
      rgb.copyWithin((top + k * width) * 3, top * 3, (top + width) * 3);
      alpha.copyWithin(top + k * width, top, top + width);
    }
  }
  const size = `/Type /XObject /Subtype /Image /Width ${width} /Height ${height} /BitsPerComponent 8 /Interpolate false`;
  let mask = "";
  if (!opaque) {
    const id = file.reserve();
    file.stream(id, `${size} /ColorSpace /DeviceGray`, alpha);
    mask = ` /SMask ${id} 0 R`;
  }
  const id = file.reserve();
  file.stream(id, `${size} /ColorSpace /DeviceRGB${mask}`, rgb);
  return id;
}

function shadingDictionary({ coords, stops: given, offsets: at }: Shading): string {
  // Stops at the same place as the next add nothing PDF can draw: Bounds
  // must increase, so only the last of them is kept.
  const kept = given
    .map((_, i) => i)
    .filter((i) => !at || i === given.length - 1 || at[i + 1]! > at[i]!);
  const stops = kept.map((i) => given[i]!);
  const offsets = at && kept.map((i) => at[i]!);
  const color = (c: [number, number, number]) => `[${c.map((v) => num(v, 3)).join(" ")}]`;
  const segment = (i: number) =>
    `<< /FunctionType 2 /Domain [0 1] /C0 ${color(stops[i]!)} /C1 ${color(stops[i + 1]!)} /N 1 >>`;
  let fn: string;
  if (stops.length === 2) fn = segment(0);
  else {
    const parts = stops.slice(1).map((_, i) => segment(i));
    const bounds = parts
      .slice(1)
      .map((_, i) => num(offsets ? offsets[i + 1]! : (i + 1) / parts.length, 4));
    const encode = parts.map(() => "0 1").join(" ");
    fn = `<< /FunctionType 3 /Domain [0 1] /Functions [${parts.join(" ")}] /Bounds [${bounds.join(" ")}] /Encode [${encode}] >>`;
  }
  return `<< /ShadingType 2 /ColorSpace /DeviceRGB /Coords [${coords.map((v) => num(v)).join(" ")}] /Function ${fn} /Extend [false false] >>`;
}

/** Objects written in order, with their byte offsets for the cross-reference table. */
export class PdfWriter {
  #chunks: Uint8Array[] = [];
  #length = 0;
  /** Byte offset of each object, by object number (0 is the free list head). */
  #offsets: number[] = [0];

  #pages = this.reserve();
  #doc = this.reserve();
  #pageIds: number[] = [];
  #figures: number[] = [];
  #fonts = new Map<PdfFont | PdfFace, number>();

  constructor() {
    // A comment with bytes above 127 tells transfer tools the file is binary.
    this.#add(latin1("%PDF-1.4\n%âãÏÓ\n"));
  }

  add(page: PdfPage, info: DocumentInfo): void {
    const id = page.writeTo(this, this.#fonts, this.#pages, this.#pageIds.length);
    const figure = this.reserve();
    this.object(
      figure,
      `<< /Type /StructElem /S /Figure /P ${this.#doc} 0 R /Pg ${id} 0 R /K 0 /Alt ${textString(info.alt ?? "")}${language(info.altLanguage)} >>`,
    );
    this.#pageIds.push(id);
    this.#figures.push(figure);
  }

  toBytes(info: DocumentInfo = {}): Uint8Array {
    const catalog = this.reserve();
    const structure = this.reserve();
    const parents = this.reserve();
    for (const [font, id] of this.#fonts) {
      if (typeof font === "string")
        this.object(
          id,
          `<< /Type /Font /Subtype /Type1 /BaseFont /${font} /Encoding /WinAnsiEncoding >>`,
        );
      else font.write(this, id);
    }
    const refs = (ids: number[]) => ids.map((id) => `${id} 0 R`).join(" ");
    const count = this.#pageIds.length;
    this.object(
      structure,
      `<< /Type /StructTreeRoot /K ${this.#doc} 0 R /ParentTree ${parents} 0 R /ParentTreeNextKey ${count} >>`,
    );
    this.object(
      this.#doc,
      `<< /Type /StructElem /S /Document /P ${structure} 0 R /K [${refs(this.#figures)}] >>`,
    );
    this.object(
      parents,
      `<< /Nums [${this.#figures.map((id, i) => `${i} [${id} 0 R]`).join(" ")}] >>`,
    );
    this.object(this.#pages, `<< /Type /Pages /Kids [${refs(this.#pageIds)}] /Count ${count} >>`);
    this.object(
      catalog,
      `<< /Type /Catalog /Pages ${this.#pages} 0 R /StructTreeRoot ${structure} 0 R /MarkInfo << /Marked true >>${language(info.language)}${info.title ? " /ViewerPreferences << /DisplayDocTitle true >>" : ""} >>`,
    );
    const infoId = this.reserve();
    this.object(
      infoId,
      `<< /Producer (Herceg)${info.title ? ` /Title ${textString(info.title)}` : ""}${info.subject ? ` /Subject ${textString(info.subject)}` : ""} >>`,
    );
    return this.finish(catalog, infoId);
  }

  #add(bytes: Uint8Array): void {
    this.#chunks.push(bytes);
    this.#length += bytes.length;
  }

  /** A new object number, so objects can refer to each other before they are written. */
  reserve(): number {
    this.#offsets.push(-1);
    return this.#offsets.length - 1;
  }

  object(id: number, body: string): void {
    this.#offsets[id] = this.#length;
    this.#add(latin1(`${id} 0 obj\n${body}\nendobj\n`));
  }

  stream(id: number, entries: string, data: Uint8Array): void {
    const packed = zlibCompress(data);
    this.#offsets[id] = this.#length;
    const space = entries ? " " : "";
    this.#add(
      latin1(
        `${id} 0 obj\n<< ${entries}${space}/Filter /FlateDecode /Length ${packed.length} >>\nstream\n`,
      ),
    );
    this.#add(packed);
    this.#add(latin1("\nendstream\nendobj\n"));
  }

  finish(root: number, info: number): Uint8Array {
    const start = this.#length;
    const size = this.#offsets.length;
    // Each entry is exactly 20 bytes, its line end included.
    let table = `xref\n0 ${size}\n0000000000 65535 f\r\n`;
    for (let id = 1; id < size; id++) {
      const offset = this.#offsets[id]!;
      if (offset < 0) throw new Error(`PDF object ${id} was reserved but not written`);
      table += `${String(offset).padStart(10, "0")} 00000 n\r\n`;
    }
    table += `trailer\n<< /Size ${size} /Root ${root} 0 R /Info ${info} 0 R >>\nstartxref\n${start}\n%%EOF\n`;
    this.#add(latin1(table));
    const out = new Uint8Array(this.#length);
    let at = 0;
    for (const chunk of this.#chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    return out;
  }
}
