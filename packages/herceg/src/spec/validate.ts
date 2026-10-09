// Runtime checks of chart specs written outside TypeScript (the Python
// package, stored JSON), where the type checker cannot help: structure,
// enumerations, booleans, finite numbers, and field references. Errors name
// the offending property by its path, such as `marks[2].strokeWidth`.
// Unknown properties are allowed, so newer specs still load, and reported,
// so misspelled ones do not go unnoticed.

import { areaFormError } from "../marks/area.ts";
import { errorBarForm } from "../marks/errorbar.ts";
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
  type ChartSpec,
  type DerivedSpec,
  type GeometryColumnSpec,
  type GridFacetSpec,
  type GridSpec,
  type InteractionSpec,
  type MarkSpec,
  type NavigatorSpec,
  type PanelSpec,
  type ProjectionSpec,
  type ResolveSpec,
  SPEC_VERSION,
  type ThemeSpec,
  type TimeColumnSpec,
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

/** Paths of the properties no check knows, collected while `checkSpec` runs. */
let unknownPaths: string[] | undefined;

function fail(path: string, expected: string, value: unknown): never {
  throw new TypeError(`${path}: expected ${expected}, got ${describe(value)}`);
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
const strings: Check = (v, path) => {
  if (!Array.isArray(v)) fail(path, "an array of strings", v);
  for (const [i, item] of v.entries()) string(item, `${path}[${i}]`);
};
const numbers: Check = (v, path) => {
  if (!Array.isArray(v)) fail(path, "an array of numbers", v);
  for (const [i, item] of v.entries()) finite(item, `${path}[${i}]`);
};
const object: Check = (v, path) => {
  if (!isRecord(v)) fail(path, "an object", v);
};

function oneOf(...values: readonly string[]): Check {
  return (v, path) => {
    if (!values.includes(v as string))
      fail(path, values.map((x) => JSON.stringify(x)).join(" or "), v);
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
    if (!Object.hasOwn(checks, key) && !others.includes(key)) unknownPaths?.push(`${path}.${key}`);
  }
  for (const [key, check] of Object.entries(checks)) {
    if (value[key] !== undefined) check(value[key], `${path}.${key}`);
  }
}

function required(value: Record<string, unknown>, path: string, keys: readonly string[]) {
  for (const key of keys) {
    if (value[key] === undefined) throw new TypeError(`${path}.${key}: required`);
  }
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
      required(operation, at, needsField ? ["op", "field", "as"] : ["op", "as"]);
      properties(operation, at, { op: oneOf(...ops), field, as: field });
    }
  };
}

/** The keys a transform of each kind takes. */
const TRANSFORMS: Record<string, { required: string[]; checks: Record<string, Check> }> = {
  filter: { required: [], checks: { filter: expression } },
  calculate: { required: ["as"], checks: { calculate: expression, as: field } },
  bin: {
    required: [],
    checks: { bin: field, as: field, step: positive, count, start: finite },
  },
  aggregate: {
    required: [],
    checks: { aggregate: operations(AGGREGATE_OPS, false), groupby: fields },
  },
  rolling: {
    required: ["size"],
    checks: { rolling: operations(ROLLING_OPS, true), size: count, groupby: fields },
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
    required(step, at, keys);
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
    for (const key of keys) if (!known.includes(key)) unknownPaths?.push(`${path}.${key}`);
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
    label: string,
    grid: boolean,
    ticks: positive,
    format: format(spec.type),
    axis: boolean,
  };
}

const axis: Check = (v, path) => {
  object(v, path);
  const spec = v as Record<string, unknown>;
  // Only the x axis has breaks: refuse them elsewhere rather than ignore them.
  if (spec.breaks !== undefined)
    fail(`${path}.breaks`, "breaks on the chart's x axis only", spec.breaks);
  if (spec.seams !== undefined)
    fail(`${path}.seams`, "seams on the chart's x axis only", spec.seams);
  properties(spec, path, axisChecks(spec));
};

const xAxis: Check = (v, path) => {
  object(v, path);
  const spec = v as Record<string, unknown>;
  properties(spec, path, {
    ...axisChecks(spec),
    // Whether any x scale is a time scale shows only once panels are planned.
    breaks: checkBreaks,
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
const theme: Check = (v, path) => {
  if (typeof v === "string") return oneOf(...THEMES)(v, path);
  object(v, path);
  properties(v as Record<string, unknown>, path, {
    extends: oneOf(...THEMES),
    titleSize: positive,
    gridDash: numbers,
    lineWidth: positive,
    barRadius: (v, path) => {
      if (typeof v !== "number" || !(v >= 0) || !Number.isFinite(v))
        fail(path, "a radius of 0 or more", v);
    },
    tooltipBackground: string,
    tooltipBorder: string,
    background: string,
    text: string,
    muted: string,
    grid: string,
    axis: string,
    font: string,
    fontSize: positive,
    palette: strings,
    sequential: strings,
    diverging: strings,
    rise: string,
    fall: string,
  } satisfies ChecksOf<ThemeSpec>);
};

/** A tree's fields: a path of category fields, or node and parent fields. */
function hierarchyChecks(): Record<"path" | "node" | "parent" | "value" | "labels", Check> {
  return {
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
type CommonKey = "type" | "data" | "id" | "axis" | "facet" | "panel";

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
      x: field,
      y: fields,
      series: field,
      stroke: string,
      strokeWidth: width,
      dash: numbers,
      curve,
      label: string,
    },
  },
  area: {
    required: ["x"],
    checks: {
      x: field,
      y: fields,
      y1: field,
      y2: field,
      series: field,
      stack: boolean,
      stackGaps: oneOf("zero", "interpolate"),
      fill: string,
      fillOpacity: fraction,
      line: boolean,
      stroke: string,
      strokeWidth: width,
      curve,
      label: string,
    },
  },
  rule: {
    required: [],
    checks: {
      x: position,
      y: position,
      stroke: string,
      strokeWidth: width,
      dash: numbers,
      label: string,
      text: field,
    },
  },
  region: {
    required: [],
    checks: {
      x1: position,
      x2: position,
      y1: position,
      y2: position,
      fill: string,
      fillOpacity: fraction,
      label: string,
      text: field,
    },
  },
  text: {
    required: ["x", "y"],
    checks: {
      x: position,
      y: position,
      label: string,
      text: field,
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
      x: fields,
      y: fields,
      series: field,
      stack: boolean,
      fill: string,
      fillOpacity: fraction,
      label: string,
      labels: (v, path) => (typeof v === "boolean" ? undefined : format("linear")(v, path)),
    },
  },
  point: {
    required: ["x", "y"],
    checks: {
      x: field,
      y: field,
      series: field,
      r: (v, path) => (typeof v === "string" ? field(v, path) : positive(v, path)),
      rRange: range,
      fill: string,
      fillOpacity: (v, path) => (typeof v === "string" ? field(v, path) : fraction(v, path)),
      stroke: string,
      strokeWidth: width,
      color: field,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      symbol: string,
      sampling: oneOf("none", "pixel"),
      label: string,
    },
  },
  histogram: {
    required: ["x"],
    checks: {
      x: field,
      bins: (v, path) => {
        if (typeof v === "number") return count(v, path);
        object(v, path);
        required(v as Record<string, unknown>, path, ["step"]);
        properties(v as Record<string, unknown>, path, { step: positive, start: finite });
      },
      series: field,
      normalize: oneOf("count", "percent", "density"),
      stack: boolean,
      fill: string,
      fillOpacity: fraction,
      label: string,
    },
  },
  treemap: { required: [], checks: hierarchyChecks() },
  sunburst: { required: [], checks: hierarchyChecks() },
  sankey: {
    required: ["source", "target"],
    checks: {
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
      source: field,
      target: field,
      value: field,
      nodes: string,
      node: field,
      group: field,
      size: field,
      labels: boolean,
    },
  },
  pie: {
    required: ["category"],
    checks: {
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
          required(band, at, ["to"]);
          properties(band, at, { to: finite, color: string });
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
      category: field,
      value: field,
      sort: oneOf("input", "value"),
      labels: boolean,
    },
  },
  radar: {
    required: [],
    checks: {
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
    required: ["x", "y"],
    checks: {
      x: field,
      y: field,
      series: field,
      fill: string,
      fillOpacity: fraction,
      label: string,
    },
  },
  violin: {
    required: ["x", "y"],
    checks: {
      x: field,
      y: field,
      series: field,
      bandwidth: positive,
      fill: string,
      fillOpacity: fraction,
      label: string,
    },
  },
  candlestick: {
    required: ["x", "open", "high", "low", "close"],
    checks: {
      x: field,
      open: field,
      high: field,
      low: field,
      close: field,
      variant: oneOf("candlestick", "ohlc"),
      rise: string,
      fall: string,
      label: string,
    },
  },
  errorbar: {
    required: [],
    checks: {
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
    },
  },
  geoshape: {
    required: [],
    checks: {
      geometry: field,
      name: field,
      color: field,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      fill: string,
      fillOpacity: fraction,
      stroke: string,
      strokeWidth: width,
      label: string,
    },
  },
  geopoint: {
    required: ["longitude", "latitude"],
    checks: {
      longitude: field,
      latitude: field,
      name: field,
      series: field,
      r: (v, path) => (typeof v === "string" ? field(v, path) : positive(v, path)),
      rRange: range,
      color: field,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      fill: string,
      fillOpacity: fraction,
      stroke: string,
      strokeWidth: width,
      label: string,
    },
  },
  heatmap: {
    required: ["x", "y", "value"],
    checks: {
      x: field,
      y: field,
      value: field,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      reduce: oneOf("mean", "max", "min"),
      label: string,
    },
  },
  point3d: {
    required: ["x", "y", "z"],
    checks: {
      x: field,
      y: field,
      z: field,
      series: field,
      name: field,
      r: positive,
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
  required(spec, path, ["type"]);
  properties(spec, path, {
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
  if (!form) fail(`${path}.type`, '"number", "time", "category", or "geometry"', spec.type);
  required(spec, path, form.required);
  properties(spec, path, form.checks);
};

/** Marks whose properties come in forms that exclude each other: why a spec has no single one. */
const FORMS: Partial<
  Record<MarkSpec["type"], (spec: Record<string, unknown>) => string | undefined>
> = {
  area: areaFormError,
  rule: ruleFormError,
  region: regionFormError,
  errorbar: (spec) => {
    const form = errorBarForm(spec);
    return typeof form === "string" ? form : undefined;
  },
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
  required(spec, path, kind.required);
  properties(
    spec,
    path,
    {
      ...kind.checks,
      data: field,
      id: string,
      axis: oneOf("left", "right"),
      facet: oneOf("repeat"),
      panel: string,
    },
    ["type"],
  );
  const problem = FORMS[spec.type as MarkSpec["type"]]?.(spec);
  if (problem) throw new TypeError(`${path}: ${problem}`);
};

/**
 * Throws a TypeError naming the first property of `spec` that is not valid.
 * Properties it does not know are allowed (see `checkSpec`).
 */
export function validateSpec(spec: unknown): asserts spec is ChartSpec {
  checkSpec(spec);
}

/**
 * Checks `spec` like `validateSpec`, and returns the paths of the
 * properties it does not know, such as `marks[0].strokeWidht`.
 */
export function checkSpec(spec: unknown): string[] {
  const found: string[] = [];
  const outer = unknownPaths;
  unknownPaths = found;
  try {
    checkChart(spec);
  } finally {
    unknownPaths = outer;
  }
  return found;
}

function checkChart(spec: unknown): asserts spec is ChartSpec {
  object(spec, "spec");
  const chart = spec as Record<string, unknown>;
  const version = chart.version;
  if (
    version !== undefined &&
    !(
      typeof version === "number" &&
      Number.isInteger(version) &&
      version >= 1 &&
      version <= SPEC_VERSION
    )
  ) {
    throw new TypeError(
      `Unsupported spec version ${describe(version)}; this herceg reads versions 1 to ${SPEC_VERSION}`,
    );
  }
  if (!Array.isArray(chart.marks)) fail("spec.marks", "an array of marks", chart.marks);
  for (const [i, item] of chart.marks.entries()) mark(item, `marks[${i}]`);
  properties(
    chart,
    "spec",
    {
      title: string,
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
            required(entry, at, ["transform"]);
            properties(entry, at, {
              source: string,
              transform: transforms,
            } satisfies ChecksOf<DerivedSpec>);
          } else {
            object(entry.columns, `${at}.columns`);
            properties(entry, at, {}, ["columns"]);
            for (const [name, values] of Object.entries(entry.columns as object))
              column(values, `${at}.columns.${name}`);
          }
        }
      },
      x: xAxis,
      y: axis,
      yRight: axis,
      panels: (p, path) => {
        if (!Array.isArray(p)) fail(path, "a list of panels", p);
        const ids = new Set<string>();
        for (const [i, item] of p.entries()) {
          const at = `${path}[${i}]`;
          object(item, at);
          const panel = item as Record<string, unknown>;
          required(panel, at, ["id"]);
          properties(panel, at, {
            id: string,
            title: string,
            x: axis,
            y: axis,
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
      resolve: (r, path) => {
        object(r, path);
        properties(r as Record<string, unknown>, path, {
          x: oneOf("shared", "independent", "rows", "columns"),
          y: oneOf("shared", "independent", "rows", "columns"),
        } satisfies ChecksOf<ResolveSpec>);
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
      legend: boolean,
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
      renderer: oneOf("auto", "svg", "canvas"),
      theme,
      locale: string,
      timeZone: string,
      projection,
      z: axis,
      camera,
      boxAspect,
    } satisfies ChecksOf<Omit<ChartSpec, "marks" | "version">>,
    ["marks", "version"],
  );
  // An older reader would draw shared axes or overlay panels, or the time
  // breaks leave out; a spec asking otherwise says so.
  const declared = (version as number | undefined) ?? 1;
  for (const name of ["resolve", "panels", "grid"])
    if (chart[name] !== undefined && declared < 2)
      fail(
        `spec.${name}`,
        'a spec with "version": 2 or later, so that older readers refuse it',
        chart[name],
      );
  const ownX = [
    ["spec.resolve.x", (chart.resolve as { x?: unknown } | undefined)?.x],
    ["spec.x.breaks", (chart.x as { breaks?: unknown } | undefined)?.breaks],
    ...((chart.panels as { x?: unknown }[] | undefined) ?? []).map(
      ({ x }, i) => [`spec.panels[${i}].x`, x] as const,
    ),
  ] as const;
  for (const [path, value] of ownX)
    if (value !== undefined && declared < 3)
      fail(path, 'a spec with "version": 3 or later, so that older readers refuse it', value);
  // An older reader would draw the chart without its strip, and the plot taller.
  const navigator = chart.navigator;
  if (navigator !== undefined && navigator !== false && declared < 4)
    fail(
      "spec.navigator",
      'a spec with "version": 4 or later, so that older readers refuse it',
      navigator,
    );
  const seams = (chart.x as XAxisSpec | undefined)?.seams;
  if (seams !== undefined && seams !== false && declared < 5)
    fail("spec.x.seams", 'a spec with "version": 5, so that older readers refuse it', seams);
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
