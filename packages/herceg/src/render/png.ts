// Minimal PNG encoder for embedding raster marks in standalone SVG without a
// canvas. Uses uncompressed (stored) deflate blocks: output is larger than a
// compressed PNG but needs no compression library and runs anywhere.

let crcTable: Uint32Array | undefined;

function crc32(bytes: Uint8Array, start: number, end: number): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ bytes[i]!) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeChunk(out: Uint8Array, at: number, type: string, data: Uint8Array): number {
  const view = new DataView(out.buffer, out.byteOffset);
  view.setUint32(at, data.length);
  for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
  out.set(data, at + 8);
  view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
  return at + 12 + data.length;
}

/** Zlib stream with stored (uncompressed) deflate blocks. */
function storedZlib(raw: Uint8Array): Uint8Array {
  const BLOCK = 65_535;
  const blocks = Math.max(1, Math.ceil(raw.length / BLOCK));
  const out = new Uint8Array(2 + blocks * 5 + raw.length + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * BLOCK;
    const length = Math.min(BLOCK, raw.length - start);
    out[at] = b === blocks - 1 ? 1 : 0;
    out[at + 1] = length & 255;
    out[at + 2] = length >> 8;
    out[at + 3] = ~length & 255;
    out[at + 4] = (~length >> 8) & 255;
    out.set(raw.subarray(start, start + length), at + 5);
    at += 5 + length;
  }
  let a = 1;
  let b = 0;
  for (let i = 0; i < raw.length; i++) {
    a = (a + raw[i]!) % 65_521;
    b = (b + a) % 65_521;
  }
  new DataView(out.buffer).setUint32(at, ((b << 16) | a) >>> 0);
  return out;
}

/** Encodes RGBA pixels (row-major, `width * height * 4` bytes) as PNG bytes. */
export function encodePng(
  width: number,
  height: number,
  rgba: Uint8ClampedArray | Uint8Array,
): Uint8Array {
  // Each row starts with filter type 0 (none).
  const raw = new Uint8Array(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  }
  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const data = storedZlib(raw);
  const out = new Uint8Array(8 + 25 + 12 + data.length + 12);
  out.set([137, 80, 78, 71, 13, 10, 26, 10]);
  let at = writeChunk(out, 8, "IHDR", header);
  at = writeChunk(out, at, "IDAT", data);
  writeChunk(out, at, "IEND", new Uint8Array(0));
  return out;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += BASE64[a >> 2]! + BASE64[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? BASE64[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? BASE64[c & 63]! : "=";
  }
  return out;
}

export function pngDataUrl(
  width: number,
  height: number,
  rgba: Uint8ClampedArray | Uint8Array,
): string {
  return `data:image/png;base64,${base64(encodePng(width, height, rgba))}`;
}
