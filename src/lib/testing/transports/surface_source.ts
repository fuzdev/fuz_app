import '../assert_dev_env.js';

/**
 * Discriminated source for the `AppSurface` a suite asserts against.
 *
 * In-process callers pass `{kind: 'inline', spec}` — the full
 * `AppSurfaceSpec` with route closures intact. Cross-process callers
 * pass `{kind: 'snapshot', path}` — a committed JSON file containing
 * only the JSON-serializable `AppSurface` shape.
 *
 * Backs the suite parameter that previously was `build: () => AppSurfaceSpec`.
 *
 * @module
 */

import type {AppSurface, AppSurfaceSpec} from '../../http/surface.js';

/**
 * Where a suite reads the `AppSurface` from for its assertions.
 *
 * Two variants. The `inline` variant carries the full `AppSurfaceSpec`
 * (with route closures) — the only variant in-process suites can use
 * for route-iteration tests, since route closures aren't JSON-serializable.
 * The `snapshot` variant carries a path to a committed JSON file containing
 * the `AppSurface` shape only — cross-process consumers use this to assert
 * against a backend that doesn't share TS handler closures.
 *
 * No `'fetched'` (live `/api/surface` endpoint) variant: a dead union
 * case is dead weight and a code-shaped invitation to add a debug
 * endpoint the design explicitly rejected; committed snapshot is the
 * contract.
 */
export type SurfaceSource =
	| {readonly kind: 'inline'; readonly spec: AppSurfaceSpec}
	| {readonly kind: 'snapshot'; readonly path: string};

/**
 * Resolve a `SurfaceSource` to the underlying surface shape.
 *
 * The `inline` variant returns the full `AppSurfaceSpec` (route closures
 * available). The `snapshot` variant returns the serialized `AppSurface`
 * shape only. Asymmetric on purpose — suites that need `route_specs`
 * (with closures) must use the `inline` variant; suites working on the
 * `AppSurface` shape work with either.
 *
 * @throws Error when called with `{kind: 'snapshot'}` — the snapshot
 *   variant lands alongside the cross-process transport plumbing.
 *   No in-process caller exercises this branch today.
 */
export const resolve_surface_source = async (
	src: SurfaceSource,
): Promise<AppSurface | AppSurfaceSpec> => {
	if (src.kind === 'inline') return src.spec;
	throw new Error(
		`surface_source.kind === 'snapshot' is not yet implemented; lands with cross-process transport plumbing (path=${src.path})`,
	);
};
