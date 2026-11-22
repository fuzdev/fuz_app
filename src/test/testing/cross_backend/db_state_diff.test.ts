import { assert, describe, test } from 'vitest';

import {
	diff_db_states,
	normalize_db_state,
	type RawDbState
} from '#lib/testing/cross_backend/db_state_diff.ts';

const AUDIT_COLUMNS = {
	id: 'uuid',
	seq: 'int8',
	event_type: 'text',
	actor_id: 'uuid',
	account_id: 'uuid',
	ip: 'text',
	created_at: 'timestamptz',
	metadata: 'jsonb'
};

const UUID_A = '0b1c2d3e-4f50-4617-8899-aabbccddeeff';
const UUID_B = '11111111-2222-4333-8444-555555555555';
const UUID_C = '99999999-8888-4777-8666-555555555555';
const UUID_D = '22222222-3333-4444-8555-666666666666';

const audit_row = (row: Record<string, unknown>): Record<string, unknown> => ({
	id: UUID_D,
	seq: 1,
	event_type: 'login',
	actor_id: null,
	account_id: null,
	ip: '127.0.0.1',
	created_at: '2026-11-21T18:00:00.5+00:00',
	metadata: null,
	...row
});

const raw = (
	rows: Array<Record<string, unknown>>,
	audit_seq_advance = rows.length
): RawDbState => ({
	columns: { audit_log: AUDIT_COLUMNS },
	rows: { audit_log: rows },
	audit_seq_advance
});

describe('normalize_db_state', () => {
	test('sorts audit rows by seq and keeps seq as an offset from the smallest', () => {
		const state = normalize_db_state(
			raw([
				audit_row({ id: UUID_B, seq: 107, event_type: 'logout' }),
				audit_row({ id: UUID_A, seq: 105, event_type: 'login' })
			])
		);
		const rows = state.tables.audit_log!;
		assert.deepEqual(
			rows.map((r) => [r.seq, r.event_type, r.id]),
			[
				[0, 'login', '<id:1>'],
				[2, 'logout', '<id:2>']
			]
		);
	});

	test('numbers ids by the walk, so a reference inside metadata compares', () => {
		const state = normalize_db_state(
			raw([
				audit_row({ id: UUID_A, seq: 1, account_id: UUID_C, metadata: { invite_id: UUID_B } }),
				audit_row({ id: UUID_D, seq: 2, account_id: UUID_B })
			])
		);
		const [first, second] = state.tables.audit_log!;
		// columns sorted: account_id before id; metadata after
		assert.strictEqual(first!.account_id, '<id:1>');
		assert.strictEqual(first!.id, '<id:2>');
		assert.deepEqual(first!.metadata, { invite_id: '<id:3>' });
		assert.strictEqual(second!.account_id, '<id:3>', 'the account the invite became');
	});

	test('ranks timestamps densely across columns and metadata, null kept', () => {
		const state = normalize_db_state(
			raw([
				audit_row({
					seq: 1,
					created_at: '2026-11-21T18:00:00.000001+00:00',
					metadata: { seen_at: '2026-11-22T18:00:00Z' }
				}),
				audit_row({ id: UUID_A, seq: 2, created_at: '2026-11-21T18:00:00.000001+00:00' }),
				audit_row({ id: UUID_B, seq: 3, created_at: '2026-11-21T19:00:00.000002+01:00' })
			])
		);
		const rows = state.tables.audit_log!;
		// 19:00+01:00 is 18:00 UTC, a microsecond after the first two
		assert.deepEqual(
			rows.map((r) => r.created_at),
			['<t:1>', '<t:1>', '<t:2>']
		);
		assert.deepEqual(rows[0]!.metadata, { seen_at: '<t:3>' });
	});

	test('an expiry is its offset from its row creation, ranked with nothing', () => {
		const state = normalize_db_state({
			columns: {
				auth_session: {
					id: 'text',
					account_id: 'uuid',
					created_at: 'timestamptz',
					expires_at: 'timestamptz'
				},
				audit_log: AUDIT_COLUMNS
			},
			rows: {
				auth_session: [
					{
						id: 'a'.repeat(64),
						account_id: UUID_A,
						created_at: '2026-11-21T18:00:00.123456+00:00',
						expires_at: '2026-12-21T18:00:20.5+00:00'
					},
					{
						id: 'b'.repeat(64),
						account_id: UUID_B,
						created_at: '2026-11-21T18:00:01+00:00',
						expires_at: '2026-11-21T17:59:01+00:00'
					}
				],
				audit_log: [
					audit_row({
						created_at: '2026-11-21T18:00:02+00:00',
						metadata: { expires_at: '2026-11-28T18:00:02Z' }
					})
				]
			},
			audit_seq_advance: 1
		});
		assert.deepEqual(
			state.tables.auth_session!.map((r) => [r.created_at, r.expires_at]),
			[
				['<t:1>', '+30d0h0m'],
				['<t:2>', '-0d0h1m']
			]
		);
		const audit = state.tables.audit_log![0]!;
		// the expiries joined no rank, so the audit row's creation is the third instant
		assert.strictEqual(audit.created_at, '<t:3>');
		assert.deepEqual(audit.metadata, { expires_at: '+7d0h0m' });
	});

	test('tokens and digests become constants, token ids and generated usernames placeholders', () => {
		const state = normalize_db_state(
			raw([
				audit_row({
					metadata: {
						token: 'secret_fuz_token_abcDEF123_-xyz',
						token_id: 'tok_abC0_d-3xyzA',
						hash: 'a'.repeat(64),
						username: 'test_user_1ab_mabc12_3',
						named: 'keeper'
					}
				})
			])
		);
		assert.deepEqual(state.tables.audit_log![0]!.metadata, {
			hash: '<hash>',
			named: 'keeper',
			token: '<token>',
			token_id: '<tok:1>',
			username: '<username:1>'
		});
	});
});

describe('diff_db_states', () => {
	test('equal dumps from different ids and times have no differences', () => {
		const a = normalize_db_state(raw([audit_row({ id: UUID_A, seq: 10, account_id: UUID_B })]));
		const b = normalize_db_state(
			raw([
				audit_row({
					id: UUID_C,
					seq: 900,
					account_id: UUID_D,
					created_at: '2026-11-21T20:00:00+00:00'
				})
			])
		);
		assert.deepEqual(diff_db_states(a, b), []);
	});

	test('a column set on one side, and the sequence moved further, differ under db.', () => {
		const a = normalize_db_state(raw([audit_row({ actor_id: null })], 1));
		const b = normalize_db_state(raw([audit_row({ actor_id: UUID_A })], 2));
		assert.deepEqual(diff_db_states(a, b), [
			{ path: 'db.audit_log[0].actor_id', a: null, b: '<id:1>' },
			{ path: 'db.audit_log[0].id', a: '<id:1>', b: '<id:2>' },
			{ path: 'db.audit_seq_advance', a: 1, b: 2 }
		]);
	});
});

describe('normalize_db_state over the auth tables', () => {
	const columns = {
		account: { id: 'uuid', username: 'text', password_hash: 'text', created_at: 'timestamptz' },
		actor: { id: 'uuid', account_id: 'uuid', name: 'text' },
		api_token: {
			id: 'text',
			account_id: 'uuid',
			last_used_at: 'timestamptz',
			last_used_ip: 'text'
		},
		audit_log: AUDIT_COLUMNS
	};
	const T = '2026-11-21T18:00:00+00:00';

	test('walks accounts before actors before audit rows, so references number alike', () => {
		const state = normalize_db_state({
			columns,
			rows: {
				audit_log: [audit_row({ id: UUID_D, account_id: UUID_B })],
				actor: [
					{ id: UUID_C, account_id: UUID_B, name: 'b' },
					{ id: UUID_D.replace('2', '7'), account_id: UUID_A, name: 'a' }
				],
				account: [
					{ id: UUID_B, username: 'zed', password_hash: 'x', created_at: T },
					{ id: UUID_A, username: 'amy', password_hash: 'x', created_at: T }
				]
			},
			audit_seq_advance: 1
		});
		assert.deepEqual(
			state.tables.account!.map((r) => [r.username, r.id]),
			[
				['amy', '<id:1>'],
				['zed', '<id:2>']
			]
		);
		assert.deepEqual(
			state.tables.actor!.map((r) => [r.account_id, r.name]),
			[
				['<id:1>', 'a'],
				['<id:2>', 'b']
			]
		);
		assert.strictEqual(state.tables.audit_log![0]!.account_id, '<id:2>');
	});

	test('a password hash keeps its argon2 parameters only', () => {
		const state = normalize_db_state({
			columns,
			rows: {
				account: [
					{
						id: UUID_A,
						username: 'amy',
						password_hash: '$argon2id$v=19$m=8,t=1,p=1$c2FsdHNhbHQ$ZGlnZXN0ZGlnZXN0',
						created_at: T
					}
				]
			},
			audit_seq_advance: 0
		});
		assert.strictEqual(
			state.tables.account![0]!.password_hash,
			'$argon2id$v=19$m=8,t=1,p=1$<salt>$<hash>'
		);
	});

	test("a token's last use compares as set or not; its ip as it is", () => {
		const state = normalize_db_state({
			columns,
			rows: {
				api_token: [
					{ id: 'tok_abC0_d-3xyzA', account_id: UUID_A, last_used_at: T, last_used_ip: '::1' },
					{ id: 'tok_zzZ9_y-8xyzB', account_id: UUID_B, last_used_at: null, last_used_ip: null }
				]
			},
			audit_seq_advance: 0
		});
		assert.deepEqual(state.tables.api_token, [
			{ account_id: '<id:1>', id: '<tok:1>', last_used_at: '<set>', last_used_ip: '::1' },
			{ account_id: '<id:2>', id: '<tok:2>', last_used_at: null, last_used_ip: null }
		]);
	});

	test("a token's last use joins no rank, so the writes around it rank alike", () => {
		const at = (minute: number): string => `2026-11-21T18:0${minute}:00+00:00`;
		const dump = (touched: string) =>
			normalize_db_state({
				columns,
				rows: {
					account: [
						{ id: UUID_A, username: 'a', password_hash: 'x', created_at: at(1) },
						{ id: UUID_B, username: 'b', password_hash: 'x', created_at: at(3) }
					],
					api_token: [
						{
							id: 'tok_abC0_d-3xyzA',
							account_id: UUID_A,
							last_used_at: touched,
							last_used_ip: '::1'
						}
					]
				},
				audit_seq_advance: 0
			});
		// the touch landing before the second account's write or after it
		const before = dump(at(2));
		const after = dump(at(4));
		assert.deepEqual(
			before.tables.account!.map((r) => r.created_at),
			['<t:1>', '<t:2>']
		);
		assert.deepEqual(before, after);
	});
});
