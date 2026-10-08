// Zlib compression (RFC 1950 and 1951) without dependencies, for PDF
// streams, which must be built synchronously wherever herceg runs (browsers,
// servers, the engine embedded in Python). One deflate block with the fixed
// Huffman codes: matches found through hash chains are where the savings come
// from. Dynamic codes would shrink text-heavy streams further at the cost of
// building code tables.

const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
];
const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
];
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
];
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

const WINDOW = 32_768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
/** Candidates tried per position: longer chains find longer matches, slowly. */
const MAX_CHAIN = 32;
/** Three-byte matches farther back than this cost more bits than literals. */
const FAR_SHORT_MATCH = 4096;
const HASH_BITS = 15;

interface Tables {
  /** Fixed Huffman code (bit-reversed, ready to write LSB first) and length per literal/length symbol. */
  codes: Uint16Array;
  lengths: Uint8Array;
  /** Length symbol index (0..28) per match length. */
  lengthCode: Uint8Array;
  /** Distance code per distance (1..32768). */
  distanceCode: Uint8Array;
}

let tables: Tables | undefined;

function reverse(code: number, length: number): number {
  let out = 0;
  for (let i = 0; i < length; i++) out = (out << 1) | ((code >> i) & 1);
  return out;
}

function buildTables(): Tables {
  const codes = new Uint16Array(288);
  const lengths = new Uint8Array(288);
  for (let symbol = 0; symbol < 288; symbol++) {
    const [code, length] =
      symbol < 144
        ? [0x30 + symbol, 8]
        : symbol < 256
          ? [0x190 + symbol - 144, 9]
          : symbol < 280
            ? [symbol - 256, 7]
            : [0xc0 + symbol - 280, 8];
    codes[symbol] = reverse(code, length);
    lengths[symbol] = length;
  }
  const lengthCode = new Uint8Array(MAX_MATCH + 1);
  for (let code = 0; code < LENGTH_BASE.length; code++) {
    const end = code + 1 < LENGTH_BASE.length ? LENGTH_BASE[code + 1]! : MAX_MATCH + 1;
    for (let length = LENGTH_BASE[code]!; length < end; length++) lengthCode[length] = code;
  }
  // 258 has its own code rather than 227 plus 31.
  lengthCode[MAX_MATCH] = LENGTH_BASE.length - 1;
  const distanceCode = new Uint8Array(WINDOW + 1);
  for (let code = 0; code < DISTANCE_BASE.length; code++) {
    const end = code + 1 < DISTANCE_BASE.length ? DISTANCE_BASE[code + 1]! : WINDOW + 1;
    for (let distance = DISTANCE_BASE[code]!; distance < end; distance++)
      distanceCode[distance] = code;
  }
  return { codes, lengths, lengthCode, distanceCode };
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  // Sums stay exact for 5552 bytes between reductions, as in zlib.
  for (let start = 0; start < data.length; start += 5552) {
    const end = Math.min(data.length, start + 5552);
    for (let i = start; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65_521;
    b %= 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

/** `data` as a zlib stream (what PDF's FlateDecode filter reads). */
export function zlibCompress(data: Uint8Array): Uint8Array {
  tables ??= buildTables();
  const { codes, lengths, lengthCode, distanceCode } = tables;
  const n = data.length;
  // Fixed codes spend at most 9 bits per input byte, matches included.
  const out = new Uint8Array(Math.ceil((n * 9) / 8) + 16);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  let bits = 0;
  let count = 0;
  const write = (value: number, length: number) => {
    bits |= value << count;
    count += length;
    while (count >= 8) {
      out[at++] = bits & 255;
      bits >>>= 8;
      count -= 8;
    }
  };
  const symbol = (s: number) => write(codes[s]!, lengths[s]!);

  write(1, 1); // final block
  write(1, 2); // fixed Huffman codes

  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const previous = new Int32Array(WINDOW);
  const hash = (i: number) =>
    Math.imul((data[i]! << 16) | (data[i + 1]! << 8) | data[i + 2]!, 0x9e3779b1) >>>
    (32 - HASH_BITS);
  const insert = (i: number) => {
    const h = hash(i);
    previous[i & (WINDOW - 1)] = head[h]!;
    head[h] = i;
  };

  let i = 0;
  while (i < n) {
    let best = 0;
    let distance = 0;
    if (i + MIN_MATCH <= n) {
      const limit = Math.min(MAX_MATCH, n - i);
      let candidate = head[hash(i)]!;
      // A candidate within the window still has its own chain link: only a
      // position a whole window later could have overwritten it.
      for (let chain = MAX_CHAIN; candidate >= 0 && i - candidate <= WINDOW && chain > 0; chain--) {
        if (data[candidate + best] === data[i + best]) {
          let length = 0;
          while (length < limit && data[candidate + length] === data[i + length]) length++;
          if (length > best) {
            best = length;
            distance = i - candidate;
            if (length === limit) break;
          }
        }
        candidate = previous[candidate & (WINDOW - 1)]!;
      }
      insert(i);
    }
    if (best >= MIN_MATCH && !(best === MIN_MATCH && distance > FAR_SHORT_MATCH)) {
      const lc = lengthCode[best]!;
      symbol(257 + lc);
      if (LENGTH_EXTRA[lc]) write(best - LENGTH_BASE[lc]!, LENGTH_EXTRA[lc]!);
      const dc = distanceCode[distance]!;
      write(reverse(dc, 5), 5);
      if (DISTANCE_EXTRA[dc]) write(distance - DISTANCE_BASE[dc]!, DISTANCE_EXTRA[dc]!);
      const end = i + best;
      for (i++; i < end; i++) if (i + MIN_MATCH <= n) insert(i);
    } else {
      symbol(data[i]!);
      i++;
    }
  }
  symbol(256); // end of block
  if (count > 0) out[at++] = bits & 255;
  const checksum = adler32(data);
  out[at++] = checksum >>> 24;
  out[at++] = (checksum >>> 16) & 255;
  out[at++] = (checksum >>> 8) & 255;
  out[at++] = checksum & 255;
  return out.slice(0, at);
}
