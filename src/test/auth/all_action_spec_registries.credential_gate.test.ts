/**
 * The **credential-gate census** — every action spec across the fuz_auth
 * registries that restricts its `auth.credential_types`, pinned as a set.
 *
 * ## Why this test exists
 *
 * `perform_action` enforces the gate wherever a spec declares one, and
 * `account_actions.credential_gate.db.test.ts` proves the enforcement over
 * live dispatch. Neither pins the *declarations*: a refactor that dropped
 * `credential_types` from `role_grant_offer_accept` would reopen the
 * privilege pivot — a leaked bearer accepting a pending admin offer, whose
 * resulting grant outlives revoking the token — and every test would still
 * pass, because each one exercises the gate it was written for on the specs
 * it happens to name.
 *
 * That is the shape the surface census family exists to catch, and it had
 * already happened to the prose: `docs/security.md` §Credential-channel
 * gating counted six gated endpoints for as long as
 * `role_grant_offer_accept` and `self_service_role_set` carried the gate
 * without appearing in the list. A list nothing walks goes stale silently.
 *
 * ## What it pins
 *
 * The set, both directions. Adding a gate to a spec fails here until the
 * spec is listed with its reason; removing one fails here too. Neither is
 * hard to do deliberately — that is the point: the edit becomes visible in
 * review next to the threat it closes.
 *
 * And the **complement**, which is the half that catches the realistic
 * failure. Pinning only the gated set says nothing about a *new* mutation
 * that forgets a gate — it is in neither list, so nothing fails. Pinning the
 * ungated mutations too makes every new side-effecting spec land in one list
 * or the other, as a diff someone reads. Twin of the Rust spine's
 * `any_credential_surface` module (`fuz_auth/src/action_auth.rs`), whose two
 * assertions this mirrors method-for-method.
 *
 * REST routes carrying the same gate (`POST /logout`, `POST /password`) are
 * not action specs and are not walked here; the route-shape modules declare
 * them, and `describe_adversarial_auth`'s credential block probes whatever a
 * surface mounts.
 *
 * @module
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, test, assert } from 'vitest';

import { all_fuz_auth_action_spec_registries } from '$lib/auth/all_action_spec_registries.ts';
import { create_account_route_shapes } from '$lib/auth/account_route_schema.ts';
import { create_audit_log_route_shape } from '$lib/auth/audit_log_route_schema.ts';
import {
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	CREDENTIAL_TYPE_SESSION
} from '$lib/auth/credential_type_schema.ts';

/**
 * Every gated method, the channels it admits, and why the channel is
 * narrowed. Reasons are load-bearing review material, not decoration — an
 * entry nobody can justify is an entry to delete.
 */
const GATED_ACTION_SPECS: Record<string, { credential_types: Array<string>; reason: string }> = {
	account_token_create: {
		credential_types: [CREDENTIAL_TYPE_SESSION],
		reason:
			'bearer-spawn-bearer persistence — a leaked api token mints siblings with innocuous names to outlive revocation'
	},
	account_token_revoke: {
		credential_types: [CREDENTIAL_TYPE_SESSION],
		reason:
			'sibling disruption — a leaked bearer revokes the legitimate sibling token to disrupt the user'
	},
	account_session_revoke: {
		credential_types: [CREDENTIAL_TYPE_SESSION],
		reason:
			'lockout by composition — a leaked bearer enumerates via `account_session_list` then revokes each session, reaching `_revoke_all` in pieces'
	},
	account_session_revoke_all: {
		credential_types: [CREDENTIAL_TYPE_SESSION],
		reason: 'lockout — a leaked bearer revokes every session in one call'
	},
	role_grant_offer_accept: {
		credential_types: [CREDENTIAL_TYPE_SESSION],
		reason:
			"privilege pivot — the only offer verb that moves the caller's own authority, and the resulting grant outlives revoking the token. `_create` is the offering side; `_decline` / `_retract` destroy a pending offer and confer nothing"
	},
	self_service_role_set: {
		credential_types: [CREDENTIAL_TYPE_SESSION],
		reason:
			'privilege pivot, self-targeted — a leaked account-wide token grants itself an eligible role. The verb serves a UI affordance, so the bearer channel buys nothing'
	},
	account_purge: {
		credential_types: [CREDENTIAL_TYPE_DAEMON_TOKEN],
		reason:
			'the gate pointing the other way — an irreversible cascading delete, restricted to the keeper channel because a filesystem-proved operator token is the ceiling no session or api token reaches'
	}
};

/**
 * Every mutation an api token may drive — the ungated complement.
 *
 * Two groups, and the distinction is why the list is worth keeping. The
 * `admin_*` / `invite_*` / `app_settings_update` rows exist because admin
 * scripting from CLI/bearer is legitimate operator workflow
 * (`docs/security.md` §Credential-channel gating). `role_grant_assign` /
 * `role_grant_revoke` are reviewed and left open: an operator wanting a CLI
 * to assign roles mints a token scoped to `rpc:role_grant_assign`, which
 * narrows, where widening the spec would loosen every caller.
 * `role_grant_offer_create` is the offering side; `_decline` / `_retract`
 * destroy a pending offer and confer nothing.
 *
 * Moving an entry out of this list is the narrowing pass. Moving one *in*
 * should be argued.
 */
const ANY_CREDENTIAL_MUTATIONS: ReadonlyArray<string> = [
	'account_delete',
	'account_undelete',
	'admin_session_revoke_all',
	'admin_token_revoke_all',
	'app_settings_update',
	'invite_create',
	'invite_delete',
	'role_grant_assign',
	'role_grant_offer_create',
	'role_grant_offer_decline',
	'role_grant_offer_retract',
	'role_grant_revoke'
];

/** Every `method` across the registries that declares a credential gate. */
const discover_gated_methods = (): Map<string, ReadonlyArray<string>> => {
	const found: Map<string, ReadonlyArray<string>> = new Map();
	for (const registry of all_fuz_auth_action_spec_registries) {
		for (const spec of registry.specs) {
			if (spec.auth.credential_types?.length) {
				found.set(spec.method, spec.auth.credential_types);
			}
		}
	}
	return found;
};

/** Every side-effecting method reachable on any authenticated channel. */
const discover_any_credential_mutations = (): Array<string> => {
	const found: Array<string> = [];
	for (const registry of all_fuz_auth_action_spec_registries) {
		for (const spec of registry.specs) {
			if (!spec.auth.credential_types?.length && spec.side_effects) found.push(spec.method);
		}
	}
	return found.sort();
};

/** The prose half of the census — `docs/security.md` §Credential-channel gating. */
const read_credential_gating_section = (): string => {
	const doc = readFileSync(
		fileURLToPath(new URL('../../../docs/security.md', import.meta.url)),
		'utf-8'
	);
	const heading = '### Credential-channel gating';
	const start = doc.indexOf(heading);
	assert.notStrictEqual(start, -1, 'docs/security.md lost its §Credential-channel gating heading');
	// The body after the heading line — `'\n## '` needs the space, so a
	// sibling `###` heading does not end the section.
	const body = doc.slice(start + heading.length).replace(/^\n+/u, '');
	const end = body.indexOf('\n## ');
	return end === -1 ? body : body.slice(0, end);
};

/**
 * Every session-gated endpoint the spine ships — action methods plus the REST
 * route shapes that carry the same gate, which is the unit the doc counts.
 */
const discover_session_gated_endpoints = (): Array<string> => {
	const endpoints = [...discover_gated_methods()]
		.filter(([, types]) => types.includes(CREDENTIAL_TYPE_SESSION))
		.map(([method]) => method);
	const route_shapes = [
		...create_account_route_shapes({ login_account_rate_limited: false }),
		create_audit_log_route_shape()
	];
	for (const shape of route_shapes) {
		if (shape.auth.credential_types?.includes(CREDENTIAL_TYPE_SESSION)) {
			endpoints.push(`${shape.method} ${shape.path}`);
		}
	}
	return endpoints.sort();
};

describe('fuz_auth registries — credential-gate census', () => {
	test('every gated spec is censused, with the channels it admits', () => {
		const gated = discover_gated_methods();
		const uncensused = [...gated.keys()].filter((m) => !(m in GATED_ACTION_SPECS)).sort();
		assert.deepStrictEqual(
			uncensused,
			[],
			`spec(s) declare credential_types but are not in the census — add an entry naming the threat the narrowed channel closes, and list the endpoint in docs/security.md §Credential-channel gating`
		);
		for (const [method, credential_types] of gated) {
			assert.deepStrictEqual(
				[...credential_types],
				GATED_ACTION_SPECS[method]!.credential_types,
				`${method} admits a different channel set than the census records`
			);
		}
	});

	test('every censused spec still declares its gate', () => {
		const gated = discover_gated_methods();
		const dropped = Object.keys(GATED_ACTION_SPECS)
			.filter((m) => !gated.has(m))
			.sort();
		assert.deepStrictEqual(
			dropped,
			[],
			'censused spec(s) no longer declare credential_types — the gate was dropped, or the method was renamed'
		);
	});

	/**
	 * The complement, as an exact partition. A new mutation spec lands here
	 * or in `GATED_ACTION_SPECS`, and either way someone reads the diff — the
	 * failure this catches is the one neither half catches alone: a
	 * side-effecting spec added with no gate and no reason to have skipped it.
	 */
	test('the ungated mutations are the expected set', () => {
		assert.deepStrictEqual(
			discover_any_credential_mutations(),
			[...ANY_CREDENTIAL_MUTATIONS],
			'a mutation is reachable on every authenticated channel — gate it, or list it with the operator workflow it serves'
		);
	});

	/**
	 * The doc is the other half of this census, and it went stale exactly the
	 * way an unwalked list does: §Credential-channel gating counted six gated
	 * endpoints for as long as `role_grant_offer_accept` and
	 * `self_service_role_set` carried the gate without appearing in it, while
	 * both specs' own TSDoc pointed readers at that list.
	 *
	 * Method names only — the prose around each one is the part a human
	 * writes and this test has no business pinning.
	 */
	test('every session-gated action method is named in docs/security.md', () => {
		const section = read_credential_gating_section();
		const unlisted = [...discover_gated_methods()]
			.filter(
				([method, types]) => types.includes(CREDENTIAL_TYPE_SESSION) && !section.includes(method)
			)
			.map(([method]) => method)
			.sort();
		assert.deepStrictEqual(
			unlisted,
			[],
			'session-gated spec(s) missing from docs/security.md §Credential-channel gating — add a bullet naming the threat the narrowed channel closes'
		);
	});

	/**
	 * And the count in that section's opening sentence, which is the sort of
	 * number that drifts silently. Derived from the specs plus the REST route
	 * shapes carrying the same gate, since the doc counts endpoints rather
	 * than action specs.
	 */
	test('the endpoint count in docs/security.md matches the shipped set', () => {
		const section = read_credential_gating_section();
		const total = discover_session_gated_endpoints().length;
		const spelled = [
			'Zero',
			'One',
			'Two',
			'Three',
			'Four',
			'Five',
			'Six',
			'Seven',
			'Eight',
			'Nine',
			'Ten',
			'Eleven',
			'Twelve'
		][total];
		assert.ok(spelled, `no spelled numeral for ${total} endpoints — extend the table`);
		assert.ok(
			section.startsWith(`${spelled} endpoints declare`),
			`docs/security.md §Credential-channel gating must open with "${spelled} endpoints declare" — the spine ships ${total}: ${discover_session_gated_endpoints().join(', ')}`
		);
	});

	test('every census entry carries a reason', () => {
		for (const [method, entry] of Object.entries(GATED_ACTION_SPECS)) {
			assert.ok(entry.reason.length > 0, `${method} has no stated reason`);
		}
	});
});
