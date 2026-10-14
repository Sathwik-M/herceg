import { FontReader, fontError } from "./binary.ts";

/** A validated static TrueType face, read-only once parsed, so exports and charts share it. */
export interface TrueTypeFont {
  data: Uint8Array;
  tables: ReadonlyMap<string, Uint8Array>;
  unitsPerEm: number;
  glyphCount: number;
  advances: Uint16Array;
  bearings: Int16Array;
  offsets: Uint32Array;
  /** Component glyph ids and the offsets at which they occur in each glyph. */
  components: ReadonlyMap<number, readonly { glyph: number; offset: number }[]>;
  bbox: readonly number[];
  ascent: number;
  descent: number;
  capHeight: number;
  italicAngle: number;
  fixedPitch: boolean;
  noSubset: boolean;
  /** OS/2 embedding permissions, which PDF export checks before embedding the face. */
  fsType: number;
  glyph(code: number): number;
  characterCodes(): Iterable<number>;
}

export function parseTrueType(data: Uint8Array): TrueTypeFont {
  if (!(data instanceof Uint8Array)) throw new TypeError("font data must be a Uint8Array");
  if (data.length > 32 * 1024 * 1024) throw new Error("font exceeds the 32 MiB limit");
  const input = new FontReader(data);
  const signature = input.u32(0);
  if (signature !== 0x00010000 && signature !== 0x74727565 && signature !== 0x4f54544f)
    throw new Error(
      "fonts must be single sfnt TrueType fonts; WOFF and collections are unsupported",
    );
  const count = input.u16(4);
  if (count < 1 || count > 128) fontError("invalid table count");
  input.check(0, 12 + count * 16);
  const tables = new Map<string, Uint8Array>();
  const ranges: { start: number; end: number }[] = [];
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    const tag = String.fromCharCode(...input.slice(at, 4));
    const start = input.u32(at + 8);
    const length = input.u32(at + 12);
    if (tables.has(tag) || start < 12 + count * 16 || start % 4 !== 0)
      fontError("duplicate or invalid table directory entry");
    tables.set(tag, input.slice(start, length));
    if (length) ranges.push({ start, end: start + length });
  }
  ranges.sort((a, b) => a.start - b.start);
  for (let i = 1; i < ranges.length; i++)
    if (ranges[i]!.start < ranges[i - 1]!.end) fontError("overlapping tables");
  if (tables.has("CFF ") || tables.has("CFF2"))
    throw new Error("OpenType CFF outlines are unsupported; supply a TrueType (glyf) font");
  if (tables.has("fvar"))
    throw new Error("variable fonts are unsupported; instantiate a static TrueType font first");
  const table = (tag: string, minimum: number) => {
    const bytes = tables.get(tag);
    if (!bytes || bytes.length < minimum) fontError(`missing or truncated ${tag} table`);
    return new FontReader(bytes);
  };
  const head = table("head", 54);
  if (head.u32(12) !== 0x5f0f3cf5) fontError("invalid head magic");
  const unitsPerEm = head.u16(18);
  if (unitsPerEm < 16 || unitsPerEm > 16384) fontError("invalid unitsPerEm");
  const format = head.i16(50);
  if (format !== 0 && format !== 1) fontError("invalid loca format");
  const maxp = table("maxp", 32);
  if (maxp.u32(0) !== 0x00010000) fontError("invalid TrueType maxp version");
  const glyphCount = maxp.u16(4);
  if (!glyphCount) fontError("empty glyph set");
  const hhea = table("hhea", 36);
  const metrics = hhea.u16(34);
  if (!metrics || metrics > glyphCount) fontError("invalid hmtx metric count");
  const hmtx = table("hmtx", metrics * 4 + (glyphCount - metrics) * 2);
  const advances = new Uint16Array(glyphCount);
  const bearings = new Int16Array(glyphCount);
  for (let i = 0; i < glyphCount; i++) {
    advances[i] = hmtx.u16(Math.min(i, metrics - 1) * 4);
    bearings[i] = hmtx.i16(i < metrics ? i * 4 + 2 : metrics * 4 + (i - metrics) * 2);
  }
  const loca = table("loca", (glyphCount + 1) * (format === 0 ? 2 : 4));
  const glyf = table("glyf", 0);
  const offsets = new Uint32Array(glyphCount + 1);
  for (let i = 0; i <= glyphCount; i++) {
    const offset = format === 0 ? loca.u16(i * 2) * 2 : loca.u32(i * 4);
    if (offset > glyf.bytes.length || (i && offset < offsets[i - 1]!))
      fontError("invalid glyph offset in loca");
    offsets[i] = offset;
  }
  const components = new Map<number, { glyph: number; offset: number }[]>();
  let componentCount = 0;
  const points = new Uint32Array(glyphCount);
  const contours = new Uint32Array(glyphCount);
  const instances = new Uint32Array(glyphCount).fill(1);
  for (let i = 0; i < glyphCount; i++) {
    const bytes = glyf.slice(offsets[i]!, offsets[i + 1]! - offsets[i]!);
    if (!bytes.length) continue;
    const validated = validateGlyph(new FontReader(bytes), glyphCount);
    points[i] = validated.points;
    contours[i] = validated.contours;
    componentCount += validated.refs.length;
    if (componentCount > 262144) fontError("font exceeds composite component resource limit");
    if (validated.refs.length) components.set(i, validated.refs);
  }
  // Reject cycles and excessive nesting before either full embedding or subsetting.
  const depths = new Map<number, number>();
  const visiting = new Set<number>();
  const visit = (id: number, depth: number): number => {
    if (depth > 64 || visiting.has(id)) fontError("cyclic or excessively nested composite glyph");
    const cached = depths.get(id);
    if (cached !== undefined) {
      if (depth + cached > 64) fontError("excessively nested composite glyph");
      return cached;
    }
    visiting.add(id);
    let below = 0;
    const refs = components.get(id);
    if (refs) {
      const reader = new FontReader(glyf.slice(offsets[id]!, offsets[id + 1]! - offsets[id]!));
      for (const child of refs) {
        below = Math.max(below, 1 + visit(child.glyph, depth + 1));
        const flags = reader.u16(child.offset - 2);
        if (!(flags & 2)) {
          const at = child.offset + 2;
          const parentPoint = flags & 1 ? reader.u16(at) : reader.u8(at);
          const childPoint = flags & 1 ? reader.u16(at + 2) : reader.u8(at + 1);
          // Both outlines expose four phantom points after their contour points.
          if (parentPoint >= points[id]! + 4 || childPoint >= points[child.glyph]! + 4)
            fontError("composite attachment references a missing point");
        }
        points[id] = points[id]! + points[child.glyph]!;
        contours[id] = contours[id]! + contours[child.glyph]!;
        instances[id] = instances[id]! + instances[child.glyph]!;
        if (points[id]! > 65535 || contours[id]! > 65535 || instances[id]! > 65536)
          fontError("composite expansion exceeds outline resource limits");
      }
    }
    visiting.delete(id);
    depths.set(id, below);
    return below;
  };
  for (const id of components.keys()) visit(id, 0);
  const os2 = table("OS/2", 2);
  const version = os2.u16(0);
  const minimum = [68, 86, 96, 96, 96, 100][version];
  if (minimum === undefined) fontError("unsupported OS/2 version");
  table("OS/2", minimum);
  // Bits 4–15 were unassigned in versions 0–1 and must be ignored.
  const fsType = os2.u16(8) & (version < 2 ? 0x000f : 0xffff);
  const post = tables.get("post");
  const postReader = post && post.length >= 16 ? new FontReader(post) : undefined;
  return {
    data,
    tables,
    unitsPerEm,
    glyphCount,
    advances,
    bearings,
    offsets,
    components,
    bbox: [head.i16(36), head.i16(38), head.i16(40), head.i16(42)],
    ascent: hhea.i16(4),
    descent: hhea.i16(6),
    capHeight: os2.u16(0) >= 2 && os2.bytes.length >= 90 ? os2.i16(88) : hhea.i16(4),
    italicAngle: postReader ? postReader.view.getInt32(4) / 65536 : 0,
    fixedPitch: !!postReader?.u32(12),
    noSubset: !!(fsType & 0x0100),
    fsType,
    ...readCmap(table("cmap", 4), glyphCount),
  };
}

function validateGlyph(
  reader: FontReader,
  count: number,
): {
  refs: { glyph: number; offset: number }[];
  points: number;
  contours: number;
} {
  reader.check(0, 10);
  const contours = reader.i16(0);
  let at = 10;
  const refs: { glyph: number; offset: number }[] = [];
  if (contours < 0) {
    let flags: number;
    let instructions = false;
    do {
      flags = reader.u16(at);
      if (!refs.length && !(flags & 2))
        fontError("first composite component requires XY placement");
      const transforms = flags & (8 | 64 | 128);
      if (transforms & (transforms - 1) || (flags & 0x1800) === 0x1800)
        fontError("conflicting composite transform flags");
      instructions ||= !!(flags & 256);
      const glyph = reader.u16(at + 2);
      if (glyph >= count) fontError("composite references a missing glyph");
      if (refs.length >= 4096) fontError("composite exceeds 4,096 components");
      refs.push({ glyph, offset: at + 2 });
      at += 4 + (flags & 1 ? 4 : 2) + (flags & 8 ? 2 : flags & 64 ? 4 : flags & 128 ? 8 : 0);
      reader.check(0, at);
    } while (flags & 32);
    if (instructions) reader.check(at + 2, reader.u16(at));
    return { refs, points: 0, contours: 0 };
  }
  if (!contours && reader.bytes.length === 10) return { refs, points: 0, contours: 0 };
  let points = 0;
  for (let i = 0; i < contours; i++) {
    const end = reader.u16(at);
    if (end < points) fontError("invalid contour endpoints");
    points = end + 1;
    at += 2;
  }
  const instructions = reader.u16(at);
  at += 2 + instructions;
  reader.check(0, at);
  let coordinates = 0;
  for (let i = 0; i < points; ) {
    const flag = reader.u8(at++);
    const repeat = flag & 8 ? reader.u8(at++) + 1 : 1;
    i += repeat;
    if (i > points) fontError("glyph flag repeat exceeds point count");
    coordinates +=
      repeat * ((flag & 2 ? 1 : flag & 16 ? 0 : 2) + (flag & 4 ? 1 : flag & 32 ? 0 : 2));
  }
  reader.check(at, coordinates);
  return { refs, points, contours };
}

function readCmap(
  cmap: FontReader,
  glyphCount: number,
): Pick<TrueTypeFont, "glyph" | "characterCodes"> {
  if (cmap.u16(0) !== 0) fontError("invalid cmap version");
  const count = cmap.u16(2);
  cmap.check(4, count * 8);
  let bmp: FontReader | undefined;
  let full: FontReader | undefined;
  for (let i = 0; i < count; i++) {
    const at = 4 + i * 8;
    const platform = cmap.u16(at);
    const encoding = cmap.u16(at + 2);
    if (platform !== 0 && !(platform === 3 && (encoding === 1 || encoding === 10))) continue;
    const offset = cmap.u32(at + 4);
    const format = cmap.u16(offset);
    if (format !== 4 && format !== 12) continue;
    const length = format === 4 ? cmap.u16(offset + 2) : cmap.u32(offset + 4);
    const reader = new FontReader(cmap.slice(offset, length));
    if (format === 4) bmp = reader;
    else full = reader;
  }
  if (!bmp && !full) fontError("font needs a Unicode cmap format 4 or 12");
  const segments = bmp ? bmp.u16(6) / 2 : 0;
  if (bmp) {
    if (!Number.isInteger(segments) || segments < 1) fontError("invalid cmap segment count");
    bmp.check(0, 16 + segments * 8);
    let previous = -1;
    for (let i = 0; i < segments; i++) {
      const end = bmp.u16(14 + i * 2);
      const start = bmp.u16(16 + segments * 2 + i * 2);
      const rangeAt = 16 + segments * 6 + i * 2;
      const range = bmp.u16(rangeAt);
      if (start > end || start <= previous || range % 2) fontError("invalid cmap segment");
      if (range) bmp.check(rangeAt + range, (end - start + 1) * 2);
      previous = end;
    }
    if (previous !== 65535) fontError("missing cmap sentinel");
  }
  const groups = full ? full.u32(12) : 0;
  if (full) {
    full.check(0, 16 + groups * 12);
    let previous = -1;
    for (let i = 0; i < groups; i++) {
      const at = 16 + i * 12;
      const start = full.u32(at);
      const end = full.u32(at + 4);
      if (
        start > end ||
        start <= previous ||
        end > 0x10ffff ||
        full.u32(at + 8) + end - start >= glyphCount
      )
        fontError("invalid cmap format 12 group");
      previous = end;
    }
  }
  const glyph = (code: number): number => {
    if (full) {
      let lo = 0;
      let hi = groups;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const at = 16 + mid * 12;
        if (code < full.u32(at)) hi = mid;
        else if (code > full.u32(at + 4)) lo = mid + 1;
        else return full.u32(at + 8) + code - full.u32(at);
      }
    }
    if (!bmp || code > 65535) return 0;
    let lo = 0;
    let hi = segments;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (bmp.u16(14 + mid * 2) < code) lo = mid + 1;
      else hi = mid;
    }
    if (lo === segments || code < bmp.u16(16 + segments * 2 + lo * 2)) return 0;
    const delta = bmp.i16(16 + segments * 4 + lo * 2);
    const rangeAt = 16 + segments * 6 + lo * 2;
    const range = bmp.u16(rangeAt);
    let glyph = range
      ? bmp.u16(rangeAt + range + (code - bmp.u16(16 + segments * 2 + lo * 2)) * 2)
      : code;
    if (!range || glyph) glyph = (glyph + delta) & 65535;
    if (glyph >= glyphCount) fontError("cmap references a missing glyph");
    return glyph;
  };
  return {
    glyph,
    *characterCodes() {
      if (bmp) {
        for (let i = 0; i < segments; i++) {
          const start = bmp.u16(16 + segments * 2 + i * 2);
          const end = bmp.u16(14 + i * 2);
          for (let code = start; code <= end; code++) if (glyph(code)) yield code;
        }
      }
      if (full) {
        for (let i = 0; i < groups; i++) {
          const at = 16 + i * 12;
          for (let code = full.u32(at); code <= full.u32(at + 4); code++)
            if (glyph(code)) yield code;
        }
      }
    },
  };
}
