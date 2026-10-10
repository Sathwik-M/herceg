// Selections of a remote source's rows. The page holds only windows of
// them, so a selection cannot be row positions (the local `SelectionStore`
// holds row sets of a table): it is a set of records' keys, or a condition
// ("all matching") with keys added to it and taken out. Both are portable,
// so a server can run them as a query's filter (`selectionCondition`).

import { compileExpression, Expr, type Expression } from "../data/expression.ts";
import { checkJson, type GridSchema, type RowKey, schemaFields } from "./query.ts";

/**
 * Records chosen by key, or every row meeting `where` (as the source holds
 * them, now and later) or keyed in `include`, but none keyed in `except`.
 */
export type RemoteSelection =
  | { readonly kind: "keys"; readonly keys: readonly RowKey[] }
  | {
      readonly kind: "matching";
      readonly where: Expression;
      readonly include: readonly RowKey[];
      readonly except: readonly RowKey[];
    };

/**
 * Selections of one remote source's rows by channel, as `SelectionStore`
 * holds a local table's: each channel one owner's selection, set and
 * cleared on its own. Selections are frozen when set.
 */
export class RemoteSelectionStore {
  readonly schema: GridSchema;
  #channels = new Map<string, RemoteSelection>();
  /** Each channel's changes, counted. */
  #versions = new Map<string, number>();
  #listeners = new Set<() => void>();
  #revision = 0;

  constructor(schema: GridSchema) {
    this.schema = schema;
  }

  /** Increments whenever a channel changes. */
  get revision(): number {
    return this.#revision;
  }

  get channels(): string[] {
    return [...this.#channels.keys()];
  }

  get(channel: string): RemoteSelection | null {
    return this.#channels.get(channel) ?? null;
  }

  /** Increments whenever the channel's selection changes. */
  version(channel: string): number {
    return this.#versions.get(channel) ?? 0;
  }

  /** Sets a channel's selection, or clears it with null. */
  set(channel: string, selection: RemoteSelection | null): void {
    if (selection === null) {
      if (!this.#channels.delete(channel)) return;
    } else this.#channels.set(channel, this.#checked(selection));
    this.#versions.set(channel, this.version(channel) + 1);
    this.#revision++;
    for (const listener of [...this.#listeners]) listener();
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #checked(selection: RemoteSelection): RemoteSelection {
    const { key } = this.schema;
    // Keys of a category field are labels; of a number field, safe integers.
    const labels = key !== null && this.schema.fields[key] === "category";
    const keys = (list: readonly RowKey[]) => {
      if (!Array.isArray(list)) throw new TypeError("A selection's keys must be a list");
      if (list.length > 0 && key === null)
        throw new Error(`"${this.schema.source}" names no key: rows are selected by condition`);
      for (const value of list)
        if (labels ? typeof value !== "string" : !Number.isSafeInteger(value))
          throw new TypeError(
            `Keys of "${key}" are ${labels ? "strings" : "safe integers"}, not ${JSON.stringify(value)}`,
          );
      // A key is selected once, however often given.
      return Object.freeze([...new Set(list)]);
    };
    if (selection.kind === "keys")
      return Object.freeze({ kind: "keys", keys: keys(selection.keys) });
    if (selection.kind !== "matching")
      throw new TypeError(`Unknown selection kind "${(selection as { kind: string }).kind}"`);
    checkJson(selection.where);
    const test = compileExpression(selection.where, schemaFields(this.schema));
    if (test.type !== "boolean")
      throw new TypeError(`A selection needs a true or false condition, not a ${test.type}`);
    const except = new Set(selection.except);
    return Object.freeze({
      kind: "matching",
      // A copy, frozen: a condition changed later must not change the selection.
      where: frozenCopy(selection.where),
      // Exceptions win over additions.
      include: keys(selection.include.filter((value) => !except.has(value))),
      except: keys(selection.except),
    });
  }
}

/** A store of selections of a remote source's rows; see `RemoteSelectionStore`. */
export function remoteSelectionStore(schema: GridSchema): RemoteSelectionStore {
  return new RemoteSelectionStore(schema);
}

/** Records by key, as a selection. */
export function selectKeys(keys: readonly RowKey[]): RemoteSelection {
  return { kind: "keys", keys };
}

/** Every row meeting a condition, as a selection, with keys added and taken out. */
export function selectMatching(
  where: Expr | Expression | boolean,
  { include = [], except = [] }: { include?: readonly RowKey[]; except?: readonly RowKey[] } = {},
): RemoteSelection {
  return {
    kind: "matching",
    where: where instanceof Expr ? where.expression : where,
    include,
    except,
  };
}

/**
 * A selection as a condition on the source's fields, `key` its key field:
 * what a server filters by to act on the selected rows.
 */
export function selectionCondition(selection: RemoteSelection, key: string | null): Expression {
  const among = (keys: readonly RowKey[]): Expression =>
    keys.length === 0 || key === null ? false : ["in", ["field", key], ...keys];
  if (selection.kind === "keys") return among(selection.keys);
  const { where, include, except } = selection;
  const added: Expression = include.length > 0 ? ["or", where, among(include)] : where;
  return except.length > 0 ? ["and", added, ["not", among(except)]] : added;
}

/** Whether a selection holds a row, given its key and whether it meets the selection's condition. */
export function selectionHas(
  selection: RemoteSelection,
  sets: { keys: ReadonlySet<RowKey>; include: ReadonlySet<RowKey>; except: ReadonlySet<RowKey> },
  key: RowKey | null,
  meets: () => boolean,
): boolean {
  if (selection.kind === "keys") return key !== null && sets.keys.has(key);
  if (key !== null && sets.except.has(key)) return false;
  return (key !== null && sets.include.has(key)) || meets();
}

function frozenCopy(expression: Expression): Expression {
  return (
    Array.isArray(expression) ? Object.freeze(expression.map(frozenCopy)) : expression
  ) as Expression;
}
