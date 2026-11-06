/**
 * Tests for `credential_type_schema.ts` — open registry of authentication
 * credential types with three builtins.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { is, parse } from '@fuzdev/fuz_schema/schema.ts';

import {
	BUILTIN_CREDENTIAL_TYPES,
	builtin_credential_type_meta,
	create_credential_type_registry,
	CREDENTIAL_TYPE_API_TOKEN,
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	CREDENTIAL_TYPE_SESSION,
	CredentialTypeName
} from '#lib/auth/credential_type_schema.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

describe('create_credential_type_registry', () => {
	test('builtins-only round-trip', () => {
		const { credential_types } = create_credential_type_registry();
		assert.strictEqual(credential_types.size, 3);
		assert.ok(credential_types.has(CREDENTIAL_TYPE_SESSION));
		assert.ok(credential_types.has(CREDENTIAL_TYPE_API_TOKEN));
		assert.ok(credential_types.has(CREDENTIAL_TYPE_DAEMON_TOKEN));
		assert.ok(!credential_types.has('unknown'));
	});

	test('consumer-declared types extend the registry', () => {
		const { credential_types } = create_credential_type_registry({
			sso_assertion: { description: 'OIDC SSO assertion' },
			agent_token: {}
		});
		assert.strictEqual(credential_types.size, 5);
		assert.ok(credential_types.has('sso_assertion'));
		assert.ok(credential_types.has('agent_token'));
		assert.strictEqual(credential_types.get('sso_assertion')?.description, 'OIDC SSO assertion');
	});

	test('throws on collision with a builtin name', () => {
		assert.throws(() => create_credential_type_registry({ session: {} }), /collides with builtin/);
		assert.throws(
			() => create_credential_type_registry({ api_token: {} }),
			/collides with builtin/
		);
		assert.throws(
			() => create_credential_type_registry({ daemon_token: {} }),
			/collides with builtin/
		);
	});

	test('rejects invalid credential-type names', () => {
		assert.throws(() => create_credential_type_registry({ '': {} }));
		assert.throws(() => create_credential_type_registry({ BadName: {} }));
		assert.throws(() => create_credential_type_registry({ _leading: {} }));
		assert.throws(() => create_credential_type_registry({ trailing_: {} }));
		assert.throws(() => create_credential_type_registry({ 'has-dash': {} }));
		assert.throws(() => create_credential_type_registry({ 'has space': {} }));
		assert.throws(() => create_credential_type_registry({ sso__assertion: {} }));
		assert.throws(() => create_credential_type_registry({ sso___assertion: {} }));
		assert.throws(() => create_credential_type_registry({ a_b__c: {} }));
		assert.throws(() => create_credential_type_registry({ __ab: {} }));
		assert.throws(() => create_credential_type_registry({ ab__: {} }));
		// a run of underscores is off the grammar, not merely unusual: it throws at construction
		assert.throws(
			() => create_credential_type_registry({ a__b: {} }),
			'Invalid credential-type name "a__b": Credential-type names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores'
		);
	});

	test('accepts valid credential-type names', () => {
		assert.ok(create_credential_type_registry({ a: {} }));
		assert.ok(create_credential_type_registry({ sso_assertion: {} }));
		assert.ok(create_credential_type_registry({ a_b_c: {} }));
	});

	test('CredentialTypeName refuses runs of underscores', () => {
		for (const name of [
			'a',
			'sso_assertion',
			'a_b_c',
			`${'a_'.repeat(NAME_LENGTH_MAX / 2 - 1)}aa`
		]) {
			assert.ok(is(CredentialTypeName, name), name);
		}
		for (const name of ['a__b', 'a___b', 'a_b__c', '__ab', 'ab__', '__', '_', '']) {
			assert.ok(!is(CredentialTypeName, name), name);
		}
	});

	test('CredentialTypeName is capped at NAME_LENGTH_MAX characters', () => {
		const at_max = 'a'.repeat(NAME_LENGTH_MAX);
		const over_max = 'a'.repeat(NAME_LENGTH_MAX + 1);
		assert.ok(is(CredentialTypeName, at_max));
		const over = parse(CredentialTypeName, over_max);
		assert.ok(!over.ok);
		assert.strictEqual(
			over.issues[0]!.message,
			'Credential-type names must be at most 64 characters'
		);
		// a registered name past the cap throws at construction
		assert.ok(create_credential_type_registry({ [at_max]: {} }));
		assert.throws(
			() => create_credential_type_registry({ [over_max]: {} }),
			`Invalid credential-type name "${over_max}": Credential-type names must be at most 64 characters`
		);
	});

	test('builtins exported as a const tuple', () => {
		assert.deepStrictEqual(
			[...BUILTIN_CREDENTIAL_TYPES],
			[CREDENTIAL_TYPE_SESSION, CREDENTIAL_TYPE_API_TOKEN, CREDENTIAL_TYPE_DAEMON_TOKEN]
		);
	});

	test('builtin metadata describes each entry', () => {
		assert.strictEqual(builtin_credential_type_meta.size, 3);
		for (const name of BUILTIN_CREDENTIAL_TYPES) {
			assert.ok(builtin_credential_type_meta.get(name)?.description);
		}
	});
});
