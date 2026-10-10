import { describe, expect, it, vi } from "vitest";
import { table } from "../../src/data/table.ts";
import { estimateText } from "../../src/layout/text.ts";
import { graph } from "../../src/marks/graph.ts";
import type { LayoutControls } from "../../src/marks/layout-mark.ts";
import { treemap } from "../../src/marks/treemap.ts";
import type { Controls } from "../../src/model/item-views.ts";
import { ChartModel } from "../../src/model/model.ts";

const tree = () => ({
  marks: [treemap(table({ path: ["A", "B"], value: [1, 2] }), { path: ["path"], value: "value" })],
  interaction: { zoom: true as const },
});
const network = () => ({
  marks: [graph(table({ from: ["a"], to: ["b"] }), { source: "from", target: "to" })],
  interaction: { drag: true },
});
const controls = () => ({ update: vi.fn(), draw: vi.fn(), dispose: vi.fn(), busy: false });

function deferredLoads() {
  const requests: {
    kind: LayoutControls["kind"];
    resolve: (controls: Controls) => void;
    reject: (error: Error) => void;
  }[] = [];
  const mount = (kind: LayoutControls["kind"]) =>
    new Promise<Controls>((resolve, reject) => requests.push({ kind, resolve, reject }));
  return { mount, requests };
}

function chart() {
  const model = new ChartModel(tree());
  model.scene(estimateText);
  return { model, items: model.items! };
}

describe("layout controls lifetime", () => {
  it("keeps the newest request through A → B → A, drawing the latest scene and options", async () => {
    const { model, items } = chart();
    const { mount, requests } = deferredLoads();
    items.updateControls(model, mount);
    const first = items.controlsLoading;
    model.update(network());
    items.updateControls(model, mount);
    const second = items.controlsLoading;
    model.update(tree());
    items.updateControls(model, mount);
    const third = items.controlsLoading;
    model.update({ ...tree(), tooltip: false });
    items.updateControls(model, mount);
    const scene = model.scene(estimateText);
    items.drawControls(scene);
    expect(requests.map(({ kind }) => kind)).toEqual(["drill", "drag", "drill"]);

    const newest = controls();
    requests[2]!.resolve(newest);
    await third;
    expect(items.controls).toBe(newest);
    expect(items.controlsLoading).toBeUndefined();
    expect(newest.update).toHaveBeenCalledWith(model.config);
    expect(newest.draw).toHaveBeenCalledWith(scene);

    const obsolete = [controls(), controls()];
    requests[0]!.resolve(obsolete[0]!);
    requests[1]!.resolve(obsolete[1]!);
    await Promise.all([first, second]);
    expect(items.controls).toBe(newest);
    for (const old of obsolete) {
      expect(old.dispose).toHaveBeenCalledOnce();
      expect(old.update).not.toHaveBeenCalled();
      expect(old.draw).not.toHaveBeenCalled();
    }
  });

  it("disposes attached controls on disable, and releases an import that finishes after destruction", async () => {
    const { model, items } = chart();
    const { mount, requests } = deferredLoads();
    items.updateControls(model, mount);
    const first = items.controlsLoading;
    const attached = controls();
    requests[0]!.resolve(attached);
    await first;
    model.update({ ...tree(), interaction: { zoom: false } });
    items.updateControls(model, mount);
    expect(attached.dispose).toHaveBeenCalledOnce();
    expect(items.controls).toBeUndefined();

    model.update(tree());
    items.updateControls(model, mount);
    const pending = items.controlsLoading;
    items.changed = vi.fn();
    items.disposeControls();
    const late = controls();
    requests[1]!.resolve(late);
    await pending;
    expect(late.dispose).toHaveBeenCalledOnce();
    expect(late.draw).not.toHaveBeenCalled();
    expect(items.controlsLoading).toBeUndefined();
    expect(items.controls).toBeUndefined();
    expect(items.changed).toBeUndefined();
    items.updateControls(model, mount);
    expect(requests).toHaveLength(2);
  });

  it("settles a failed import and retries when its family is requested again", async () => {
    const { model, items } = chart();
    const { mount, requests } = deferredLoads();
    items.updateControls(model, mount);
    const failed = items.controlsLoading;
    requests[0]!.reject(new Error("Unavailable chunk"));
    await failed;
    expect(items.controlsLoading).toBeUndefined();
    expect(items.controls).toBeNull();
    items.updateControls(model, mount);
    expect(requests).toHaveLength(1);
    model.update({ ...tree(), interaction: { zoom: false } });
    items.updateControls(model, mount);
    model.update(tree());
    items.updateControls(model, mount);
    const retry = items.controlsLoading;
    requests[1]!.resolve(controls());
    await retry;
    expect(requests).toHaveLength(2);
    expect(items.controls).not.toBeNull();
  });
});
