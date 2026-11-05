/**
 * Every length-capped wire string with no grammar of its own counts UTF-16
 * code units at its own site — an astral string at the cap in code units passes, and one past
 * the cap in code units but under it in code points is refused, whichever
 * unit the installed Zod's `.max()` counts.
 *
 * The per-site complement to `primitive_schemas.bounded_string.test.ts`. These
 * cases only bite on a Zod that counts code points — there a site gone back to
 * a bare `.max()` fails them; on a code unit Zod they pass either way. A
 * `@fuzdev/fuz_schema` site (`actor_search`'s `query`) counts code units
 * itself, so its cases bite on any install.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { get_schema_entries } from '@fuzdev/fuz_schema/introspect.ts';

import { UsernameProvided, USERNAME_PROVIDED_LENGTH_MAX } from '#lib/primitive_schemas.ts';
import {
	Password,
	PasswordProvided,
	PASSWORD_LENGTH_MAX,
	PASSWORD_LENGTH_MIN
} from '#lib/auth/password.ts';
import {
	CellCreateInput,
	CellListInput,
	CellPath,
	CELL_KIND_LENGTH_MAX,
	CELL_PATH_LENGTH_MAX
} from '#lib/auth/cell_action_specs.ts';
import { TokenCreateInput, API_TOKEN_NAME_LENGTH_MAX } from '#lib/auth/account_action_specs.ts';
import {
	RoleGrantOfferCreateInput,
	RoleGrantOfferDeclineInput,
	RoleGrantRevokeInput
} from '#lib/auth/role_grant_offer_action_specs.ts';
import {
	RoleGrantOfferJson,
	ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX
} from '#lib/auth/role_grant_offer_schema.ts';
import { RoleGrantRevokedParams } from '#lib/auth/role_grant_offer_notifications.ts';
import { ROLE_GRANT_REVOKED_REASON_LENGTH_MAX } from '#lib/auth/account_schema.ts';
import {
	ActorSearchInput,
	ACTOR_SEARCH_QUERY_LENGTH_MAX
} from '#lib/auth/actor_search_action_specs.ts';
import { parse_any, type ValidationSchema } from '#lib/schema_issues.ts';

/** U+1F600 — one code point, two UTF-16 code units. */
const ASTRAL = '\u{1F600}';

/** An astral string of exactly `units` code units. */
const astral_of = (units: number): string =>
	ASTRAL.repeat(Math.floor(units / 2)) + (units % 2 === 0 ? '' : 'a');

// Zod sites and `@fuzdev/fuz_schema` ones alike, read through `parse_any`
const capped: Array<[name: string, schema: ValidationSchema, max: number]> = [
	['UsernameProvided', UsernameProvided, USERNAME_PROVIDED_LENGTH_MAX],
	['Password', Password, PASSWORD_LENGTH_MAX],
	['PasswordProvided', PasswordProvided, PASSWORD_LENGTH_MAX],
	['CellPath', CellPath, CELL_PATH_LENGTH_MAX],
	['cell_create kind', CellCreateInput.shape.kind, CELL_KIND_LENGTH_MAX],
	['cell_list kind', CellListInput.unwrap().shape.kind, CELL_KIND_LENGTH_MAX],
	['token_create name', TokenCreateInput.shape.name, API_TOKEN_NAME_LENGTH_MAX],
	[
		'role_grant_offer_create message',
		get_schema_entries(RoleGrantOfferCreateInput)!.message!,
		ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX
	],
	[
		'role_grant_offer_decline reason',
		RoleGrantOfferDeclineInput.def.reason,
		ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX
	],
	[
		'role_grant_revoke reason',
		RoleGrantRevokeInput.def.reason,
		ROLE_GRANT_REVOKED_REASON_LENGTH_MAX
	],
	[
		'role_grant_revoked notification reason',
		RoleGrantRevokedParams.def.reason,
		ROLE_GRANT_REVOKED_REASON_LENGTH_MAX
	],
	[
		'RoleGrantOfferJson message',
		RoleGrantOfferJson.def.message,
		ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX
	],
	[
		'RoleGrantOfferJson decline_reason',
		RoleGrantOfferJson.def.decline_reason,
		ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX
	],
	['actor_search query', ActorSearchInput.def.query, ACTOR_SEARCH_QUERY_LENGTH_MAX]
];

describe('length caps count UTF-16 code units', () => {
	for (const [name, schema, max] of capped) {
		test(`${name}: astral at the cap passes, past it in units is refused`, () => {
			const at_cap = astral_of(max);
			assert.strictEqual(at_cap.length, max);
			assert.ok(parse_any(schema, at_cap).ok);
			const over = astral_of(max + 1);
			assert.strictEqual(over.length, max + 1);
			assert.ok(Array.from(over).length <= max, 'at or under the cap in code points');
			assert.ok(!parse_any(schema, over).ok);
		});
	}
});

describe('Password floor counts UTF-16 code units', () => {
	test('at the floor in code units but under it in code points passes', () => {
		const at_min = astral_of(PASSWORD_LENGTH_MIN);
		assert.strictEqual(at_min.length, PASSWORD_LENGTH_MIN);
		assert.ok(Array.from(at_min).length < PASSWORD_LENGTH_MIN);
		assert.ok(Password.safeParse(at_min).success);
	});

	test('one code unit under the floor is refused', () => {
		assert.ok(!Password.safeParse(astral_of(PASSWORD_LENGTH_MIN - 1)).success);
	});
});
