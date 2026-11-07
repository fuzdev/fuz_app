/**
 * The `_testing_*` action schemas (`testing/cross_backend/testing_reset_actions.ts`)
 * and the schema-snapshot and migration-tracker schemas they answer with
 * (`testing/schema_introspect.ts`): their valid samples, the integer bounds at
 * their edges, and one declared choice: a snapshot's `record` takes a `Date`
 * as an empty record, as fuz_schema's `record` takes a class instance; no JSON
 * body holds one.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { format_issue, is_schema, parse, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import { create_uuid } from '#lib/primitive_schemas.ts';
import type { ValidationSchema } from '#lib/schema_issues.ts';
import {
	TESTING_FLOOD_MAX_COUNT,
	TESTING_FLOOD_MAX_SIZE,
	TESTING_SHORTEN_CREDENTIAL_EXPIRY_MAX_SECONDS,
	TESTING_SHORTEN_CREDENTIAL_EXPIRY_MIN_SECONDS,
	testing_drain_effects_action_spec,
	testing_flood_notifications_action_spec,
	testing_migration_tracker_action_spec,
	testing_mint_session_action_spec,
	testing_put_fact_action_spec,
	testing_reset_action_spec,
	testing_schema_snapshot_action_spec,
	testing_shorten_credential_expiry_action_spec,
	testing_action_manifest_action_spec
} from '#lib/testing/cross_backend/testing_reset_actions.ts';
import { MigrationTracker, SchemaSnapshot } from '#lib/testing/schema_introspect.ts';

const ID = create_uuid();
const HASH = `blake3:${'a'.repeat(64)}`;
const SEEDED = {
	account: { id: ID, username: 'keeper' },
	actor: { id: ID },
	api_token: 't',
	session_cookie: 'c'
};
const COLUMN = {
	data_type: 'uuid',
	udt_name: 'uuid',
	is_nullable: false,
	column_default: 'gen_random_uuid()',
	is_identity: false
};
const TABLE = {
	columns: {
		id: COLUMN,
		note: {
			data_type: 'text',
			udt_name: 'text',
			is_nullable: true,
			column_default: null,
			is_identity: false
		}
	},
	indexes: [{ name: 'account_pkey', definition: 'CREATE UNIQUE INDEX …' }],
	constraints: [{ name: 'account_pkey', type: 'PRIMARY KEY', definition: 'PRIMARY KEY (id)' }]
};
const SNAPSHOT = {
	tables: { account: TABLE },
	sequences: { s: { data_type: 'bigint' } },
	enums: { cell_visibility: { labels: ['private', 'public'] } }
};

const SPECS = [
	testing_reset_action_spec,
	testing_drain_effects_action_spec,
	testing_mint_session_action_spec,
	testing_put_fact_action_spec,
	testing_flood_notifications_action_spec,
	testing_schema_snapshot_action_spec,
	testing_migration_tracker_action_spec,
	testing_shorten_credential_expiry_action_spec,
	testing_action_manifest_action_spec
];

/** A spec slot, typed `ValidationSchema`, as the fuz_schema schema it must be. */
const fuz_slot = (schema: ValidationSchema): AnySchema => {
	if (!is_schema(schema)) throw new Error('a spec slot is no fuz_schema schema');
	return schema;
};

/** The first issue of a failed parse, with its message. */
const first_issue = (schema: AnySchema, input: unknown) => {
	const result = parse(schema, input);
	assert.ok(!result.ok);
	const { kind, path, expected, received } = result.issues[0]!;
	return { kind, path, expected, received, message: format_issue(result.issues[0]!) };
};

const SAMPLES: Array<[name: string, schema: ValidationSchema, samples: ReadonlyArray<unknown>]> = [
	['_testing_drain_effects input', testing_drain_effects_action_spec.input, [undefined]],
	['_testing_migration_tracker input', testing_migration_tracker_action_spec.input, [undefined]],
	['_testing_action_manifest input', testing_action_manifest_action_spec.input, [undefined]],
	[
		'_testing_reset input',
		testing_reset_action_spec.input,
		[
			{},
			{
				extra_keeper_roles: ['admin'],
				extra_accounts: [
					{ username: 'a', password_value: 'p', roles: ['r'] },
					{ username: 'b', roles: [] }
				],
				extra_actors: ['second']
			}
		]
	],
	[
		'_testing_reset output',
		testing_reset_action_spec.output,
		[
			{ ...SEEDED, extra_accounts: [SEEDED], extra_actors: [{ id: ID, name: 'second' }] },
			{ ...SEEDED, extra_accounts: [], extra_actors: [] }
		]
	],
	[
		'_testing_drain_effects output',
		testing_drain_effects_action_spec.output,
		[
			{ ok: true, tracked: true },
			{ ok: true, tracked: false }
		]
	],
	[
		'_testing_mint_session input',
		testing_mint_session_action_spec.input,
		[
			{ account_id: ID, expires_in_seconds: -60 },
			{ account_id: ID.toUpperCase(), expires_in_seconds: -1 }
		]
	],
	[
		'_testing_mint_session output',
		testing_mint_session_action_spec.output,
		[{ session_cookie: 'c' }]
	],
	[
		'_testing_put_fact input',
		testing_put_fact_action_spec.input,
		[
			{ content: 'x' },
			{ content: '', content_type: 'text/plain', holder: ID, external_url: 'https://x' }
		]
	],
	['_testing_put_fact output', testing_put_fact_action_spec.output, [{ hash: HASH }]],
	[
		'_testing_flood_notifications input',
		testing_flood_notifications_action_spec.input,
		[
			{ count: 0, size: 0 },
			{ count: TESTING_FLOOD_MAX_COUNT, size: TESTING_FLOOD_MAX_SIZE }
		]
	],
	[
		'_testing_flood_notifications output',
		testing_flood_notifications_action_spec.output,
		[{ queued: 3 }, { queued: -1 }]
	],
	[
		'_testing_schema_snapshot input',
		testing_schema_snapshot_action_spec.input,
		[{}, { exclude_tables: ['a', 'b'] }]
	],
	['SchemaSnapshot', SchemaSnapshot, [SNAPSHOT, { tables: {}, sequences: {}, enums: {} }]],
	[
		'MigrationTracker',
		MigrationTracker,
		[
			{ entries: [{ namespace: 'fuz_auth', name: 'full_auth_schema', sequence: 0 }] },
			{ entries: [] }
		]
	],
	[
		'_testing_shorten_credential_expiry input',
		testing_shorten_credential_expiry_action_spec.input,
		[
			{ account_id: ID, seconds: TESTING_SHORTEN_CREDENTIAL_EXPIRY_MIN_SECONDS },
			{ account_id: ID, seconds: TESTING_SHORTEN_CREDENTIAL_EXPIRY_MAX_SECONDS }
		]
	],
	[
		'_testing_shorten_credential_expiry output',
		testing_shorten_credential_expiry_action_spec.output,
		[{ sessions: 0, api_tokens: 2 }]
	]
];

describe('the testing seams', () => {
	test('the testing action specs are all fuz_schema', () => {
		for (const spec of SPECS) {
			assert.ok(is_schema(spec.input), `${spec.method} input`);
			assert.ok(is_schema(spec.output), `${spec.method} output`);
		}
	});

	test('every valid sample parses', () => {
		for (const [name, schema, samples] of SAMPLES) {
			for (const sample of samples) {
				assert.ok(parse(fuz_slot(schema), sample).ok, `${name} ${JSON.stringify(sample)}`);
			}
		}
	});

	test('the void inputs refuse a value', () => {
		for (const spec of [
			testing_drain_effects_action_spec,
			testing_migration_tracker_action_spec,
			testing_action_manifest_action_spec
		]) {
			assert.ok(!parse(fuz_slot(spec.input), {}).ok, spec.method);
			assert.ok(!parse(fuz_slot(spec.input), null).ok, spec.method);
		}
	});

	test('the integer bounds hold at their edges', () => {
		const mint = fuz_slot(testing_mint_session_action_spec.input);
		const flood = fuz_slot(testing_flood_notifications_action_spec.input);
		const shorten = fuz_slot(testing_shorten_credential_expiry_action_spec.input);
		const shortened = fuz_slot(testing_shorten_credential_expiry_action_spec.output);
		const cases: Array<[name: string, schema: AnySchema, input: unknown, ok: boolean]> = [
			['mint -1', mint, { account_id: ID, expires_in_seconds: -1 }, true],
			['mint 0', mint, { account_id: ID, expires_in_seconds: 0 }, false],
			['mint -1.5', mint, { account_id: ID, expires_in_seconds: -1.5 }, false],
			['flood -1', flood, { count: -1, size: 0 }, false],
			['flood max count + 1', flood, { count: TESTING_FLOOD_MAX_COUNT + 1, size: 0 }, false],
			['flood max size + 1', flood, { count: 0, size: TESTING_FLOOD_MAX_SIZE + 1 }, false],
			['flood 0.5', flood, { count: 0.5, size: 0 }, false],
			[
				'shorten min - 1',
				shorten,
				{ account_id: ID, seconds: TESTING_SHORTEN_CREDENTIAL_EXPIRY_MIN_SECONDS - 1 },
				false
			],
			[
				'shorten max + 1',
				shorten,
				{ account_id: ID, seconds: TESTING_SHORTEN_CREDENTIAL_EXPIRY_MAX_SECONDS + 1 },
				false
			],
			['shortened -1', shortened, { sessions: -1, api_tokens: 0 }, false],
			['shortened 1.5', shortened, { sessions: 0, api_tokens: 1.5 }, false]
		];
		for (const [name, schema, input, ok] of cases) {
			assert.strictEqual(parse(schema, input).ok, ok, name);
		}
	});
});

describe('the snapshot schemas drop unknown keys', () => {
	test('a column with an extra key parses to the column without it, in schema key order', () => {
		const input = {
			tables: { t: { ...TABLE, columns: { id: { extra: 1, ...COLUMN } } } },
			sequences: {},
			enums: {}
		};
		const parsed = parse(SchemaSnapshot, input);
		assert.ok(parsed.ok);
		const column = parsed.value.tables.t!.columns.id!;
		assert.deepStrictEqual(Object.keys(column), [
			'data_type',
			'udt_name',
			'is_nullable',
			'column_default',
			'is_identity'
		]);
	});
});

describe('the declared differences', () => {
	test("a snapshot's record takes a Date as an empty record, and refuses a non-object", () => {
		const cases: Array<[input: unknown, ok: boolean]> = [
			[{ tables: new Date(0), sequences: {}, enums: {} }, true],
			[{ ...SNAPSHOT, enums: new Date(0) }, true],
			[{ tables: { t: { ...TABLE, columns: new Date(0) } }, sequences: {}, enums: {} }, true],
			[{ tables: 'x', sequences: {}, enums: {} }, false],
			[{ tables: [], sequences: {}, enums: {} }, false],
			[{ tables: { t: { ...TABLE, columns: { id: 'x' } } }, sequences: {}, enums: {} }, false]
		];
		for (const [input, ok] of cases) {
			assert.strictEqual(parse(SchemaSnapshot, input).ok, ok, String(Object.keys(input as object)));
		}
		assert.deepStrictEqual(first_issue(SchemaSnapshot, { tables: 'x', sequences: {}, enums: {} }), {
			kind: 'record',
			path: ['tables'],
			expected: 'object',
			received: 'string',
			message: 'tables: expected object, received string'
		});
		assert.deepStrictEqual(
			first_issue(SchemaSnapshot, {
				tables: { t: { ...TABLE, columns: { id: 'x' } } },
				sequences: {},
				enums: {}
			}),
			{
				kind: 'strip_object',
				path: ['tables', 't', 'columns', 'id'],
				expected: 'object',
				received: 'string',
				message: 'tables.t.columns.id: expected object, received string'
			}
		);
	});
});
