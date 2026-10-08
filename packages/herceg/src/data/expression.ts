// Portable expressions: JSON arrays with the operator first, such as
// [">", ["field", "temp"], 30]. Specs carry them as plain data, Python builds
// them with operators (`hg.col("temp") > 30`), and TypeScript with `col`.
// `compileExpression` checks one against a table's fields and turns it into
// a function of a row.

import type { FieldKind, NumericArray } from "./column.ts";

/** What expressions read: a table, or a transform's intermediate result. */
export interface Fields {
  fields(): string[];
  has(name: string): boolean;
  kind(name: string): FieldKind;
  numbers(name: string): NumericArray;
  categories(name: string): { codes: Int32Array; dictionary: readonly string[] };
}

/** A literal, or an operator applied to expressions. */
export type Expression = number | string | boolean | null | readonly [Operator, ...Expression[]];

export type Operator =
  | "field"
  | "=="
  | "!="
  | "<"
  | "<="
  | ">"
  | ">="
  | "and"
  | "or"
  | "not"
  | "+"
  | "-"
  | "*"
  | "/"
  | "%"
  | "abs"
  | "sqrt"
  | "exp"
  | "log"
  | "log10"
  | "pow"
  | "min"
  | "max"
  | "round"
  | "floor"
  | "ceil"
  | "in"
  | "missing"
  | "if";

/** What an expression evaluates to. Missing numbers are NaN; missing strings null. */
export type ValueType = "number" | "string" | "boolean";

/** A compiled expression: its type and its value at a row. */
export interface Compiled {
  type: ValueType;
  at(row: number): number | string | boolean | null;
}

const COMPARE = new Set(["==", "!=", "<", "<=", ">", ">="]);
// Maps, so names such as "constructor" are not operators.
const ARITHMETIC = new Map<string, (a: number, b: number) => number>(
  Object.entries({
    "+": (a: number, b: number) => a + b,
    "-": (a: number, b: number) => a - b,
    "*": (a: number, b: number) => a * b,
    "/": (a: number, b: number) => a / b,
    "%": (a: number, b: number) => a % b,
    pow: (a: number, b: number) => a ** b,
  }),
);
const MATH = new Map<string, (a: number) => number>(
  Object.entries({
    abs: Math.abs,
    sqrt: Math.sqrt,
    exp: Math.exp,
    log: Math.log,
    log10: Math.log10,
    round: Math.round,
    floor: Math.floor,
    ceil: Math.ceil,
  }),
);

/** Checks an expression against a table and compiles it; errors name what is wrong. */
export function compileExpression(expression: Expression, table: Fields): Compiled {
  return compile(expression, table);
}

function compile(e: Expression, table: Fields): Compiled {
  if (e === null) return { type: "number", at: () => Number.NaN };
  if (typeof e === "number") {
    if (!Number.isFinite(e)) throw new TypeError(`Expression numbers must be finite, not ${e}`);
    return { type: "number", at: () => e };
  }
  if (typeof e === "string") return { type: "string", at: () => e };
  if (typeof e === "boolean") return { type: "boolean", at: () => e };
  if (!Array.isArray(e) || typeof e[0] !== "string") {
    throw new TypeError(`Not an expression: ${JSON.stringify(e)}`);
  }
  const [op, ...args] = e as readonly [string, ...Expression[]];
  if (op === "field") return field(args, table);
  if (COMPARE.has(op)) return compare(op, args, table);
  if (op === "and" || op === "or") {
    if (args.length < 1) throw new TypeError(`"${op}" needs operands`);
    const parts = args.map((arg) => typed(arg, "boolean", op, table).at);
    return {
      type: "boolean",
      at:
        op === "and"
          ? (row) => parts.every((part) => part(row))
          : (row) => parts.some((part) => part(row)),
    };
  }
  if (op === "not") {
    const [a] = arity(op, args, 1).map((arg) => typed(arg, "boolean", op, table).at);
    return { type: "boolean", at: (row) => !a!(row) };
  }
  if (op === "-" && args.length === 1) {
    const a = typed(args[0]!, "number", op, table).at;
    return { type: "number", at: (row) => -(a(row) as number) };
  }
  const binary = ARITHMETIC.get(op);
  if (binary) {
    const [a, b] = arity(op, args, 2).map((arg) => typed(arg, "number", op, table).at);
    return { type: "number", at: (row) => binary(a!(row) as number, b!(row) as number) };
  }
  const unary = MATH.get(op);
  if (unary) {
    const [a] = arity(op, args, 1).map((arg) => typed(arg, "number", op, table).at);
    return { type: "number", at: (row) => unary(a!(row) as number) };
  }
  if (op === "min" || op === "max") {
    if (args.length < 1) throw new TypeError(`"${op}" needs operands`);
    const parts = args.map((arg) => typed(arg, "number", op, table).at);
    const pick = op === "min" ? Math.min : Math.max;
    return { type: "number", at: (row) => pick(...parts.map((part) => part(row) as number)) };
  }
  if (op === "in") return membership(args, table);
  if (op === "missing") {
    const [a] = arity(op, args, 1).map((arg) => compile(arg, table));
    return { type: "boolean", at: (row) => isMissing(a!.at(row)) };
  }
  if (op === "if") {
    const [condition, yes, no] = arity(op, args, 3);
    const test = typed(condition!, "boolean", op, table).at;
    // A null branch is missing in the other branch's type: NaN or no category.
    const then = yes === null ? undefined : compile(yes!, table);
    const otherwise = no === null ? undefined : typed(no!, then?.type ?? "number", op, table);
    const type = then?.type ?? otherwise?.type ?? "number";
    const missing = type === "string" ? null : Number.NaN;
    const a = then ? then.at : () => missing;
    const b = otherwise ? otherwise.at : () => missing;
    return { type, at: (row) => (test(row) ? a(row) : b(row)) };
  }
  throw new TypeError(`Unknown expression operator "${op}"`);
}

function field(args: readonly Expression[], table: Fields): Compiled {
  const name = args[0];
  if (args.length !== 1 || typeof name !== "string")
    throw new TypeError(`"field" needs one field name, as ["field", "x"]`);
  if (!table.has(name)) {
    const known = table
      .fields()
      .map((f) => `"${f}"`)
      .join(", ");
    throw new Error(`Unknown field "${name}" in an expression; the table has ${known}`);
  }
  if (table.kind(name) === "category") {
    const { codes, dictionary } = table.categories(name);
    return {
      type: "string",
      at: (row) => {
        const code = codes[row]!;
        return code < 0 ? null : dictionary[code]!;
      },
    };
  }
  const values = table.numbers(name);
  return { type: "number", at: (row) => values[row]! };
}

/** Comparisons; one between a category field and a string compares codes. */
function compare(op: string, args: readonly Expression[], table: Fields): Compiled {
  const [left, right] = arity(op, args, 2);
  // Comparing with null tests for a missing value.
  if (left === null || right === null) {
    if (op !== "==" && op !== "!=") throw new TypeError(`"${op}" cannot compare with null`);
    const other = compile(left === null ? right! : left!, table);
    const equal = op === "==";
    return { type: "boolean", at: (row) => isMissing(other.at(row)) === equal };
  }
  const a = compile(left!, table);
  const b = compile(right!, table);
  if (a.type !== b.type)
    throw new TypeError(`"${op}" compares ${a.type} with ${b.type}; both sides need one type`);
  const code = categoryLiteral(left!, right!, table);
  if (code && (op === "==" || op === "!=")) {
    const { codes, target } = code;
    return {
      type: "boolean",
      at: op === "==" ? (row) => codes[row] === target : (row) => codes[row] !== target,
    };
  }
  const test = comparison(op);
  return {
    type: "boolean",
    at: (row) => {
      const x = a.at(row);
      const y = b.at(row);
      // Missing values compare false, except as unequal.
      if (isMissing(x) || isMissing(y)) return op === "!=";
      return test(x as number | string | boolean, y as number | string | boolean);
    },
  };
}

function comparison(
  op: string,
): (a: number | string | boolean, b: number | string | boolean) => boolean {
  switch (op) {
    case "==":
      return (a, b) => a === b;
    case "!=":
      return (a, b) => a !== b;
    case "<":
      return (a, b) => a < b;
    case "<=":
      return (a, b) => a <= b;
    case ">":
      return (a, b) => a > b;
    default:
      return (a, b) => a >= b;
  }
}

/** A category field compared with a string literal: its codes and the literal's code. */
function categoryLiteral(
  left: Expression,
  right: Expression,
  table: Fields,
): { codes: Int32Array; target: number } | undefined {
  const [name, literal] =
    typeof right === "string" ? [fieldName(left), right] : [fieldName(right), left];
  if (name === undefined || typeof literal !== "string" || table.kind(name) !== "category")
    return undefined;
  const { codes, dictionary } = table.categories(name);
  // A value not in the dictionary matches no row: -2 is no row's code.
  const index = dictionary.indexOf(literal);
  return { codes, target: index < 0 ? -2 : index };
}

function fieldName(e: Expression): string | undefined {
  return Array.isArray(e) && e[0] === "field" && typeof e[1] === "string" ? e[1] : undefined;
}

function membership(args: readonly Expression[], table: Fields): Compiled {
  if (args.length < 2) throw new TypeError(`"in" needs a value and at least one candidate`);
  const [value, ...candidates] = args;
  const a = compile(value!, table);
  for (const candidate of candidates) {
    const type = candidate === null ? a.type : typeof candidate;
    if (Array.isArray(candidate) || type !== a.type)
      throw new TypeError(`"in" candidates must be ${a.type} literals`);
  }
  const set = new Set(candidates);
  const missing = candidates.includes(null);
  return {
    type: "boolean",
    at: (row) => {
      const x = a.at(row);
      return isMissing(x) ? missing : set.has(x as Expression);
    },
  };
}

function typed(e: Expression, type: ValueType, op: string, table: Fields): Compiled {
  const compiled = compile(e, table);
  if (compiled.type !== type)
    throw new TypeError(`"${op}" needs ${type} operands, not ${compiled.type}`);
  return compiled;
}

function arity(op: string, args: readonly Expression[], count: number): readonly Expression[] {
  if (args.length !== count)
    throw new TypeError(
      `"${op}" takes ${count} operand${count === 1 ? "" : "s"}, not ${args.length}`,
    );
  return args;
}

function isMissing(value: number | string | boolean | null): boolean {
  return value === null || (typeof value === "number" && Number.isNaN(value));
}

/**
 * What an expression gives, for type checking: a number, text, or truth
 * value; "value" for a field read as it is (its own kind).
 */
export type ExprKind = "number" | "string" | "boolean" | "value";

/** The kind of an operand: a literal's own, an expression's, or "missing" for null. */
export type KindOf<T> =
  T extends Expr<infer K>
    ? K
    : T extends string
      ? "string"
      : T extends boolean
        ? "boolean"
        : T extends number
          ? "number"
          : "missing";

/** The kind of `when`: its branches' (a null branch takes the other's; both null, a number). */
export type Branches<T, O> = Exclude<
  KindOf<T> extends "missing" ? (KindOf<O> extends "missing" ? "number" : KindOf<O>) : KindOf<T>,
  "missing"
>;

/** Something an expression method takes: an expression or a literal. */
export type Operand = Expr<ExprKind> | number | string | boolean | null;

const json = (operand: Operand): Expression =>
  operand instanceof Expr ? operand.expression : operand;

/**
 * An expression built in TypeScript; specs and charts take its JSON form.
 *
 * ```ts
 * col("temp").gt(30).and(col("site").eq("north"))
 * col("temp").mul(1.8).add(32)
 * ```
 */
export class Expr<K extends ExprKind = ExprKind> {
  readonly expression: Expression;
  /** What the expression evaluates to, for type checking only. */
  declare readonly kind: K;

  constructor(expression: Expression) {
    this.expression = expression;
  }

  toJSON(): Expression {
    return this.expression;
  }

  #apply<R extends ExprKind>(op: Operator, ...operands: Operand[]): Expr<R> {
    return new Expr<R>([op, this.expression, ...operands.map(json)]);
  }

  eq(other: Operand): Expr<"boolean"> {
    return this.#apply("==", other);
  }
  ne(other: Operand): Expr<"boolean"> {
    return this.#apply("!=", other);
  }
  lt(other: Operand): Expr<"boolean"> {
    return this.#apply("<", other);
  }
  le(other: Operand): Expr<"boolean"> {
    return this.#apply("<=", other);
  }
  gt(other: Operand): Expr<"boolean"> {
    return this.#apply(">", other);
  }
  ge(other: Operand): Expr<"boolean"> {
    return this.#apply(">=", other);
  }
  and(...others: Operand[]): Expr<"boolean"> {
    return this.#apply("and", ...others);
  }
  or(...others: Operand[]): Expr<"boolean"> {
    return this.#apply("or", ...others);
  }
  not(): Expr<"boolean"> {
    return this.#apply("not");
  }
  add(other: Operand): Expr<"number"> {
    return this.#apply("+", other);
  }
  sub(other: Operand): Expr<"number"> {
    return this.#apply("-", other);
  }
  mul(other: Operand): Expr<"number"> {
    return this.#apply("*", other);
  }
  div(other: Operand): Expr<"number"> {
    return this.#apply("/", other);
  }
  mod(other: Operand): Expr<"number"> {
    return this.#apply("%", other);
  }
  pow(other: Operand): Expr<"number"> {
    return this.#apply("pow", other);
  }
  neg(): Expr<"number"> {
    return this.#apply("-");
  }
  abs(): Expr<"number"> {
    return this.#apply("abs");
  }
  sqrt(): Expr<"number"> {
    return this.#apply("sqrt");
  }
  exp(): Expr<"number"> {
    return this.#apply("exp");
  }
  log(): Expr<"number"> {
    return this.#apply("log");
  }
  log10(): Expr<"number"> {
    return this.#apply("log10");
  }
  round(): Expr<"number"> {
    return this.#apply("round");
  }
  floor(): Expr<"number"> {
    return this.#apply("floor");
  }
  ceil(): Expr<"number"> {
    return this.#apply("ceil");
  }
  /** True when the value is one of `values`. */
  isIn(...values: (number | string | null)[]): Expr<"boolean"> {
    return this.#apply("in", ...values);
  }
  /** True when the value is missing: NaN, or a missing category. */
  isMissing(): Expr<"boolean"> {
    return this.#apply("missing");
  }
}

/** A field of the table an expression is evaluated against. */
export function col(name: string): Expr<"value"> {
  return new Expr<"value">(["field", name]);
}

/** `then` where `condition` holds, else `otherwise`. */
export function when<T extends Operand, O extends Operand>(
  condition: Operand,
  then: T,
  otherwise: O,
): Expr<Branches<T, O>> {
  return new Expr<Branches<T, O>>(["if", json(condition), json(then), json(otherwise)]);
}

/** The JSON form of an expression or literal. */
export function expressionOf(operand: Operand): Expression {
  return json(operand);
}
