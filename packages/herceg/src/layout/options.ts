// Layouts as TypeScript writes them: the spec's (spec/layout.ts), where a
// panel may be given with its settings in the place it goes, and its id may
// be left out. `normalizeLayout` turns them into the spec's panels and
// layout, as `panels(...)`, the adapters, and Python do alike.

import type { PanelOptions } from "../guides/options.ts";
import type {
  GridLayoutSpec,
  InsetSpec,
  LayoutCellSpec,
  LayoutSpec,
  PanelLayoutSpec,
} from "../spec/spec.ts";

/** A panel's settings where it is placed: its id may be left out (see `normalizeLayout`). */
export type PanelDefinition = Omit<PanelOptions, "id"> & { id?: string | undefined };

/** A panel placed in a layout: the id of one of `panels`, or its settings. */
export type PanelRef = string | PanelDefinition;

export interface PanelLayoutOptions extends Omit<PanelLayoutSpec, "panel" | "insets"> {
  panel: PanelRef;
  insets?: readonly InsetOptions[] | undefined;
}

export interface InsetOptions extends Omit<InsetSpec, "panel" | "insets"> {
  panel: PanelRef;
  insets?: readonly InsetOptions[] | undefined;
}

export interface LayoutCellOptions extends Omit<LayoutCellSpec, "content"> {
  content: LayoutOptions;
}

export interface GridLayoutOptions extends Omit<GridLayoutSpec, "cells"> {
  cells?: readonly LayoutCellOptions[] | undefined;
}

/** A layout whose panels may be given with their settings. */
export type LayoutOptions = GridLayoutOptions | PanelLayoutOptions;

/**
 * `list` and `layout` as the spec has them, and the id of each panel given:
 * the panels `layout` gives with their settings join `list`, in the order
 * they are declared, and those without an id are named by their place
 * among all panels declared, "panel-1", "panel-2", ..., or "panel-2-2"
 * where that is taken. Without a list, an id the layout names that no
 * panel's settings give declares a panel of that id.
 */
export function normalizeLayout(
  list: readonly PanelOptions[],
  layout: LayoutOptions | undefined,
): {
  list: PanelOptions[];
  layout: LayoutSpec | undefined;
  idOf: (ref: PanelRef) => string;
} {
  const given: PanelRef[] = [];
  walk(layout, (ref) => given.push(ref));
  const settings = new Set(given.flatMap((ref) => (typeof ref === "string" ? [] : (ref.id ?? []))));
  const named = new Set<string>();
  const declared: PanelDefinition[] = [...list];
  for (const ref of given)
    if (typeof ref !== "string") declared.push(ref);
    else if (list.length === 0 && !settings.has(ref) && !named.has(ref)) {
      named.add(ref);
      declared.push({ id: ref });
    }
  const taken = new Set(declared.flatMap(({ id }) => (id === undefined ? [] : [id])));
  const ids = new Map<PanelDefinition, string>();
  declared.forEach((panel, i) => {
    if (panel.id !== undefined) {
      ids.set(panel, panel.id);
      return;
    }
    let id = `panel-${i + 1}`;
    for (let n = 2; taken.has(id); n++) id = `panel-${i + 1}-${n}`;
    taken.add(id);
    ids.set(panel, id);
  });
  const idOf = (ref: PanelRef) => (typeof ref === "string" ? ref : ids.get(ref)!);
  return {
    list: declared.map((panel) => ({ ...panel, id: ids.get(panel)! })),
    layout: layout && specOf(layout, idOf),
    idOf,
  };
}

function walk(layout: LayoutOptions | undefined, visit: (ref: PanelRef) => void): void {
  if (!layout || typeof layout !== "object") return;
  if (layout.type === "panel") {
    visit(layout.panel);
    walkInsets(layout.insets, visit);
  } else for (const cell of layout.cells ?? []) walk(cell.content, visit);
}

function walkInsets(list: readonly InsetOptions[] | undefined, visit: (ref: PanelRef) => void) {
  for (const inset of list ?? []) {
    visit(inset.panel);
    walkInsets(inset.insets, visit);
  }
}

function specOf(layout: LayoutOptions, idOf: (ref: PanelRef) => string): LayoutSpec {
  if (layout.type === "panel") {
    const { panel, insets, ...rest } = layout;
    return { ...rest, panel: idOf(panel), ...(insets && { insets: insetSpecs(insets, idOf) }) };
  }
  if (layout.type !== "grid") return layout;
  const { cells, ...rest } = layout;
  return cells
    ? { ...rest, cells: cells.map((cell) => ({ ...cell, content: specOf(cell.content, idOf) })) }
    : rest;
}

function insetSpecs(list: readonly InsetOptions[], idOf: (ref: PanelRef) => string): InsetSpec[] {
  return list.map(({ panel, insets, ...rest }) => ({
    ...rest,
    panel: idOf(panel),
    ...(insets && { insets: insetSpecs(insets, idOf) }),
  }));
}
