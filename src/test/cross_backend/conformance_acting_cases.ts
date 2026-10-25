/**
 * Multi-actor `acting` conformance cases — run against a keeper seeded with a
 * second actor (`extra_actors: [ACTING_EXTRA_ACTOR_NAME]`).
 *
 * On both spines the authorization phase resolves the acting actor from the
 * request's `acting` selector before any 403 gate, and the role gate then
 * reads the resolved actor's grants — never the account's, and never an actor
 * the credential happens to be bound to. These rows pin that:
 *
 * - **resolution** — no `acting` on a multi-actor account → 400
 *   `actor_required`, and so does a malformed one (read as omitted ahead of
 *   validation); an `acting` naming no actor of the caller's account → 400
 *   `actor_not_on_account`, identical for the nil id, an unused id, and a real
 *   actor on another account (the `acting_not_on_account` group — a prober
 *   learns nothing about which actor ids exist).
 * - **the role gate over the resolved actor** — acting as the extra actor,
 *   which holds no grants, an admin method answers 403
 *   `insufficient_permissions` on a session and on a bearer, and a keeper
 *   method on the daemon token answers 403 too; acting as the bootstrap actor,
 *   which holds them, the same requests pass the gate.
 *
 * Each `note` cites where its property is stated: the `ActingActor` and
 * `parse_acting` TSDoc in `http/auth_shape.ts`, the `ERROR_ACTOR_*` TSDoc in
 * `http/error_schemas.ts`, or `docs/identity.md` §Key Decisions.
 *
 * @module
 */

import { ROLE_ADMIN, ROLE_KEEPER } from '#lib/auth/role_schema.ts';
import {
	ERROR_ACTOR_NOT_ON_ACCOUNT,
	ERROR_ACTOR_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS
} from '#lib/http/error_schemas.ts';
import { ERROR_PURGE_NOT_CONFIRMED } from '#lib/auth/admin_action_specs.ts';
import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';

/** The name of the keeper's seeded second actor. */
export const ACTING_EXTRA_ACTOR_NAME = 'keeper_second_persona';

/** A well-formed UUID that names no actor. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A well-formed v4 UUID no fixture mints. */
const UNUSED_ACTOR_ID = '6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b';

const ACTING_NOT_ON_ACCOUNT_GROUP = 'acting_not_on_account';

export const conformance_acting_cases: ReadonlyArray<ConformanceCase> = [
	{
		name: 'multi-actor keeper, no acting → admin_account_list → 400 actor_required',
		request: { method: 'admin_account_list', as: 'keeper' },
		expect: { status: 400, error_reason: ERROR_ACTOR_REQUIRED },
		note: '`ActingActor` — omitted + multiple actors → actor_required with the available list; the dispatcher never picks a persona'
	},
	{
		name: 'multi-actor keeper, malformed acting → admin_account_list → 400 actor_required',
		request: { method: 'admin_account_list', as: 'keeper', params: { acting: 'not-a-uuid' } },
		expect: { status: 400, error_reason: ERROR_ACTOR_REQUIRED },
		note: '`parse_acting` — a malformed selector reads as omitted, so the authority gates answer ahead of the input-shape complaint'
	},
	{
		name: 'multi-actor keeper, nil acting → admin_account_list → 400 actor_not_on_account',
		request: { method: 'admin_account_list', as: 'keeper', params: { acting: NIL_UUID } },
		expect: {
			status: 400,
			error_reason: ERROR_ACTOR_NOT_ON_ACCOUNT,
			equivalence_group: ACTING_NOT_ON_ACCOUNT_GROUP
		},
		note: '`ERROR_ACTOR_NOT_ON_ACCOUNT` — a supplied acting must name an actor on the authenticated account'
	},
	{
		name: 'multi-actor keeper, unused acting → admin_account_list → 400 actor_not_on_account',
		request: { method: 'admin_account_list', as: 'keeper', params: { acting: UNUSED_ACTOR_ID } },
		expect: {
			status: 400,
			error_reason: ERROR_ACTOR_NOT_ON_ACCOUNT,
			equivalence_group: ACTING_NOT_ON_ACCOUNT_GROUP
		},
		note: '`ERROR_ACTOR_NOT_ON_ACCOUNT` — an id naming no actor answers like the nil id'
	},
	{
		name: "fresh account acting as the keeper's actor → admin_account_list → 400 actor_not_on_account",
		request: { method: 'admin_account_list', as: 'fresh_non_admin', acting: 'keeper_actor' },
		expect: {
			status: 400,
			error_reason: ERROR_ACTOR_NOT_ON_ACCOUNT,
			equivalence_group: ACTING_NOT_ON_ACCOUNT_GROUP
		},
		note: "`ActingActor` — a real actor on another account is foreign: the selector picks among the caller's own actors, and the refusal is the one an unused id gets"
	},
	{
		name: 'keeper session acting as the extra actor → admin_account_list → 403 insufficient_permissions',
		request: { method: 'admin_account_list', as: 'keeper', acting: 'extra_actor' },
		expect: {
			status: 403,
			error_reason: ERROR_INSUFFICIENT_PERMISSIONS,
			fields: { required_roles: [ROLE_ADMIN] }
		},
		note: "identity.md §Key Decisions — role grants target actors: the gate reads the resolved actor's grants, and the sibling holds none of the keeper's"
	},
	{
		name: 'keeper bearer acting as the extra actor → admin_account_list → 403 insufficient_permissions',
		request: { method: 'admin_account_list', as: 'token', acting: 'extra_actor' },
		expect: {
			status: 403,
			error_reason: ERROR_INSUFFICIENT_PERMISSIONS,
			fields: { required_roles: [ROLE_ADMIN] }
		},
		note: 'identity.md §Key Decisions — an API token names the account, not an actor, so it resolves the selector like a session'
	},
	{
		name: 'keeper session acting as its bootstrap actor → admin_account_list → 200',
		request: { method: 'admin_account_list', as: 'keeper', acting: 'principal' },
		expect: { status: 200 },
		note: 'the positive control: the actor holding admin passes the gate the sibling is refused'
	},
	{
		name: 'daemon token acting as the extra actor → account_purge → 403 insufficient_permissions',
		request: {
			method: 'account_purge',
			as: 'daemon',
			acting: 'extra_actor',
			params: { account_id: NIL_UUID, confirm: false }
		},
		expect: {
			status: 403,
			error_reason: ERROR_INSUFFICIENT_PERMISSIONS,
			fields: { required_roles: [ROLE_KEEPER] }
		},
		note: 'identity.md §Key Decisions — the daemon token names the keeper account, and the keeper role is a grant on its bootstrap actor alone'
	},
	{
		name: 'daemon token acting as its bootstrap actor → account_purge clears the gates (confirm guard)',
		request: {
			method: 'account_purge',
			as: 'daemon',
			acting: 'principal',
			params: { account_id: NIL_UUID, confirm: false }
		},
		expect: { status: 400, error_reason: ERROR_PURGE_NOT_CONFIRMED },
		note: 'the positive control: the actor holding keeper reaches the handler, whose confirm guard answers'
	}
];
