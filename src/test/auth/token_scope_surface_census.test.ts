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

import { TOKEN_SURFACE_CAPABILITIES, type TokenSurface } from '$lib/auth/token_scope.ts';

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
		file: 'auth/audit_log_routes.ts',
		role: 'consults',
		reason: 'long-lived admin SSE feed — no point after open at which a narrowing could be applied'
	},
	{
		file: 'server/serve_fact_route.ts',
		role: 'consults',
		reason:
			'the admin-only bare-hash read serves any stored fact with no per-reference cell check; the sibling per-cell route is ungated because its authz is the `(cell, hash)` edge, which a narrowed token can already reach through the RPC methods it names'
	},
	// --- Exempt, with reasons ---
	{
		file: 'actions/register_ws_endpoint.ts',
		role: 'exempt',
		reason:
			'the upgrade stack (origin → auth → acting-actor → role) around `register_action_ws`; it resolves an actor and adds no reach of its own, and the rule-3 gate sits in the inner registration it delegates to'
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
const CREDENTIAL_MARKERS = [
	'ACCOUNT_ID_KEY',
	'CREDENTIAL_TYPE_KEY',
	'TOKEN_SCOPE_KEY',
	'REQUEST_CONTEXT_KEY',
	'require_request_context',
	'get_request_context',
	'token_scope_surface_denial'
] as const;

/**
 * Files the scan sees that are not production surfaces: the context-key
 * declarations themselves, and the test harnesses, whose middlewares fabricate
 * a credential rather than resolve one and which no production server mounts.
 *
 * An explicit list rather than a path filter in the walker, so the exclusions
 * are as reviewable as the inclusions.
 */
const NON_SURFACE_SITES: ReadonlyArray<string> = [
	'hono_context.ts',
	'testing/auth_apps.ts',
	'testing/middleware.ts',
	'testing/ws_round_trip.ts'
];

/**
 * Which file gates each rule-3 surface, or `null` when the spine does not mount
 * it.
 *
 * `db_admin` is `null` because the TS spine ships no table browser — the
 * capability string exists so a consumer that mounts one (the Rust
 * `fuz_db_admin` router, or a consumer-side equivalent) denies with the same
 * body. A consumer carries its own census; the spine cannot see its surfaces.
 */
const RULE_3_SURFACE_SITES: Record<TokenSurface, string | null> = {
	fact_bare: 'server/serve_fact_route.ts',
	ws_upgrade: 'actions/register_action_ws.ts',
	audit_stream: 'auth/audit_log_routes.ts',
	db_admin: null
};

const lib_dir = fileURLToPath(new URL('../../lib', import.meta.url));

/** Read a censused file's source by its `src/lib`-relative path. */
const read_lib_source = (file: string): string => readFileSync(join(lib_dir, file), 'utf-8');

/** Walk `src/lib` for files that reach a resolved credential. */
const discover_credential_sites = (): Set<string> => {
	const found = new Set<string>();
	const walk = (dir: string, prefix: string): void => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) {
				walk(join(dir, entry.name), rel);
			} else if (entry.name.endsWith('.ts') || entry.name.endsWith('.svelte')) {
				const source = readFileSync(join(dir, entry.name), 'utf-8');
				if (CREDENTIAL_MARKERS.some((marker) => source.includes(marker))) found.add(rel);
			}
		}
	};
	walk(lib_dir, '');
	return found;
};

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
			'auth/audit_log_routes.ts',
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
	test('every mounted rule-3 surface is censused as consulting and calls the guard', () => {
		const consulting = new Set(CENSUS.filter((e) => e.role === 'consults').map((e) => e.file));
		for (const surface of Object.keys(TOKEN_SURFACE_CAPABILITIES) as Array<TokenSurface>) {
			const file = RULE_3_SURFACE_SITES[surface];
			if (file === null) continue;
			assert.ok(
				consulting.has(file),
				`${file} gates the ${surface} surface but is not censused as consulting scope`
			);
			assert.ok(
				read_lib_source(file).includes(`token_scope_surface_denial(c, '${surface}')`),
				`${file} gates the ${surface} surface but never calls token_scope_surface_denial for it`
			);
		}
	});
});
