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

import {readFile} from 'node:fs/promises';

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
 * available). The `snapshot` variant reads `src.path` from disk and
 * parses the contents as the serialized `AppSurface` shape. Asymmetric
 * on purpose — suites that need `route_specs` (with closures) must use
 * the `inline` variant; suites working on the `AppSurface` shape work
 * with either.
 *
 * @throws Error when the snapshot file is unreadable or contains
 *   non-JSON content. The thrown message names the path so a mistyped
 *   `surface_source.path` surfaces clearly. Structural validation
 *   against the `AppSurface` schema is the caller's responsibility —
 *   the cross-process schema-parity primitives
 *   (`assert_schema_snapshots_equal`) already gate consumer drift.
 */
export const resolve_surface_source = async (
	src: SurfaceSource,
): Promise<AppSurface | AppSurfaceSpec> => {
	if (src.kind === 'inline') return src.spec;
	let raw: string;
	try {
		raw = await readFile(src.path, 'utf-8');
	} catch (err) {
		throw new Error(`surface_source snapshot unreadable at ${src.path}: ${(err as Error).message}`);
	}
	try {
		return JSON.parse(raw) as AppSurface;
	} catch (err) {
		throw new Error(
			`surface_source snapshot at ${src.path} is not valid JSON: ${(err as Error).message}`,
		);
	}
};
