/**
 * The **surface census** — every site in the TS spine that consumes a resolved
 * credential, classified as resolving the scope, consulting it, or exempt with
 * a stated reason.
 *
 * ## Why this test exists
 *
 * Twin of the Rust spine's `fuz_auth/tests/token_scope_surface_census.rs`, and
 * it exists because that twin did not. Token scoping shipped on both spines the
 * same day; on this side rule 3 (*a narrowed token reaches no non-RPC surface*)
 * was **declared but unwired** — `token_scope_admits_non_rpc` and
 * `TOKEN_SURFACE_CAPABILITIES` were exported with docstrings asserting the rule
 * while nothing called them, and the WS upgrade carried a comment claiming a
 * narrowed token could not upgrade when nothing stopped it. A manual read
 * caught it. The Rust half could not fail the same way because its census
 * enumerated the call sites.
 *
 * A declared capability with no consumer is precisely what made the 2026-02
 * `scope` column a false promise, so the asymmetry — not the specific miss —
 * was the hole. This closes it.
 *
 * ## What it pins
 *
 * The realistic failure is not deleting a check; it is **adding a surface and
 * forgetting one**. A new bearer-reachable route that reads the authenticated
 * identity and never asks what that credential may do is a silent hole in the
 * original defect's exact shape, and it is invisible without a grep.
 *
 * So the set of credential-consuming sites is an assertion. It is a source
 * scan, deliberately: the property ("no *unreviewed* site exists") is about
 * code not yet written, which no type can express.
 *
 * The TS spine also needs one assertion the Rust census does not. Rust resolves
 * every credential through a single `resolve_auth_from_headers`, so a resolved
 * credential always carries a scope — `ResolvedAuth.scope` is not optional.
 * Here resolution is three separate middlewares writing `TOKEN_SCOPE_KEY` into
 * the Hono context, and the shared guard `token_scope_surface_denial` must read
 * that key defensively (`scope && !admits(scope)`) because the anonymous caller
 * has none. A fourth middleware that authenticated someone and forgot the key
 * would therefore sail through every rule-3 surface at once — the permissive
 * default, re-entered by omission. The `resolvers set the token scope` case
 * below pins it.
 *
 * **This is the proportionate control, not the strongest one.** The strongest
 * is making the scope-consulting read the only way to obtain a usable identity,
 * so a forgetful surface fails to compile. That was costed and declined on the
 * Rust side (it changes every call site, and the WS path needs the scope to
 * survive the upgrade rather than be consumed by it); the same reasoning holds
 * here. **If a surface ever does slip past this census, that typestate is the
 * named escalation.**
 *
 * @module
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, assert, test } from 'vitest';

import {
	is_token_surface,
	TOKEN_SURFACE_CAPABILITIES,
	type TokenSurface
} from '$lib/auth/token_scope.ts';

/** How a reviewed site relates to the credential's `TokenScope`. */
type CensusRole =
	/** Authenticates a caller and writes the scope into the request context. */
	| 'resolves'
	/** Reads the scope and refuses what it does not admit. */
	| 'consults'
	/** Reads a resolved credential but applies no scope check — reason required. */
	| 'exempt';

/** A reviewed credential-consuming site. */
interface CensusEntry {
	/** Path relative to `src/lib/`. */
	file: string;
	/** Which side of the gate this site is on. */
	role: CensusRole;
	/**
	 * Why — required in every direction, so an exemption is an argument someone
	 * wrote down rather than an omission nobody noticed.
	 */
	reason: string;
}

/**
 * Every site in the spine that reads a resolved credential off the request.
 *
 * Adding a row here is the review. A new bearer-reachable surface must decide
 * which side it is on **and say why**, which is the whole point.
 */
const CENSUS: ReadonlyArray<CensusEntry> = [
	// --- Resolves: writes the scope every gate below reads ---
	{
		file: 'auth/bearer_auth.ts',
		role: 'resolves',
		reason:
			'the only credential that can carry a narrowing — reads `api_token.scope` off the validated row, fail-closed to full only when the row parses (an unreadable document refuses the credential outright)'
	},
	{
		file: 'auth/request_context.ts',
		role: 'resolves',
		reason:
			'session cookies resolve to full by construction — a browser session *is* full account authority, and narrowing it is what role grants are for'
	},
	{
		file: 'auth/daemon_token_middleware.ts',
		role: 'resolves',
		reason:
			'the daemon token resolves to full — singular, filesystem-proved, and keeper-bound, with no minting surface to attach a narrowing to'
	},
	// --- Consults scope ---
	{
		file: 'actions/action_rpc.ts',
		role: 'consults',
		reason:
			'HTTP JSON-RPC entry — threads the scope into `perform_action`, which runs the per-method gate between the credential gate and the role gate'
	},
	{
		file: 'actions/register_action_ws.ts',
		role: 'consults',
		reason:
			'WS upgrade — rule 3 rejects a narrowed token at the boundary (server-initiated pushes have no per-recipient filter), and the socket retains the scope for the per-message gate'
	},
	{
		file: 'actions/register_ws_endpoint.ts',
		role: 'consults',
		reason:
			'the composed upgrade stack mounts the rule-3 guard between `require_auth` and the role guard, so a narrowed token hears about its scope rather than about a role it also lacks; `register_action_ws` repeats the check for consumers that mount it directly'
	},
	{
		file: 'auth/audit_log_route_schema.ts',
		role: 'consults',
		reason:
			'declares `token_surface: audit_stream` on the route shape — a long-lived admin SSE feed with no point after open at which a narrowing could be applied'
	},
	{
		file: 'server/serve_fact_route.ts',
		role: 'consults',
		reason:
			'declares `token_surface: fact_bare` — the admin-only bare-hash read serves any stored fact with no per-reference cell check; the sibling per-cell route is ungated because its authz is the `(cell, hash)` edge, which a narrowed token can already reach through the RPC methods it names'
	},
	// --- Exempt, with reasons ---
	{
		file: 'auth/audit_log_routes.ts',
		role: 'exempt',
		reason:
			'the SSE handler behind the shape above; it reads the resolved context to key the subscription and adds no reach of its own, the rule-3 decision having been declared on the shape it spreads'
	},
	{
		file: 'auth/account_routes.ts',
		role: 'exempt',
		reason:
			"`/status` and `/verify` read back the caller's own credential state, which crosses no boundary; `/login` mints and `/logout` tears down; `/password` is already credential-gated to the session channel, so no bearer credential arrives"
	}
];

/**
 * The ways a surface can reach the resolved credential. A site touching any of
 * these has an authenticated caller in hand and must decide whether the
 * credential's scope applies.
 *
 * Broader than the Rust scan's single `resolve_auth_from_headers` because TS
 * resolution is middleware-and-context rather than one function — and the
 * breadth is load-bearing: the audit SSE route reaches its caller through
 * `require_request_context` alone, so a scan for the context *keys* would have
 * missed it.
 */
const CREDENTIAL_MARKERS: ReadonlyArray<string | RegExp> = [
	'ACCOUNT_ID_KEY',
	'CREDENTIAL_TYPE_KEY',
	'TOKEN_SCOPE_KEY',
	'REQUEST_CONTEXT_KEY',
	'require_request_context',
	'get_request_context',
	'token_scope_surface_denial',
	// A route shape declaring the rule-3 slot decides about a credential's
	// scope without otherwise touching one, so it needs its own marker.
	// Anchored to a property declaration rather than matched as a substring:
	// the field is *named* in the `RouteAuth` definition, in the resolver that
	// reads it, and in the registry error that rejects it on an action — none
	// of which consume a credential, and all of which a bare `token_surface: '`
	// would drag into the census.
	/^\s*token_surface: '/mu
] as const;

/**
 * Files the scan sees that are not production surfaces: the context-key
 * declarations themselves, and the test harnesses, whose middlewares fabricate
 * a credential rather than resolve one and which no production server mounts.
 *
 * An explicit list rather than a path filter in the walker, so the exclusions
 * are as reviewable as the inclusions. Keep it to files whose *code* reaches a
 * marker — a file that only mentions one in a comment is handled by
 * `strip_comments` and never reaches this list.
 */
const NON_SURFACE_SITES: ReadonlyArray<string> = [
	'hono_context.ts',
	'testing/auth_apps.ts',
	'testing/middleware.ts',
	'testing/ws_round_trip.ts'
];

/**
 * Which file gates each rule-3 surface and the exact source it must contain,
 * or `null` when the spine does not mount the surface.
 *
 * Two shapes, because there are two kinds of surface. A route spec declares
 * `token_surface` on its `auth` and `fuz_auth_guard_resolver` mounts the guard
 * ahead of the role gate; the WS upgrade is not a route spec, so it calls the
 * shared decision directly. Both are exact-match, so a gate that is imported
 * and documented but never reached still fails — the original miss's shape.
 *
 * `db_admin` is `null`, but **not** because the spine ships no table browser —
 * `http/db_routes.ts` is exactly that, a generic browser over the `public`
 * schema with row `DELETE`. It needs no `token_surface` because its shipped
 * auth is `credential_types: ['daemon_token']`, and a daemon token resolves to
 * `full` by construction: no narrowed credential can reach it, and the
 * credential gate — which now runs ahead of the scope guard — answers first
 * with the coarser `credential_type_required`. Declaring the surface would
 * invert that and name a scope to a channel that may never call the route at
 * all.
 *
 * **The hazard that reasoning rests on is the consumer's auth, not ours.** A
 * consumer mounting `create_db_route_specs` under a widened `auth` — dropping
 * the credential gate, or swapping keeper for an admin role a bearer
 * satisfies — puts every `public` row behind a credential this census no
 * longer describes. That exact rewrite is how the capability string came to
 * exist. A consumer carries its own census; the spine cannot see its surfaces,
 * and cannot see its own surfaces re-authed. See ../../../docs/security.md
 * §Token scoping.
 */
const RULE_3_SURFACE_SITES: Record<TokenSurface, { file: string; source: string } | null> = {
	fact_bare: {
		file: 'server/serve_fact_route.ts',
		source: "token_surface: 'fact_bare'"
	},
	ws_upgrade: {
		file: 'actions/register_action_ws.ts',
		source: "token_scope_surface_denial(c, 'ws_upgrade')"
	},
	audit_stream: {
		file: 'auth/audit_log_route_schema.ts',
		source: "token_surface: 'audit_stream'"
	},
	db_admin: null
};

/** Matches a route spec's `token_surface: '<name>'` declaration. */
const TOKEN_SURFACE_DECLARATION = /token_surface:\s*'([a-z_]+)'/gu;

const lib_dir = fileURLToPath(new URL('../../lib', import.meta.url));

/** Read a censused file's source by its `src/lib`-relative path. */
const read_lib_source = (file: string): string => readFileSync(join(lib_dir, file), 'utf-8');

/** Walk `src/lib` for files whose source matches a predicate, by relative path. */
const discover_lib_files = (matches: (source: string) => boolean): Set<string> => {
	const found = new Set<string>();
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(join(dir, entry.name), rel);
			} else if (entry.name.endsWith('.ts') || entry.name.endsWith('.svelte')) {
				if (matches(readFileSync(join(dir, entry.name), 'utf-8'))) found.add(rel);
			}
		}
	};
	walk(lib_dir, '');
	return found;
};

/**
 * Blank out comments, preserving every newline so line-anchored markers still
 * match at their real positions.
 *
 * The census asks whether a file **reaches** a resolved credential, and prose
 * doesn't. Without this, documenting a marker pulls the documenting file into
 * the census — which happened twice: `http/error_schemas.ts` naming
 * `token_scope_surface_denial` in the TSDoc for the shape it declares, and
 * `actions/action_bridge.ts` telling consumers to read `TOKEN_SCOPE_KEY`
 * themselves. Both were the right thing to write and neither touches a
 * credential. Parking them in `NON_SURFACE_SITES` would have made the
 * exclusion list absorb a scanner bug, and left every future cross-reference
 * a tripwire.
 */
const strip_comments = (source: string): string =>
	source
		.replace(/\/\*[\s\S]*?\*\//gu, (block) => block.replace(/[^\n]/gu, ' '))
		.replace(/\/\/[^\n]*/gu, '');

/** Walk `src/lib` for files that reach a resolved credential. */
const discover_credential_sites = (): Set<string> =>
	discover_lib_files((raw) => {
		const source = strip_comments(raw);
		return CREDENTIAL_MARKERS.some((marker) =>
			typeof marker === 'string' ? source.includes(marker) : marker.test(source)
		);
	});

/** Walk `src/lib` for files declaring `token_surface` on a route spec. */
const discover_declared_token_surfaces = (): Set<string> =>
	discover_lib_files((raw) => strip_comments(raw).includes('token_surface:'));

describe('token scope surface census', () => {
	/**
	 * Every credential-consuming site is reviewed.
	 *
	 * Failing here means a surface was added that reads an authenticated
	 * identity without anyone deciding whether the credential's scope applies.
	 * Add a `CensusEntry` — and if the answer is "exempt", write the reason,
	 * because that reason is the artifact this test exists to produce.
	 */
	test('every credential-consuming site is reviewed', () => {
		const discovered = discover_credential_sites();
		const reviewed = new Set([...CENSUS.map((e) => e.file), ...NON_SURFACE_SITES]);

		const unreviewed = [...discovered].filter((f) => !reviewed.has(f)).sort();
		assert.deepStrictEqual(
			unreviewed,
			[],
			"unreviewed credential-consuming sites — each must decide whether the token scope applies, and say why (see this module's docs)"
		);

		const vanished = [...reviewed].filter((f) => !discovered.has(f)).sort();
		assert.deepStrictEqual(
			vanished,
			[],
			'census names sites that no longer consume a credential — a stale entry makes the census read as covering more than it does'
		);
	});

	/**
	 * Every census entry carries a reason, in every direction.
	 *
	 * An exemption without an argument is indistinguishable from an oversight;
	 * this is what keeps the exempt list from becoming a place to park things.
	 */
	test('every census entry states its reasoning', () => {
		for (const entry of CENSUS) {
			assert.ok(entry.reason.length > 20, `${entry.file} needs a real reason, not a placeholder`);
		}
	});

	/**
	 * The scope-consulting set is exactly the two RPC transports plus the
	 * non-RPC surfaces the spine mounts — pinned as an exact list so *narrowing*
	 * it (deleting a check) fails here too, not just widening it.
	 */
	test('the scope-consulting set is the expected one', () => {
		const consulting = CENSUS.filter((e) => e.role === 'consults')
			.map((e) => e.file)
			.sort();
		assert.deepStrictEqual(consulting, [
			'actions/action_rpc.ts',
			'actions/register_action_ws.ts',
			'actions/register_ws_endpoint.ts',
			'auth/audit_log_route_schema.ts',
			'server/serve_fact_route.ts'
		]);
	});

	/**
	 * Every resolver writes `TOKEN_SCOPE_KEY`.
	 *
	 * The TS-specific half of the census, and the one with no Rust twin. Every
	 * gate reads the key as `scope && !admits(scope)` — necessarily, since the
	 * anonymous caller holds no credential to narrow — so a middleware that
	 * authenticates a caller and leaves the key unset makes that caller
	 * *un-narrowable* at every surface at once. That is the permissive default
	 * this design removed, re-entered by omission rather than by decision.
	 */
	test('resolvers set the token scope', () => {
		for (const entry of CENSUS) {
			if (entry.role !== 'resolves') continue;
			const source = read_lib_source(entry.file);
			assert.ok(
				source.includes(`c.set(TOKEN_SCOPE_KEY`),
				`${entry.file} resolves a credential but never sets TOKEN_SCOPE_KEY — the caller would be un-narrowable at every surface`
			);
		}
	});

	/**
	 * The rule-3 map, the census, and the source agree — for every surface the
	 * spine mounts.
	 *
	 * The source half is the assertion that would have caught the original miss:
	 * it fails on a gate that is *declared* — imported, documented, commented —
	 * but never reached, because it demands the call naming that exact surface.
	 * The census half stops the two lists drifting, so a surface cannot be gated
	 * in `RULE_3_SURFACE_SITES` while reading as exempt in `CENSUS`. `db_admin`
	 * is exempt by absence, not by allowance; see `RULE_3_SURFACE_SITES`.
	 */
	test('every mounted rule-3 surface is censused as consulting and reaches the guard', () => {
		const consulting = new Set(CENSUS.filter((e) => e.role === 'consults').map((e) => e.file));
		for (const surface of Object.keys(TOKEN_SURFACE_CAPABILITIES) as Array<TokenSurface>) {
			const site = RULE_3_SURFACE_SITES[surface];
			if (site === null) continue;
			assert.ok(
				consulting.has(site.file),
				`${site.file} gates the ${surface} surface but is not censused as consulting scope`
			);
			assert.ok(
				read_lib_source(site.file).includes(site.source),
				`${site.file} gates the ${surface} surface but does not contain \`${site.source}\``
			);
		}
	});

	/**
	 * Every declared `token_surface` names a real surface.
	 *
	 * `RouteAuth` types the field as a plain string so `http/` needs no `auth/`
	 * import, which means a typo is a value error rather than a type error.
	 * `fuz_auth_guard_resolver` throws on one at registration; this catches it
	 * without standing an app up.
	 */
	test('declared token surfaces exist', () => {
		const declared = new Set<string>();
		for (const file of discover_declared_token_surfaces()) {
			for (const match of strip_comments(read_lib_source(file)).matchAll(
				TOKEN_SURFACE_DECLARATION
			)) {
				declared.add(match[1]!);
			}
		}
		const unknown = [...declared].filter((s) => !is_token_surface(s)).sort();
		assert.deepStrictEqual(unknown, [], 'route specs declare token surfaces that do not exist');
	});
});
