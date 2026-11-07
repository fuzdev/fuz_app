/**
 * The `_testing_*` action schemas (`testing/cross_backend/testing_reset_actions.ts`)
 * and the schema-snapshot and migration-tracker schemas they answer with
 * (`testing/schema_introspect.ts`) held to Zod copies of the schemas they
 * were, kept here. Over each schema's valid samples and every variant of them
 * one edit away (a node replaced by a value of the pool, a key dropped, a key
 * added), the verdict and the output are Zod's. The integer bounds (`.int()`,
 * `.negative()`) are `safe_integer` and `max_value` over the same numbers. One
 * declared difference: a snapshot's `record` takes a `Date` as an empty record,
 * where Zod's refused anything but a plain object; no JSON body holds one.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { z } from 'zod';
import { is_schema, parse, type AnySchema } from '@fuzdev/fuz_schema/schema.ts';

import {
	create_uuid,
	FactHashSchema as ZodFactHashSchema,
	Uuid as ZodUuid
} from '#lib/primitive_schemas.ts';
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
import {
	assert_matches_zod,
	holds_date,
	show,
	type DifferentialRow
} from '../differential_test_helpers.ts';

// --- the Zod copies, as the library wrote them ---

const ZodSeededAccountShape = z.strictObject({
	account: z.strictObject({ id: ZodUuid, username: z.string() }),
	actor: z.strictObject({ id: ZodUuid }),
	api_token: z.string(),
	session_cookie: z.string()
});
const ZodResetInput = z.strictObject({
	extra_keeper_roles: z.array(z.string()).optional(),
	extra_accounts: z
		.array(
			z.strictObject({
				username: z.string(),
				password_value: z.string().optional(),
				roles: z.array(z.string())
			})
		)
		.optional(),
	extra_actors: z.array(z.string()).optional()
});
const ZodResetOutput = ZodSeededAccountShape.extend({
	extra_accounts: z.array(ZodSeededAccountShape),
	extra_actors: z.array(z.strictObject({ id: ZodUuid, name: z.string() }))
});
const ZodDrainOutput = z.strictObject({ ok: z.boolean(), tracked: z.boolean() });
const ZodMintSessionInput = z.strictObject({
	account_id: ZodUuid,
	expires_in_seconds: z.number().int().negative()
});
const ZodMintSessionOutput = z.strictObject({ session_cookie: z.string() });
const ZodPutFactInput = z.strictObject({
	content: z.string(),
	content_type: z.string().optional(),
	holder: ZodUuid.optional(),
	external_url: z.string().optional()
});
const ZodPutFactOutput = z.strictObject({ hash: ZodFactHashSchema });
const ZodFloodInput = z.strictObject({
	count: z.number().int().min(0).max(TESTING_FLOOD_MAX_COUNT),
	size: z.number().int().min(0).max(TESTING_FLOOD_MAX_SIZE)
});
const ZodFloodOutput = z.strictObject({ queued: z.number().int() });
const ZodSchemaSnapshotInput = z.strictObject({ exclude_tables: z.array(z.string()).optional() });
const ZodShortenInput = z.strictObject({
	account_id: ZodUuid,
	seconds: z
		.number()
		.int()
		.min(TESTING_SHORTEN_CREDENTIAL_EXPIRY_MIN_SECONDS)
		.max(TESTING_SHORTEN_CREDENTIAL_EXPIRY_MAX_SECONDS)
});
const ZodShortenOutput = z.strictObject({
	sessions: z.number().int().min(0),
	api_tokens: z.number().int().min(0)
});

const ZodColumnSnapshot = z.object({
	data_type: z.string(),
	udt_name: z.string(),
	is_nullable: z.boolean(),
	column_default: z.string().nullable(),
	is_identity: z.boolean()
});
const ZodTableSnapshot = z.object({
	columns: z.record(z.string(), ZodColumnSnapshot),
	indexes: z.array(z.object({ name: z.string(), definition: z.string() })),
	constraints: z.array(z.object({ name: z.string(), type: z.string(), definition: z.string() }))
});
const ZodSchemaSnapshot = z.object({
	tables: z.record(z.string(), ZodTableSnapshot),
	sequences: z.record(z.string(), z.object({ data_type: z.string() })),
	enums: z.record(z.string(), z.object({ labels: z.array(z.string()) }))
});
const ZodMigrationTracker = z.object({
	entries: z.array(
		z.object({ namespace: z.string(), name: z.string(), sequence: z.number().int() })
	)
});

// --- the inputs ---

const ID = create_uuid();
const HASH = `blake3:${'a'.repeat(64)}`;
const SEEDED = {
	account: { id: ID, username: 'keeper' },
	actor: { id: ID },
	api_token: 't',
	session_cookie: 'c'
};
const SNAPSHOT = {
	tables: {
		account: {
			columns: {
				id: {
					data_type: 'uuid',
					udt_name: 'uuid',
					is_nullable: false,
					column_default: 'gen_random_uuid()',
					is_identity: false
				},
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
		}
	},
	sequences: { s: { data_type: 'bigint' } },
	enums: { cell_visibility: { labels: ['private', 'public'] } }
};

/** The integers at the edges of every bound the specs declare. */
const INTEGER_POOL: ReadonlyArray<unknown> = [
	-2,
	-1.5,
	-0.5,
	TESTING_FLOOD_MAX_COUNT,
	TESTING_FLOOD_MAX_COUNT + 1,
	TESTING_FLOOD_MAX_SIZE,
	TESTING_FLOOD_MAX_SIZE + 1,
	TESTING_SHORTEN_CREDENTIAL_EXPIRY_MAX_SECONDS,
	TESTING_SHORTEN_CREDENTIAL_EXPIRY_MAX_SECONDS + 1,
	-Number.MAX_SAFE_INTEGER,
	-(2 ** 53),
	ID,
	ID.toUpperCase(),
	HASH,
	`blake3:${'A'.repeat(64)}`
];

/** `value` with every `Date` in it replaced by an empty object. */
const dates_as_records = (value: unknown): unknown =>
	value instanceof Date
		? {}
		: Array.isArray(value)
			? value.map(dates_as_records)
			: value !== null && typeof value === 'object'
				? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, dates_as_records(v)]))
				: value;

/** A snapshot holding a `Date` where a record goes, which the fuz_schema `record` takes as empty. */
const is_snapshot_with_date_record = (input: unknown): boolean =>
	holds_date(input) && ZodSchemaSnapshot.safeParse(dates_as_records(input)).success;

/** A spec slot, typed `ValidationSchema`, as the fuz_schema schema it must be. */
const fuz_slot = (schema: ValidationSchema): AnySchema => {
	if (!is_schema(schema)) throw new Error('a spec slot is no fuz_schema schema');
	return schema;
};

const VOID_INPUTS: Array<[name: string, schema: ValidationSchema]> = [
	['_testing_drain_effects input', testing_drain_effects_action_spec.input],
	['_testing_migration_tracker input', testing_migration_tracker_action_spec.input],
	['_testing_action_manifest input', testing_action_manifest_action_spec.input]
];

const ROWS: Array<DifferentialRow> = [
	...VOID_INPUTS.map(([name, schema]): DifferentialRow => ({
		name,
		fuz: fuz_slot(schema),
		zod: z.void(),
		samples: [undefined]
	})),
	{
		name: '_testing_reset input',
		fuz: fuz_slot(testing_reset_action_spec.input),
		zod: ZodResetInput,
		samples: [
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
	},
	{
		name: '_testing_reset output',
		fuz: fuz_slot(testing_reset_action_spec.output),
		zod: ZodResetOutput,
		samples: [
			{ ...SEEDED, extra_accounts: [SEEDED], extra_actors: [{ id: ID, name: 'second' }] },
			{ ...SEEDED, extra_accounts: [], extra_actors: [] }
		]
	},
	{
		name: '_testing_drain_effects output',
		fuz: fuz_slot(testing_drain_effects_action_spec.output),
		zod: ZodDrainOutput,
		samples: [
			{ ok: true, tracked: true },
			{ ok: true, tracked: false }
		]
	},
	{
		name: '_testing_mint_session input',
		fuz: fuz_slot(testing_mint_session_action_spec.input),
		zod: ZodMintSessionInput,
		samples: [
			{ account_id: ID, expires_in_seconds: -60 },
			{ account_id: ID.toUpperCase(), expires_in_seconds: -1 }
		],
		pool: INTEGER_POOL
	},
	{
		name: '_testing_mint_session output',
		fuz: fuz_slot(testing_mint_session_action_spec.output),
		zod: ZodMintSessionOutput,
		samples: [{ session_cookie: 'c' }]
	},
	{
		name: '_testing_put_fact input',
		fuz: fuz_slot(testing_put_fact_action_spec.input),
		zod: ZodPutFactInput,
		samples: [
			{ content: 'x' },
			{ content: '', content_type: 'text/plain', holder: ID, external_url: 'https://x' }
		],
		pool: INTEGER_POOL
	},
	{
		name: '_testing_put_fact output',
		fuz: fuz_slot(testing_put_fact_action_spec.output),
		zod: ZodPutFactOutput,
		samples: [{ hash: HASH }],
		pool: INTEGER_POOL
	},
	{
		name: '_testing_flood_notifications input',
		fuz: fuz_slot(testing_flood_notifications_action_spec.input),
		zod: ZodFloodInput,
		samples: [
			{ count: 0, size: 0 },
			{ count: TESTING_FLOOD_MAX_COUNT, size: TESTING_FLOOD_MAX_SIZE }
		],
		pool: INTEGER_POOL
	},
	{
		name: '_testing_flood_notifications output',
		fuz: fuz_slot(testing_flood_notifications_action_spec.output),
		zod: ZodFloodOutput,
		samples: [{ queued: 3 }, { queued: -1 }],
		pool: INTEGER_POOL
	},
	{
		name: '_testing_schema_snapshot input',
		fuz: fuz_slot(testing_schema_snapshot_action_spec.input),
		zod: ZodSchemaSnapshotInput,
		samples: [{}, { exclude_tables: ['a', 'b'] }]
	},
	{
		name: 'SchemaSnapshot',
		fuz: SchemaSnapshot,
		zod: ZodSchemaSnapshot,
		samples: [SNAPSHOT, { tables: {}, sequences: {}, enums: {} }],
		declared: (input, zod_ok) => zod_ok || is_snapshot_with_date_record(input)
	},
	{
		name: 'MigrationTracker',
		fuz: MigrationTracker,
		zod: ZodMigrationTracker,
		samples: [
			{ entries: [{ namespace: 'fuz_auth', name: 'full_auth_schema', sequence: 0 }] },
			{ entries: [] }
		],
		pool: INTEGER_POOL
	},
	{
		name: '_testing_shorten_credential_expiry input',
		fuz: fuz_slot(testing_shorten_credential_expiry_action_spec.input),
		zod: ZodShortenInput,
		samples: [
			{ account_id: ID, seconds: TESTING_SHORTEN_CREDENTIAL_EXPIRY_MIN_SECONDS },
			{ account_id: ID, seconds: TESTING_SHORTEN_CREDENTIAL_EXPIRY_MAX_SECONDS }
		],
		pool: INTEGER_POOL
	},
	{
		name: '_testing_shorten_credential_expiry output',
		fuz: fuz_slot(testing_shorten_credential_expiry_action_spec.output),
		zod: ZodShortenOutput,
		samples: [{ sessions: 0, api_tokens: 2 }],
		pool: INTEGER_POOL
	}
];

describe('the testing seams against their Zod copies', () => {
	for (const row of ROWS) {
		test(`${row.name}: every variant gets Zod's verdict and output`, () => {
			assert_matches_zod(row);
		});
	}

	test('the testing action specs are all fuz_schema', () => {
		for (const spec of [
			testing_reset_action_spec,
			testing_drain_effects_action_spec,
			testing_mint_session_action_spec,
			testing_put_fact_action_spec,
			testing_flood_notifications_action_spec,
			testing_schema_snapshot_action_spec,
			testing_migration_tracker_action_spec,
			testing_shorten_credential_expiry_action_spec,
			testing_action_manifest_action_spec
		]) {
			assert.ok(is_schema(spec.input), `${spec.method} input`);
			assert.ok(is_schema(spec.output), `${spec.method} output`);
		}
	});
});

describe('the snapshot schemas drop unknown keys, as the stripping Zod objects did', () => {
	test('a column with an extra key parses to the column without it, in schema key order', () => {
		const { id } = SNAPSHOT.tables.account.columns;
		const input = {
			tables: { t: { ...SNAPSHOT.tables.account, columns: { id: { extra: 1, ...id } } } },
			sequences: {},
			enums: {}
		};
		const parsed = parse(SchemaSnapshot, input);
		assert.ok(parsed.ok, show(input));
		const column = parsed.value.tables.t!.columns.id!;
		assert.deepStrictEqual(Object.keys(column), Object.keys(ZodColumnSnapshot.shape));
	});
});
