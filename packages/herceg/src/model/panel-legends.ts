// Legends of subplots: what each panel draws, what the legends of a panel
// list there (which the chart's legend leaves to them), and how entries
// look where panels show or hide series of their own. Loaded with subplots
// (model/panels.ts), which hand it to the guide compiler's legends.

import { ChartError } from "../spec/errors.ts";
import type { Theme } from "../theme.ts";
import type { LegendContent, LegendEntry, LegendPart } from "./legend.ts";

/** A mark, by its id or index, and the channel of a scale it owns. */
type Owned = readonly { mark: string | number; channel: string }[];

/** The marks owning each legend part (see `partOwners` in guides/legends.ts). */
export type PartOwners = ReadonlyMap<string, { owners: Owned }>;

/** How an entry is as panels' own visibility leaves it, where it is drawn. */
export type EntryState = "hidden" | "shown" | "mixed";

/** What a panel of subplots draws, as its legends list it. */
interface PanelTargets {
  /** The keys of its series (or a layout mark's items), by their entries' keys. */
  members: Map<string, string[]>;
  /**
   * The keys of every series it draws, of marks its legends leave out
   * (`legend: false`) too, which custom entries may name; not of marks of
   * every panel, which follow the chart's visibility.
   */
  series: Set<string>;
  /**
   * What each entry toggles there, by its key: what its series stand for,
   * or a series' own key where it stands for nothing (the entry's key).
   */
  targets: Map<string, readonly string[]>;
  /** The marks drawing each entry's series there. */
  marks: Map<string, (string | number)[]>;
  /** Every mark drawn there but marks of every panel, which are the chart's legend's alone. */
  drawn: Set<string | number>;
  /** The keys of the legend parts (a map's color ramp) of the layout mark drawn there. */
  parts: Set<string>;
  /** The entries of the layout mark drawn there, under their identities' keys, for swatches. */
  also: LegendEntry[];
}

/** The legends of one scene of a chart of subplots. */
export class PanelLegends {
  readonly #content: LegendContent;
  readonly #panels = new Map<string, PanelTargets>();
  /** The marks drawing each entry's series, and those owning each part, in any panel. */
  readonly #owners: ReadonlyMap<string, readonly (string | number)[]>;
  readonly #partsOf: PartOwners;
  /** Marks of every panel, which follow the chart's visibility in each. */
  readonly #everywhere: ReadonlySet<string | number>;
  /** What panels' legends list, by panel. */
  readonly #covered = new Map<string, Set<string>>();

  constructor(
    content: LegendContent,
    owners: ReadonlyMap<string, readonly (string | number)[]>,
    partsOf: PartOwners,
    theme: Theme,
    locale: string | undefined,
  ) {
    this.#content = content;
    this.#owners = owners;
    this.#partsOf = partsOf;
    const { split, color } = content;
    const groups = content.hidden.groups;
    const everywhere = new Set<string | number>();
    split?.keys.forEach((key, p) => {
      const members = new Map<string, string[]>();
      const keys = new Set<string>();
      const targets = new Map<string, readonly string[]>();
      const marks = new Map<string, (string | number)[]>();
      const drawn = new Set<string | number>();
      const parts = new Set<string>();
      const also: LegendEntry[] = [];
      // An entry toggles what its series stand for, where they stand for
      // something, in the panel, as the chart's toggle it in the chart:
      // their identity's key, which another spec of the same values keeps.
      const add = (entry: string, key: string, mark: string | number) => {
        const list = members.get(entry);
        if (list) list.push(key);
        else members.set(entry, [key]);
        keys.add(key);
        targets.set(entry, [entry]);
        const owners = marks.get(entry) ?? [];
        if (!owners.includes(mark)) marks.set(entry, [...owners, mark]);
      };
      const item = split.items?.[p];
      if (item && color) {
        // Its items' keys take its id or its place in the chart. As an
        // owner, beside marks along axes (known by their ids, or their
        // places among those from 0), an unnamed one goes by a negative
        // number, which no id or place is.
        const id = item.mark.spec.id ?? item.index;
        const owner = item.mark.spec.id ?? -1 - item.index;
        drawn.add(owner);
        for (const entry of item.mark.legend(id, color, theme)) {
          const identity = groups?.get(entry.key) ?? entry.key;
          add(identity, entry.key, owner);
          also.push({ ...entry, key: identity });
        }
        for (const part of item.mark.legends?.(theme, locale) ?? []) parts.add(part.key);
      } else
        split.panels[p]!.forEach(({ mark, series }, m) => {
          const id = mark.spec.id ?? m;
          // Marks of every panel are the chart's legend's alone.
          if (mark.spec.panel === "*") everywhere.add(id);
          if (split.members?.[p]?.[m] === false || mark.spec.panel === "*") return;
          for (const s of series) keys.add(s.key);
          if (mark.spec.legend === false) return;
          drawn.add(id);
          for (const s of series) add(s.entry ?? s.key, s.key, id);
        });
      this.#panels.set(key, { members, series: keys, targets, marks, drawn, parts, also });
    });
    this.#everywhere = everywhere;
  }

  /** Throws unless the chart has panel `panel`, which the legend at `path` names. */
  check(panel: string, path: string): void {
    if (this.#panels.has(panel)) return;
    throw new ChartError({
      code: "unknown-reference",
      path: `${path}.panel`,
      message: `${path}.panel: no panel "${panel}"; name one of ${[...this.#panels.keys()].map((key) => `"${key}"`).join(", ")}`,
    });
  }

  /**
   * What the legend of panel `panel` lists: the entries of what the panel
   * draws, and of `parts` those of the marks drawn there, that `shows`
   * keeps of the scales their marks own; which the chart's legend then
   * leaves to it there. A legend of entries of its own (`custom`, the
   * series they target) covers those whose every series there it targets.
   */
  listed(
    panel: string,
    entries: readonly LegendEntry[],
    parts: readonly LegendPart[],
    shows: (owned: Owned) => boolean,
    custom?: ReadonlySet<string>,
  ): { entries: LegendEntry[]; parts: LegendPart[] } {
    const own = this.#panels.get(panel)!;
    const listed = {
      entries: entries.filter(
        ({ key }) =>
          own.targets.has(key) &&
          shows(own.marks.get(key)!.map((mark) => ({ mark, channel: "series" }))) &&
          (!custom || own.members.get(key)!.every((series) => custom.has(series))),
      ),
      parts: parts.filter(
        ({ key }) =>
          own.parts.has(key) ||
          !!this.#partsOf.get(key)?.owners.some(({ mark }) => own.drawn.has(mark)),
      ),
    };
    const covered = this.#covered.get(panel) ?? new Set<string>();
    for (const { key } of [...listed.entries, ...listed.parts]) covered.add(key);
    this.#covered.set(panel, covered);
    return listed;
  }

  /**
   * Of the chart's legend's entries and parts, those the legends of panels
   * leave to it: drawn in no panel, by a mark of every panel, or in a panel
   * whose legends do not list them.
   */
  uncovered(
    entries: readonly LegendEntry[],
    parts: readonly LegendPart[],
  ): { entries: LegendEntry[]; parts: LegendPart[] } {
    if (this.#covered.size === 0) return { entries: [...entries], parts: [...parts] };
    const left = (
      key: string,
      owners: readonly (string | number)[] | undefined,
      inPanel: (panel: PanelTargets) => boolean,
    ) => {
      const drawnIn = [...this.#panels].filter(([, drawn]) => inPanel(drawn));
      return (
        drawnIn.length === 0 ||
        !!owners?.some((mark) => this.#everywhere.has(mark)) ||
        drawnIn.some(([panel]) => !this.#covered.get(panel)?.has(key))
      );
    };
    return {
      entries: entries.filter(({ key }) =>
        left(key, this.#owners.get(key), (p) => p.targets.has(key)),
      ),
      parts: parts.filter(({ key }) => {
        const marks = this.#partsOf.get(key)?.owners.map(({ mark }) => mark) ?? [];
        return left(key, marks, (p) => p.parts.has(key) || marks.some((mark) => p.drawn.has(mark)));
      }),
    };
  }

  /**
   * How a legend shows `entries`: for panel `panel`'s, hidden where every
   * one of their series is there, toggling their series there; for the
   * chart's, as panels' own visibility leaves them (hidden, or shown in
   * some panels and hidden in others), and undefined where no panel shows
   * or hides series of its own. With `custom` entries, whether a series
   * they name is hidden: in the panel, or in every panel drawing it.
   */
  shown(
    panel: string | undefined,
    entries: readonly LegendEntry[],
    custom: boolean,
  ):
    | {
        entries: LegendEntry[];
        hidden: ReadonlySet<string>;
        hides: ((key: string) => boolean) | undefined;
        targets: ReadonlyMap<string, readonly string[]> | undefined;
        /** For a panel's legend, the marks drawn there, whose looks its swatches draw. */
        drawn?: ReadonlySet<string | number>;
        also?: readonly LegendEntry[];
      }
    | undefined {
    const hides = custom ? this.#hides(panel) : undefined;
    if (panel !== undefined) {
      const own = this.#panels.get(panel)!;
      return {
        entries: [...entries],
        hidden: this.#hiddenIn(panel, entries),
        hides,
        targets: own.targets,
        drawn: own.drawn,
        also: own.also,
      };
    }
    if (!this.#content.hidden.panels?.size) return undefined;
    const states = this.#states(entries);
    return {
      entries: entries.map((entry) => ({ ...entry, mixed: states.get(entry.key) === "mixed" })),
      hidden: new Set(entries.flatMap(({ key }) => (states.get(key) === "hidden" ? [key] : []))),
      hides,
      targets: undefined,
    };
  }

  /** Each of the chart's entries as panels' own visibility leaves it, by key. */
  #states(entries: readonly LegendEntry[]): Map<string, EntryState> {
    const { hidden } = this.#content;
    return new Map(
      entries.map(({ key }) => {
        let shown = false;
        let hiddenSome = false;
        for (const [panel, { members }] of this.#panels)
          for (const target of members.get(key) ?? [])
            if (hidden.hiddenIn!(target, panel)) hiddenSome = true;
            else shown = true;
        // Drawn by a mark of every panel, or by none of the panels: as in the chart.
        if (
          (!shown && !hiddenSome) ||
          this.#owners.get(key)?.some((mark) => this.#everywhere.has(mark))
        )
          if (hidden.has(key)) hiddenSome = true;
          else shown = true;
        return [key, shown && hiddenSome ? "mixed" : hiddenSome ? "hidden" : "shown"];
      }),
    );
  }

  /** The keys of panel `panel`'s legend's entries hidden there: those whose every series is. */
  #hiddenIn(panel: string, entries: readonly LegendEntry[]): Set<string> {
    const own = this.#panels.get(panel)!;
    const { hidden } = this.#content;
    return new Set(
      entries.flatMap(({ key }) =>
        (own.members.get(key) ?? []).every((target) => hidden.hiddenIn!(target, panel))
          ? [key]
          : [],
      ),
    );
  }

  /**
   * Whether a series a legend's own entries name is hidden: in its panel
   * `panel`, or for the chart's legend in every panel drawing it.
   */
  #hides(panel: string | undefined): (key: string) => boolean {
    const { hidden } = this.#content;
    if (panel !== undefined) return (key) => hidden.hiddenIn!(key, panel);
    return (key) => {
      let drawn = false;
      for (const [panel, { series }] of this.#panels)
        if (series.has(key)) {
          if (!hidden.hiddenIn!(key, panel)) return false;
          drawn = true;
        }
      return drawn || hidden.has(key);
    };
  }
}
