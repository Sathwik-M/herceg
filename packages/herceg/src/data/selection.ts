// Selections of a table's rows that several views share: a chart's brush,
// a grid's selected rows. The application owns the store and decides which
// views read which channels, and whether they filter or highlight with
// them; nothing propagates on its own.

import { compileExpression, Expr, type Expression } from "./expression.ts";
import type { RowSet } from "./row-set.ts";
import type { Schema, Table } from "./table.ts";

/**
 * A selection: a condition on the table's fields, which rows appended
 * later meet or not (a chart's brushed range), or a set of rows, which
 * later rows are never in (rows clicked in a grid). Conditions are portable
 * and can run where the data lives; row sets belong to the local table.
 */
export type DataSelection<S extends Schema = Schema> = ConditionSelection | RowsSelection<S>;

export interface ConditionSelection {
  readonly kind: "predicate";
  readonly expression: Expression;
}

export interface RowsSelection<S extends Schema = Schema> {
  readonly kind: "rows";
  readonly rows: RowSet<S>;
}

/**
 * Selections of one table by channel: each channel is one owner's
 * selection ("chart-brush", "grid-rows"), set and cleared on its own.
 */
export class SelectionStore<S extends Schema = Schema> {
  readonly source: Table<S>;
  #channels = new Map<string, DataSelection<S>>();
  #listeners = new Set<() => void>();
  #revision = 0;

  constructor(source: Table<S>) {
    this.source = source;
  }

  /** Increments whenever a channel changes. */
  get revision(): number {
    return this.#revision;
  }

  /** The channels holding a selection. */
  get channels(): string[] {
    return [...this.#channels.keys()];
  }

  get(channel: string): DataSelection<S> | null {
    return this.#channels.get(channel) ?? null;
  }

  /** Sets a channel's selection, or clears it with null. */
  set(channel: string, selection: DataSelection<S> | null): void {
    if (selection === null) {
      if (!this.#channels.delete(channel)) return;
    } else {
      this.#check(selection);
      this.#channels.set(channel, selection);
    }
    this.#revision++;
    for (const listener of [...this.#listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * The conjunction of the conditions of `channels` (rows meeting all of
   * them), to filter a view by; undefined when none of them holds a condition.
   */
  condition(channels: readonly string[]): Expression | undefined {
    const conditions = channels.flatMap((channel) => {
      const selection = this.#channels.get(channel);
      return selection?.kind === "predicate" ? [selection.expression] : [];
    });
    if (conditions.length <= 1) return conditions[0];
    return ["and", ...conditions];
  }

  #check(selection: DataSelection<S>) {
    if (selection.kind === "rows") {
      if (selection.rows.source !== this.source)
        throw new Error("A row selection must be of the store's table");
      return;
    }
    const test = compileExpression(selection.expression, this.source as unknown as Table);
    if (test.type !== "boolean")
      throw new TypeError(`A selection needs a true or false condition, not a ${test.type}`);
  }
}

/** A store of selections of `source`'s rows; see `SelectionStore`. */
export function selectionStore<S extends Schema>(source: Table<S>): SelectionStore<S> {
  return new SelectionStore(source);
}

/** A condition as a selection: `store.set("brush", selectWhere(col("t").ge(a).and(col("t").le(b))))`. */
export function selectWhere(condition: Expr | Expression | boolean): ConditionSelection {
  return {
    kind: "predicate",
    expression: condition instanceof Expr ? condition.expression : condition,
  };
}

/** A row set as a selection. */
export function selectRows<S extends Schema>(set: RowSet<S>): RowsSelection<S> {
  return { kind: "rows", rows: set };
}
