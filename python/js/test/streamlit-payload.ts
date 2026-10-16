// Payloads as herceg.streamlit builds them, and Streamlit's side of a run,
// for the Streamlit component's tests.

import herceg, { type Component, type Header } from "../streamlit.ts";

/**
 * A payload as Python builds it, placed `offset` bytes into a larger buffer
 * as protobuf hands it over.
 */
export function payload(
  spec: Header["spec"],
  buffers: ArrayBufferView[],
  events: Header["events"],
  offset = 3,
  epoch?: string,
  itemEpoch?: string,
): Uint8Array {
  const offsets: [number, number][] = [];
  let end = 0;
  for (const buffer of buffers) {
    offsets.push([end, buffer.byteLength]);
    end = Math.ceil((end + buffer.byteLength) / 8) * 8;
  }
  const header = new TextEncoder().encode(
    JSON.stringify({
      spec,
      buffers: offsets,
      events,
      ...(epoch && { epoch }),
      ...(itemEpoch && { itemEpoch }),
    }),
  );
  const start = Math.ceil((4 + header.length) / 8) * 8;
  const out = new Uint8Array(offset + start + end).subarray(offset);
  new DataView(out.buffer, out.byteOffset).setUint32(0, header.length, true);
  out.set(header, 4);
  buffers.forEach((buffer, i) => {
    const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    out.set(bytes, start + offsets[i]![0]);
  });
  return out;
}

/** Streamlit's side of one script run: the payload and the value setters. */
export function run(parentElement: HTMLElement | ShadowRoot, data: Uint8Array) {
  const state: [string, unknown][] = [];
  const triggers: [string, unknown][] = [];
  const component: Component = {
    data,
    parentElement,
    setStateValue: (name, value) => state.push([name, value]),
    setTriggerValue: (name, value) => triggers.push([name, value]),
  };
  return { cleanup: herceg(component), state, triggers };
}
