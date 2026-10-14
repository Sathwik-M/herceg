// Which file each family and weight is on a page: a document has one face
// of each, whichever chart registered it, so charts must agree on them.

import type { FontSource } from "../fonts/registry.ts";

/** Each document's faces by family and weight: the file charts gave each. */
const claims = new WeakMap<Document, Map<string, Uint8Array>>();

/** A face's family (as CSS matches it) and weight. */
export function faceKey({ family, weight }: FontSource): string {
  return `${family
    .trim()
    .replace(/^["']|["']$/g, "")
    .toLowerCase()}|${weight ?? "normal"}`;
}

/**
 * Notes the faces of `sources` as `document`'s, refusing them all when the
 * page already has one's family and weight from another file: the page
 * would draw both charts' text in whichever face it chose.
 */
export function claimFaces(document: Document, sources: readonly FontSource[]): void {
  let own = claims.get(document);
  if (!own) {
    own = new Map();
    claims.set(document, own);
  }
  for (const source of sources) {
    const claimed = own.get(faceKey(source));
    if (claimed && claimed !== source.data && !sameBytes(claimed, source.data))
      throw new TypeError(
        `chart fonts: the page already has a ${source.weight ?? "normal"} "${source.family.trim()}" face from another file; give charts on one page the same file for each family and weight`,
      );
  }
  for (const source of sources) {
    const key = faceKey(source);
    if (!own.has(key)) own.set(key, source.data);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
