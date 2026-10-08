// Runtime checks of chart specs written outside TypeScript (the Python
// package, stored JSON), where the type checker cannot help: structure,
// enumerations, booleans, finite numbers, and field references. Errors name
// the offending property by its path, such as `marks[2].strokeWidth`.
// Unknown properties are ignored, so newer specs still load.

import type { ChartSpec } from "./spec.ts";

type Check = (value: unknown, path: string) => void;

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

/** Checks the listed properties of `value` that are present. */
function properties(value: Record<string, unknown>, path: string, checks: Record<string, Check>) {
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
    for (const key of Object.keys(step)) {
      if (!(key in checks))
        throw new TypeError(`${at}.${key}: not an option of a ${kind} transform`);
    }
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
  };
}

const axis: Check = (v, path) => {
  object(v, path);
  const spec = v as Record<string, unknown>;
  properties(spec, path, {
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
  });
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
  });
};

/** A tree's fields: a path of category fields, or node and parent fields. */
function hierarchyChecks(): Record<string, Check> {
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

const MARKS: Record<string, { required: string[]; checks: Record<string, Check> }> = {
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
      fill: string,
      fillOpacity: fraction,
      line: boolean,
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
  heatmap: {
    required: ["x", "y", "value"],
    checks: {
      x: field,
      y: field,
      value: field,
      colors: ramp,
      colorDomain: range,
      colorMidpoint: finite,
      label: string,
    },
  },
};

const mark: Check = (v, path) => {
  object(v, path);
  const spec = v as Record<string, unknown>;
  const kind = Object.hasOwn(MARKS, spec.type as string) ? MARKS[spec.type as string] : undefined;
  if (!kind)
    fail(
      `${path}.type`,
      Object.keys(MARKS)
        .map((k) => JSON.stringify(k))
        .join(" or "),
      spec.type,
    );
  required(spec, path, kind.required);
  properties(spec, path, {
    ...kind.checks,
    data: field,
    id: string,
    axis: oneOf("left", "right"),
    facet: oneOf("repeat"),
  });
};

/** Throws a TypeError naming the first property of `spec` that is not valid. */
export function validateSpec(spec: unknown): asserts spec is ChartSpec {
  object(spec, "spec");
  const chart = spec as Record<string, unknown>;
  if (!Array.isArray(chart.marks)) fail("spec.marks", "an array of marks", chart.marks);
  for (const [i, item] of chart.marks.entries()) mark(item, `marks[${i}]`);
  properties(chart, "spec", {
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
          properties(entry, at, { source: string, transform: transforms });
        } else {
          object(entry.columns, `${at}.columns`);
        }
      }
    },
    x: axis,
    y: axis,
    yRight: axis,
    resolve: (r, path) => {
      object(r, path);
      properties(r as Record<string, unknown>, path, {
        y: oneOf("shared", "independent", "rows", "columns"),
      });
    },
    facet: (f, path) => {
      object(f, path);
      const spec = f as Record<string, unknown>;
      if ("field" in spec) {
        properties(spec, path, { field, columns: count });
        if ("row" in spec || "column" in spec)
          fail(path, "a field to wrap, or row and column fields, not both", f);
        return;
      }
      properties(spec, path, { row: field, column: field });
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
      });
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
      });
    },
    renderer: oneOf("auto", "svg", "canvas"),
    theme,
    locale: string,
    timeZone: string,
  });
}
