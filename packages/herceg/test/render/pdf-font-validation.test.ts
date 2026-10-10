import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { subsetTrueType, writeSfnt } from "../../src/render/pdf-font-subset.ts";
import { parseTrueType } from "../../src/render/pdf-truetype.ts";

const fixture = () =>
  parseTrueType(
    new Uint8Array(readFileSync(new URL("../fixtures/pdf-fonts/sans.ttf", import.meta.url))),
  );
function tables(): Map<string, Uint8Array> {
  const data = new Map([...fixture().tables].map(([tag, bytes]) => [tag, new Uint8Array(bytes)]));
  new DataView(data.get("head")!.buffer).setUint32(8, 0);
  return data;
}

/** OS/2 fixtures keep all other tables from the licensed sans face. */
function os2Fixture(version: number, length: number, flags = 0): Uint8Array {
  const data = tables();
  const os2 = new Uint8Array(length);
  os2.set(data.get("OS/2")!.subarray(0, length));
  new DataView(os2.buffer).setUint16(0, version);
  new DataView(os2.buffer).setUint16(8, flags);
  data.set("OS/2", os2);
  return writeSfnt(data);
}

interface Component {
  glyph: number;
  flags?: number;
  parent?: number;
  child?: number;
}

function composite(components: Component[]): Uint8Array {
  const records = components.map(({ glyph, flags = 3, parent = 0, child = 0 }, i) => {
    flags |= i + 1 < components.length ? 32 : 0;
    const transform = flags & 8 ? 2 : flags & 64 ? 4 : flags & 128 ? 8 : 0;
    const bytes = new Uint8Array(4 + (flags & 1 ? 4 : 2) + transform);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, flags);
    view.setUint16(2, glyph);
    if (flags & 1) {
      view.setUint16(4, parent);
      view.setUint16(6, child);
    } else {
      view.setUint8(4, parent);
      view.setUint8(5, child);
    }
    return bytes;
  });
  const bytes = new Uint8Array(10 + records.reduce((sum, record) => sum + record.length, 0));
  new DataView(bytes.buffer).setInt16(0, -1);
  let at = 10;
  for (const record of records) {
    bytes.set(record, at);
    at += record.length;
  }
  return bytes;
}

function withGlyphs(replacements: Map<number, Uint8Array>): Uint8Array {
  const font = fixture();
  const data = tables();
  const original = data.get("glyf")!;
  const glyphs = Array.from(
    { length: font.glyphCount },
    (_, id) => replacements.get(id) ?? original.subarray(font.offsets[id]!, font.offsets[id + 1]!),
  );
  const glyf = new Uint8Array(
    glyphs.reduce((sum, glyph) => sum + Math.ceil(glyph.length / 4) * 4, 0),
  );
  const loca = new Uint8Array((font.glyphCount + 1) * 4);
  const view = new DataView(loca.buffer);
  let at = 0;
  glyphs.forEach((glyph, id) => {
    view.setUint32(id * 4, at);
    glyf.set(glyph, at);
    at += Math.ceil(glyph.length / 4) * 4;
  });
  view.setUint32(font.glyphCount * 4, at);
  new DataView(data.get("head")!.buffer).setInt16(50, 1);
  data.set("glyf", glyf);
  data.set("loca", loca);
  return writeSfnt(data);
}

function pointCount(code: number): number {
  const font = fixture();
  const glyf = font.tables.get("glyf")!;
  const at = font.offsets[font.glyph(code)]!;
  const view = new DataView(glyf.buffer, glyf.byteOffset, glyf.byteLength);
  return view.getUint16(at + 10 + (view.getInt16(at) - 1) * 2) + 1;
}

describe("PDF composite attachments", () => {
  const font = fixture();
  const a = font.glyph(65);
  const b = font.glyph(66);
  const parent = font.glyph(233);
  const aPoints = pointCount(65);
  const bPoints = pointCount(66);
  const parse = (children: Component[]) =>
    parseTrueType(withGlyphs(new Map([[parent, composite(children)]])));

  it("requires XY placement for the first component", () => {
    expect(() => parse([{ glyph: a, flags: 1 }])).toThrow(/first composite component.*XY/);
  });

  it.each([
    ["parent", aPoints + 4, 0],
    ["child", 0, bPoints + 4],
    ["unsigned byte parent", 255, 0],
    ["unsigned byte child", 0, 255],
  ])("rejects an out-of-range %s attachment", (name, parentPoint, childPoint) => {
    expect(() =>
      parse([
        { glyph: a },
        {
          glyph: b,
          flags: name.startsWith("unsigned") ? 0 : 1,
          parent: parentPoint,
          child: childPoint,
        },
      ]),
    ).toThrow(/composite.*point/);
  });

  it("accepts accumulated outline points and all four parent and child phantom points", () => {
    for (let phantom = 0; phantom < 4; phantom++) {
      const parsed = parse([
        { glyph: a },
        { glyph: b, flags: 1, parent: aPoints + phantom, child: bPoints + phantom },
        { glyph: a, flags: 1, parent: aPoints + bPoints - 1, child: aPoints - 1 },
      ]);
      const subset = subsetTrueType(parsed, new Map([[233, parent]]));
      expect(parseTrueType(subset.data).components.get(subset.glyphs.get(parent)!)).toHaveLength(3);
    }
  });

  it("checks nested child and accumulated parent point counts", () => {
    const nested = font.glyph(67);
    const data = (parentPoint: number, childPoint: number) =>
      withGlyphs(
        new Map([
          [nested, composite([{ glyph: a }, { glyph: b }])],
          [
            parent,
            composite([
              { glyph: a },
              { glyph: nested, flags: 1, parent: parentPoint, child: childPoint },
            ]),
          ],
        ]),
      );
    expect(() => parseTrueType(data(aPoints + 3, aPoints + bPoints + 3))).not.toThrow();
    expect(() => parseTrueType(data(aPoints + 4, 0))).toThrow(/composite.*point/);
    expect(() => parseTrueType(data(0, aPoints + bPoints + 4))).toThrow(/composite.*point/);
  });

  it.each([8 | 64, 8 | 128, 64 | 128, 8 | 64 | 128, 0x800 | 0x1000])(
    "rejects conflicting transform flags %s",
    (flags) => {
      expect(() => parse([{ glyph: a, flags: flags | 3 }])).toThrow(/conflicting composite.*flags/);
    },
  );
});

describe("PDF OS/2 versions", () => {
  it.each([
    [0, 68],
    [0, 78],
    [1, 86],
    [2, 96],
    [3, 96],
    [4, 96],
    [5, 100],
  ])("accepts version %s at its minimum length %s", (version, length) => {
    const font = parseTrueType(os2Fixture(version, length));
    const subset = subsetTrueType(font, new Map([[65, font.glyph(65)]]));
    expect(parseTrueType(subset.data).tables.get("OS/2")).toHaveLength(length);
  });

  it.each([
    [0, 67],
    [1, 85],
    [2, 95],
    [3, 95],
    [4, 95],
    [5, 78],
    [5, 99],
  ])("rejects version %s truncated to %s bytes", (version, length) => {
    expect(() => parseTrueType(os2Fixture(version, length))).toThrow(/truncated OS\/2/);
  });

  it.each([0, 1])("ignores bitmap and no-subsetting bits in version %s", (version) => {
    const font = parseTrueType(os2Fixture(version, version === 0 ? 68 : 86, 0x300));
    expect(font.noSubset).toBe(false);
    expect(subsetTrueType(font, new Map([[65, font.glyph(65)]])).data.length).toBeLessThan(
      font.data.length,
    );
    expect(() => parseTrueType(os2Fixture(version, version === 0 ? 68 : 86, 2))).toThrow(/fsType/);
  });
});
