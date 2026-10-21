/**
 * Import-graph gate: every `src/lib` module stays free of the optional `hono`
 * peer unless it's listed in `HONO_SIDE`.
 *
 * `hono` and the `@hono/*` adapters are optional peers. A consumer whose
 * backend is a spawned Rust binary installs neither: it imports fuz_app's
 * client, specs, and UI, and runs the cross-process suites against that binary
 * over HTTP. One value import of `hono` anywhere in those modules' static graph
 * makes the consumer's suites or build fail to load
 * (`Could not resolve "hono/utils/ipaddr"`), and nothing in fuz_app's own run
 * notices, since fuz_app installs hono. This walks the graph instead.
 *
 * Every `.ts` and `.svelte` module under `src/lib` is covered by default.
 * `HONO_SIDE` lists the modules that build or drive a Hono app on purpose
 * (the TS server, its route and middleware factories, and the in-process test
 * harnesses), and is itself checked for staleness: each entry must exist and
 * still reach hono.
 *
 * A whole-statement `import type` / `export type` is erased and skipped; any
 * other static import or re-export is followed, `import { type X }` included
 * (its statement survives emit). Dynamic `import()` is lazy and not followed.
 * A relative or `#lib/` specifier that doesn't resolve to a file fails the
 * walk, so a missed module can't silently shrink the graph.
 *
 * @module
 */

import { test, assert, describe } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve } from 'node:path';

/** Absolute path to `src/lib`, resolved relative to this test. */
const LIB_DIR = join(dirname(fileURLToPath(import.meta.url)), '../lib');

/** `src/lib` modules that reach hono by design, relative to `src/lib`. */
const HONO_SIDE: ReadonlySet<string> = new Set([
	'auth/account_routes.ts',
	'auth/audit_log_routes.ts',
	'auth/bootstrap_routes.ts',
	'auth/session_middleware.ts',
	'auth/signup_routes.ts',
	'http/body_limit.ts',
	'http/proxy.ts',
	'realtime/sse.ts',
	'server/app_server.ts',
	'testing/adversarial_404.ts',
	'testing/adversarial_headers.ts',
	'testing/adversarial_input.ts',
	'testing/app_server.ts',
	'testing/attack_surface.ts',
	'testing/auth_apps.ts',
	'testing/bootstrap_success.ts',
	'testing/cross_backend/default_spine_surface.ts',
	'testing/cross_backend/full_spine_mount.ts',
	'testing/cross_backend/in_process_setup.ts',
	'testing/cross_backend/testing_reset_actions.ts',
	'testing/cross_backend/testing_server_bun.ts',
	'testing/cross_backend/testing_server_deno.ts',
	'testing/cross_backend/testing_server_node.ts',
	'testing/middleware.ts',
	'testing/rate_limiting.ts',
	'testing/rpc_attack_surface.ts',
	'testing/sse_round_trip.ts',
	'testing/standard.ts',
	'testing/ws_round_trip.ts'
]);

/** A static `import` / `export … from` statement; group 1 is `type `, group 2 the specifier. */
const STATIC_IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]/gm;

const HONO_SPECIFIER = /^(?:hono|@hono\/)/;

/** Module extensions the walk follows; other in-repo targets (JSON, CSS) are leaves. */
const MODULE_EXTENSION = /\.(?:ts|svelte)$/;

/** The static, value-carrying imports of `file`. */
const value_imports = (file: string): Array<string> => {
	const specifiers: Array<string> = [];
	for (const match of readFileSync(file, 'utf8').matchAll(STATIC_IMPORT)) {
		if (!match[1]) specifiers.push(match[2]!);
	}
	return specifiers;
};

/** Resolve an in-repo specifier to an absolute path, `null` for a package import. */
const resolve_local = (from: string, specifier: string): string | null => {
	if (specifier.startsWith('.')) return resolve(dirname(from), specifier);
	if (specifier.startsWith('#lib/')) return join(LIB_DIR, specifier.slice('#lib/'.length));
	return null;
};

interface HonoWalk {
	/** Every hono value import reachable, each as its chain (`a.ts → b.ts → hono/cookie`). */
	chains: Array<string>;
	/** In-repo specifiers that resolve to no file, as `module → specifier`. */
	unresolved: Array<string>;
}

/** Walk the static value-import graph from `entry`. */
const walk_hono = (entry: string): HonoWalk => {
	const parent: Map<string, string | null> = new Map([[entry, null]]);
	const chains: Array<string> = [];
	const unresolved: Array<string> = [];
	const chain_to = (file: string): Array<string> => {
		const path: Array<string> = [];
		for (let f: string | null = file; f !== null; f = parent.get(f) ?? null) {
			path.unshift(relative(LIB_DIR, f));
		}
		return path;
	};
	const queue = [entry];
	while (queue.length > 0) {
		const file = queue.shift()!;
		for (const specifier of value_imports(file)) {
			if (HONO_SPECIFIER.test(specifier)) {
				chains.push([...chain_to(file), specifier].join(' → '));
				continue;
			}
			const target = resolve_local(file, specifier);
			if (target === null) continue;
			if (!existsSync(target)) {
				unresolved.push(`${relative(LIB_DIR, file)} → ${specifier}`);
				continue;
			}
			if (MODULE_EXTENSION.test(target) && !parent.has(target)) {
				parent.set(target, file);
				queue.push(target);
			}
		}
	}
	return { chains, unresolved };
};

const lib_modules = (): Array<string> =>
	readdirSync(LIB_DIR, { recursive: true, encoding: 'utf8' })
		.filter((name) => MODULE_EXTENSION.test(name))
		.sort();

describe('src/lib modules reach no hono value import unless listed in HONO_SIDE', () => {
	for (const module of lib_modules()) {
		if (HONO_SIDE.has(module)) continue;
		test(module, () => {
			const { chains, unresolved } = walk_hono(join(LIB_DIR, module));
			assert.deepStrictEqual(unresolved, [], 'unresolved in-repo imports');
			assert.deepStrictEqual(chains, []);
		});
	}

	test('every HONO_SIDE entry exists and does reach hono', () => {
		// a stale entry would silently exempt a module that could stay hono-free
		for (const module of HONO_SIDE) {
			const file = join(LIB_DIR, module);
			assert.ok(existsSync(file), `${module} is listed but missing`);
			assert.ok(walk_hono(file).chains.length > 0, `${module} no longer needs hono — drop it`);
		}
	});
});
