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

import { is_token_surface, TOKEN_SURFACES, type TokenSurface } from '$lib/auth/token_scope.ts';

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
		file: 'actions/perform_action.ts',
		role: 'consults',
		reason:
			'the shared dispatch core, and the per-method gate itself — runs between the credential gate and the role gate for every transport that reaches it (HTTP RPC and WS)'
	},
	{
		file: 'actions/action_bridge.ts',
		role: 'consults',
		reason:
			'derives `required_scope: rpc:<method>` onto every bridged route — a bridged handler runs through the REST pipeline and never reaches `perform_action`, so without this the per-method gate simply would not fire on that transport'
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
	// Building a capability string is deciding what a credential's scope must
	// admit, which is a census-worthy act even in a file that never reads one:
	// it is how `actions/action_bridge.ts` gates a route the dispatcher can't.
	'token_scope_method_capability',
	// A route shape declaring the scope slot decides about a credential's
	// scope without otherwise touching one, so it needs its own marker.
	// Anchored to a property declaration rather than matched as a substring:
	// the field is *named* in the `RouteAuth` definition, in the resolver that
	// reads it, and in the registry error that rejects it on an action — none
	// of which consume a credential, and all of which a bare `required_scope: '`
	// would drag into the census.
	/^\s*required_scope: '/mu
] as const;

/**
 * Files the scan sees that are not production surfaces: the context-key
 * declarations themselves, and the test harnesses, whose middlewares fabricate
 * a credential rather than resolve one and which no production server mounts.
 *
 * An explicit list rather than a path filter in the walker, so the exclusions
 * are as reviewable as the inclusions. Keep it to files whose *code* reaches a
 * marker — a file that only mentions one in a comment is handled by
 * `strip_comment_lines` and never reaches this list.
 */
const NON_SURFACE_SITES: ReadonlyArray<string> = [
	'hono_context.ts',
	// The capability vocabulary itself, for the same reason `hono_context.ts`
	// is here: it declares the names every gate below is written in, and holds
	// no credential of its own.
	'auth/token_scope.ts',
	'testing/auth_apps.ts',
	'testing/middleware.ts',
	'testing/ws_round_trip.ts'
];

/**
 * Which file gates each rule-3 surface and the exact source it must contain,
 * or `null` when the spine does not mount the surface.
 *
 * Two shapes, because there are two kinds of surface. A route spec declares
 * `required_scope: 'surface:<name>'` on its `auth` and `fuz_auth_guard_resolver`
 * mounts the guard ahead of the role gate; the WS upgrade is not a route spec,
 * so it calls the shared decision directly. Both are exact-match, so a gate
 * that is imported and documented but never reached still fails — the original
 * miss's shape.
 *
 * Both spellings name the surface the same way — `'surface:<name>'` — so the
 * declaration scan below covers the direct call too, and every site here is
 * pinned twice: once by exact source, once by "names a surface we mount". The
 * direct-call form deliberately isn't type-narrowed to `TokenSurface` (a
 * consumer surface would have nothing to pass), so those two are what stands in
 * for the compile-time check.
 *
 * `db_admin` is `null`, but **not** because the spine ships no table browser —
 * `http/db_routes.ts` is exactly that, an allowlist-gated browser over the
 * `public` schema with row `DELETE`. It needs no `required_scope` because its shipped
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
 * satisfies — puts every browsable row (the credential tables are floored,
 * but data columns still carry consumer secrets) behind a credential this
 * census no longer describes. That exact rewrite is how the capability string came to
 * exist. A consumer carries its own census; the spine cannot see its surfaces,
 * and cannot see its own surfaces re-authed. See `docs/security.md`
 * §Token scoping.
 */
const RULE_3_SURFACE_SITES: Record<TokenSurface, { file: string; source: string } | null> = {
	fact_bare: {
		file: 'server/serve_fact_route.ts',
		source: "required_scope: 'surface:fact_bare'"
	},
	ws_upgrade: {
		file: 'actions/register_action_ws.ts',
		source: "token_scope_surface_denial(c, 'surface:ws_upgrade')"
	},
	audit_stream: {
		file: 'auth/audit_log_route_schema.ts',
		source: "required_scope: 'surface:audit_stream'"
	},
	db_admin: null
};

/**
 * Matches any `'surface:<name>'` literal — a route spec's `required_scope`
 * declaration or a direct `require_token_scope` / denial call.
 *
 * Deliberately not anchored to the declaration slot: the WS upgrade names its
 * surface in a call rather than a route shape, and both spellings should be
 * held to the same list.
 */
const TOKEN_SURFACE_LITERAL = /'surface:([a-z_]+)'/gu;

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

/** A line whose first non-whitespace is a comment token — `//`, `/*`, or a `*` continuation. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/u;

/**
 * Blank whole comment lines, preserving every newline so line-anchored markers
 * still match at their real positions.
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
 *
 * **Line-oriented, because a span-oriented stripper is unsafe here.** The
 * earlier form blanked `/\*` to the next `*\/` with no string-literal
 * awareness, and `app.use('/api/*', bearer_middleware)` supplies that opener —
 * so the blanked span ran to the end of some later doc block, taking every
 * marker between them with it. A file that silently leaves the discovered set
 * is never reviewed, which is the one failure direction this census cannot
 * tolerate; over-discovery merely demands a census row, which fails loud. No
 * literal can open a multi-line blank when only a line's own first token
 * decides it. Nine files under `src/lib` carry such a literal, two of them
 * already in `NON_SURFACE_SITES` — where an under-scanned file and an exempt
 * one look identical.
 *
 * Relies on doc blocks carrying their ` * ` continuations, which the formatter
 * guarantees. Twin of the Rust censuses' `strip_comment_lines`.
 */
const strip_comment_lines = (source: string): string =>
	source
		.split('\n')
		.map((line) => (COMMENT_LINE.test(line) ? '' : line))
		.join('\n');

/** Walk `src/lib` for files that reach a resolved credential. */
const discover_credential_sites = (): Set<string> =>
	discover_lib_files((raw) => {
		const source = strip_comment_lines(raw);
		return CREDENTIAL_MARKERS.some((marker) =>
			typeof marker === 'string' ? source.includes(marker) : marker.test(source)
		);
	});

/** Walk `src/lib` for files naming a token surface in code. */
const discover_declared_token_surfaces = (): Set<string> =>
	discover_lib_files((raw) => strip_comment_lines(raw).includes("'surface:"));

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
	 * The scope-consulting set is exactly the dispatch core and its two RPC
	 * transports, the REST bridge that stands in for the core on a transport it
	 * never reaches, and the non-RPC surfaces the spine mounts — pinned as an
	 * exact list so *narrowing* it (deleting a check) fails here too, not just
	 * widening it.
	 */
	test('the scope-consulting set is the expected one', () => {
		const consulting = CENSUS.filter((e) => e.role === 'consults')
			.map((e) => e.file)
			.sort();
		assert.deepStrictEqual(consulting, [
			'actions/action_bridge.ts',
			'actions/action_rpc.ts',
			'actions/perform_action.ts',
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
		for (const surface of TOKEN_SURFACES) {
			const site = RULE_3_SURFACE_SITES[surface];
			if (site === null) continue;
			assert.ok(
				consulting.has(site.file),
				`${site.file} gates the ${surface} surface but is not censused as consulting scope`
			);
			assert.ok(
				strip_comment_lines(read_lib_source(site.file)).includes(site.source),
				`${site.file} gates the ${surface} surface but does not contain \`${site.source}\``
			);
		}
	});

	/**
	 * **The spine names only surfaces the spine mounts.**
	 *
	 * `auth.required_scope` is deliberately open on the identifier — a consumer
	 * names its own non-RPC surface without registering it upstream, because the
	 * name decides nothing (rule 3 is all-or-nothing) and the sibling
	 * `rpc:<method>` arm of the same wire field has always carried arbitrary
	 * consumer method names. The resolver therefore checks *shape*, not
	 * membership.
	 *
	 * That leaves fuz_app's own declarations unguarded against a typo, which
	 * this restores and then some: every `'surface:<name>'` literal in `src/lib`
	 * — route-shape declaration or direct guard call alike — must name one of
	 * `TOKEN_SURFACES`. So the closed set still binds where it is a real check
	 * (this repo's routes, which the map above pairs with the gate that mounts
	 * them) and stops binding where it was only ever a spelling rule on someone
	 * else's diagnostic string.
	 */
	test('the spine declares only surfaces it mounts', () => {
		const declared = new Set<string>();
		for (const file of discover_declared_token_surfaces()) {
			for (const match of strip_comment_lines(read_lib_source(file)).matchAll(
				TOKEN_SURFACE_LITERAL
			)) {
				declared.add(match[1]!);
			}
		}
		const unknown = [...declared].filter((s) => !is_token_surface(s)).sort();
		assert.deepStrictEqual(
			unknown,
			[],
			'src/lib names token surfaces the spine does not mount — consumers may name their own, this repo may not'
		);
	});

	/**
	 * The stripper drops prose and keeps code — including code that only *looks*
	 * like a comment opener.
	 *
	 * Pinned because the failure it prevents is silent in the worst direction.
	 * The span-oriented form this replaced read the `/*` inside a route-glob
	 * literal as a comment opener and blanked everything up to the next `*\/`,
	 * so a file's real markers could vanish and the file with them — and a file
	 * that leaves the discovered set is never reviewed at all. The `'/api/*'`
	 * case below is that regression, held as a literal because it is the exact
	 * shape `testing/middleware.ts` mounts.
	 */
	test('the stripper drops prose and keeps code', () => {
		const stripped = strip_comment_lines(
			[
				'/**',
				' * a doc comment naming require_request_context(',
				' */',
				'// a leading note naming require_request_context(',
				"app.use('/api/*', bearer_middleware);",
				'const context = require_request_context(c); // a trailing note'
			].join('\n')
		);
		assert.strictEqual(
			stripped.match(/require_request_context\(/gu)?.length,
			1,
			'prose about a marker must not read as the marker, but the call must survive'
		);
		assert.ok(
			stripped.includes("'/api/*'"),
			'a route-glob literal must survive intact — reading its `/*` as a comment opener is what blanked whole files'
		);
	});
});
