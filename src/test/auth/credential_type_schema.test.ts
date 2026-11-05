/**
 * Tests for `credential_type_schema.ts` — open registry of authentication
 * credential types with three builtins.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';

import {
	BUILTIN_CREDENTIAL_TYPES,
	builtin_credential_type_meta,
	create_credential_type_schema,
	CREDENTIAL_TYPE_API_TOKEN,
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	CREDENTIAL_TYPE_SESSION,
	CredentialTypeName
} from '#lib/auth/credential_type_schema.ts';
import { NAME_LENGTH_MAX } from '#lib/auth/name_schema.ts';

describe('create_credential_type_schema', () => {
	test('builtins-only round-trip', () => {
		const { CredentialType, credential_types } = create_credential_type_schema();
		assert.strictEqual(credential_types.size, 3);
		assert.ok(CredentialType.safeParse(CREDENTIAL_TYPE_SESSION).success);
		assert.ok(CredentialType.safeParse(CREDENTIAL_TYPE_API_TOKEN).success);
		assert.ok(CredentialType.safeParse(CREDENTIAL_TYPE_DAEMON_TOKEN).success);
		assert.ok(!CredentialType.safeParse('unknown').success);
	});

	test('consumer-declared types extend the registry', () => {
		const { CredentialType, credential_types } = create_credential_type_schema({
			sso_assertion: { description: 'OIDC SSO assertion' },
			agent_token: {}
		});
		assert.strictEqual(credential_types.size, 5);
		assert.ok(CredentialType.safeParse('sso_assertion').success);
		assert.ok(CredentialType.safeParse('agent_token').success);
		assert.strictEqual(credential_types.get('sso_assertion')?.description, 'OIDC SSO assertion');
	});

	test('throws on collision with a builtin name', () => {
		assert.throws(() => create_credential_type_schema({ session: {} }), /collides with builtin/);
		assert.throws(() => create_credential_type_schema({ api_token: {} }), /collides with builtin/);
		assert.throws(
			() => create_credential_type_schema({ daemon_token: {} }),
			/collides with builtin/
		);
	});

	test('rejects invalid credential-type names', () => {
		assert.throws(() => create_credential_type_schema({ '': {} }));
		assert.throws(() => create_credential_type_schema({ BadName: {} }));
		assert.throws(() => create_credential_type_schema({ _leading: {} }));
		assert.throws(() => create_credential_type_schema({ trailing_: {} }));
		assert.throws(() => create_credential_type_schema({ 'has-dash': {} }));
		assert.throws(() => create_credential_type_schema({ 'has space': {} }));
		assert.throws(() => create_credential_type_schema({ sso__assertion: {} }));
		assert.throws(() => create_credential_type_schema({ sso___assertion: {} }));
		assert.throws(() => create_credential_type_schema({ a_b__c: {} }));
		assert.throws(() => create_credential_type_schema({ __ab: {} }));
		assert.throws(() => create_credential_type_schema({ ab__: {} }));
		// a run of underscores is off the grammar, not merely unusual: it throws at construction
		assert.throws(
			() => create_credential_type_schema({ a__b: {} }),
			'Invalid credential-type name "a__b": Credential-type names must be lowercase letters and underscores (a-z_), no leading, trailing or consecutive underscores'
		);
	});

	test('accepts valid credential-type names', () => {
		assert.ok(create_credential_type_schema({ a: {} }));
		assert.ok(create_credential_type_schema({ sso_assertion: {} }));
		assert.ok(create_credential_type_schema({ a_b_c: {} }));
	});

	test('CredentialTypeName refuses runs of underscores', () => {
		for (const name of [
			'a',
			'sso_assertion',
			'a_b_c',
			`${'a_'.repeat(NAME_LENGTH_MAX / 2 - 1)}aa`
		]) {
			assert.ok(CredentialTypeName.safeParse(name).success, name);
		}
		for (const name of ['a__b', 'a___b', 'a_b__c', '__ab', 'ab__', '__', '_', '']) {
			assert.ok(!CredentialTypeName.safeParse(name).success, name);
		}
	});

	test('CredentialTypeName is capped at NAME_LENGTH_MAX characters', () => {
		const at_max = 'a'.repeat(NAME_LENGTH_MAX);
		const over_max = 'a'.repeat(NAME_LENGTH_MAX + 1);
		assert.ok(CredentialTypeName.safeParse(at_max).success);
		const over = CredentialTypeName.safeParse(over_max);
		assert.ok(!over.success);
		assert.strictEqual(
			over.error.issues[0]!.message,
			'Credential-type names must be at most 64 characters'
		);
		// a registered name past the cap throws at construction
		assert.ok(create_credential_type_schema({ [at_max]: {} }));
		assert.throws(
			() => create_credential_type_schema({ [over_max]: {} }),
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
