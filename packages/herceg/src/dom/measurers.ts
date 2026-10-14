// What charts in a page measure text with when no supplied fonts do: each
// document's canvas. Faces that load in a document (from any chart's
// supplied fonts) change how its text draws, so they drop its measurer and
// every chart there lays out again.

import { canvasMeasurer, type MeasureText } from "../layout/text.ts";

/**
 * Without a canvas to measure with (some test environments), glyphs are
 * taken to be 0.6 em wide; browsers always measure, so charts do not carry
 * the static estimator's font tables.
 */
export const roughText: MeasureText = (text, font) =>
  text.length * 0.6 * (Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1]) || 12);

const measurers = new WeakMap<Document, MeasureText>();
const listeners = new WeakMap<Document, Set<() => void>>();

/** `document`'s canvas measurer, made again after faces load there. */
export function measurer(document: Document): MeasureText {
  let measure = measurers.get(document);
  if (!measure) {
    const context = document.createElement("canvas").getContext("2d");
    measure = context ? canvasMeasurer(context) : roughText;
    measurers.set(document, measure);
  }
  return measure;
}

/** Calls `changed` whenever faces load in `document`; returns what stops it. */
export function onFacesLoaded(document: Document, changed: () => void): () => void {
  let own = listeners.get(document);
  if (!own) {
    own = new Set();
    listeners.set(document, own);
  }
  own.add(changed);
  return () => own.delete(changed);
}

/** A face loaded in `document`: text there is measured again, by every chart. */
export function facesLoaded(document: Document): void {
  measurers.delete(document);
  for (const changed of listeners.get(document) ?? []) changed();
}
