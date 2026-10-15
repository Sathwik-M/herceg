// Expressions built in TypeScript: `col`, `when`, and the methods of `Expr`
// make the JSON form specs carry (see data/expression.ts, which compiles
// it). Apart from the compiler, so a chart that only builds expressions
// carries no code that evaluates them.

import type { Expression, Operator } from "./expression.ts";

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
