// Charts sharing what `interaction.sync` names: each channel (the cursor's
// position, the view's range, the selection) with the charts of its group.
// Values travel as data (times as epoch ms, categories by name), so each
// chart shows them on its own scales. The groups are the page's, whichever
// copy of herceg made a chart (a notebook's widgets each load their own);
// charts in frames of their own (static notebook outputs) take part through
// a relay (relay.ts).

import type { CursorSnap, SyncSpec } from "../spec/spec.ts";

/** What charts share: the cursor's position, the x (or y) range in view, and the selection. */
export type Channel = "cursor" | "viewport" | "selection";

/**
 * A channel a chart takes part in: its group, and the chart's scale that
 * carries it; for the cursor, how it shows the cursors it receives.
 */
export interface ChannelOf {
  group: string;
  scale: "x" | "y" | "xy";
  snap?: CursorSnap | undefined;
  tooltip?: boolean | undefined;
}

export interface SyncMember {
  /** Shows what a chart of the group shares on `channel`; never shares it again. */
  receive(channel: Channel, value: unknown): void;
}

/**
 * The groups' members, and the broadcasts per channel and group (so that a
 * broadcast can tell when a newer one started): on the global object under
 * a versioned key, which every copy of herceg on the page shares. Members
 * meet only through `SyncMember.receive` and plain values.
 */
interface Registry {
  groups: Map<string, Set<SyncMember>>;
  revisions: Map<string, number>;
}
const page = globalThis as unknown as Record<symbol, Registry | undefined>;
const KEY = Symbol.for("herceg.sync/1");
page[KEY] ??= { groups: new Map(), revisions: new Map() };
const { groups, revisions } = page[KEY];

/** The channels `interaction.sync` names, each with its group and scale. */
export function channelsOf(
  sync: string | SyncSpec | undefined,
): Partial<Record<Channel, ChannelOf>> {
  const channels: Partial<Record<Channel, ChannelOf>> = {};
  for (const channel of ["cursor", "viewport", "selection"] as const) {
    const given = typeof sync === "string" ? sync : sync?.[channel];
    // Selections are shared whole by default; the others along x.
    const scale = channel === "selection" ? "xy" : "x";
    if (given)
      channels[channel] =
        typeof given === "string"
          ? { group: given, scale }
          : { ...given, scale: given.scale ?? scale };
  }
  return channels;
}

/**
 * Joins a chart's member to the group of each channel; returns what leaves
 * them all. In a frame of opaque origin (a sandboxed notebook output), the
 * charts of the page's other frames take part through a relay.
 */
export function join(
  channels: Partial<Record<Channel, ChannelOf>>,
  member: SyncMember,
): () => void {
  const keys = Object.entries(channels).map(([channel, { group }]) => `${channel} ${group}`);
  const leave = enter(keys, member);
  let left = false;
  let leaveFrames: (() => void) | undefined;
  if (keys.length > 0 && globalThis.origin === "null" && globalThis.top !== globalThis.self)
    import("./relay.ts").then(
      ({ relay }) => {
        if (!left) leaveFrames = relay(keys, { enter, broadcast });
      },
      () => {},
    );
  return () => {
    left = true;
    leaveFrames?.();
    leave();
  };
}

/** Adds `member` to the groups `keys` name ("channel group"); returns what takes it out. */
function enter(keys: readonly string[], member: SyncMember): () => void {
  for (const key of keys) {
    const group = groups.get(key) ?? new Set();
    groups.set(key, group);
    group.add(member);
  }
  return () => {
    for (const key of keys) {
      const group = groups.get(key);
      group?.delete(member);
      if (group?.size === 0) {
        groups.delete(key);
        revisions.delete(key);
      }
    }
  };
}

/**
 * Hands the group's other members what `from` shares on `channel`. A
 * member's listener may start a newer broadcast on the channel; this one
 * then stops, so no member ends on the older value.
 */
export function broadcast(channel: Channel, group: string, from: SyncMember, value: unknown): void {
  const key = `${channel} ${group}`;
  const revision = (revisions.get(key) ?? 0) + 1;
  revisions.set(key, revision);
  for (const member of [...(groups.get(key) ?? [])]) {
    if (revisions.get(key) !== revision) return;
    if (member !== from) member.receive(channel, value);
  }
}
