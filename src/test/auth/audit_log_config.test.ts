/**
 * Unit tests for `create_audit_log_config` and `builtin_audit_log_config`.
 *
 * Runtime + DB-level behavior of consumer event types is covered by
 * `audit_log_queries.db.test.ts`; this file tests the pure factory.
 *
 * @module
 */

import {describe, test, assert} from 'vitest';
import {z} from 'zod';

import {
	AUDIT_EVENT_TYPES,
	audit_metadata_schemas,
	AuditEventTypeName,
	builtin_audit_log_config,
	create_audit_log_config,
} from '$lib/auth/audit_log_schema.js';

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
		const config = create_audit_log_config({extra_events: {}});
		assert.strictEqual(config, builtin_audit_log_config);
	});

	test('appends extra event keys after the builtins', () => {
		const config = create_audit_log_config({
			extra_events: {classroom_create: null, classroom_update: null},
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
		const config = create_audit_log_config({extra_events: {classroom_create: null}});
		assert.isTrue(Object.isFrozen(config));
		assert.isTrue(Object.isFrozen(config.event_types));
		assert.isTrue(Object.isFrozen(config.metadata_schemas));
	});

	test('schema entries populate metadata_schemas; null entries register the type only', () => {
		const classroom_schema = z.looseObject({classroom_id: z.string()});
		const config = create_audit_log_config({
			extra_events: {
				classroom_create: classroom_schema,
				classroom_delete: null,
			},
		});
		// builtin entries still present
		assert.strictEqual(config.metadata_schemas.login, audit_metadata_schemas.login);
		// schema entry exposed
		assert.strictEqual(config.metadata_schemas.classroom_create, classroom_schema);
		// null entry: type is registered, but no schema entry — validation skips
		assert.isTrue(config.event_types.includes('classroom_delete'));
		assert.isUndefined(config.metadata_schemas.classroom_delete);
	});

	test('rejects extra_events keys that collide with a builtin', () => {
		assert.throws(
			() => create_audit_log_config({extra_events: {login: null}}),
			/collides with a builtin/,
		);
		assert.throws(
			() => create_audit_log_config({extra_events: {logout: z.object({foo: z.string()})}}),
			/collides with a builtin/,
		);
	});

	test('accepts extra_events keys with allowed punctuation (. / - _)', () => {
		const config = create_audit_log_config({
			extra_events: {
				'app.classroom.create': null,
				'app/classroom/update': null,
				'app-classroom-delete': null,
				app_classroom_archive: null,
			},
		});
		assert.isTrue(config.event_types.includes('app.classroom.create'));
		assert.isTrue(config.event_types.includes('app/classroom/update'));
		assert.isTrue(config.event_types.includes('app-classroom-delete'));
		assert.isTrue(config.event_types.includes('app_classroom_archive'));
	});

	test('rejects extra_events keys that fail format validation', () => {
		// empty string
		assert.throws(() => create_audit_log_config({extra_events: {'': null}}), /invalid format/);
		// leading whitespace
		assert.throws(
			() => create_audit_log_config({extra_events: {' login_alt': null}}),
			/invalid format/,
		);
		// leading separator
		assert.throws(
			() => create_audit_log_config({extra_events: {'.classroom_create': null}}),
			/invalid format/,
		);
		// disallowed character
		assert.throws(
			() => create_audit_log_config({extra_events: {'classroom create': null}}),
			/invalid format/,
		);
		// digit-leading
		assert.throws(
			() => create_audit_log_config({extra_events: {'1classroom_create': null}}),
			/invalid format/,
		);
	});
});

describe('AuditEventTypeName invariant', () => {
	test('every builtin AUDIT_EVENT_TYPES entry passes the schema', () => {
		for (const t of AUDIT_EVENT_TYPES) {
			const result = AuditEventTypeName.safeParse(t);
			assert.isTrue(result.success, `builtin "${t}" failed AuditEventTypeName format`);
		}
	});
});
