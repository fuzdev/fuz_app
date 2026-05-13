/**
 * Tests for `credential_type_schema.ts` — open registry of authentication
 * credential types with three builtins.
 *
 * @module
 */

import {describe, assert, test} from 'vitest';

import {
	BUILTIN_CREDENTIAL_TYPES,
	builtin_credential_type_meta,
	create_credential_type_schema,
	CREDENTIAL_TYPE_API_TOKEN,
	CREDENTIAL_TYPE_DAEMON_TOKEN,
	CREDENTIAL_TYPE_SESSION,
} from '$lib/auth/credential_type_schema.js';

describe('create_credential_type_schema', () => {
	test('builtins-only round-trip', () => {
		const {CredentialType, credential_types} = create_credential_type_schema();
		assert.strictEqual(credential_types.size, 3);
		assert.ok(CredentialType.safeParse(CREDENTIAL_TYPE_SESSION).success);
		assert.ok(CredentialType.safeParse(CREDENTIAL_TYPE_API_TOKEN).success);
		assert.ok(CredentialType.safeParse(CREDENTIAL_TYPE_DAEMON_TOKEN).success);
		assert.ok(!CredentialType.safeParse('unknown').success);
	});

	test('consumer-declared types extend the registry', () => {
		const {CredentialType, credential_types} = create_credential_type_schema({
			sso_assertion: {description: 'OIDC SSO assertion'},
			agent_token: {},
		});
		assert.strictEqual(credential_types.size, 5);
		assert.ok(CredentialType.safeParse('sso_assertion').success);
		assert.ok(CredentialType.safeParse('agent_token').success);
		assert.strictEqual(credential_types.get('sso_assertion')?.description, 'OIDC SSO assertion');
	});

	test('throws on collision with a builtin name', () => {
		assert.throws(() => create_credential_type_schema({session: {}}), /collides with builtin/);
		assert.throws(() => create_credential_type_schema({api_token: {}}), /collides with builtin/);
		assert.throws(() => create_credential_type_schema({daemon_token: {}}), /collides with builtin/);
	});

	test('rejects invalid credential-type names', () => {
		assert.throws(() => create_credential_type_schema({'': {}}));
		assert.throws(() => create_credential_type_schema({BadName: {}}));
		assert.throws(() => create_credential_type_schema({_leading: {}}));
		assert.throws(() => create_credential_type_schema({trailing_: {}}));
		assert.throws(() => create_credential_type_schema({'has-dash': {}}));
		assert.throws(() => create_credential_type_schema({'has space': {}}));
	});

	test('builtins exported as a const tuple', () => {
		assert.deepStrictEqual(
			[...BUILTIN_CREDENTIAL_TYPES],
			[CREDENTIAL_TYPE_SESSION, CREDENTIAL_TYPE_API_TOKEN, CREDENTIAL_TYPE_DAEMON_TOKEN],
		);
	});

	test('builtin metadata describes each entry', () => {
		assert.strictEqual(builtin_credential_type_meta.size, 3);
		for (const name of BUILTIN_CREDENTIAL_TYPES) {
			assert.ok(builtin_credential_type_meta.get(name)?.description);
		}
	});
});
