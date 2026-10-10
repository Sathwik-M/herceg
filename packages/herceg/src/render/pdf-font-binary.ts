/** Bounded reads of big-endian sfnt data, including Uint8Array views. */
export class FontReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  check(offset: number, length: number): void {
    if (offset < 0 || length < 0 || offset + length > this.bytes.length)
      throw new Error("Malformed PDF font: data outside table bounds");
  }
  u8(offset: number): number {
    this.check(offset, 1);
    return this.view.getUint8(offset);
  }
  u16(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset);
  }
  i16(offset: number): number {
    this.check(offset, 2);
    return this.view.getInt16(offset);
  }
  u32(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset);
  }
  slice(offset: number, length: number): Uint8Array {
    this.check(offset, length);
    return this.bytes.subarray(offset, offset + length);
  }
}

export function fontError(reason: string): never {
  throw new Error(`Malformed PDF font: ${reason}`);
}

/** sfnt checksums pad the final word with zeros. */
export function fontChecksum(bytes: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < bytes.length; i += 4) {
    const word =
      ((bytes[i] ?? 0) * 0x1000000 +
        (bytes[i + 1] ?? 0) * 0x10000 +
        (bytes[i + 2] ?? 0) * 0x100 +
        (bytes[i + 3] ?? 0)) >>>
      0;
    sum = (sum + word) >>> 0;
  }
  return sum;
}
