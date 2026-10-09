// The herceg grid as a React component, imported as `@herceg/react/grid` so
// that applications drawing only charts never load it.

import type { Schema } from "herceg";
import { createGrid, type GridModel, type GridOptions, type Grid as HercegGrid } from "herceg/grid";
import { type CSSProperties, type Ref, useImperativeHandle, useLayoutEffect, useRef } from "react";

export interface GridProps<S extends Schema = Schema> extends Omit<GridOptions<S>, "model"> {
  /**
   * What the grid shows, made with `createGridModel` and owned by the
   * application. Data changes, scrolling, focus, and selection go through it
   * and the grid, never through React; a new model makes a new grid.
   */
  model: GridModel<S>;
  className?: string;
  /** Style of the container. Without a height, the grid is 320 px tall. */
  style?: CSSProperties;
  /** The underlying grid, for imperative calls such as `focusCell`. */
  ref?: Ref<HercegGrid<S> | null>;
}

/**
 * A herceg grid. Props other than `model` are applied with `grid.update`
 * when they change; a theme or header height no longer passed goes back to
 * its default.
 *
 * ```tsx
 * const model = useMemo(() => createGridModel({ data: rowView(requests), columns }), []);
 * <Grid model={model} ariaLabel="Requests" />
 * ```
 */
export function Grid<S extends Schema>({ model, className, style, ref, ...options }: GridProps<S>) {
  const container = useRef<HTMLDivElement>(null);
  const grid = useRef<HercegGrid<S> | null>(null);
  /** The options the grid has, to skip updates when a re-render changed none. */
  const applied = useRef("");
  const { ariaLabel, theme, headerHeight } = options;
  const key = JSON.stringify([ariaLabel, theme, headerHeight]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: options change through update()
  useLayoutEffect(() => {
    const created = createGrid(container.current!, {
      model,
      ariaLabel,
      ...(theme !== undefined && { theme }),
      ...(headerHeight !== undefined && { headerHeight }),
    });
    grid.current = created;
    applied.current = key;
    return () => {
      created.destroy();
      grid.current = null;
    };
  }, [model]);

  useLayoutEffect(() => {
    if (!grid.current || applied.current === key) return;
    applied.current = key;
    grid.current.update({ ariaLabel, theme, headerHeight });
  });

  // A new model makes a new grid, which the ref then gives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the grid changes with the model
  useImperativeHandle<HercegGrid<S> | null, HercegGrid<S> | null>(ref, () => grid.current, [model]);

  return <div ref={container} className={className} style={style} />;
}
