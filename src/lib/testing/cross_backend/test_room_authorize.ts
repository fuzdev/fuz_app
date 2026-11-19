import '../assert_dev_env.ts';

/**
 * Test `RoomAuthorize` policy mounted on **both** reference spines — the TS
 * spine binary's full mount (`full_spine_mount.ts`) and the Rust
 * `testing_spine_stub` — so the `rooms_ws` cross suite drives the room verbs
 * with one rule set on both. The twin of the Rust `TestRoomAuthorize`, rule
 * for rule.
 *
 * The room id's prefix decides, so a case picks its rule by naming its room:
 *
 * - `open:<rest>` — join and watch, no scope, the registry's cap;
 * - `scoped:<scope>:<rest>` — join and watch under the scope `<scope>`
 *   (non-empty);
 * - `pair:<rest>` — join and watch, at most two members;
 * - `watch:<rest>` — watch only; a join is denied;
 * - `admin:<rest>` — join and watch for an actor holding the global `admin`
 *   role, denied to anyone else;
 * - anything else — denied (`room_not_found`).
 *
 * A test policy, not a model. The `admin:` rule reads the grant live through
 * the request's database, inside the reserve window, as every authorizer must
 * (`RoomAuthorize`); no other rule reads the database. A cross-language test
 * contract.
 *
 * @module
 */

import type { RoomAccess, RoomAuthorize, RoomVerdict } from '../../actions/room_actions.ts';
import { query_actor_has_active_global_role } from '../../auth/role_grant_queries.ts';
import { ROLE_ADMIN } from '../../auth/role_schema.ts';

/**
 * Whether `room_id`'s rule reads the actor's global `admin` grant.
 *
 * @param room_id - the room the request names
 * @returns `true` for an `admin:` room
 */
export const test_room_rule_reads_admin = (room_id: string): boolean => {
	const colon = room_id.indexOf(':');
	return colon !== -1 && room_id.slice(0, colon) === 'admin';
};

/**
 * The verdict for `room_id`, as the module doc lists — pure, so the rule table
 * is checked without a database. Twin of the Rust `TestRoomAuthorize::verdict`.
 *
 * @param room_id - the room the request names
 * @param access - join or watch
 * @param holds_admin - the live read, consulted only by the `admin:` rule
 * @returns the verdict
 */
export const test_room_verdict = (
	room_id: string,
	access: RoomAccess,
	holds_admin: boolean
): RoomVerdict => {
	const colon = room_id.indexOf(':');
	if (colon === -1) return { allow: false };
	const kind = room_id.slice(0, colon);
	const rest = room_id.slice(colon + 1);
	switch (kind) {
		case 'open':
			return { allow: true, scope: null, max_members: null };
		case 'scoped': {
			const scope_end = rest.indexOf(':');
			if (scope_end <= 0) return { allow: false };
			return { allow: true, scope: rest.slice(0, scope_end), max_members: null };
		}
		case 'pair':
			return { allow: true, scope: null, max_members: 2 };
		case 'watch':
			return access === 'watch'
				? { allow: true, scope: null, max_members: null }
				: { allow: false };
		case 'admin':
			return holds_admin ? { allow: true, scope: null, max_members: null } : { allow: false };
		default:
			return { allow: false };
	}
};

/** The test policy (module doc), reading the `admin:` rule's grant live through the request's `db`. */
export const test_room_authorize: RoomAuthorize = {
	authorize: async (input, db) => {
		const holds_admin = test_room_rule_reads_admin(input.room_id)
			? await query_actor_has_active_global_role({ db }, input.actor_id, ROLE_ADMIN)
			: false;
		return test_room_verdict(input.room_id, input.access, holds_admin);
	}
};
