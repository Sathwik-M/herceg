// Base64 for buffers embedded in HTML or passed through an embedded
// JavaScript engine, which has no `atob` or `btoa`.

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const LOOKUP = new Uint8Array(128);
for (let i = 0; i < ALPHABET.length; i++) LOOKUP[ALPHABET.charCodeAt(i)] = i;

export function decodeBase64(text: string): Uint8Array<ArrayBuffer> {
  const clean = text.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (let i = 0; i < clean.length; i++) {
    value = (value << 6) | LOOKUP[clean.charCodeAt(i)]!;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 255;
    }
  }
  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1] ?? 0;
    const c = bytes[i + 2] ?? 0;
    out += ALPHABET[a >> 2]! + ALPHABET[((a & 3) << 4) | (b >> 4)]!;
    out += i + 1 < bytes.length ? ALPHABET[((b & 15) << 2) | (c >> 6)]! : "=";
    out += i + 2 < bytes.length ? ALPHABET[c & 63]! : "=";
  }
  return out;
}
