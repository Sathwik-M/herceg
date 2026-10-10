/// <reference types="node" />
// A client of Firefox's remote debugging protocol, the one its DevTools speak:
// JSON packets, each prefixed by its length and a colon, sent to an actor and
// answered by it in order. Packets with a `type` are events, which are
// dropped. https://firefox-source-docs.mozilla.org/devtools/backend/protocol.html

import { connect, type Socket } from "node:net";

export type Packet = Record<string, unknown> & { from: string; error?: string; message?: string };

/** How long a request may wait for its answer, in milliseconds. */
const PATIENCE = 10_000;

export class DevTools {
  readonly #socket: Socket;
  readonly #waiting = new Map<string, Waiter[]>();
  #buffer = Buffer.alloc(0);
  #closed: Error | null = null;

  private constructor(socket: Socket) {
    this.#socket = socket;
    socket.on("data", (data) => this.#receive(data));
    const fail = (error?: Error) => {
      this.#closed ??= error ?? new Error("Firefox DevTools: the connection closed");
      for (const queue of this.#waiting.values())
        for (const waiter of queue) waiter.fail(this.#closed);
      this.#waiting.clear();
    };
    socket.on("error", fail);
    socket.on("close", () => fail());
  }

  /** Connects to the server listening on the Unix socket at `path`, once it has said hello. */
  static async connect(path: string): Promise<DevTools> {
    const client = new DevTools(connect(path));
    try {
      await client.#wait("root", "hello");
    } catch (error) {
      client.close();
      throw error;
    }
    return client;
  }

  /** Sends `type` to the actor `to` and resolves with its answer; rejects on an error answer. */
  request(to: string, type: string, args: Record<string, unknown> = {}): Promise<Packet> {
    const answer = this.#wait(to, type);
    const json = JSON.stringify({ to, type, ...args });
    if (!this.#closed) this.#socket.write(`${Buffer.byteLength(json)}:${json}`);
    return answer;
  }

  /** The actors of the tab showing `url`, as its target names them (`accessibilityActor`, ...). */
  async target(url: string): Promise<Record<string, string>> {
    const { tabs } = (await this.request("root", "listTabs")) as Packet & {
      tabs: { actor: string; url: string }[];
    };
    const tab = tabs.find((candidate) => candidate.url === url);
    if (!tab) throw new Error(`Firefox DevTools: no tab at ${url}`);
    const { frame } = (await this.request(tab.actor, "getTarget")) as Packet & {
      frame: Record<string, string>;
    };
    return frame;
  }

  close(): void {
    this.#socket.destroy();
  }

  /** The next answer from `from`, failing on an error answer, a closed connection, or a wait too long. */
  #wait(from: string, what: string): Promise<Packet> {
    return new Promise((resolve, reject) => {
      if (this.#closed) return reject(this.#closed);
      const timer = setTimeout(() => {
        this.close();
        reject(new Error(`Firefox DevTools ${from} ${what}: no answer in ${PATIENCE} ms`));
      }, PATIENCE);
      const queue = this.#waiting.get(from) ?? [];
      queue.push({
        take: (packet) => {
          clearTimeout(timer);
          if (packet.error)
            reject(
              new Error(
                `Firefox DevTools ${from} ${what}: ${packet.error} ${packet.message ?? ""}`,
              ),
            );
          else resolve(packet);
        },
        fail: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#waiting.set(from, queue);
    });
  }

  #receive(data: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, data]);
    for (;;) {
      const colon = this.#buffer.indexOf(":");
      if (colon < 0) return;
      const length = Number(this.#buffer.subarray(0, colon).toString());
      if (this.#buffer.length < colon + 1 + length) return;
      const packet = JSON.parse(this.#buffer.subarray(colon + 1, colon + 1 + length).toString());
      this.#buffer = this.#buffer.subarray(colon + 1 + length);
      if (packet.type) continue;
      this.#waiting.get(packet.from)?.shift()?.take(packet);
    }
  }
}

interface Waiter {
  take(packet: Packet): void;
  fail(error: Error): void;
}
