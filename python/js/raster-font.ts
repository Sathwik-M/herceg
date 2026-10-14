import { FontReader } from "../../packages/herceg/src/render/pdf-font-binary.ts";
import type { PdfFontSource } from "../../packages/herceg/src/render/pdf-font-resolver.ts";
import { writeSfnt } from "../../packages/herceg/src/render/pdf-font-subset.ts";

/** resvg selects by sfnt names, whereas pdfFonts selects by the supplied family. */
export function rasterFont(source: PdfFontSource, index: number): Uint8Array {
  // The PDF resolver has already validated every face. Keep all glyphs and
  // tables, including fonts whose license forbids subsetting.
  const input = new FontReader(source.data);
  const tables = new Map<string, Uint8Array>();
  for (let i = 0; i < input.u16(4); i++) {
    const at = 12 + i * 16;
    tables.set(
      String.fromCharCode(...input.slice(at, 4)),
      input.slice(input.u32(at + 8), input.u32(at + 12)),
    );
  }
  const family = source.family
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  const bold = source.weight === "bold";
  const style = bold ? "Bold" : "Regular";
  const names = [
    [1, family],
    [2, style],
    [4, `${family} ${style}`],
    [6, `HercegExport${index}`],
    [16, family],
    [17, style],
  ] as const;
  const storage = 6 + names.length * 12;
  const strings = names.reduce((sum, [, text]) => sum + text.length * 2, 0);
  if (strings > 65535) throw new Error("font family name exceeds the sfnt naming limit");
  const name = new Uint8Array(storage + strings);
  const view = new DataView(name.buffer);
  view.setUint16(2, names.length);
  view.setUint16(4, storage);
  let offset = 0;
  names.forEach(([id, text], i) => {
    const at = 6 + i * 12;
    view.setUint16(at, 3);
    view.setUint16(at + 2, 1);
    view.setUint16(at + 4, 0x0409);
    view.setUint16(at + 6, id);
    view.setUint16(at + 8, text.length * 2);
    view.setUint16(at + 10, offset);
    for (let j = 0; j < text.length; j++)
      view.setUint16(storage + offset + j * 2, text.charCodeAt(j));
    offset += text.length * 2;
  });
  tables.set("name", name);
  // Match the mapping's weight even when the source's metadata disagrees.
  const os2 = tables.get("OS/2")!.slice();
  const weight = new DataView(os2.buffer);
  weight.setUint16(4, bold ? 700 : 400);
  weight.setUint16(62, (weight.getUint16(62) & ~0x60) | (bold ? 0x20 : 0x40));
  tables.set("OS/2", os2);
  const head = tables.get("head")!.slice();
  const flags = new DataView(head.buffer);
  flags.setUint32(8, 0);
  flags.setUint16(44, (flags.getUint16(44) & ~1) | (bold ? 1 : 0));
  tables.set("head", head);
  return writeSfnt(tables);
}
