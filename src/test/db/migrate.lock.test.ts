/**
 * The migration runner's namespace lock and its `schema_version` DDL race,
 * over a fake `Db` that records which statements run inside a transaction —
 * a pool hands each `Db.query` whichever client is free, so only a statement
 * inside the chain transaction shares its client.
 *
 * @module
 */

import { assert, describe, test } from 'vitest';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { Db, no_nested_transaction } from '#lib/db/db.ts';
import {
	baseline,
	MigrationError,
	namespace_lock_key,
	run_migrations,
	type Migration
} from '#lib/db/migrate.ts';

interface Statement {
	/** `'pool'` for a `Db.query` outside a transaction, else the transaction's index. */
	scope: 'pool' | number;
	text: string;
}

const pg_error = (code: string): Error => Object.assign(new Error(`pg ${code}`), { code });

/**
 * A `Db` that records every statement with its scope and answers each with no
 * rows, so every namespace reads as unapplied.
 */
const create_recording_db = (
	options: { ddl_error?: Error; lock_error?: Error } = {}
): { db: Db; statements: Array<Statement> } => {
	const statements: Array<Statement> = [];
	const client_for = (scope: Statement['scope']) => ({
		query: async <T>(text: string): Promise<{ rows: Array<T> }> => {
			statements.push({ scope, text });
			if (
				options.ddl_error &&
				scope === 'pool' &&
				text.includes('CREATE TABLE IF NOT EXISTS schema_version')
			) {
				throw options.ddl_error;
			}
			if (options.lock_error && lock_statement(text)) throw options.lock_error;
			return { rows: [] };
		}
	});
	let transactions = 0;
	const db = new Db({
		client: client_for('pool'),
		transaction: async (fn) =>
			fn(new Db({ client: client_for(transactions++), transaction: no_nested_transaction }))
	});
	return { db, statements };
};

const lock_statement = (text: string): boolean => text.includes('pg_advisory');

/** A `Logger` that records each `debug` as one joined string. */
const create_debug_log = (): { log: Logger; debugs: Array<string> } => {
	const debugs: Array<string> = [];
	const log = {
		debug: (...args: Array<unknown>): void => void debugs.push(args.join(' '))
	} as unknown as Logger;
	return { log, debugs };
};

describe('the namespace lock', () => {
	test('is taken inside the chain transaction, before any migration statement', async () => {
		const { db, statements } = create_recording_db();
		const migrations: Array<Migration> = [
			{
				name: 'm0',
				up: async (tx) => {
					await tx.query('CREATE TABLE m0_t (id INT)');
				}
			}
		];

		await run_migrations(db, [{ namespace: 'lock_ns', migrations }]);

		const locks = statements.filter((s) => lock_statement(s.text));
		assert.deepStrictEqual(
			locks.map((s) => s.text),
			['SELECT pg_advisory_xact_lock($1)'],
			'one transaction-scoped lock, with no unlock to leak'
		);
		const tx_statements = statements.filter((s) => s.scope === 0);
		assert.ok(lock_statement(tx_statements[0]!.text), 'the transaction opens with the lock');
		assert.ok(tx_statements.some((s) => s.text.includes('CREATE TABLE m0_t')));
		assert.ok(
			statements.filter((s) => s.scope === 'pool').every((s) => !lock_statement(s.text)),
			'no lock statement runs on the pool'
		);
	});

	test('baseline takes it inside the transaction that writes the rows', async () => {
		const { db, statements } = create_recording_db();
		await baseline(db, { namespace: 'lock_ns', migrations: [{ name: 'a', up: async () => {} }] }, [
			'a'
		]);

		const tx_statements = statements.filter((s) => s.scope === 0);
		assert.strictEqual(tx_statements[0]!.text, 'SELECT pg_advisory_xact_lock($1)');
		assert.ok(tx_statements.some((s) => s.text.includes('INSERT INTO schema_version')));
		assert.ok(statements.filter((s) => s.scope === 'pool').every((s) => !lock_statement(s.text)));
	});

	const assert_lock_failed = (caught: unknown, driver_error: Error): void => {
		assert.ok(caught instanceof MigrationError, 'a failed lock throws MigrationError');
		assert.strictEqual(caught.kind, 'migration-lock-failed');
		assert.strictEqual(caught.namespace, 'lock_ns');
		assert.include(caught.message, '"lock_ns"');
		assert.include(caught.message, driver_error.message);
		assert.strictEqual(caught.cause, driver_error, 'the driver error is the cause');
	};

	test('a failed lock throws migration-lock-failed naming the namespace', async () => {
		const failure = pg_error('55P03');
		const { db, statements } = create_recording_db({ lock_error: failure });
		let caught: unknown;
		try {
			await run_migrations(db, [
				{ namespace: 'lock_ns', migrations: [{ name: 'm0', up: async () => {} }] }
			]);
		} catch (err) {
			caught = err;
		}
		assert_lock_failed(caught, failure);
		assert.ok(
			statements.every((s) => !s.text.includes('INSERT INTO schema_version')),
			'nothing in the namespace was applied'
		);
	});

	test('baseline throws migration-lock-failed on a failed lock too', async () => {
		const failure = pg_error('57014');
		const { db, statements } = create_recording_db({ lock_error: failure });
		let caught: unknown;
		try {
			await baseline(
				db,
				{ namespace: 'lock_ns', migrations: [{ name: 'a', up: async () => {} }] },
				['a']
			);
		} catch (err) {
			caught = err;
		}
		assert_lock_failed(caught, failure);
		assert.ok(statements.every((s) => !s.text.includes('INSERT INTO schema_version')));
	});

	test('the key matches the Rust twin, sign and UTF-8 bytes included', () => {
		// the same vectors as `fuz_db`'s `namespace_lock_key_matches_the_ts_twin`
		assert.strictEqual(namespace_lock_key('fuz_auth'), -271_612_341);
		assert.strictEqual(namespace_lock_key('fuz_cell'), -271_558_151);
		assert.strictEqual(namespace_lock_key('fuz_facts'), -368_079_798);
		assert.strictEqual(namespace_lock_key('café'), 255_161_979);
	});
});

describe('the schema_version DDL race', () => {
	for (const code of ['23505', '42P07', '42710']) {
		test(`a concurrent boot's ${code} on the DDL is tolerated, and the run proceeds`, async () => {
			const { db, statements } = create_recording_db({ ddl_error: pg_error(code) });
			const results = await run_migrations(db, [
				{ namespace: 'race_ns', migrations: [{ name: 'm0', up: async () => {} }] }
			]);
			assert.deepStrictEqual(results, [{ namespace: 'race_ns', applied_names: ['m0'] }]);
			assert.ok(statements.some((s) => s.text.includes('INSERT INTO schema_version')));
		});
	}

	test('baseline tolerates it too', async () => {
		const { db, statements } = create_recording_db({ ddl_error: pg_error('42P07') });
		await baseline(db, { namespace: 'race_ns', migrations: [{ name: 'a', up: async () => {} }] }, [
			'a'
		]);
		assert.ok(statements.some((s) => s.text.includes('INSERT INTO schema_version')));
	});

	test('run_migrations logs the tolerated race at debug', async () => {
		const { db } = create_recording_db({ ddl_error: pg_error('42710') });
		const { log, debugs } = create_debug_log();
		await run_migrations(db, [{ namespace: 'race_ns', migrations: [] }], { log });
		assert.deepStrictEqual(debugs, ['schema_version DDL raced (42710); another boot won']);
	});

	test('baseline logs the tolerated race at debug, as run_migrations does', async () => {
		const { db } = create_recording_db({ ddl_error: pg_error('23505') });
		const { log, debugs } = create_debug_log();
		await baseline(
			db,
			{ namespace: 'race_ns', migrations: [{ name: 'a', up: async () => {} }] },
			['a'],
			{ log }
		);
		assert.deepStrictEqual(debugs, ['schema_version DDL raced (23505); another boot won']);
	});

	test('any other error on the DDL propagates', async () => {
		const failure = pg_error('42501');
		const { db } = create_recording_db({ ddl_error: failure });
		let caught: unknown;
		try {
			await run_migrations(db, [{ namespace: 'race_ns', migrations: [] }]);
		} catch (err) {
			caught = err;
		}
		assert.strictEqual(caught, failure);
	});
});
