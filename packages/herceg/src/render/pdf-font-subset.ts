import { FontReader, fontChecksum, fontError } from "../fonts/binary.ts";
import type { TrueTypeFont } from "../fonts/truetype.ts";

export interface FontSubset {
  data: Uint8Array;
  glyphs: ReadonlyMap<number, number>;
  name: string;
}

/** Rebuilds only after drawing: measurement never adds glyphs to this set. */
export function subsetTrueType(
  font: TrueTypeFont,
  characters: ReadonlyMap<number, number>,
): FontSubset {
  const used = new Set<number>([0]);
  const include = (id: number) => {
    if (used.has(id)) return;
    used.add(id);
    for (const ref of font.components.get(id) ?? []) include(ref.glyph);
  };
  // .notdef can itself be composite.
  for (const ref of font.components.get(0) ?? []) include(ref.glyph);
  for (const id of characters.values()) include(id);
  const ids = [...used].sort((a, b) => a - b);
  const glyphs = new Map(ids.map((id, i) => [id, font.noSubset ? id : i]));
  const name = fontName(font, ids);
  if (font.noSubset) return { data: font.data, glyphs, name };

  const tables = new Map<string, Uint8Array>();
  // Hinting programs contain no glyph ids; layout/variation/color tables do.
  for (const tag of ["OS/2", "cvt ", "fpgm", "prep", "gasp"])
    if (font.tables.has(tag)) tables.set(tag, new Uint8Array(font.tables.get(tag)!));
  const head = new Uint8Array(font.tables.get("head")!);
  const headView = new DataView(head.buffer);
  headView.setUint32(8, 0);
  headView.setInt16(50, 1);
  tables.set("head", head);
  const maxp = new Uint8Array(font.tables.get("maxp")!);
  new DataView(maxp.buffer).setUint16(4, ids.length);
  tables.set("maxp", maxp);
  const hhea = new Uint8Array(font.tables.get("hhea")!);
  new DataView(hhea.buffer).setUint16(34, ids.length);
  tables.set("hhea", hhea);

  const hmtx = new Uint8Array(ids.length * 4);
  const hmtxView = new DataView(hmtx.buffer);
  const loca = new Uint8Array((ids.length + 1) * 4);
  const locaView = new DataView(loca.buffer);
  const source = font.tables.get("glyf")!;
  const size = ids.reduce((sum, id) => sum + aligned(font.offsets[id + 1]! - font.offsets[id]!), 0);
  const glyf = new Uint8Array(size);
  let at = 0;
  const bbox = [Infinity, Infinity, -Infinity, -Infinity];
  let advanceMax = 0;
  let lsbMin = Infinity;
  let rsbMin = Infinity;
  let extentMax = -Infinity;
  ids.forEach((id, i) => {
    hmtxView.setUint16(i * 4, font.advances[id]!);
    hmtxView.setInt16(i * 4 + 2, font.bearings[id]!);
    locaView.setUint32(i * 4, at);
    const length = font.offsets[id + 1]! - font.offsets[id]!;
    let glyphWidth = 0;
    if (length) {
      const reader = new FontReader(source.subarray(font.offsets[id]!, font.offsets[id + 1]!));
      const bounds = [reader.i16(2), reader.i16(4), reader.i16(6), reader.i16(8)];
      bbox[0] = Math.min(bbox[0]!, bounds[0]!);
      bbox[1] = Math.min(bbox[1]!, bounds[1]!);
      bbox[2] = Math.max(bbox[2]!, bounds[2]!);
      bbox[3] = Math.max(bbox[3]!, bounds[3]!);
      glyphWidth = bounds[2]! - bounds[0]!;
    }
    advanceMax = Math.max(advanceMax, font.advances[id]!);
    lsbMin = Math.min(lsbMin, font.bearings[id]!);
    rsbMin = Math.min(rsbMin, font.advances[id]! - font.bearings[id]! - glyphWidth);
    extentMax = Math.max(extentMax, font.bearings[id]! + glyphWidth);
    glyf.set(source.subarray(font.offsets[id]!, font.offsets[id + 1]!), at);
    const view = new DataView(glyf.buffer);
    for (const ref of font.components.get(id) ?? [])
      view.setUint16(at + ref.offset, glyphs.get(ref.glyph)!);
    at += aligned(length);
  });
  for (let i = 0; i < 4; i++)
    headView.setInt16(36 + i * 2, Number.isFinite(bbox[i]) ? bbox[i]! : 0);
  const hheaView = new DataView(hhea.buffer);
  hheaView.setUint16(10, advanceMax);
  hheaView.setInt16(12, Math.max(-32768, lsbMin));
  hheaView.setInt16(14, Math.max(-32768, Math.min(32767, rsbMin)));
  hheaView.setInt16(16, Math.max(-32768, Math.min(32767, extentMax)));
  locaView.setUint32(ids.length * 4, at);
  tables.set("glyf", glyf);
  tables.set("loca", loca);
  tables.set("hmtx", hmtx);
  tables.set("cmap", subsetCmap(characters, glyphs));
  tables.set("name", subsetName(name));
  const post = new Uint8Array(32);
  const sourcePost = font.tables.get("post");
  if (sourcePost) post.set(sourcePost.subarray(0, 32));
  new DataView(post.buffer).setUint32(0, 0x00030000); // No stale glyph names.
  tables.set("post", post);
  return { data: writeSfnt(tables), glyphs, name };
}

const aligned = (size: number) => Math.ceil(size / 4) * 4;

function fontName(font: TrueTypeFont, ids: readonly number[]): string {
  if (font.noSubset) {
    const bytes = font.tables.get("name");
    if (bytes) {
      const reader = new FontReader(bytes);
      const count = reader.u16(2);
      const storage = reader.u16(4);
      reader.check(6, count * 12);
      for (let i = 0; i < count; i++) {
        const at = 6 + i * 12;
        if (reader.u16(at + 6) !== 6) continue;
        const text = reader.slice(storage + reader.u16(at + 10), reader.u16(at + 8));
        const platform = reader.u16(at);
        const wide = platform === 0 || platform === 3;
        if (wide && text.length % 2) fontError("odd UTF-16 name length");
        let name = "";
        for (let k = 0; k < text.length; k += wide ? 2 : 1)
          name += String.fromCharCode(wide ? text[k]! * 256 + text[k + 1]! : text[k]!);
        if (/^[A-Za-z0-9_-]+$/.test(name)) return name;
      }
    }
    return "HercegFont";
  }
  let hash = 2166136261;
  for (const byte of font.data) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  for (const id of ids) hash = Math.imul(hash ^ id, 16777619) >>> 0;
  let prefix = "";
  for (let i = 0; i < 6; i++) {
    prefix += String.fromCharCode(65 + (hash % 26));
    hash = Math.floor(hash / 26);
  }
  return `${prefix}+HercegFont`;
}

function subsetName(name: string): Uint8Array {
  const ids = [1, 2, 4, 6];
  const bytes = new Uint8Array(6 + ids.length * 12 + name.length * 2);
  const view = new DataView(bytes.buffer);
  view.setUint16(2, ids.length);
  const storage = 6 + ids.length * 12;
  view.setUint16(4, storage);
  ids.forEach((id, i) => {
    const at = 6 + i * 12;
    view.setUint16(at, 3);
    view.setUint16(at + 2, 1);
    view.setUint16(at + 4, 0x0409);
    view.setUint16(at + 6, id);
    view.setUint16(at + 8, name.length * 2);
  });
  for (let i = 0; i < name.length; i++) view.setUint16(storage + i * 2, name.charCodeAt(i));
  return bytes;
}

function subsetCmap(
  characters: ReadonlyMap<number, number>,
  glyphs: ReadonlyMap<number, number>,
): Uint8Array {
  const entries = [...characters].sort(([a], [b]) => a - b);
  // Format 12 represents BMP and supplementary scalars without truncating them.
  const bytes = new Uint8Array(20 + 16 + entries.length * 12);
  const view = new DataView(bytes.buffer);
  view.setUint16(2, 2);
  view.setUint16(4, 0);
  view.setUint16(6, 4);
  view.setUint32(8, 20);
  view.setUint16(12, 3);
  view.setUint16(14, 10);
  view.setUint32(16, 20);
  view.setUint16(20, 12);
  view.setUint32(24, bytes.length - 20);
  view.setUint32(32, entries.length);
  entries.forEach(([code, id], i) => {
    const at = 36 + i * 12;
    view.setUint32(at, code);
    view.setUint32(at + 4, code);
    view.setUint32(at + 8, glyphs.get(id)!);
  });
  return bytes;
}

export function writeSfnt(tables: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const entries = [...tables].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const header = 12 + entries.length * 16;
  const bytes = new Uint8Array(
    header + entries.reduce((sum, [, data]) => sum + aligned(data.length), 0),
  );
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x00010000);
  view.setUint16(4, entries.length);
  const power = Math.floor(Math.log2(entries.length));
  view.setUint16(6, 16 * 2 ** power);
  view.setUint16(8, power);
  view.setUint16(10, entries.length * 16 - 16 * 2 ** power);
  let offset = header;
  let headOffset = 0;
  entries.forEach(([tag, data], i) => {
    const at = 12 + i * 16;
    for (let j = 0; j < 4; j++) bytes[at + j] = tag.charCodeAt(j);
    view.setUint32(at + 4, fontChecksum(data));
    view.setUint32(at + 8, offset);
    view.setUint32(at + 12, data.length);
    bytes.set(data, offset);
    if (tag === "head") headOffset = offset;
    offset += aligned(data.length);
  });
  if (!headOffset) fontError("missing subset head");
  view.setUint32(headOffset + 8, (0xb1b0afba - fontChecksum(bytes)) >>> 0);
  return bytes;
}
