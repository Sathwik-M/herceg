// Runtime checks of chart specs written outside TypeScript (the Python
// package, stored JSON), where the type checker cannot help: structure,
// enumerations, booleans, finite numbers, and field references. Errors name
// the offending property by its path and say what was expected, as in
// `marks[2].inner: expected "box", "quartiles", or "none"; received "quart"`.
// Properties the format does not have are refused by default, naming the
// property meant where one is close, so misspellings do not go unnoticed.

import { checkBins } from "../data/bins.ts";
import { areaFormError } from "../marks/area.ts";
import { boxPlotFormError } from "../marks/boxplot-input.ts";
import { contourFormError } from "../marks/contour-input.ts";
import { checkLeaves, checkLinkage } from "../marks/dendrogram-data.ts";
import { errorBarForm } from "../marks/errorbar.ts";
import { heatmapFormError } from "../marks/heatmap.ts";
import { histogramFormError, perAxisBins } from "../marks/histogram-input.ts";
import { regionFormError } from "../marks/region.ts";
import { ruleFormError } from "../marks/rule.ts";
import { treeFormError } from "../marks/tree-data.ts";
import { checkBreaks } from "../scale/breaks.ts";
import {
  type AnimationSpec,
  type AxisSpec,
  type BinaryColumnSpec,
  type CameraSpec,
  type CategoryColumnSpec,
  type ChartAxisSpec,
  type ChartSpec,
  type ColumnsSpec,
  type DerivedSpec,
  type GeometryColumnSpec,
  type GridFacetSpec,
  type GridSpec,
  type InsidePlace,
  type InteractionSpec,
  type LegendSpec,
  type MarkSpec,
  type NavigatorSpec,
  type PanelSpec,
  type PanelTitleSpec,
  type PlotStyle,
  type ProjectionSpec,
  type RowSelectionSpec,
  type SidePlace,
  SPEC_VERSION,
  type StrokeStyle,
  type StyleRoles,
  type TextBox,
  type TextStyle,
  type ThemeSpec,
  type ThemeTokens,
  type TimeColumnSpec,
  type TitleSpec,
  type TooltipSpec,
  type WrappedFacetSpec,
  type XAxisSpec,
} from "./spec.ts";

type Check = (value: unknown, path: string) => void;

/** Every property of any form of `T`. */
type AllKeys<T> = T extends unknown ? keyof T : never;
/**
 * A check for each property of `T`, so that adding a property to a spec
 * without checking it here fails to compile.
 */
type ChecksOf<T> = Record<AllKeys<T>, Check>;

/** A property no check knows, with the properties its object may have. */
export interface UnknownProperty {
  path: string;
  known: readonly string[];
}

/** The properties no check knows, collected while `checkSpec` runs. */
let unknownPaths: UnknownProperty[] | undefined;

function fail(path: string, expected: string, value: unknown): never {
  throw new TypeError(`${path}: expected ${expected}; received ${describe(value)}`);
}

/** Choices in prose: "a", "a or b", or "a, b, or c". */
export function either(choices: readonly string[]): string {
  if (choices.length < 3) return choices.join(" or ");
  return `${choices.slice(0, -1).join(", ")}, or ${choices.at(-1)}`;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string")
    return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}…` : value);
  if (typeof value === "object") return "an object";
  return String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const string: Check = (v, path) => {
  if (typeof v !== "string") fail(path, "a string", v);
};
const field: Check = (v, path) => {
  if (typeof v !== "string") fail(path, "a field name", v);
};
const integer: Check = (v, path) => {
  if (!Number.isInteger(v)) fail(path, "a whole number", v);
};
const group: Check = (v, path) => {
  if (typeof v !== "string" || v === "") fail(path, "a legend group's name", v);
};
const fields: Check = (v, path) => {
  if (Array.isArray(v)) {
    if (v.length === 0) fail(path, "at least one field name", v);
    for (const [i, item] of v.entries()) field(item, `${path}[${i}]`);
  } else {
    field(v, path);
  }
};
const boolean: Check = (v, path) => {
  if (typeof v !== "boolean") fail(path, "true or false", v);
};
const finite: Check = (v, path) => {
  if (typeof v !== "number" || !Number.isFinite(v)) fail(path, "a finite number", v);
};
const positive: Check = (v, path) => {
  if (typeof v !== "number" || !(v > 0) || !Number.isFinite(v)) fail(path, "a positive number", v);
};
const count: Check = (v, path) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
    fail(path, "a whole number of at least 1", v);
};
/** Colors as a list, or a scheme's name (resolved when the spec is loaded). */
const ramp: Check = (v, path) => {
  if (typeof v === "string") return;
  strings(v, path);
};
/** Two finite numbers, the first below the second. */
const range: Check = (v, path) => {
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    !v.every((x) => typeof x === "number" && Number.isFinite(x)) ||
    !(v[0] < v[1])
  )
    fail(path, "two finite numbers, ascending", v);
};
/** A constant position or a field name. */
const position: Check = (v, path) => {
  if (typeof v !== "string" && (typeof v !== "number" || !Number.isFinite(v)))
    fail(path, "a finite number or a field name", v);
};
const width: Check = (v, path) => {
  if (typeof v !== "number" || !(v >= 0) || !Number.isFinite(v))
    fail(path, "a number of at least 0", v);
};
const fraction: Check = (v, path) => {
  if (typeof v !== "number" || !(v >= 0 && v <= 1)) fail(path, "a number from 0 to 1", v);
};
/** A number strictly between 0 and 1. */
const share: Check = (v, path) => {
  if (typeof v !== "number" || !(v > 0 && v < 1)) fail(path, "a number between 0 and 1", v);
};
const strings: Check = (v, path) => {
  if (!Array.isArray(v)) fail(path, "an array of strings", v);
  for (const [i, item] of v.entries()) string(item, `${path}[${i}]`);
};
const numbers: Check = (v, path) => {
  if (!Array.isArray(v)) fail(path, "an array of numbers", v);
  for (const [i, item] of v.entries()) finite(item, `${path}[${i}]`);
};
const dash: Check = (v, path) => {
  if (typeof v === "string") oneOf("-", "--", ":", "-.")(v, path);
  else numbers(v, path);
};
/** Rows by position: a buffer index, or a list of whole numbers from 0. */
const positions: Check = (v, path) => {
  if (typeof v === "number") {
    if (!Number.isInteger(v) || v < 0) fail(path, "a buffer index or a list of row positions", v);
    return;
  }
  if (!Array.isArray(v)) fail(path, "a buffer index or a list of row positions", v);
  for (const [i, item] of v.entries())
    if (!Number.isInteger(item) || item < 0)
      fail(`${path}[${i}]`, "a row position, 0 or more", item);
};
const object: Check = (v, path) => {
  if (!isRecord(v)) fail(path, "an object", v);
};

function oneOf(...values: readonly string[]): Check {
  return (v, path) => {
    if (!values.includes(v as string)) fail(path, either(values.map((x) => JSON.stringify(x))), v);
  };
}

/**
 * Checks the listed properties of `value` that are present, and notes any
 * property neither listed nor among `others`, which are checked elsewhere.
 */
function properties(
  value: Record<string, unknown>,
  path: string,
  checks: Record<string, Check>,
  others: readonly string[] = [],
) {
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(checks, key) && !others.includes(key))
      unknownPaths?.push({ path: `${path}.${key}`, known: [...Object.keys(checks), ...others] });
  }
  for (const [key, check] of Object.entries(checks)) {
    if (value[key] !== undefined) check(value[key], `${path}.${key}`);
  }
}

/** A property of `value` outside `known` that looks like a misspelling of `key`. */
function misspelling(
  value: Record<string, unknown>,
  key: string,
  known: readonly string[],
): string | undefined {
  return Object.keys(value).find((name) => !known.includes(name) && closest(name, [key]) === key);
}

/** The error for a missing `key`, naming its misspelling when there is one. */
function missing(path: string, key: string, typo: string | undefined): TypeError {
  return new TypeError(
    typo === undefined
      ? `${path}.${key}: required`
      : `${path}.${key}: required; rename "${typo}", which is not a property, to "${key}"`,
  );
}

/**
 * Refuses a value missing any of `keys`. With the properties it may have
 * (`known`), a missing key's misspelling among the others is named.
 */
function required(
  value: Record<string, unknown>,
  path: string,
  keys: readonly string[],
  known?: readonly string[],
) {
  for (const key of keys) {
    if (value[key] === undefined) throw missing(path, key, known && misspelling(value, key, known));
  }
}

/** Refuses an object missing any of `keys`, then checks its properties. */
function checkProperties(
  value: Record<string, unknown>,
  path: string,
  keys: readonly string[],
  checks: Record<string, Check>,
) {
  required(value, path, keys, Object.keys(checks));
  properties(value, path, checks);
}

const curve = oneOf("linear", "step", "step-before", "step-after", "monotone");

/** A portable expression: a literal, or an array of an operator and its operands. */
const expression: Check = (v, path) => {
  if (v === null || typeof v === "number" || typeof v === "string" || typeof v === "boolean")
    return;
  if (!Array.isArray(v) || typeof v[0] !== "string")
    fail(path, 'an expression: a literal or ["operator", ...operands]', v);
  for (let i = 1; i < v.length; i++) expression(v[i], `${path}[${i}]`);
};

const AGGREGATE_OPS = [
  "count",
  "sum",
  "mean",
  "median",
  "min",
  "max",
  "q1",
  "q3",
  "stdev",
  "variance",
  "distinct",
  "first",
  "last",
] as const;
const ROLLING_OPS = ["count", "sum", "mean", "min", "max", "stdev"] as const;

/** A list of operations, each `{ op, field?, as }`. */
function operations(ops: readonly string[], needsField: boolean): Check {
  return (v, path) => {
    if (!Array.isArray(v)) fail(path, "a list of operations", v);
    for (const [i, item] of v.entries()) {
      const at = `${path}[${i}]`;
      object(item, at);
      const operation = item as Record<string, unknown>;
      checkProperties(operation, at, needsField ? ["op", "field", "as"] : ["op", "as"], {
        op: oneOf(...ops),
        field,
        as: field,
      });
    }
  };
}

/** Bins along one axis: a count, `{ step, start }`, or edges. */
const binSpec: Check = (v, path) => {
  if (typeof v === "number" || Array.isArray(v)) {
    checkBins(v, path);
    return;
  }
  if (!isRecord(v)) fail(path, "a bin count, { step, start }, or a list of edges", v);
  checkProperties(v, path, ["step"], { step: positive, start: finite });
};

/** The keys a transform of each kind takes. */
const TRANSFORMS: Record<string, { required: string[]; checks: Record<string, Check> }> = {
  filter: { required: [], checks: { filter: expression } },
  calculate: { required: ["as"], checks: { calculate: expression, as: field } },
  bin: {
    required: [],
    checks: { bin: field, bins: binSpec, as: field, end: field },
  },
  aggregate: {
    required: [],
    checks: { aggregate: operations(AGGREGATE_OPS, false), by: fields },
  },
  rolling: {
    required: ["size"],
    checks: { rolling: operations(ROLLING_OPS, true), size: count, by: fields },
  },
  sort: { required: [], checks: { sort: field, order: oneOf("ascending", "descending") } },
};

/** The steps of a derived table. */
const transforms: Check = (v, path) => {
  if (!Array.isArray(v)) fail(path, "a list of transforms", v);
  for (const [i, item] of v.entries()) {
    const at = `${path}[${i}]`;
    object(item, at);
    const step = item as Record<string, unknown>;
    const kind = Object.keys(TRANSFORMS).find((name) => step[name] !== undefined);
    if (!kind) fail(at, `a transform (${Object.keys(TRANSFORMS).join(", ")})`, item);
    const { required: keys, checks } = TRANSFORMS[kind]!;
    required(step, at, keys, Object.keys(checks));
    // A step naming two transforms is ambiguous; other keys are unknown.
    const other = Object.keys(step).find((key) => key !== kind && Object.hasOwn(TRANSFORMS, key));
    if (other) throw new TypeError(`${at}.${other}: a step is one transform, here ${kind}`);
    properties(step, at, checks);
  }
};

/** Options only number or only date formatting reads, to tell which a format is for. */
const NUMBER_FORMAT =
  /^(m(ax|in)imum|notation|style|currency|unit|compactDisplay|signDisplay|useGrouping|roundingMode)/;
const TIME_FORMAT =
  /^(year|month|day|hour|minute|second|weekday|era|timeZoneName|hour12|hourCycle|dateStyle|timeStyle|fractionalSecondDigits|dayPeriod)$/;

/** Checks an axis' Intl format options by constructing the formatter they are for. */
function format(type: unknown): Check {
  return (v, path) => {
    object(v, path);
    const keys = Object.keys(v as object);
    const time =
      type === "time" || (type === undefined && keys.some((key) => TIME_FORMAT.test(key)));
    const number =
      type !== "time" && (type !== undefined || keys.some((key) => NUMBER_FORMAT.test(key)));
    try {
      if (time) new Intl.DateTimeFormat(undefined, v as Intl.DateTimeFormatOptions);
      if (number) new Intl.NumberFormat(undefined, v as Intl.NumberFormatOptions);
    } catch (error) {
      throw new TypeError(`${path}: ${(error as Error).message}`);
    }
    // Intl ignores options it does not know, so misspelled ones are noted here.
    // Without an axis type, either kind of option may be meant.
    const known = [
      ...(type !== "linear" && type !== "log" ? TIME_OPTIONS : []),
      ...(type !== "time" ? NUMBER_OPTIONS : []),
    ];
    for (const key of keys)
      if (!known.includes(key)) unknownPaths?.push({ path: `${path}.${key}`, known });
  };
}

const NUMBER_OPTIONS = [
  "localeMatcher",
  "numberingSystem",
  "style",
  "currency",
  "currencyDisplay",
  "currencySign",
  "unit",
  "unitDisplay",
  "notation",
  "compactDisplay",
  "signDisplay",
  "useGrouping",
  "minimumIntegerDigits",
  "minimumFractionDigits",
  "maximumFractionDigits",
  "minimumSignificantDigits",
  "maximumSignificantDigits",
  "roundingMode",
  "roundingPriority",
  "roundingIncrement",
  "trailingZeroDisplay",
];
const TIME_OPTIONS = [
  "localeMatcher",
  "numberingSystem",
  "calendar",
  "timeZone",
  "hour12",
  "hourCycle",
  "formatMatcher",
  "dateStyle",
  "timeStyle",
  "weekday",
  "era",
  "year",
  "month",
  "day",
  "dayPeriod",
  "hour",
  "minute",
  "second",
  "fractionalSecondDigits",
  "timeZoneName",
];

/** The checks of an axis' options. */
function axisChecks(spec: Record<string, unknown>): ChecksOf<AxisSpec> {
  return {
    type: oneOf("linear", "log", "time"),
    domain: (d, p) => {
      numbers(d, p);
      if ((d as unknown[]).length !== 2) fail(p, "two numbers", d);
    },
    nice: boolean,
    zero: boolean,
    title: string,
    grid: boolean,
    ticks: positive,
    format: format(spec.type),
    tooltipFormat: format(spec.type),
    show: boolean,
    style: axisStyle,
  };
}

/** Which panels share a scale. */
const scope = oneOf("chart", "panel", "row", "column");

/**
 * A y axis (`chart`, the chart's y or yRight, whose scale panels may share),
 * or a panel's or a 3D chart's axis.
 */
function anyAxis(v: unknown, path: string, chart: boolean): void {
  object(v, path);
  const spec = v as Record<string, unknown>;
  // Only the x axis has breaks: refuse them elsewhere rather than ignore them.
  if (spec.breaks !== undefined)
    fail(`${path}.breaks`, "breaks on the chart's x axis only", spec.breaks);
  if (spec.seams !== undefined)
    fail(`${path}.seams`, "seams on the chart's x axis only", spec.seams);
  if (chart)
    properties(spec, path, { ...axisChecks(spec), scope } satisfies ChecksOf<ChartAxisSpec>);
  else {
    if (spec.scope !== undefined)
      fail(`${path}.scope`, "scope on the chart's x, y, or yRight only", spec.scope);
    properties(spec, path, axisChecks(spec));
  }
}

const axis: Check = (v, path) => anyAxis(v, path, false);
const chartAxis: Check = (v, path) => anyAxis(v, path, true);

const xAxis: Check = (v, path) => {
  object(v, path);
  const spec = v as Record<string, unknown>;
  properties(spec, path, {
    ...axisChecks(spec),
    scope,
    // Whether any x scale is a time scale shows only once panels are planned.
    breaks: (v, at) => {
      checkBreaks(v, at);
      // Each break is of one kind, whose keys are the only ones it takes.
      for (const [i, rule] of (v as Record<string, unknown>[]).entries()) {
        const kind = ["weekdays", "hours", "dates"].find((key) => rule[key] !== undefined);
        properties(rule, `${at}[${i}]`, {}, kind ? [kind] : ["from", "to"]);
      }
    },
    seams: (v, at) => {
      if (typeof v !== "boolean") {
        object(v, at);
        properties(v as Record<string, unknown>, at, { minSpacing: positive });
      }
      if (v !== false && spec.breaks === undefined)
        fail(at, "time-axis breaks when seams are enabled", v);
    },
  } satisfies ChecksOf<XAxisSpec>);
};

const THEMES = ["light", "dark", "high-contrast", "high-contrast-dark", "auto"];

/** Space around a box: one number of pixels, or one per side. */
const insets: Check = (v, path) => {
  if (typeof v === "number") return width(v, path);
  object(v, path);
  properties(v as Record<string, unknown>, path, {
    top: width,
    right: width,
    bottom: width,
    left: width,
  });
};

const halo: Check = (v, path) => {
  if (v === false || v === "auto") return;
  if (!isRecord(v)) fail(path, '"auto", false, or an object with a color', v);
  checkProperties(v, path, ["color"], { color: string, width, opacity: fraction });
};

const textBox: Check = (v, path) => {
  if (v === false) return;
  if (!isRecord(v)) fail(path, "false or an object with fill", v);
  checkProperties(v, path, ["fill"], {
    fill: string,
    stroke: string,
    strokeWidth: width,
    radius: width,
  } satisfies ChecksOf<TextBox>);
};

const textStyle: Check = (v, path) => {
  object(v, path);
  properties(v as Record<string, unknown>, path, {
    font: string,
    fontSize: positive,
    fontWeight: (w, at) => {
      if (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > 1000)
        fail(at, "a whole number from 1 to 1000, such as 400 or 600", w);
    },
    fontStyle: oneOf("normal", "italic"),
    color: string,
    opacity: fraction,
    lineHeight: positive,
    align: oneOf("start", "center", "end"),
    halo,
    background: textBox,
    padding: insets,
  } satisfies ChecksOf<TextStyle>);
};

const strokeChecks = {
  stroke: string,
  strokeWidth: width,
  dash,
  opacity: fraction,
} satisfies ChecksOf<StrokeStyle>;

const strokeStyle: Check = (v, path) => {
  object(v, path);
  properties(v as Record<string, unknown>, path, strokeChecks);
};

/** The checks of each style role. */
const ROLES = {
  text: textStyle,
  title: textStyle,
  panelTitle: textStyle,
  axisTitle: textStyle,
  tickLabel: textStyle,
  legendLabel: textStyle,
  legendTitle: textStyle,
  plot: (v, path) => {
    object(v, path);
    properties(v as Record<string, unknown>, path, {
      fill: string,
      stroke: string,
      strokeWidth: width,
    } satisfies ChecksOf<PlotStyle>);
  },
  grid: strokeStyle,
  axisLine: strokeStyle,
  tick: strokeStyle,
  line: (v, path) => {
    object(v, path);
    properties(v as Record<string, unknown>, path, { strokeWidth: positive });
  },
  bar: (v, path) => {
    object(v, path);
    properties(v as Record<string, unknown>, path, { radius: width });
  },
  tooltip: (v, path) => {
    object(v, path);
    properties(v as Record<string, unknown>, path, { fill: string, stroke: string });
  },
} satisfies ChecksOf<StyleRoles>;

/** Styles of `roles` only: a guide's or a panel's, which style what it draws. */
function rolesOf<K extends keyof StyleRoles>(roles: readonly K[]): Check {
  const checks = Object.fromEntries(roles.map((role) => [role, ROLES[role]])) as Record<K, Check>;
  return (v, path) => {
    object(v, path);
    properties(v as Record<string, unknown>, path, checks);
  };
}

const AXIS_ROLES = ["axisLine", "tick", "tickLabel", "axisTitle", "grid"] as const;
const axisStyle = rolesOf(AXIS_ROLES);

const theme: Check = (v, path) => {
  if (typeof v === "string") return oneOf(...THEMES)(v, path);
  object(v, path);
  properties(v as Record<string, unknown>, path, {
    extends: oneOf(...THEMES),
    tokens: (t, at) => {
      object(t, at);
      properties(t as Record<string, unknown>, at, {
        background: string,
        text: string,
        muted: string,
        grid: string,
        axis: string,
        palette: strings,
        sequential: strings,
        diverging: strings,
        rise: string,
        fall: string,
      } satisfies ChecksOf<ThemeTokens>);
    },
    style: (r, at) => {
      object(r, at);
      properties(r as Record<string, unknown>, at, ROLES);
    },
  } satisfies ChecksOf<ThemeSpec>);
};

const sides = oneOf("top", "right", "bottom", "left");

/** Where a guide goes: on a side outside the plots, or inside a plot. */
const place: Check = (v, path) => {
  object(v, path);
  const spec = v as Record<string, unknown>;
  const where = { scope: oneOf("chart", "panel"), panel: string };
  if (spec.inside !== undefined) {
    if (spec.side !== undefined) fail(path, "side or inside, not both", v);
    properties(spec, path, {
      inside: oneOf(
        "top-left",
        "top",
        "top-right",
        "right",
        "bottom-right",
        "bottom",
        "bottom-left",
        "left",
      ),
      inset: width,
      ...where,
    } satisfies ChecksOf<InsidePlace>);
    return;
  }
  checkProperties(spec, path, ["side"], {
    side: sides,
    align: oneOf("start", "center", "end"),
    offset: width,
    ...where,
  } satisfies ChecksOf<SidePlace>);
};

/** A chart's title: its text, or its text with its place and style. */
const title: Check = (v, path) => {
  if (typeof v === "string") return;
  if (!isRecord(v)) fail(path, "a string or an object with text", v);
  checkProperties(v, path, ["text"], {
    text: string,
    place: (p, at) => {
      object(p, at);
      checkProperties(p as Record<string, unknown>, at, ["side"], {
        side: oneOf("top", "bottom"),
      });
    },
    style: textStyle,
  } satisfies ChecksOf<TitleSpec>);
};

const panelTitle: Check = (v, path) => {
  if (typeof v === "string") return;
  if (!isRecord(v)) fail(path, "a string or an object with text", v);
  checkProperties(v, path, ["text"], {
    text: string,
    style: textStyle,
  } satisfies ChecksOf<PanelTitleSpec>);
};

const legend: Check = (v, path) => {
  if (typeof v === "boolean") return;
  if (!isRecord(v)) fail(path, "true, false, or an object", v);
  properties(v, path, {
    place,
    style: rolesOf(["legendLabel", "legendTitle", "tickLabel"]),
  } satisfies ChecksOf<LegendSpec>);
};

/** A tree's fields: a path of category fields, or node and parent fields. */
function hierarchyChecks(): Record<
  "path" | "node" | "parent" | "value" | "labels" | "panel",
  Check
> {
  return {
    panel: string,
    path: (v, path) => {
      if (!Array.isArray(v) || v.length === 0) fail(path, "a list of at least one field", v);
      for (const [i, item] of (v as unknown[]).entries()) field(item, `${path}[${i}]`);
    },
    node: field,
    parent: field,
    value: field,
    labels: boolean,
  };
}

/** Properties `mark` checks for every mark. */
type CommonKey = "type" | "data" | "id";

/** Placement properties of the marks whose specs have them. */
const side = oneOf("left", "right");
const repeat = oneOf("repeat");
/** What a mark's drawing is cut to. */
const clip: Check = (v, path) => {
  if (v !== "plot" && v !== "chart" && v !== false) fail(path, '"plot", "chart", or false', v);
};
const placement = { axis: side, facet: repeat, panel: string, clip };

/** What a mark's tooltips show of its rows: fields, by name or with a label and format. */
const tooltip: Check = (v, path) => {
  object(v, path);
  properties(v as Record<string, unknown>, path, {
    fields: (list, at) => {
      if (!Array.isArray(list)) fail(at, "an array of fields", list);
      list.forEach((entry, i) => {
        if (typeof entry === "string") return;
        if (!isRecord(entry)) fail(`${at}[${i}]`, "a field name or an object", entry);
        checkProperties(entry, `${at}[${i}]`, ["field"], {
          field,
          label: string,
          format: format(undefined),
        });
      });
    },
  });
};

/**
 * The properties each mark takes, typed against its spec so that adding a
 * property to a spec without checking it here fails to compile.
 */
type MarkChecks = {
  [K in MarkSpec["type"]]: {
    required: AllKeys<Extract<MarkSpec, { type: K }>>[];
    checks: Record<Exclude<AllKeys<Extract<MarkSpec, { type: K }>>, CommonKey>, Check>;
  };
};

const MARKS: MarkChecks = {
  line: {
    required: ["x", "y"],
    checks: {
      tooltip,
      ...placement,
      x: fields,
      y: fields,
      orient: oneOf("x", "y"),
      series: field,
      dodge: boolean,
      stroke: string,
      strokeWidth: width,
      dash,
      curve,
      label: string,
      legendGroup: group,
    },
  },
  area: {
    required: [],
    checks: {
      tooltip,
      ...placement,
      x: fields,
      y: fields,
      y1: field,
      y2: field,
      x1: field,
      x2: field,
      orient: oneOf("x", "y"),
      series: field,
      dodge: boolean,
      stack: (v, path) => {
        if (typeof v !== "boolean" && v !== "fill" && v !== "center" && v !== "wiggle")
          throw new Error(
            `${path}: expected true, false, "fill", "center", or "wiggle"; choose a supported stack`,
          );
      },
      stackOrder: (v, path) => {
        if (v !== "input" && v !== "inside-out")
          throw new Error(`${path}: expected "input" or "inside-out"; choose a supported order`);
      },
      stackGaps: oneOf("zero", "interpolate"),
      fill: string,
      fillOpacity: fraction,
      line: boolean,
      stroke: string,
      strokeWidth: width,
      curve,
      label: string,
      legendGroup: group,
    },
  },
  dendrogram: {
    required: ["first", "second", "height", "leaves"],
    checks: {
      facet: repeat,
      panel: string,
      clip,
      first: field,
      second: field,
      height: field,
      leaves: (v, path) => {
        try {
          checkLeaves(v as string[]);
        } catch (error) {
          // The message names the leaves itself.
          throw new TypeError(
            `${path.slice(0, path.lastIndexOf("."))}: ${(error as Error).message}`,
          );
        }
      },
      side: oneOf("bottom", "top", "left", "right"),
      stroke: string,
      strokeWidth: width,
      label: string,
    },
  },
  rule: {
    required: [],
    checks: {
      ...placement,
      x: position,
      y: position,
      stroke: string,
      strokeWidth: width,
      dash,
      label: string,
      textField: field,
    },
  },
  region: {
    required: [],
    checks: {
      halo,
      ...placement,
      x1: position,
      x2: position,
      y1: position,
      y2: position,
      fill: string,
      fillOpacity: fraction,
      label: string,
      textField: field,
    },
  },
  text: {
    required: ["x", "y"],
    checks: {
      halo,
      ...placement,
      x: position,
      y: position,
      label: string,
      textField: field,
      fill: string,
      anchor: oneOf("start", "middle", "end"),
      overlap: oneOf("show", "hide", "move"),
      dx: finite,
      dy: finite,
    },
  },
  bar: {
    required: ["x", "y"],
    checks: {
      halo,
      tooltip,
      ...placement,
      x: fields,
      y: fields,
      series: field,
      stack: (v, path) => {
        if (typeof v !== "boolean" && v !== "fill")
          throw new Error(
            `${path}: expected true, false, or "fill"; use an area for "center" or "wiggle"`,
          );
      },
      fill: string,
      fillOpacity: fraction,
      label: string,
      labels: (v, path) => (typeof v === "boolean" ? undefined : format("linear")(v, path)),
      legendGroup: group,
    },
  },
  point: {
    required: ["x", "y"],
    checks: {
      tooltip,
      ...placement,
      x: field,
      y: field,
      series: field,
      animationKey: field,
      radius: positive,
      size: field,
      radiusRange: range,
      fill: string,
      fillOpacity: (v, path) => (typeof v === "string" ? field(v, path) : fraction(v, path)),
      stroke: string,
      strokeWidth: width,
      color: field,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      symbol: (v, path) => {
        if (typeof v === "string") return;
        if (!isRecord(v)) fail(path, 'a shape\'s name or { field: "..." }', v);
        checkProperties(v, path, ["field"], { field });
      },
      sampling: oneOf("none", "pixel"),
      label: string,
      legendGroup: group,
      dodge: boolean,
      jitter: (v, path) => {
        object(v, path);
        checkProperties(v as Record<string, unknown>, path, ["width"], {
          width: fraction,
          seed: integer,
        });
      },
      swarm: boolean,
    },
  },
  histogram: {
    required: [],
    checks: {
      ...placement,
      x: field,
      y: field,
      bins: (v, path) => {
        if (!perAxisBins(v)) return binSpec(v, path);
        properties(v as Record<string, unknown>, path, { x: binSpec, y: binSpec });
      },
      series: field,
      weight: field,
      normalize: oneOf("count", "frequency", "probability", "percent", "density"),
      stack: (v, path) => {
        if (typeof v !== "boolean" && v !== "fill") fail(path, 'true, false, or "fill"', v);
      },
      commonNorm: boolean,
      cumulative: boolean,
      dodge: boolean,
      element: oneOf("bars", "step", "poly"),
      fill: string,
      fillOpacity: fraction,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      label: string,
      legendGroup: group,
    },
  },
  treemap: { required: [], checks: hierarchyChecks() },
  sunburst: { required: [], checks: hierarchyChecks() },
  sankey: {
    required: ["source", "target"],
    checks: {
      halo,
      panel: string,
      source: field,
      target: field,
      value: field,
      labels: boolean,
      nodeWidth: positive,
      sort: oneOf("input", "value"),
    },
  },
  graph: {
    required: ["source", "target"],
    checks: {
      halo,
      source: field,
      target: field,
      value: field,
      directed: boolean,
      linkLabelField: field,
      nodes: string,
      node: field,
      color: field,
      size: field,
      labels: boolean,
      layout: (v, path) => {
        const types = oneOf("force", "circular", "layered");
        if (typeof v === "string") return types(v, path);
        object(v, path);
        const layout = v as Record<string, unknown>;
        types(layout.type, `${path}.type`);
        checkProperties(layout, path, ["type"], {
          type: string,
          ...(layout.type === "force" && { settle: boolean }),
          ...(layout.type === "circular" && { sort: oneOf("degree", "input", "name") }),
          ...(layout.type === "layered" && { direction: oneOf("down", "right", "up", "left") }),
        });
      },
      panel: string,
    },
  },
  pie: {
    required: ["category"],
    checks: {
      panel: string,
      category: field,
      value: field,
      innerRadius: (v, path) => {
        if (typeof v !== "number" || !(v >= 0 && v < 1))
          fail(path, "a fraction at least 0 and below 1", v);
      },
      sort: oneOf("value", "input"),
      labels: boolean,
    },
  },
  gauge: {
    required: ["value"],
    checks: {
      panel: string,
      value: field,
      min: finite,
      max: finite,
      bands: (v, path) => {
        if (!Array.isArray(v)) fail(path, "a list of bands", v);
        // Bands must also lie within the dial, which the mark checks.
        let previous = Number.NEGATIVE_INFINITY;
        for (const [i, item] of v.entries()) {
          const at = `${path}[${i}]`;
          object(item, at);
          const band = item as Record<string, unknown>;
          checkProperties(band, at, ["to"], { to: finite, color: string });
          const to = band.to as number;
          if (!(to > previous))
            fail(`${at}.to`, `an end above the previous band's (${previous})`, to);
          previous = to;
        }
      },
      label: string,
      format: format("linear"),
    },
  },
  funnel: {
    required: ["category"],
    checks: {
      halo,
      panel: string,
      category: field,
      value: field,
      sort: oneOf("input", "value"),
      labels: boolean,
    },
  },
  radar: {
    required: [],
    checks: {
      halo,
      panel: string,
      category: field,
      value: field,
      fields: (v, path) => {
        if (!Array.isArray(v)) fail(path, "a list of field names", v);
        for (const [i, item] of v.entries()) field(item, `${path}[${i}]`);
      },
      series: field,
      domain: range,
      fillOpacity: fraction,
      points: boolean,
      label: string,
    },
  },
  boxplot: {
    required: [],
    checks: {
      ...placement,
      x: field,
      y: field,
      low: field,
      q1: field,
      median: field,
      q3: field,
      high: field,
      count: field,
      whiskers: (v, path) => {
        if (v === "tukey" || v === "range") return;
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
          fail(path, '"tukey", "range", or a finite nonnegative IQR multiple', v);
      },
      notch: boolean,
      outliers: boolean,
      series: field,
      fill: string,
      fillOpacity: fraction,
      label: string,
      legendGroup: group,
    },
  },
  boxen: {
    required: ["x", "y"],
    checks: {
      ...placement,
      x: field,
      y: field,
      series: field,
      depth: (v, path) => {
        if (["tukey", "proportion", "trustworthy", "full"].includes(v as string)) return;
        if (typeof v !== "number" || !Number.isInteger(v) || v < 1)
          fail(path, '"tukey", "proportion", "trustworthy", "full", or a whole number from 1', v);
      },
      outlierProportion: share,
      trustAlpha: share,
      widthMethod: oneOf("exponential", "linear", "area"),
      outliers: boolean,
      fill: string,
      fillOpacity: fraction,
      label: string,
      legendGroup: group,
    },
  },
  violin: {
    required: ["x", "y"],
    checks: {
      ...placement,
      x: field,
      y: field,
      series: field,
      split: boolean,
      inner: oneOf("box", "quartiles", "none"),
      bandwidth: positive,
      fill: string,
      fillOpacity: fraction,
      label: string,
      legendGroup: group,
    },
  },
  candlestick: {
    required: ["x", "open", "high", "low", "close"],
    checks: {
      tooltip,
      ...placement,
      x: field,
      open: field,
      high: field,
      low: field,
      close: field,
      variant: oneOf("candlestick", "ohlc"),
      rise: string,
      fall: string,
      label: string,
      legendGroup: group,
    },
  },
  rug: {
    required: [],
    checks: {
      tooltip,
      ...placement,
      x: field,
      y: field,
      series: field,
      length: positive,
      side: oneOf("bottom", "top", "left", "right"),
      stroke: string,
      strokeWidth: width,
      label: string,
      legendGroup: group,
    },
  },
  errorbar: {
    required: [],
    checks: {
      tooltip,
      ...placement,
      x: field,
      y: field,
      x1: field,
      x2: field,
      y1: field,
      y2: field,
      xError: field,
      yError: field,
      series: field,
      stroke: string,
      strokeWidth: width,
      cap: width,
      label: string,
      legendGroup: group,
      dodge: boolean,
    },
  },
  geoshape: {
    required: [],
    checks: {
      tooltip,
      geometry: field,
      labelField: field,
      color: field,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      fill: string,
      fillOpacity: fraction,
      stroke: string,
      strokeWidth: width,
      label: string,
      facet: repeat,
      panel: string,
    },
  },
  geopoint: {
    required: ["longitude", "latitude"],
    checks: {
      tooltip,
      longitude: field,
      latitude: field,
      labelField: field,
      series: field,
      radius: positive,
      size: field,
      radiusRange: range,
      color: field,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      fill: string,
      fillOpacity: fraction,
      stroke: string,
      strokeWidth: width,
      label: string,
      facet: repeat,
      panel: string,
    },
  },
  heatmap: {
    required: ["color"],
    checks: {
      tooltip,
      ...placement,
      x: field,
      y: field,
      x1: field,
      x2: field,
      y1: field,
      y2: field,
      date: field,
      calendar: oneOf("weeks", "months"),
      weekStart: oneOf("sun", "mon", "tue", "wed", "thu", "fri", "sat"),
      color: field,
      xStep: positive,
      yStep: positive,
      xBanded: boolean,
      yBanded: boolean,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      reduce: oneOf("last", "mean", "sum", "min", "max"),
      sampling: (v, path) => {
        object(v, path);
        properties(v as Record<string, unknown>, path, { reduce: oneOf("mean", "max", "min") });
      },
      label: string,
    },
  },
  contour: {
    required: ["x", "y", "color"],
    checks: {
      ...placement,
      x: field,
      y: field,
      color: field,
      thresholds: (v, path) => {
        if (typeof v === "number") return count(v, path);
        numbers(v, path);
        const list = v as number[];
        for (let i = 1; i < list.length; i++)
          if (!(list[i]! > list[i - 1]!))
            fail(`${path}[${i}]`, `a value above ${list[i - 1]}, the one before`, list[i]);
      },
      variant: oneOf("lines", "bands"),
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      stroke: string,
      strokeWidth: width,
      fillOpacity: fraction,
      label: string,
    },
  },
  point3d: {
    required: ["x", "y", "z"],
    checks: {
      panel: string,
      tooltip,
      x: field,
      y: field,
      z: field,
      series: field,
      labelField: field,
      radius: positive,
      color: field,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      fill: string,
      fillOpacity: fraction,
      label: string,
    },
  },
  line3d: {
    required: ["x", "y", "z"],
    checks: {
      panel: string,
      tooltip,
      x: field,
      y: field,
      z: field,
      series: field,
      stroke: string,
      strokeWidth: positive,
      label: string,
    },
  },
  surface: {
    required: ["x", "y", "z"],
    checks: {
      panel: string,
      x: field,
      y: field,
      z: field,
      color: field,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      fillOpacity: fraction,
      shading: boolean,
      wireframe: boolean,
      label: string,
    },
  },
};

const camera: Check = (v, path) => {
  object(v, path);
  properties(v as Record<string, unknown>, path, {
    azimuth: finite,
    elevation: (e, at) => {
      if (typeof e !== "number" || !(e >= -90 && e <= 90)) fail(at, "degrees from -90 to 90", e);
    },
    zoom: (z, at) => {
      if (typeof z !== "number" || !(z >= 0.5 && z <= 10)) fail(at, "a number from 0.5 to 10", z);
    },
    perspective: boolean,
  } satisfies ChecksOf<CameraSpec>);
};

/** Three positive numbers: the relative lengths of a 3D box's sides. */
const boxAspect: Check = (v, path) => {
  if (
    !Array.isArray(v) ||
    v.length !== 3 ||
    !v.every((x) => typeof x === "number" && x > 0 && Number.isFinite(x))
  )
    fail(path, "three positive numbers", v);
};

const PROJECTIONS = [
  "equal-earth",
  "natural-earth",
  "mercator",
  "equirectangular",
  "conic-equal-area",
] as const;
/** A longitude, latitude pair: within ±540 and ±90 degrees, as geometry is. */
const lonLat: Check = (v, path) => {
  if (
    !Array.isArray(v) ||
    v.length !== 2 ||
    !v.every((x) => typeof x === "number" && Number.isFinite(x)) ||
    !(Math.abs(v[0]) <= 540 && Math.abs(v[1]) <= 90)
  )
    fail(path, "[longitude, latitude] in degrees", v);
};
const projection: Check = (v, path) => {
  if (typeof v === "string") return oneOf(...PROJECTIONS)(v, path);
  object(v, path);
  const spec = v as Record<string, unknown>;
  checkProperties(spec, path, ["type"], {
    type: oneOf(...PROJECTIONS),
    centralMeridian: finite,
    parallels: (p, at) => {
      range(p, at);
      if (!(p as number[]).every((x) => Math.abs(x) <= 90))
        fail(at, "two latitudes from -90 to 90", p);
    },
    fit: (f, at) => {
      if (f === "data" || f === "world") return;
      if (!Array.isArray(f) || f.length !== 2)
        fail(at, '"data", "world", or [[west, south], [east, north]]', f);
      lonLat(f[0], `${at}[0]`);
      lonLat(f[1], `${at}[1]`);
      const [[west, south], [east, north]] = f as [number[], number[]];
      if (!(south! < north!)) fail(`${at}[1][1]`, "a north above the south", north);
      if (west === east) fail(`${at}[1][0]`, "an east apart from the west", east);
    },
  } satisfies ChecksOf<ProjectionSpec>);
};

/** A buffer index into the buffers delivered with the spec. */
const bufferIndex: Check = (v, path) => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) fail(path, "a buffer index", v);
};
/** A buffer index, or the values as a JSON array. */
const bufferOrArray: Check = (v, path) => {
  if (!Array.isArray(v)) bufferIndex(v, path);
};
const array: Check = (v, path) => {
  if (!Array.isArray(v)) fail(path, "an array", v);
};

/** The forms of column objects: their required properties and checks. */
const COLUMNS = {
  values: {
    required: ["values"],
    checks: { type: oneOf("time"), values: array } satisfies ChecksOf<TimeColumnSpec>,
  },
  binary: {
    required: ["dtype", "buffer"],
    checks: {
      type: oneOf("number", "time"),
      dtype: oneOf("float64", "float32", "int32", "uint32", "int16", "uint16", "int8", "uint8"),
      buffer: bufferIndex,
    } satisfies ChecksOf<BinaryColumnSpec>,
  },
  category: {
    required: ["codes", "dictionary"],
    checks: {
      type: oneOf("category"),
      codes: bufferOrArray,
      dictionary: strings,
    } satisfies ChecksOf<CategoryColumnSpec>,
  },
  geometry: {
    required: ["coordinates", "ringOffsets", "polygonOffsets", "geometryOffsets"],
    checks: {
      type: oneOf("geometry"),
      coordinates: bufferOrArray,
      ringOffsets: bufferOrArray,
      polygonOffsets: bufferOrArray,
      geometryOffsets: bufferOrArray,
      codes: bufferOrArray,
    } satisfies ChecksOf<GeometryColumnSpec>,
  },
};
const COLUMN_KEYS = [
  ...new Set(Object.values(COLUMNS).flatMap((form) => Object.keys(form.checks))),
];

/**
 * A column's form and the types of its properties. Inline values are
 * checked row by row when the table is built.
 */
const column: Check = (v, path) => {
  if (Array.isArray(v)) return;
  object(v, path);
  const spec = v as Record<string, unknown>;
  const form =
    spec.type === "category" || spec.type === "geometry"
      ? COLUMNS[spec.type]
      : spec.type === "time" && spec.values !== undefined
        ? COLUMNS.values
        : spec.type === "number" || spec.type === "time"
          ? COLUMNS.binary
          : undefined;
  if (!form) {
    const typo = spec.type === undefined ? misspelling(spec, "type", COLUMN_KEYS) : undefined;
    if (typo !== undefined) throw missing(path, "type", typo);
    fail(`${path}.type`, '"number", "time", "category", or "geometry"', spec.type);
  }
  checkProperties(spec, path, form.required, form.checks);
};

/** Why a point's size is in no single form: a constant radius and a size field both. */
function sizeFormError(spec: Record<string, unknown>, type: string): string | undefined {
  return spec.radius !== undefined && spec.size !== undefined
    ? `${type} radius: a constant radius or a size field, not both; drop one`
    : undefined;
}

/** Marks whose properties come in forms that exclude each other: why a spec has no single one. */
const FORMS: Partial<
  Record<MarkSpec["type"], (spec: Record<string, unknown>) => string | undefined>
> = {
  area: areaFormError,
  heatmap: heatmapFormError,
  boxplot: boxPlotFormError,
  contour: contourFormError,
  histogram: histogramFormError,
  rule: ruleFormError,
  region: regionFormError,
  rug: (spec) => {
    if ((spec.x !== undefined) === (spec.y !== undefined))
      return "rug: needs exactly one of x and y";
    const sides = spec.x !== undefined ? ["bottom", "top"] : ["left", "right"];
    if (spec.side !== undefined && !sides.includes(spec.side as string))
      return `rug side: expected "${sides.join('" or "')}"; received ${JSON.stringify(spec.side)}`;
    if (spec.y !== undefined && spec.axis === "right")
      return 'rug axis: a y rug has no right axis; drop axis: "right"';
    return undefined;
  },
  errorbar: (spec) => {
    const form = errorBarForm(spec);
    return typeof form === "string" ? form : undefined;
  },
  point: (spec) => sizeFormError(spec, "point"),
  geopoint: (spec) => sizeFormError(spec, "geopoint"),
  treemap: (spec) => treeFormError(spec, "treemap"),
  sunburst: (spec) => treeFormError(spec, "sunburst"),
};

const mark: Check = (v, path) => {
  object(v, path);
  const spec = v as Record<string, unknown>;
  const kind: { required: readonly string[]; checks: Record<string, Check> } | undefined =
    Object.hasOwn(MARKS, spec.type as string) ? MARKS[spec.type as MarkSpec["type"]] : undefined;
  if (!kind)
    fail(
      `${path}.type`,
      Object.keys(MARKS)
        .map((k) => JSON.stringify(k))
        .join(" or "),
      spec.type,
    );
  const checks = { ...kind.checks, data: field, id: string };
  required(spec, path, kind.required, [...Object.keys(checks), "type"]);
  properties(spec, path, checks, ["type"]);
  if (spec.type === "dendrogram" && spec.axis !== undefined)
    throw new TypeError(
      `${path}.axis: a dendrogram's heights are plot-relative, on no y axis; drop axis`,
    );
  const problem = FORMS[spec.type as MarkSpec["type"]]?.(spec);
  if (problem) throw new TypeError(`${path}: ${problem}`);
};

/**
 * Throws a TypeError naming the first property of `spec` that is not valid,
 * or that the spec format does not have (`checkSpec` returns those instead).
 */
export function validateSpec(spec: unknown): asserts spec is ChartSpec {
  const unknown = findUnknown(spec);
  if (unknown.length > 0) throw new TypeError(unknownError(unknown));
}

/**
 * Checks `spec` like `validateSpec`, but returns the paths of the
 * properties it does not know, such as `marks[0].strokeWidht`, rather than
 * refusing them.
 */
export function checkSpec(spec: unknown): string[] {
  return findUnknown(spec).map(({ path }) => path);
}

/** Checks `spec`, throwing for what is not valid, and returns the properties it does not know. */
export function findUnknown(spec: unknown): UnknownProperty[] {
  const found: UnknownProperty[] = [];
  const outer = unknownPaths;
  unknownPaths = found;
  try {
    checkChart(spec);
    checkDendrogramData(spec);
  } finally {
    unknownPaths = outer;
  }
  return found;
}

/** An unknown property's path and, when a known one is close, the name it likely meant. */
export function describeUnknown({ path, known }: UnknownProperty): string {
  const name = path.slice(path.lastIndexOf(".") + 1);
  const meant = closest(name, known);
  return meant === undefined ? path : `${path} (did you mean "${meant}"?)`;
}

/** Why a spec with unknown properties is refused, and what to do instead. */
export function unknownError(unknown: readonly UnknownProperty[]): string {
  const [first, ...rest] = unknown;
  const name = first!.path.slice(first!.path.lastIndexOf(".") + 1);
  const meant = closest(name, first!.known);
  const fix =
    meant !== undefined
      ? `did you mean "${meant}"?`
      : 'remove it, or load with { unknown: "warn" } or "ignore"';
  const more = rest.length > 0 ? ` (also unknown: ${rest.map(describeUnknown).join(", ")})` : "";
  return `${first!.path}: not a property of herceg's spec format; ${fix}${more}`;
}

/** The known name a misspelling most likely means: one or two edits away, or the same but for case. */
function closest(name: string, known: readonly string[]): string | undefined {
  let best: string | undefined;
  let distance = name.length < 4 ? 1 : 2;
  for (const candidate of known) {
    if (candidate.toLowerCase() === name.toLowerCase()) return candidate;
    const d = edits(name, candidate, distance);
    if (d <= distance && (best === undefined || d < distance)) {
      best = candidate;
      distance = d;
    }
  }
  return best;
}

/** Levenshtein distance between `a` and `b`, or more than `limit` once it surely is. */
function edits(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++)
      next[j] = Math.min(
        row[j]! + 1,
        next[j - 1]! + 1,
        row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    row = next;
  }
  return row[b.length]!;
}

/** Check inline linkage rows here; the loader checks binary and derived data. */
function checkDendrogramData(spec: ChartSpec): void {
  spec.marks.forEach((mark, i) => {
    if (mark.type !== "dendrogram") return;
    const path = `marks[${i}]`;
    if (spec.facet && mark.facet !== "repeat")
      throw new TypeError(
        `${path}.facet: missing; a dendrogram is drawn whole in every facet panel, so give it facet: "repeat"`,
      );
    const names = Object.keys(spec.data ?? {});
    const name = mark.data ?? (names.length === 1 ? names[0] : undefined);
    const data =
      name !== undefined && Object.hasOwn(spec.data ?? {}, name) ? spec.data![name] : undefined;
    if (!data)
      throw new TypeError(`${path}.data: no table for the dendrogram; name one of spec.data`);
    if ("source" in data) return;
    const fields = [mark.first, mark.second, mark.height] as const;
    const columns = fields.map((field, channel) => {
      const column = Object.hasOwn(data.columns, field) ? data.columns[field] : undefined;
      if (column === undefined)
        throw new TypeError(
          `${path}.${["first", "second", "height"][channel]}: no field "${field}" in the dendrogram's table`,
        );
      if (Array.isArray(column)) {
        const bad = column.findIndex((value) => value !== null && typeof value !== "number");
        if (bad >= 0)
          throw new TypeError(
            `${path}: dendrogram row ${bad}, field "${field}": expected a number; received ${describe(column[bad])}`,
          );
        return column as readonly (number | null)[];
      }
      if ((column as { type: string }).type !== "number")
        throw new TypeError(`${path}: dendrogram field "${field}": expected a number column`);
      return undefined;
    });
    const rows = columns.find((column) => column !== undefined)?.length;
    if (rows === undefined) return;
    for (const [channel, column] of columns.entries())
      if (column && column.length !== rows)
        throw new TypeError(
          `${path}: dendrogram row ${Math.min(rows, column.length)}, field "${fields[channel]}": the fields have different row counts; give each one row per merge`,
        );
    try {
      checkLinkage(rows, mark.leaves, fields, (channel, row) => {
        const column = columns[channel];
        return column ? (column[row] ?? NaN) : undefined;
      });
    } catch (error) {
      throw new TypeError(`${path}: ${(error as Error).message}`);
    }
  });
}

function checkChart(spec: unknown): asserts spec is ChartSpec {
  object(spec, "spec");
  const chart = spec as Record<string, unknown>;
  // Later versions may mean what this herceg cannot draw, so they are refused.
  const version = chart.version;
  if (version !== undefined && version !== SPEC_VERSION)
    fail("spec.version", `${SPEC_VERSION}, the version this herceg reads`, version);
  if (!Array.isArray(chart.marks)) fail("spec.marks", "an array of marks", chart.marks);
  for (const [i, item] of chart.marks.entries()) mark(item, `marks[${i}]`);
  properties(
    chart,
    "spec",
    {
      title,
      description: string,
      width: positive,
      height: positive,
      data: (data, path) => {
        object(data, path);
        for (const [name, table] of Object.entries(data as Record<string, unknown>)) {
          const at = `${path}.${name}`;
          object(table, at);
          const entry = table as Record<string, unknown>;
          if (entry.source !== undefined) {
            checkProperties(entry, at, ["transform"], {
              source: string,
              transform: transforms,
            } satisfies ChecksOf<DerivedSpec>);
          } else {
            required(entry, at, ["columns"], ["columns", "matrix"]);
            object(entry.columns, `${at}.columns`);
            const fields = Object.keys(entry.columns as object);
            properties(entry, at, {
              columns: () => {},
              matrix: (m, where) => {
                object(m, where);
                const coordinate: Check = (v, path) => {
                  field(v, path);
                  if (!fields.includes(v as string))
                    fail(
                      path,
                      `a column of the table (${fields.map((f) => `"${f}"`).join(", ")})`,
                      v,
                    );
                };
                checkProperties(m as Record<string, unknown>, where, ["x", "y"], {
                  x: coordinate,
                  y: coordinate,
                });
              },
            } satisfies ChecksOf<ColumnsSpec>);
            for (const [name, values] of Object.entries(entry.columns as object))
              column(values, `${at}.columns.${name}`);
          }
        }
      },
      x: xAxis,
      y: chartAxis,
      yRight: chartAxis,
      panels: (p, path) => {
        if (!Array.isArray(p)) fail(path, "a list of panels", p);
        const ids = new Set<string>();
        for (const [i, item] of p.entries()) {
          const at = `${path}[${i}]`;
          object(item, at);
          const panel = item as Record<string, unknown>;
          checkProperties(panel, at, ["id"], {
            id: string,
            title: panelTitle,
            style: rolesOf(["plot", "panelTitle", ...AXIS_ROLES]),
            camera,
            x: axis,
            y: axis,
            yRight: axis,
          } satisfies ChecksOf<PanelSpec>);
          const id = panel.id as string;
          if (id === "" || id === "*") fail(`${at}.id`, 'a name other than "" and "*"', id);
          if (ids.has(id)) fail(`${at}.id`, "a name no other panel has", id);
          ids.add(id);
        }
      },
      grid: (g, path) => {
        object(g, path);
        properties(g as Record<string, unknown>, path, {
          columns: count,
          rowHeights: (v, at) => {
            if (!Array.isArray(v) || v.length === 0) fail(at, "a list of relative heights", v);
            for (const [i, height] of v.entries()) positive(height, `${at}[${i}]`);
          },
          columnWidths: (v, at) => {
            if (!Array.isArray(v) || v.length === 0) fail(at, "a list of relative widths", v);
            for (const [i, width] of v.entries()) positive(width, `${at}[${i}]`);
          },
        } satisfies ChecksOf<GridSpec>);
      },
      facet: (f, path) => {
        object(f, path);
        const spec = f as Record<string, unknown>;
        if ("field" in spec) {
          properties(spec, path, { field, columns: count } satisfies ChecksOf<WrappedFacetSpec>);
          if ("row" in spec || "column" in spec)
            fail(path, "a field to wrap, or row and column fields, not both", f);
          return;
        }
        properties(spec, path, { row: field, column: field } satisfies ChecksOf<GridFacetSpec>);
        if (spec.row === undefined && spec.column === undefined)
          fail(path, "a field, or a row or column field", f);
        // A grid's columns are its column field's values.
        if ("columns" in spec)
          fail(`${path}.columns`, "absent in a grid of row and column fields", spec.columns);
      },
      legend,
      padding: insets,
      tooltip: (t, path) => {
        if (typeof t === "boolean") return;
        object(t, path);
        properties(t as Record<string, unknown>, path, {
          mode: oneOf("nearest-x", "nearest-y", "nearest"),
          axisLabels: boolean,
        } satisfies ChecksOf<TooltipSpec>);
      },
      interaction: (i, path) => {
        object(i, path);
        properties(i as Record<string, unknown>, path, {
          zoom: (v, path) => {
            if (typeof v !== "boolean" && v !== "x" && v !== "y" && v !== "xy")
              fail(path, 'true, false, "x", "y", or "xy"', v);
          },
          brush: oneOf("x", "y", "xy", "lasso"),
          sync: string,
          rotate: boolean,
          drag: boolean,
        } satisfies ChecksOf<InteractionSpec>);
      },
      navigator: (v, path) => {
        if (typeof v === "boolean") return;
        object(v, path);
        properties(v as Record<string, unknown>, path, {
          height: (h, at) => {
            if (typeof h !== "number" || !(h >= 16) || !Number.isFinite(h))
              fail(at, "a height of at least 16 pixels", h);
          },
          marks: (m, at) => {
            strings(m, at);
            const ids = m as string[];
            ids.forEach((id, i) => {
              if (ids.indexOf(id) !== i) fail(`${at}[${i}]`, "a mark id not listed before", id);
            });
          },
          halo,
        } satisfies ChecksOf<NavigatorSpec>);
      },
      animation: (a, path) => {
        if (typeof a === "boolean") return;
        object(a, path);
        properties(a as Record<string, unknown>, path, {
          duration: (v, at) => {
            if (typeof v !== "number" || !(v >= 0) || !Number.isFinite(v))
              fail(at, "milliseconds, at least 0", v);
          },
          values: boolean,
        } satisfies ChecksOf<AnimationSpec>);
      },
      rowSelection: (v, path) => {
        const bindings = Array.isArray(v) ? v : [v];
        if (bindings.length === 0) fail(path, "a binding or a list of them", v);
        bindings.forEach((binding, i) => {
          const at = Array.isArray(v) ? `${path}[${i}]` : path;
          object(binding, at);
          const b = binding as Record<string, unknown>;
          checkProperties(b, at, ["channel"], {
            data: string,
            channel: (c, where) => {
              if (typeof c !== "string" || c === "") fail(where, "a channel's name", c);
            },
            events: (e, where) => {
              strings(e, where);
              const gesture = oneOf("brush", "lasso", "click");
              for (const [k, event] of (e as string[]).entries()) gesture(event, `${where}[${k}]`);
            },
            effect: oneOf("highlight", "none"),
            selection: (selection, where) => {
              object(selection, where);
              const kind = (selection as { kind?: unknown }).kind;
              const checks: Record<string, Check> | undefined =
                kind === "rows"
                  ? { kind: string, rows: positions }
                  : kind === "predicate"
                    ? { kind: string, expression }
                    : undefined;
              if (!checks) fail(`${where}.kind`, '"predicate" or "rows"', kind);
              checkProperties(
                selection as Record<string, unknown>,
                where,
                kind === "rows" ? ["rows"] : ["expression"],
                checks,
              );
            },
          } satisfies ChecksOf<RowSelectionSpec>);
        });
      },
      renderer: oneOf("auto", "svg", "canvas"),
      theme,
      locale: string,
      timeZone: string,
      projection,
      z: (v, path) => {
        if (isRecord(v) && v.style !== undefined)
          fail(`${path}.style`, "no style on a 3D chart's axes, which take the theme's", v.style);
        axis(v, path);
      },
      camera,
      boxAspect,
    } satisfies ChecksOf<Omit<ChartSpec, "marks" | "version">>,
    ["marks", "version"],
  );
  for (const [i, item] of (chart.marks as Record<string, unknown>[]).entries()) {
    if (item.type === "violin" && item.split === true && item.series === undefined)
      fail(`marks[${i}].split`, "a series field for split violins", item.split);
    if (item.type === "heatmap")
      for (const axis of ["x", "y"])
        if (item[`${axis}Step`] !== undefined && item[`${axis}Banded`] === true)
          fail(`marks[${i}].${axis}Step`, `no ${axis}Step with ${axis}Banded`, item[`${axis}Step`]);
  }
  // Dragging moves a network's nodes; a chart of other marks has none.
  const interaction = chart.interaction as { drag?: unknown } | undefined;
  if (
    interaction?.drag === true &&
    !(chart.marks as Record<string, unknown>[]).some(({ type }) => type === "graph")
  )
    fail("spec.interaction.drag", "a spec with a graph mark, whose nodes dragging moves", true);
  // A projection places maps' marks; a chart of other marks has nothing to project.
  if (
    chart.projection !== undefined &&
    !(chart.marks as Record<string, unknown>[]).some(
      ({ type }) => type === "geoshape" || type === "geopoint",
    )
  )
    fail(
      "spec.projection",
      "a spec with geoshape or geopoint marks: a projection needs geoshape or geopoint marks",
      chart.projection,
    );
  // A 3D chart's options mean nothing to other charts, which an older
  // reader might draw without them.
  const threeD = (chart.marks as Record<string, unknown>[]).some(
    ({ type }) => type === "point3d" || type === "line3d" || type === "surface",
  );
  for (const name of ["z", "camera", "boxAspect"])
    if (chart[name] !== undefined && !threeD)
      fail(`spec.${name}`, "a spec with point3d, line3d, or surface marks", chart[name]);
  // Marks name panels the chart has; with panels, every mark names one.
  const panels = chart.panels as { id: string }[] | undefined;
  if (chart.grid !== undefined && !panels) fail("spec.grid", "a spec with panels", chart.grid);
  const ids = new Set(panels?.map(({ id }) => id));
  for (const [i, item] of (chart.marks as Record<string, unknown>[]).entries()) {
    const panel = item.panel;
    if (!panels && panel !== undefined) fail(`marks[${i}].panel`, "a spec with panels", panel);
    if (panels && panel !== "*" && !ids.has(panel as string))
      fail(`marks[${i}].panel`, `"*" or the id of one of the panels`, panel);
  }
}
