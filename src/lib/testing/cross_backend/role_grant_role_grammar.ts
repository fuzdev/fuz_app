import '../assert_dev_env.ts';

/**
 * Cross-backend parity suite for an **off-grammar `role` or `scope_kind`** on
 * the grant verbs.
 *
 * `role_grant_assign` and `role_grant_offer_create` declare `role` as
 * `RoleName` (lowercase letters and underscores, no leading, trailing or
 * consecutive underscores, at most 64 characters). A role string outside that
 * grammar is refused at input validation — JSON-RPC `invalid_params`, with no
 * `data.reason` — and writes no audit row: a role is caller-chosen text until
 * it passes the grammar, and the grant verbs record the role they refuse in
 * their failure rows.
 *
 * - **refused at validation** — each off-grammar role, on each verb, answers
 *   `invalid_params` with no reason, so the refusal is the input schema's and
 *   not a grant-path or authorizer one. One of them is all lowercase letters
 *   and one character past the length cap: the cap is part of the grammar, so
 *   a failure row never carries an arbitrarily long caller-chosen string.
 * - **no audit row** — after the refusals, no grant audit row carries an
 *   off-grammar role. The control keeps that read from being vacuous: an
 *   on-grammar role no registry holds is refused past validation with
 *   `role_not_web_grantable`, the refusal a failure row records — as is one
 *   exactly at the length cap, which pins the boundary.
 * - **`scope_kind` too** — `scope_kind` is a `ScopeKindName`, the same grammar
 *   and cap, so an off-grammar one with its `scope_id` is refused the same way
 *   and recorded in no row. Among them is `'GLOBAL'` with the all-zeros
 *   uuid, the partial unique indexes' key for a global grant, which a spine
 *   letting it through would answer with a 500 on an actor already holding
 *   the role globally. The role is on the grammar and held by no registry, so
 *   a `scope_kind` let through is refused past validation with a reason.
 *
 * Exists because the action-manifest parity gate captures no param schemas
 * while the Rust spine parses params by hand — a spine that let an off-grammar
 * role reach its grant path would answer with a different error and write the
 * caller's text into the audit log. Both verbs are on every spine's standard
 * surface, so the suite is ungated. Cross-process only: it reads the audit log
 * through `_testing_drain_effects`, which the spine binaries mount.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';

import { ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE } from '../../auth/role_grant_offer_action_specs.ts';
import { ERROR_ROLE_NOT_WEB_GRANTABLE } from '../../http/error_schemas.ts';
import { JSONRPC_ERROR_CODES } from '../../http/jsonrpc_errors.ts';
import { list_audit_events } from './audit_cross_helpers.ts';
import { cross_rpc_call, error_reason } from './cross_rpc.ts';
import type { RpcPathCrossSuiteOptions } from './setup.ts';
import { SPINE_RPC_PATH } from './spine_surface_constants.ts';

/** Options for the role-grammar suite (the standard RPC-dispatched shape). */
export type RoleGrantRoleGrammarCrossTestOptions = RpcPathCrossSuiteOptions;

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The longest role name or scope kind the grammar admits — an independent
 * copy of the producers' `NAME_LENGTH_MAX`, so a cap moved on one spine fails
 * here.
 */
const NAME_LENGTH_MAX = 64;

/** All lowercase letters, so only its length is off the grammar. */
const OVER_LENGTH_ROLE = 'a'.repeat(NAME_LENGTH_MAX + 1);

/** On the grammar at exactly the length cap, held by no registry. */
const AT_LENGTH_ROLE = 'a'.repeat(NAME_LENGTH_MAX);

/** Each breaks one rule of the `RoleName` grammar. */
const OFF_GRAMMAR_ROLES: ReadonlyArray<string> = [
	'Admin', // uppercase
	'role-name', // hyphen
	'role1', // digit
	'_role', // leading underscore
	'role_', // trailing underscore
	'role__name', // a run of two underscores
	'role___name', // a run of three
	'role name', // space
	'', // empty
	OVER_LENGTH_ROLE // on the alphabet, one past the length cap
];

/** On the grammar, held by no registry. */
const UNREGISTERED_ROLE = 'not_a_registered_role';

/** Each breaks one rule of the `ScopeKindName` grammar. */
const OFF_GRAMMAR_SCOPE_KINDS: ReadonlyArray<string> = [
	'GLOBAL', // the partial unique indexes' token for a global grant
	'Classroom', // uppercase
	'a__b', // a run of two underscores
	'_a', // leading underscore
	'a_', // trailing underscore
	'a1', // digit
	'', // empty
	'a'.repeat(NAME_LENGTH_MAX + 1) // on the alphabet, one past the length cap
];

/** On the grammar, the second exactly at the length cap. */
const ON_GRAMMAR_SCOPE_KINDS: ReadonlyArray<string> = ['classroom', 'a'.repeat(NAME_LENGTH_MAX)];

const GRANT_METHODS = ['role_grant_assign', 'role_grant_offer_create'] as const;

/** What each grant verb refuses an unregistered role with, past validation. */
const NOT_GRANTABLE_REASONS: Record<(typeof GRANT_METHODS)[number], string> = {
	role_grant_assign: ERROR_ROLE_NOT_WEB_GRANTABLE,
	role_grant_offer_create: ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE
};

/** The audit event types the grant verbs write. */
const GRANT_EVENT_TYPES = ['role_grant_create', 'role_grant_offer_create'] as const;

export const describe_role_grant_role_grammar_cross_tests = (
	options: RoleGrantRoleGrammarCrossTestOptions
): void => {
	const { setup_test } = options;
	const rpc_path = options.rpc_path ?? SPINE_RPC_PATH;

	describe('grant verbs refuse an off-grammar role at validation', () => {
		for (const method of GRANT_METHODS) {
			test(`${method}: an off-grammar role is invalid_params with no reason`, async () => {
				const fixture = await setup_test();
				const t = fixture.fresh_transport();
				for (const role of OFF_GRAMMAR_ROLES) {
					const res = await cross_rpc_call(
						t,
						rpc_path,
						method,
						{ to_account_id: NIL_UUID, role },
						fixture.create_session_headers()
					);
					const label = `${method} role=${JSON.stringify(role)}`;
					assert.strictEqual(res.ok, false, `${label}: expected a refusal`);
					assert.strictEqual(res.error?.code, JSONRPC_ERROR_CODES.invalid_params, label);
					// a validation refusal, not a grant-path or authorizer one
					assert.strictEqual(error_reason(res), undefined, `${label}: no data.reason`);
				}
			});
		}

		test('an off-grammar role writes no audit row; an unregistered on-grammar one is refused past validation', async () => {
			const fixture = await setup_test();
			const t = fixture.fresh_transport();
			const session = fixture.create_session_headers();

			for (const method of GRANT_METHODS) {
				for (const role of OFF_GRAMMAR_ROLES) {
					const res = await cross_rpc_call(
						t,
						rpc_path,
						method,
						{ to_account_id: NIL_UUID, role },
						session
					);
					assert.strictEqual(
						res.error?.code,
						JSONRPC_ERROR_CODES.invalid_params,
						`${method} ${JSON.stringify(role)}`
					);
				}
			}
			// control: the same call with an on-grammar role reaches the grant-path gate
			const control = await cross_rpc_call(
				t,
				rpc_path,
				'role_grant_assign',
				{ to_account_id: NIL_UUID, role: UNREGISTERED_ROLE },
				session
			);
			assert.strictEqual(error_reason(control), ERROR_ROLE_NOT_WEB_GRANTABLE);
			// and the length cap is inclusive: a role exactly at it is on the grammar
			const at_length = await cross_rpc_call(
				t,
				rpc_path,
				'role_grant_assign',
				{ to_account_id: NIL_UUID, role: AT_LENGTH_ROLE },
				session
			);
			assert.strictEqual(
				error_reason(at_length),
				ERROR_ROLE_NOT_WEB_GRANTABLE,
				'a role at the length cap passes validation'
			);

			// both spines write audit rows off the request path, so each read is
			// behind the drain barrier
			for (const event_type of GRANT_EVENT_TYPES) {
				const events = await list_audit_events(fixture, { event_type }, rpc_path);
				const roles = events.map((event) => (event.metadata as { role?: unknown } | null)?.role);
				for (const role of roles) {
					assert.ok(
						typeof role !== 'string' || !OFF_GRAMMAR_ROLES.includes(role),
						`${event_type}: an audit row records the off-grammar role ${JSON.stringify(role)}`
					);
				}
				if (event_type === 'role_grant_create') {
					// the controls' failure rows are in the same read, so it is not vacuous
					assert.ok(roles.includes(UNREGISTERED_ROLE), 'the control refusal wrote its failure row');
					assert.ok(roles.includes(AT_LENGTH_ROLE), 'the at-cap refusal wrote its failure row');
				}
			}
		});
	});
	describe('grant verbs refuse an off-grammar scope_kind at validation', () => {
		const scoped = (scope_kind: string) => ({
			to_account_id: NIL_UUID,
			role: UNREGISTERED_ROLE,
			scope_kind,
			scope_id: NIL_UUID
		});

		for (const method of GRANT_METHODS) {
			test(`${method}: an off-grammar scope_kind is invalid_params with no reason`, async () => {
				const fixture = await setup_test();
				const t = fixture.fresh_transport();
				for (const scope_kind of OFF_GRAMMAR_SCOPE_KINDS) {
					const res = await cross_rpc_call(
						t,
						rpc_path,
						method,
						scoped(scope_kind),
						fixture.create_session_headers()
					);
					const label = `${method} scope_kind=${JSON.stringify(scope_kind)}`;
					assert.strictEqual(res.ok, false, `${label}: expected a refusal`);
					assert.strictEqual(res.error?.code, JSONRPC_ERROR_CODES.invalid_params, label);
					// a validation refusal, not the grant-path one an unregistered role gets
					assert.strictEqual(error_reason(res), undefined, `${label}: no data.reason`);
				}
				// on the grammar, the same call reaches the grant-path gate
				for (const scope_kind of ON_GRAMMAR_SCOPE_KINDS) {
					const res = await cross_rpc_call(
						t,
						rpc_path,
						method,
						scoped(scope_kind),
						fixture.create_session_headers()
					);
					assert.strictEqual(
						error_reason(res),
						NOT_GRANTABLE_REASONS[method],
						`${method} scope_kind=${JSON.stringify(scope_kind)}: passes validation`
					);
				}
			});
		}

		test('an off-grammar scope_kind writes no audit row', async () => {
			const fixture = await setup_test();
			const t = fixture.fresh_transport();
			const session = fixture.create_session_headers();
			for (const method of GRANT_METHODS) {
				for (const scope_kind of [...OFF_GRAMMAR_SCOPE_KINDS, ...ON_GRAMMAR_SCOPE_KINDS]) {
					await cross_rpc_call(t, rpc_path, method, scoped(scope_kind), session);
				}
			}
			for (const event_type of GRANT_EVENT_TYPES) {
				const events = await list_audit_events(fixture, { event_type }, rpc_path);
				const scope_kinds = events.map(
					(event) => (event.metadata as { scope_kind?: unknown } | null)?.scope_kind
				);
				for (const scope_kind of scope_kinds) {
					assert.ok(
						typeof scope_kind !== 'string' || !OFF_GRAMMAR_SCOPE_KINDS.includes(scope_kind),
						`${event_type}: an audit row records the off-grammar scope_kind ${JSON.stringify(scope_kind)}`
					);
				}
				if (event_type === 'role_grant_create') {
					// the on-grammar refusals' failure rows are in the same read, so it is not vacuous
					for (const scope_kind of ON_GRAMMAR_SCOPE_KINDS) {
						assert.ok(
							scope_kinds.includes(scope_kind),
							`the scope_kind=${JSON.stringify(scope_kind)} refusal wrote its failure row`
						);
					}
				}
			}
		});
	});
};
