/**
 * Unit tests for `create_audit_log_config` and `builtin_audit_log_config`.
 *
 * Runtime + DB-level behavior of consumer event types is covered by
 * `audit_log_queries.db.test.ts`; this file tests the pure factory.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import * as s from '@fuzdev/fuz_schema/schema.ts';

import {
	AUDIT_EVENT_TYPES,
	audit_metadata_schemas,
	AuditEventTypeName,
	builtin_audit_log_config,
	create_audit_log_config
} from '#lib/auth/audit_log_schema.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

describe('builtin_audit_log_config', () => {
	test('event_types is AUDIT_EVENT_TYPES', () => {
		assert.strictEqual(builtin_audit_log_config.event_types, AUDIT_EVENT_TYPES);
	});

	test('metadata_schemas is audit_metadata_schemas', () => {
		assert.strictEqual(builtin_audit_log_config.metadata_schemas, audit_metadata_schemas);
	});

	test('the wrapper is frozen', () => {
		assert.isTrue(Object.isFrozen(builtin_audit_log_config));
	});
});

describe('create_audit_log_config', () => {
	test('with no options returns builtin_audit_log_config by reference', () => {
		const config = create_audit_log_config();
		assert.strictEqual(config, builtin_audit_log_config);
	});

	test('with empty extra_events returns builtin_audit_log_config by reference', () => {
		const config = create_audit_log_config({ extra_events: {} });
		assert.strictEqual(config, builtin_audit_log_config);
	});

	test('appends extra event keys after the builtins', () => {
		const config = create_audit_log_config({
			extra_events: { classroom_create: null, classroom_update: null }
		});
		const types = [...config.event_types];
		assert.strictEqual(types.length, AUDIT_EVENT_TYPES.length + 2);
		// builtins still at the front, in order
		for (let i = 0; i < AUDIT_EVENT_TYPES.length; i++) {
			assert.strictEqual(types[i], AUDIT_EVENT_TYPES[i]);
		}
		assert.isTrue(types.includes('classroom_create'));
		assert.isTrue(types.includes('classroom_update'));
		assert.isTrue(config.event_types.includes('login'));
	});

	test('returned config is deep-frozen', () => {
		const config = create_audit_log_config({ extra_events: { classroom_create: null } });
		assert.isTrue(Object.isFrozen(config));
		assert.isTrue(Object.isFrozen(config.event_types));
		assert.isTrue(Object.isFrozen(config.metadata_schemas));
	});

	test('schema entries populate metadata_schemas; null entries register the type only', () => {
		const classroom_schema = s.loose_object({ classroom_id: s.string });
		const config = create_audit_log_config({
			extra_events: {
				classroom_create: classroom_schema,
				classroom_delete: null
			}
		});
		// builtin entries still present
		assert.strictEqual(config.metadata_schemas.login, audit_metadata_schemas.login);
		// schema entry exposed
		assert.strictEqual(config.metadata_schemas.classroom_create, classroom_schema);
		// null entry: type is registered, but no schema entry — validation skips
		assert.isTrue(config.event_types.includes('classroom_delete'));
		assert.isUndefined(config.metadata_schemas.classroom_delete);
	});

	test('rejects an extra_events value that is neither null nor a schema', () => {
		for (const value of [{}, 'schema', 1]) {
			assert.throws(
				() => create_audit_log_config({ extra_events: { classroom_create: value as never } }),
				/extra_events key "classroom_create"/
			);
		}
	});

	test('rejects extra_events keys that collide with a builtin', () => {
		assert.throws(
			() => create_audit_log_config({ extra_events: { login: null } }),
			/collides with a builtin/
		);
		assert.throws(
			() =>
				create_audit_log_config({ extra_events: { logout: s.strip_object({ foo: s.string }) } }),
			/collides with a builtin/
		);
	});

	test('accepts extra_events keys with allowed punctuation (. / - _)', () => {
		const config = create_audit_log_config({
			extra_events: {
				'app.classroom.create': null,
				'app/classroom/update': null,
				'app-classroom-delete': null,
				app_classroom_archive: null
			}
		});
		assert.isTrue(config.event_types.includes('app.classroom.create'));
		assert.isTrue(config.event_types.includes('app/classroom/update'));
		assert.isTrue(config.event_types.includes('app-classroom-delete'));
		assert.isTrue(config.event_types.includes('app_classroom_archive'));
	});

	test('rejects extra_events keys that fail format validation', () => {
		// empty string
		assert.throws(() => create_audit_log_config({ extra_events: { '': null } }), /invalid format/);
		// leading whitespace
		assert.throws(
			() => create_audit_log_config({ extra_events: { ' login_alt': null } }),
			/invalid format/
		);
		// leading separator
		assert.throws(
			() => create_audit_log_config({ extra_events: { '.classroom_create': null } }),
			/invalid format/
		);
		// disallowed character
		assert.throws(
			() => create_audit_log_config({ extra_events: { 'classroom create': null } }),
			/invalid format/
		);
		// digit-leading
		assert.throws(
			() => create_audit_log_config({ extra_events: { '1classroom_create': null } }),
			/invalid format/
		);
	});

	test('an extra_events key is at most NAME_LENGTH_MAX characters', () => {
		const at_max = `app.${'a'.repeat(NAME_LENGTH_MAX - 4)}`;
		const over_max = `${at_max}a`;
		assert.isTrue(
			create_audit_log_config({ extra_events: { [at_max]: null } }).event_types.includes(at_max)
		);
		assert.throws(
			() => create_audit_log_config({ extra_events: { [over_max]: null } }),
			`extra_events key "${over_max}" has invalid format: must be at most 64 characters`
		);
	});
});

describe('AuditEventTypeName invariant', () => {
	test('every builtin AUDIT_EVENT_TYPES entry passes the schema', () => {
		for (const t of AUDIT_EVENT_TYPES) {
			assert.isTrue(
				s.parse(AuditEventTypeName, t).ok,
				`builtin "${t}" failed AuditEventTypeName format`
			);
		}
	});

	test('the length cap comes before the grammar, and reports alone', () => {
		const result = s.parse(AuditEventTypeName, `1${'a'.repeat(NAME_LENGTH_MAX)}`);
		assert.ok(!result.ok);
		assert.deepStrictEqual(
			result.issues.map((i) => i.message),
			['must be at most 64 characters']
		);
	});

	test('a key both too long and off the grammar throws with the length message', () => {
		const key = `1${'a'.repeat(NAME_LENGTH_MAX)}`;
		assert.throws(
			() => create_audit_log_config({ extra_events: { [key]: null } }),
			`extra_events key "${key}" has invalid format: must be at most 64 characters`
		);
	});

	test('a key off the grammar throws with the pattern message', () => {
		for (const key of ['1login', '_login', 'log in', 'login\n', '']) {
			assert.throws(
				() => create_audit_log_config({ extra_events: { [key]: null } }),
				`extra_events key "${key}" has invalid format: must start with a letter; only letters, digits, _ . / - allowed`
			);
		}
	});
});
