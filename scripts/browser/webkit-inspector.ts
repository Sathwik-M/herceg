/// <reference types="node" />
// WebKit's inspector protocol, the one Safari's Web Inspector speaks, for what
// Playwright does not offer: the accessibility tree and garbage collection.
// Playwright talks to its WebKit build through that protocol but exposes no
// session, so this reaches into its in-process server objects; a Playwright
// release that moves them fails here, loudly, rather than testing less.

import type { JSHandle, Page } from "playwright";

export interface InspectorSession {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
}

interface Internals {
  _connection?: { toImpl?: (object: unknown) => unknown };
}

function server(object: Page | JSHandle, page: Page): Record<string, unknown> {
  const toImpl = (page as unknown as Internals)._connection?.toImpl;
  const found = toImpl?.(object) as Record<string, unknown> | undefined;
  if (!found) throw new Error("webkit-inspector: Playwright no longer runs its server in process");
  return found;
}

/** The inspector session of `page`'s current WebKit target. */
export function inspectorSession(page: Page): InspectorSession {
  const delegate = server(page, page).delegate as { _session?: InspectorSession } | undefined;
  if (!delegate?._session)
    throw new Error("webkit-inspector: Playwright's WebKit page has no session");
  return delegate._session;
}

/** The inspector's remote object id of a handle `page` made. */
export function objectId(handle: JSHandle, page: Page): string {
  const id = server(handle, page)._objectId;
  if (typeof id !== "string")
    throw new Error("webkit-inspector: Playwright's handle has no object id");
  return id;
}
