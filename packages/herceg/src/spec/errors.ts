// The errors a chart reports: what went wrong, where, and at which step, in
// one shape for every surface. The engine throws them, the chart shows and
// reports them (`chart.on("error")`, `onError`, `chart.ready`), the static
// renderer hands them to Python as JSON (`ChartErrorInfo`), and the Python
// package raises them as `herceg.ChartError`, a `ValueError`.

/**
 * What kind of problem it is, for programs that react to some:
 *
 * - "invalid-option": an option or spec value is refused.
 * - "unknown-field": a field the mark's table does not have.
 * - "field-type": a field whose values a channel cannot take.
 * - "series-varies": a line's or area's color changes within one of its series.
 * - "series-with-values": several value fields together with a series field.
 * - "unknown-reference": a panel, scale, or mark id the chart does not have.
 * - "layout-failed": the chart cannot fit what it must draw in its size.
 * - "load-failed": code the chart needs could not be loaded.
 * - "render-failed": drawing failed for another reason.
 */
export type ChartErrorCode =
  | "invalid-option"
  | "unknown-field"
  | "field-type"
  | "series-varies"
  | "series-with-values"
  | "unknown-reference"
  | "layout-failed"
  | "load-failed"
  | "render-failed";

/**
 * When it happened: checking options or a spec ("validate"), compiling them
 * ("compile"), loading code ("load"), laying the chart out ("layout"), or
 * drawing a frame of its data ("render").
 */
export type ChartErrorPhase = "validate" | "compile" | "load" | "layout" | "render";

/**
 * A chart error as data, the same in every language: what Python raises
 * and what events and messages between runtimes carry.
 *
 * `message` is shaped "location: problem; correction". `path` is where in
 * the chart's options or spec the problem is, in the spec's spelling,
 * properties joined by dots and list indexes in brackets
 * (`marks[1].encode.color.field`, `scales.region.domain`); a mark function
 * that refuses its options gives the path within them (`color`). Python
 * gives option names in snake_case (`marks[1].stroke_width`), never fields
 * or ids. `mark` names the mark (its `id`, else its index in `marks`) and
 * `panel` the panel, where the problem is one's.
 */
export interface ChartErrorInfo {
  readonly code: ChartErrorCode;
  readonly message: string;
  readonly phase: ChartErrorPhase;
  readonly path?: string | undefined;
  readonly mark?: string | number | undefined;
  readonly panel?: string | undefined;
}

/** Errors made knowing their phase (a layout's), which `chartError` keeps. */
const phased = new WeakSet<ChartError>();

/** A chart error as the engine throws and reports it: an `Error` with `ChartErrorInfo`. */
export class ChartError extends Error implements ChartErrorInfo {
  declare readonly code: ChartErrorCode;
  /** Where the chart met the error, unless it was made knowing (a layout's). */
  declare phase: ChartErrorPhase;
  /** Completed where the error is known to be one mark's or one table's (see `within`). */
  declare path: string | undefined;
  declare mark: string | number | undefined;
  declare readonly panel: string | undefined;

  constructor(info: Omit<ChartErrorInfo, "phase"> & { phase?: ChartErrorPhase }, cause?: unknown) {
    super(info.message, cause === undefined ? undefined : { cause });
    // Fields left out stay undefined: `errorInfo` leaves them out.
    Object.assign(this, info, { name: "ChartError", phase: info.phase ?? "validate" });
    if (info.phase !== undefined) phased.add(this);
  }
}

/**
 * `error`, thrown by what the chart's options at `location` built (a mark
 * of `marks`, named `mark`), placed there: its message starting at the
 * location and, for a ChartError, its path within it.
 */
export function within(location: string, error: unknown, mark?: string | number): Error {
  const message = `${location}: ${(error as Error).message}`;
  if (error instanceof ChartError) {
    error.message = message;
    error.path = error.path === undefined ? location : `${location}.${error.path}`;
    error.mark ??= mark;
    return error;
  }
  if (error instanceof RangeError) return new RangeError(message);
  if (error instanceof TypeError) return new TypeError(message);
  return new Error(message);
}

/** A chart error as JSON-safe data, as other runtimes take it: without its stack and cause. */
export function errorInfo(error: ChartErrorInfo): ChartErrorInfo {
  const { code, message, phase, path, mark, panel } = error;
  return {
    code,
    message,
    phase,
    ...(path !== undefined && { path }),
    ...(mark !== undefined && { mark }),
    ...(panel !== undefined && { panel }),
  };
}

/**
 * `error` as a chart error met in `phase`: a ChartError, at that phase
 * unless made knowing its own, or anything else wrapped as `code` with its
 * message, the original kept as the cause.
 */
export function chartError(
  error: unknown,
  phase: ChartErrorPhase,
  code: ChartErrorCode = phase === "load"
    ? "load-failed"
    : phase === "render"
      ? "render-failed"
      : "invalid-option",
): ChartError {
  if (error instanceof ChartError) {
    if (!phased.has(error)) error.phase = phase;
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const made = new ChartError({ code, message }, error);
  made.phase = phase;
  return made;
}
