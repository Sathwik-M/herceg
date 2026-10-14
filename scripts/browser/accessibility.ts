/// <reference types="node" />
// The accessibility tree each engine builds for screen readers, read through
// its own protocol and written the same way for all three: one node a line,
// `role "name" (description) state=value ...`, indented by depth.
//
// - Chrome: the DevTools protocol's full tree.
// - Firefox: its remote debugging protocol, the tree its Accessibility
//   Inspector shows (Gecko's, which the platform's accessibility API serves).
// - WebKit: its inspector protocol, the tree Safari's Web Inspector shows.
//
// Where engines say the same thing differently, the lines say it one way:
// - Roles keep their ARIA names; text is `StaticText`, as Chrome calls it.
// - Nodes assistive technology ignores are left out, their children in their
//   place, and so is the text under roles whose children are presentational
//   (buttons, checkboxes, sliders, ...), with generic elements around it
//   that say nothing of their own: the engines differ in what they keep
//   there, and screen readers read the node's name. Anything else there
//   stays (a link, an alert, a description).
// - A description that repeats the name is left out, as Firefox leaves it.
// - WebKit names rows, cells, and headers by their content only through
//   their children, which VoiceOver reads; the lines name them by that
//   content, as the other engines do.
// - What WebKit's protocol does not report, descriptions, `multiselectable`,
//   and `keyshortcuts`, comes from the element's ARIA attributes: what the
//   page declares, rather than what WebKit exposes.
// - WebKit on Linux has no nodes for text; the lines take the text shown
//   from the page, where WebKit on macOS has them (`TEXT_LEFT_OUT`).
//
// Other differences remain, for tests to know: Firefox and WebKit report no
// value ranges (`valuemin`, `valuemax`); WebKit's tables have no row groups,
// and its rows say `selected` only when they are; Firefox's rows and cells
// of grids are all selectable (`selected=false`), a selected row's cells
// selected too.

import type { BrowserCommandContext } from "vitest/node";
import { firefoxDevTools } from "./browsers.ts";
import { DevTools, type Packet } from "./firefox-devtools.ts";
import { inspectorSession, objectId } from "./webkit-inspector.ts";

interface Node {
  role: string;
  name: string;
  description?: string;
  /** States and properties as strings, `pressed: "true"`, by their ARIA names. */
  states: Record<string, string>;
  children: Node[];
}

/** Roles whose children are presentational (WAI-ARIA 1.2). */
const LEAVES = new Set([
  "button",
  "checkbox",
  "img",
  "image",
  "menuitemcheckbox",
  "menuitemradio",
  "meter",
  "option",
  "progressbar",
  "radio",
  "scrollbar",
  "separator",
  "slider",
  "switch",
  "tab",
]);

/**
 * What nodes under a role whose children are presentational expose beyond
 * the text that names it: not text, nor generic elements around it that
 * say nothing of their own, but a link, an alert, or a description inside a
 * button, say.
 */
function beyondText(nodes: readonly Node[]): Node[] {
  return nodes.flatMap((node) =>
    node.role === "StaticText"
      ? []
      : node.role === "generic" &&
          !node.name &&
          !node.description &&
          Object.keys(node.states).length === 0
        ? beyondText(node.children)
        : [node],
  );
}

/** The tree under the one node of role `root` in the test's frame, with the `states` asked for. */
export async function accessibilityTree(
  context: BrowserCommandContext,
  root: string,
  states: readonly string[],
): Promise<string[]> {
  const engine = context.project.config.browser.name;
  // Firefox builds its tree from the page's changes when it next refreshes.
  if (engine === "firefox")
    await (await context.frame()).evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))),
    );
  const top =
    engine === "chromium"
      ? await chromeTree(context)
      : engine === "firefox"
        ? await firefoxTree(context)
        : await webkitTree(context);
  const found: Node[] = [];
  const find = (node: Node) => {
    if (node.role === root) found.push(node);
    node.children.forEach(find);
  };
  top.forEach(find);
  if (found.length !== 1)
    throw new Error(`accessibilityTree: ${found.length} nodes of role ${root} in ${engine}`);
  const lines: string[] = [];
  const write = (node: Node, depth: number) => {
    const shown = states.filter((state) => node.states[state] !== undefined);
    const described = node.description && node.description !== node.name;
    lines.push(
      [
        `${"  ".repeat(depth)}${node.role}`,
        JSON.stringify(node.name),
        ...(described ? [`(${node.description})`] : []),
        ...shown.map((state) => `${state}=${node.states[state]}`),
      ].join(" "),
    );
    const children = LEAVES.has(node.role) ? beyondText(node.children) : node.children;
    for (const child of children) write(child, depth + 1);
  };
  write(found[0]!, 0);
  return lines;
}

// Chrome ---------------------------------------------------------------------

interface ChromeNode {
  nodeId: string;
  ignored: boolean;
  role?: { value: string };
  name?: { value: string };
  description?: { value: string };
  childIds?: string[];
  properties?: { name: string; value: { value: unknown } }[];
}

/** The nodes of the test's frame, in Chrome. */
async function chromeTree(context: BrowserCommandContext): Promise<Node[]> {
  const session = await context.page.context().newCDPSession(context.page);
  try {
    const { frameTree } = (await session.send("Page.getFrameTree")) as {
      frameTree: { childFrames?: { frame: { id: string; name?: string } }[] };
    };
    const testers = (frameTree.childFrames ?? []).filter(
      ({ frame }) => frame.name === "vitest-iframe",
    );
    if (testers.length !== 1) throw new Error(`accessibilityTree: ${testers.length} test frames`);
    const { nodes } = (await session.send("Accessibility.getFullAXTree", {
      frameId: testers[0]!.frame.id,
    })) as { nodes: ChromeNode[] };
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    const convert = (node: ChromeNode): Node[] => {
      const children = (node.childIds ?? []).flatMap((id) => convert(byId.get(id)!));
      if (node.ignored || node.role?.value === "InlineTextBox") return children;
      const states: Record<string, string> = {};
      for (const { name, value } of node.properties ?? []) states[name] = String(value.value);
      // Chrome reports `focused` only on the node with the focus; so do the others.
      if (states.focused !== "true") delete states.focused;
      return [
        {
          role: node.role?.value ?? "",
          name: node.name?.value ?? "",
          ...(node.description?.value && { description: node.description.value }),
          states,
          children,
        },
      ];
    };
    return convert(nodes[0]!);
  } finally {
    await session.detach();
  }
}

// Firefox --------------------------------------------------------------------

interface GeckoNode {
  role: string;
  name: string | null;
  description: string;
  states: string[];
  attributes: Record<string, string>;
  children: GeckoNode[];
}

/** Gecko's roles that have no ARIA name, and their names here. */
const GECKO_ROLES: Record<string, string> = {
  "text leaf": "StaticText",
  "internal frame": "Iframe",
};

/** The nodes of the test's frame, in Firefox. */
async function firefoxTree(context: BrowserCommandContext): Promise<Node[]> {
  const devtools = await DevTools.connect(firefoxDevTools);
  try {
    const { accessibilityActor } = await devtools.target(context.page.url());
    const { parentAccessibilityActor } = (await devtools.request("root", "getRoot")) as Packet & {
      parentAccessibilityActor: string;
    };
    await devtools.request(parentAccessibilityActor, "enable");
    const { walker } = (await devtools.request(accessibilityActor!, "getWalker")) as Packet & {
      walker: { actor: string };
    };
    // The tree is built lazily: the first look may find documents still loading.
    for (let attempt = 0; ; attempt++) {
      const { children } = (await devtools.request(walker.actor, "children")) as Packet & {
        children: { actor: string }[];
      };
      const { snapshot } = (await devtools.request(children[0]!.actor, "snapshot")) as Packet & {
        snapshot: GeckoNode;
      };
      const frames: GeckoNode[] = [];
      const find = (node: GeckoNode) => {
        if (node.role === "internal frame") frames.push(node);
        else node.children.forEach(find);
      };
      find(snapshot);
      if (frames.length !== 1) throw new Error(`accessibilityTree: ${frames.length} test frames`);
      const documents = frames[0]!.children;
      const ready = documents.length > 0 && documents.every((d) => !d.states.includes("busy"));
      if (ready) return documents.flatMap(fromGecko);
      if (attempt === 50) throw new Error("accessibilityTree: Firefox's tree stayed busy");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    devtools.close();
  }
}

function fromGecko(node: GeckoNode): Node[] {
  const has = (state: string) => node.states.includes(state);
  const { attributes } = node;
  const states: Record<string, string> = {};
  if (attributes.pressed !== undefined) states.pressed = attributes.pressed;
  else if (has("pressed")) states.pressed = "true";
  if (has("focusable")) states.focusable = "true";
  if (has("focused")) states.focused = "true";
  if (attributes.live) states.live = attributes.live;
  if (attributes.atomic) states.atomic = attributes.atomic;
  if (attributes.level) states.level = attributes.level;
  if (has("expanded")) states.expanded = "true";
  else if (has("collapsed")) states.expanded = "false";
  if (has("selected")) states.selected = "true";
  else if (has("selectable")) states.selected = "false";
  if (has("mixed")) states.checked = "mixed";
  else if (has("checked")) states.checked = "true";
  else if (has("checkable")) states.checked = "false";
  if (has("multiselectable")) states.multiselectable = "true";
  if (has("unavailable")) states.disabled = "true";
  if (attributes.keyshortcuts) states.keyshortcuts = attributes.keyshortcuts;
  return [
    {
      role: GECKO_ROLES[node.role] ?? node.role,
      name: node.name ?? "",
      ...(node.description && { description: node.description }),
      states,
      children: node.children.flatMap(fromGecko),
    },
  ];
}

// WebKit ---------------------------------------------------------------------

/**
 * WebKit's Linux ports (GTK and WPE, which Playwright runs there) expose an
 * element's text through the element, as AT-SPI's text interface does, and
 * not as nodes of its own, which the inspector leaves out. There the lines
 * write the text shown, outside `aria-hidden`, as WebKit on macOS does.
 */
const TEXT_LEFT_OUT = process.platform === "linux";

interface WebKitProperties {
  exists: boolean;
  ignored?: boolean;
  role: string;
  label: string;
  nodeId: number;
  parentNodeId?: number;
  childNodeIds?: number[];
  pressed?: boolean;
  focused?: boolean;
  liveRegionStatus?: string;
  liveRegionAtomic?: boolean;
  hierarchyLevel?: number;
  headingLevel?: number;
  expanded?: boolean;
  selected?: boolean;
  checked?: string;
  disabled?: boolean;
}

/**
 * What WebKit's inspector leaves out, from the element's ARIA attributes;
 * with `textLeftOut`, also the text the element shows that none of its
 * accessible `children` holds, among them where the document has it.
 * Children keep WebKit's order: one the document has before a child
 * earlier in that order comes after it. What the element owns
 * (`aria-owns`) comes after all else, as WebKit puts it.
 */
function declared(this: Element, textLeftOut: boolean, ...children: ChildNode[]) {
  if (this.nodeType !== 1) return { text: this.textContent ?? "" };
  // Ids name elements of the element's own tree: its document, or its shadow root.
  const scope = this.getRootNode() as Document | ShadowRoot;
  const ids = this.getAttribute("aria-describedby")?.split(/\s+/) ?? [];
  const described = ids.map((id) => scope.getElementById(id)?.textContent ?? "");
  let order: (number | string)[] | undefined;
  if (textLeftOut) {
    const items: (number | string)[] = [];
    let next = 0;
    const reached = new Set<number>();
    const place = (child: number) => {
      reached.add(child);
      while (reached.delete(next)) items.push(next++);
    };
    // Text the page lays out and leaves visible. It takes its style from its
    // parent in the composed tree: the slot it is assigned to, or the host
    // of a shadow root it lies in directly.
    const shown = (text: Text) => {
      const range = this.ownerDocument.createRange();
      range.selectNodeContents(text);
      const parent =
        text.assignedSlot ?? text.parentElement ?? (text.parentNode as ShadowRoot).host;
      return range.getClientRects().length > 0 && getComputedStyle(parent).visibility === "visible";
    };
    // An element's parent in the composed tree: the slot it is assigned to,
    // its parent, or the host of the shadow root it lies in directly.
    const up = (element: Element) =>
      element.assignedSlot ??
      element.parentElement ??
      (element.parentNode as ShadowRoot | null)?.host ??
      null;
    // Inert is what lies in an `inert` element, or outside an open modal
    // dialog, which leaves inert elements around it.
    const modal = this.ownerDocument.querySelector(":modal");
    const inertAt = (element: Element | null): boolean => {
      for (let at = element; at; at = up(at)) {
        if (at === modal) return false;
        if (at.hasAttribute("inert")) return true;
      }
      return modal !== null;
    };
    const hiddenAt = (element: Element | null): boolean => {
      for (let at = element; at; at = up(at))
        if (/^true$/i.test(at.getAttribute("aria-hidden") ?? "")) return true;
      return false;
    };
    // Elements that an element in the tree owns (`aria-owns`) are under it,
    // after its own content, rather than where the document has them. Ids
    // name elements of their own tree: their document, or their shadow root.
    const owners = new Map<Document | ShadowRoot, Set<string>>();
    const owned = (element: Element) => {
      if (element.id === "") return false;
      const root = element.getRootNode() as Document | ShadowRoot;
      let ids = owners.get(root);
      if (!ids) {
        const named = [...root.querySelectorAll("[aria-owns]")]
          .filter((owner) => !inertAt(owner) && !hiddenAt(owner))
          .flatMap((owner) => owner.getAttribute("aria-owns")!.split(/\s+/));
        ids = new Set(named);
        owners.set(root, ids);
      }
      return ids.has(element.id);
    };
    const visit = (node: ChildNode, inert: boolean) => {
      const child = children.indexOf(node);
      if (child >= 0) place(child);
      else if (node.nodeType === 3) {
        const text = node as Text;
        if (!inert && text.data.trim() && shown(text)) items.push(text.data);
      } else if (node.nodeType === 1) {
        const element = node as Element;
        // Hidden from assistive technology, all of it but what it owns away.
        if (/^true$/i.test(element.getAttribute("aria-hidden") ?? "")) return;
        const within = element !== modal && (inert || element.hasAttribute("inert"));
        // The composed tree: an open shadow root's nodes rather than the
        // host's, and the nodes assigned to a slot, or its own without any.
        const assigned =
          element instanceof HTMLSlotElement ? (element.assignedNodes() as ChildNode[]) : [];
        walk(assigned.length > 0 ? assigned : (element.shadowRoot ?? element).childNodes, within);
      }
    };
    const walk = (nodes: Iterable<ChildNode>, inert: boolean) => {
      for (const node of nodes)
        if (node.nodeType !== 1 || !owned(node as Element)) visit(node, inert);
    };
    walk((this.shadowRoot ?? this).childNodes, inertAt(this));
    // What the element owns is in its tree, out of an aria-hidden element
    // too, but stays inert inside an inert one.
    for (const id of this.getAttribute("aria-owns")?.split(/\s+/) ?? []) {
      const element = scope.getElementById(id);
      if (element) visit(element, inertAt(up(element)));
    }
    // Children the walk did not reach come last.
    for (let i = next; i < children.length; i++) items.push(i);
    order = items;
  }
  return {
    // In the order accessible descriptions are computed: the title counts when it is not the name.
    description:
      described.filter(Boolean).join(" ") ||
      this.getAttribute("aria-description") ||
      this.getAttribute("title") ||
      "",
    multiselectable: this.getAttribute("aria-multiselectable") ?? undefined,
    keyshortcuts: this.getAttribute("aria-keyshortcuts") ?? undefined,
    order,
  };
}

/** The nodes of the test's frame, in WebKit. */
async function webkitTree(context: BrowserCommandContext): Promise<Node[]> {
  const session = inspectorSession(context.page);
  const group = "herceg-accessibility";
  const properties = async (nodeId: number) =>
    (
      (await session.send("DOM.getAccessibilityPropertiesForNode", { nodeId })) as {
        properties: WebKitProperties;
      }
    ).properties;
  /** The lines' nodes for a node of WebKit's tree, and the remote object of its DOM node. */
  const convert = async (node: WebKitProperties): Promise<{ nodes: Node[]; objectId?: string }> => {
    if (!node.exists) return { nodes: [] };
    // An ignored node's children name its parent as theirs; a table's cells
    // are its rows' children and also its columns', which have no element of
    // their own: each node is written under the parent it names.
    const kids: { nodes: Node[]; objectId?: string }[] = [];
    for (const id of node.childNodeIds ?? []) {
      const child = await properties(id);
      if (node.ignored || child.parentNodeId === node.nodeId) kids.push(await convert(child));
    }
    const { object } = (await session.send("DOM.resolveNode", {
      nodeId: node.nodeId,
      objectGroup: group,
    })) as { object: { objectId: string } };
    const { result } = (await session.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration: declared.toString(),
      arguments: [
        { value: TEXT_LEFT_OUT },
        ...kids.map(({ objectId }) => (objectId ? { objectId } : { value: null })),
      ],
      returnByValue: true,
    })) as { result: { value: ReturnType<typeof declared> } };
    const dom = result.value;
    const children =
      "order" in dom && dom.order
        ? dom.order.flatMap((item) =>
            typeof item === "number"
              ? kids[item]!.nodes
              : [{ role: "StaticText", name: item, states: {}, children: [] }],
          )
        : kids.flatMap(({ nodes }) => nodes);
    if (node.ignored) return { nodes: children, objectId: object.objectId };
    return { nodes: [fromWebKit(node, dom, children)], objectId: object.objectId };
  };
  const body = await (await context.frame()).evaluateHandle(() => document.body);
  try {
    await session.send("DOM.getDocument");
    const { nodeId } = (await session.send("DOM.requestNode", {
      objectId: objectId(body, context.page),
    })) as { nodeId: number };
    return (await convert(await properties(nodeId))).nodes;
  } finally {
    await body.dispose();
    await session.send("Runtime.releaseObjectGroup", { objectGroup: group });
  }
}

function fromWebKit(
  node: WebKitProperties,
  dom: ReturnType<typeof declared>,
  children: Node[],
): Node {
  const states: Record<string, string> = {};
  if (node.pressed !== undefined) states.pressed = String(node.pressed);
  // WebKit reports `focused` on what can be focused only.
  if (node.focused !== undefined) states.focusable = "true";
  if (node.focused) states.focused = "true";
  if (node.liveRegionStatus && node.liveRegionStatus !== "off") {
    states.live = node.liveRegionStatus;
    if (node.liveRegionAtomic) states.atomic = "true";
  }
  const level = node.hierarchyLevel ?? node.headingLevel;
  if (level) states.level = String(level);
  if (node.expanded !== undefined) states.expanded = String(node.expanded);
  if (node.selected !== undefined) states.selected = String(node.selected);
  if (node.checked !== undefined) states.checked = node.checked;
  if (node.disabled) states.disabled = "true";
  if ("text" in dom) return { role: "StaticText", name: dom.text, states, children };
  if (dom.multiselectable) states.multiselectable = dom.multiselectable;
  if (dom.keyshortcuts) states.keyshortcuts = dom.keyshortcuts;
  const name = node.label || (CONTENT_NAMED.has(node.role) ? content(children) : "");
  return {
    role: node.role,
    name,
    ...(dom.description && dom.description !== name && { description: dom.description }),
    states,
    children,
  };
}

/** Roles named by their content where nothing else names them (WAI-ARIA 1.2), which WebKit leaves to its children. */
const CONTENT_NAMED = new Set(["cell", "columnheader", "gridcell", "row", "rowheader", "menuitem"]);

/** What the nodes say, as names from content run on: their names, or what their children say. */
function content(nodes: readonly Node[]): string {
  return nodes
    .map((node) => node.name || content(node.children))
    .filter(Boolean)
    .join(" ");
}
