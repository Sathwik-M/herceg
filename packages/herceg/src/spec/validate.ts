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

const curve = oneOf("linear", "step", "step-before", "step-after");

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

const theme: Check = (v, path) => {
  if (typeof v === "string") return oneOf("light", "dark")(v, path);
  object(v, path);
  properties(v as Record<string, unknown>, path, {
    extends: oneOf("light", "dark"),
    background: string,
    text: string,
    muted: string,
    grid: string,
    axis: string,
    font: string,
    fontSize: positive,
    palette: strings,
    sequential: strings,
  });
};

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
      r: positive,
      fill: string,
      fillOpacity: fraction,
      sampling: oneOf("none", "pixel"),
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
    checks: { x: field, y: field, value: field, colors: strings, label: string },
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
  properties(spec, path, { ...kind.checks, data: field, id: string, axis: oneOf("left", "right") });
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
        object(table, `${path}.${name}`);
        object((table as Record<string, unknown>).columns, `${path}.${name}.columns`);
      }
    },
    x: axis,
    y: axis,
    yRight: axis,
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
        zoom: boolean,
        brush: oneOf("x"),
        sync: string,
      });
    },
    renderer: oneOf("auto", "svg", "canvas"),
    theme,
    locale: string,
    timeZone: string,
  });
}
