// Charts with the same `interaction.sync` name share their cursor position and
// zoomed x range.

export interface SyncMember {
  /** Shows a cursor at data x, or hides it with null. Does not rebroadcast. */
  syncCursor(x: number | null): void;
  /** Applies an x range, or null to fit the data. Does not rebroadcast. */
  syncViewport(domain: readonly [number, number] | null): void;
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
    if (group.size === 0) groups.delete(name);
  };
}

export function broadcastCursor(name: string, from: SyncMember, x: number | null): void {
  for (const member of groups.get(name) ?? []) if (member !== from) member.syncCursor(x);
}

export function broadcastViewport(
  name: string,
  from: SyncMember,
  domain: readonly [number, number] | null,
): void {
  for (const member of groups.get(name) ?? []) if (member !== from) member.syncViewport(domain);
}
