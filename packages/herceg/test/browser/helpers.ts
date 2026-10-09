// Helpers shared by the browser tests.

import { expect } from "vitest";
import { cdp } from "vitest/browser";

/** The x and width of a brush outline drawn as a rectangle, "M x0 y0 H x1 V y1 H x0 Z". */
export function bandBox(outline: Element): { x: number; width: number } {
  const [x0, , x1] = (outline.getAttribute("d") ?? "").match(/-?[\d.]+/g)!.map(Number);
  return { x: x0!, width: x1! - x0! };
}

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
  childIds?: string[];
  properties?: { name: string; value: { value: unknown } }[];
}

/**
 * The accessibility tree Chrome gives screen readers under the one node of
 * role `root`, one node a line: `role "name"`, then its description and the
 * `states` it has, indented by depth. Nodes assistive technology ignores are
 * left out.
 */
export async function accessibilityTree(
  root: string,
  states: readonly string[],
): Promise<string[]> {
  // Tests run in vitest's frame of the page the session is attached to.
  const { frameTree } = (await cdp().send("Page.getFrameTree")) as {
    frameTree: { childFrames?: { frame: { id: string; name?: string } }[] };
  };
  const testers = (frameTree.childFrames ?? []).filter(
    ({ frame }) => frame.name === "vitest-iframe",
  );
  expect(testers).toHaveLength(1);
  const frameId = testers[0]!.frame.id;
  const { nodes } = (await cdp().send("Accessibility.getFullAXTree", { frameId })) as {
    nodes: AXNode[];
  };
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const roots = nodes.filter((node) => node.role?.value === root);
  expect(roots).toHaveLength(1);
  const lines: string[] = [];
  const walk = (node: AXNode, depth: number) => {
    const shown = !node.ignored && node.role?.value !== "InlineTextBox";
    if (shown) {
      const found = (node.properties ?? [])
        .filter(({ name }) => states.includes(name))
        .map(({ name, value }) => `${name}=${value.value}`);
      const description = node.description?.value ? [`(${node.description.value})`] : [];
      lines.push(
        `${"  ".repeat(depth)}${[node.role?.value, JSON.stringify(node.name?.value ?? ""), ...description, ...found].join(" ")}`,
      );
    }
    for (const id of node.childIds ?? []) walk(byId.get(id)!, shown ? depth + 1 : depth);
  };
  walk(roots[0]!, 0);
  return lines;
}
