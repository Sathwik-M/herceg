// Sync between charts in frames of one page that share nothing else: the
// outputs of a notebook, each in a sandboxed frame of its own, of opaque
// origin (Jupyter, VS Code, Colab). A relay in each such frame takes part
// in its charts' groups (dom/sync.ts) for the charts of the other frames:
// what a chart there shares, it posts to the relays of the page's other
// frames in that group, and what it hears from them, it shares in its own
// frame, where no chart shares it again. Relays find each other with a
// hello naming their groups, and take one only from a frame of the page's
// tree. Messages carry what sync carries (cursor values, view ranges,
// selections, with the group's name) and nothing more, and are checked
// whole as they arrive. A chart loads this module only when it syncs, in
// such a frame.

import type { broadcast, Channel, SyncMember } from "./sync.ts";

/** What the relay takes part in groups with, handed in by sync.ts. */
export interface RelayKit {
  /** Adds a member to the groups ("channel group"), without a relay of its own. */
  enter(keys: readonly string[], member: SyncMember): () => void;
  broadcast: typeof broadcast;
}

/** The relays' messages: the same tag in every frame, versioned with the sync registry. */
const TAG = "herceg.sync/1";

/** What a frame's relay keeps, on the global object, so that copies of herceg in it share one. */
interface Relay {
  kit: RelayKit;
  /** Per group ("channel group") the frame's charts take part in: the relay's member, and how many charts. */
  members: Map<string, { member: SyncMember; charts: number; leave: () => void }>;
  /** The frames of the page whose relays said hello, and the groups they are in. */
  peers: Map<MessageEventSource, Set<string>>;
  listener: (event: MessageEvent) => void;
}

const page = globalThis as unknown as Record<symbol, Relay | undefined>;
const SLOT = Symbol.for("herceg.relay/1");

/** Takes part in the groups `keys` names for the page's other frames; returns what leaves them. */
export function relay(keys: readonly string[], kit: RelayKit): () => void {
  page[SLOT] ??= start(kit);
  const state = page[SLOT];
  let added = false;
  for (const key of keys) {
    let entry = state.members.get(key);
    if (!entry) {
      const group = key.slice(key.indexOf(" ") + 1);
      const member: SyncMember = {
        receive: (from, value) => post(state, key, { herceg: TAG, channel: from, group, value }),
      };
      entry = { member, charts: 0, leave: state.kit.enter([key], member) };
      state.members.set(key, entry);
      added = true;
    }
    entry.charts++;
  }
  // Peers learn of groups this frame joined since its hello.
  if (added) hello(state, frames(top), true);
  return () => {
    let removed = false;
    for (const key of keys) {
      const entry = state.members.get(key);
      if (entry && --entry.charts === 0) {
        entry.leave();
        state.members.delete(key);
        removed = true;
      }
    }
    // Every frame hears of the groups left (peers whose answers are on
    // their way too), and with the last, the relay stops.
    if (removed) hello(state, frames(top), true);
    if (state.members.size > 0) return;
    removeEventListener("message", state.listener);
    page[SLOT] = undefined;
  };
}

/** Starts the frame's relay: it listens, and says hello to every other frame of the page. */
function start(kit: RelayKit): Relay {
  const state: Relay = {
    kit,
    members: new Map(),
    peers: new Map(),
    listener: (event) => {
      const { source, data } = event;
      // Its own frame's messages are not heard again.
      if (!source || source === self || data?.herceg !== TAG) return;
      if (data.hello === true) {
        // Only the page's own frames take part (not a window it opened).
        if (!Array.isArray(data.keys) || !frames(top).includes(source as Window)) return;
        const keys = data.keys.filter(
          (key: unknown) => typeof key === "string" && key.length < 1100,
        );
        if (keys.length > 0) state.peers.set(source, new Set(keys));
        else state.peers.delete(source);
        if (data.back !== true) hello(state, [source as Window], true);
        return;
      }
      const { channel, group, value } = data;
      const key = `${channel} ${group}`;
      const entry = typeof group === "string" && state.members.get(key);
      if (!entry || !state.peers.get(source)?.has(key) || !valid(channel, value)) return;
      state.kit.broadcast(channel as Channel, group, entry.member, value);
    },
  };
  addEventListener("message", state.listener);
  // Frames that start later say hello themselves, and this one answers them.
  hello(state, frames(top), false);
  return state;
}

/** Tells `to` the groups this frame's relay is in; `back` when no answer is wanted. */
function hello(state: Relay, to: readonly Window[], back: boolean): void {
  const message = { herceg: TAG, hello: true, back, keys: [...state.members.keys()] };
  for (const frame of to)
    try {
      frame.postMessage(message, "*");
    } catch {
      // A frame that went takes no message.
    }
}

/** Every frame of the page but this one: `root`'s, recursively (cross-origin ones too). */
function frames(root: Window | null): Window[] {
  const found: Window[] = [];
  const visit = (frame: Window) => {
    if (frame !== self) found.push(frame);
    try {
      for (let i = 0; i < frame.length; i++) visit(frame[i] as Window);
    } catch {
      // A frame that went while walking has no frames to visit.
    }
  };
  if (root) visit(root);
  return found;
}

/** Posts what a chart of the frame shared to the peers in its group. */
function post(state: Relay, key: string, message: object): void {
  for (const [peer, keys] of state.peers)
    if (keys.has(key))
      try {
        (peer as Window).postMessage(message, "*");
      } catch {
        state.peers.delete(peer);
      }
}

const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const name = (value: unknown) => typeof value === "string" && value.length <= 1000;
const range = (value: unknown) => Array.isArray(value) && value.length === 2 && value.every(finite);
/** At most this many category names or lasso points travel in a selection. */
const MOST = 100_000;

/** Whether `value` is what sync carries on `channel` (see chart.ts, `SharedSelection`). */
function valid(channel: unknown, value: unknown): boolean {
  if (value === null)
    return channel === "cursor" || channel === "viewport" || channel === "selection";
  if (channel === "cursor") return finite(value) || name(value);
  if (channel === "viewport") return range(value);
  if (channel !== "selection" || !Array.isArray(value) || value.length !== 3) return false;
  const [along, across, lasso] = value as unknown[];
  const part = (p: unknown) =>
    p === null || range(p) || (Array.isArray(p) && p.length <= MOST && p.every(name));
  return (
    part(along) &&
    part(across) &&
    (lasso === null || (Array.isArray(lasso) && lasso.length <= MOST && lasso.every(range)))
  );
}
