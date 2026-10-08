// Charts with the same `interaction.sync` name share their cursor position,
// zoomed x range, and selection.

import type { Selection } from "./brush.ts";

export interface SyncMember {
  /** Shows a cursor at data x, or hides it with null. Does not rebroadcast. */
  syncCursor(x: number | null): void;
  /** Applies an x range, or null to fit the data. Does not rebroadcast. */
  syncViewport(domain: readonly [number, number] | null): void;
  /** Shows a selection, or none with null. Does not rebroadcast. */
  syncSelection(selection: Selection | null): void;
}

const groups = new Map<string, Set<SyncMember>>();

export function join(name: string, member: SyncMember): () => void {
  let group = groups.get(name);
  if (!group) {
    group = new Set();
    groups.set(name, group);
  }
  group.add(member);
  return () => {
    group.delete(member);
    if (group.size === 0) {
      groups.delete(name);
      viewports.delete(name);
      selections.delete(name);
    }
  };
}

export function broadcastCursor(name: string, from: SyncMember, x: number | null): void {
  for (const member of groups.get(name) ?? []) if (member !== from) member.syncCursor(x);
}

/** Viewport and selection broadcasts per group, so a broadcast can tell when a newer one started. */
const viewports = new Map<string, number>();
const selections = new Map<string, number>();

/**
 * Hands the group's other members something to apply. A member's listener
 * may start a newer broadcast of the same kind; this one then stops, so no
 * member ends on the older value.
 */
function broadcast(
  name: string,
  revisions: Map<string, number>,
  from: SyncMember,
  apply: (member: SyncMember) => void,
): void {
  const revision = (revisions.get(name) ?? 0) + 1;
  revisions.set(name, revision);
  for (const member of [...(groups.get(name) ?? [])]) {
    if (revisions.get(name) !== revision) return;
    if (member !== from) apply(member);
  }
}

/** Applies `domain` to the group's other members. */
export function broadcastViewport(
  name: string,
  from: SyncMember,
  domain: readonly [number, number] | null,
): void {
  broadcast(name, viewports, from, (member) => member.syncViewport(domain));
}

/** Shows a selection in the group's other members. */
export function broadcastSelection(
  name: string,
  from: SyncMember,
  selection: Selection | null,
): void {
  broadcast(name, selections, from, (member) => member.syncSelection(selection));
}
