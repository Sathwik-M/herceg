// Small helpers for writing SVG markup.

import type { SvgElement } from "../scene/scene.ts";

/** Rounds to 0.1 px: invisible at any pixel ratio and keeps paths short. */
export function n(value: number): string {
  return String(Math.round(value * 10) / 10);
}

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A `stroke-dasharray` attribute, or nothing for solid strokes. */
export function dashAttribute(value: readonly number[] | undefined): string {
  return value && value.length > 0 ? ` stroke-dasharray="${value.join(" ")}"` : "";
}

/** Markup of elements, for drawings that describe their output as elements. */
export function markupOf(elements: readonly SvgElement[]): string {
  let out = "";
  for (const { tag, attributes } of elements) {
    out += `<${tag}`;
    for (const name in attributes) out += ` ${name}="${escapeXml(attributes[name]!)}"`;
    out += "/>";
  }
  return out;
}

/** Control point distance of a cubic Bezier quarter circle, per unit of radius. */
export const KAPPA = 0.5522847498;

/** What paths are traced into: a canvas context, or a builder of SVG or PDF path data. */
export type PathSink = Pick<
  CanvasPath,
  "moveTo" | "lineTo" | "bezierCurveTo" | "closePath" | "rect"
>;

/** Builds SVG path data from the calls that trace a path on a canvas. */
export class SvgPath implements PathSink {
  d = "";
  moveTo(x: number, y: number): void {
    this.d += `M${n(x)} ${n(y)}`;
  }
  lineTo(x: number, y: number): void {
    this.d += `L${n(x)} ${n(y)}`;
  }
  bezierCurveTo(ax: number, ay: number, bx: number, by: number, x: number, y: number): void {
    this.d += `C${n(ax)} ${n(ay)} ${n(bx)} ${n(by)} ${n(x)} ${n(y)}`;
  }
  rect(x: number, y: number, width: number, height: number): void {
    this.d += `M${n(x)} ${n(y)}h${n(width)}v${n(height)}h${n(-width)}Z`;
  }
  closePath(): void {
    this.d += "Z";
  }
}
