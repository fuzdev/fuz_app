/**
 * Tests for `account_action_specs.ts` — the length cap on
 * `account_token_create`'s `name`, and `account_token_revoke`'s
 * `@fuzdev/fuz_schema` schemas: their surface entry is the one captured in
 * `fixtures/surface/account_token_revoke.json`.
 *
 * @module
 */

import { describe, test, assert } from 'vitest';
import { readFileSync } from 'node:fs';
import { is, is_schema, parse } from '@fuzdev/fuz_schema/schema.ts';

import {
	API_TOKEN_NAME_LENGTH_MAX,
	TokenCreateInput,
	TokenRevokeInput,
	TokenRevokeOutput,
	account_token_revoke_action_spec
} from '#lib/auth/account_action_specs.ts';
import { generate_app_surface } from '#lib/http/surface.ts';
import { action_manifest_entry } from '#lib/testing/cross_backend/action_manifest.ts';

const base = { scope: { kind: 'full' }, lifetime: { kind: 'eternal' } } as const;

describe('TokenCreateInput name', () => {
	test('defaults when omitted', () => {
		const parsed = parse(TokenCreateInput, base);
		assert.ok(parsed.ok);
		assert.strictEqual(parsed.value.name, 'CLI token');
	});

	test('admits a name at the cap and refuses one past it', () => {
		const at_cap = parse(TokenCreateInput, {
			...base,
			name: 'a'.repeat(API_TOKEN_NAME_LENGTH_MAX)
		});
		assert.ok(at_cap.ok);
		assert.strictEqual(at_cap.value.name.length, API_TOKEN_NAME_LENGTH_MAX);
		assert.ok(!is(TokenCreateInput, { ...base, name: 'a'.repeat(API_TOKEN_NAME_LENGTH_MAX + 1) }));
	});

	test('counts UTF-16 code units, so an astral character costs two', () => {
		const astral = '\u{1F600}';
		// the cap is odd: the largest whole number of astral characters, plus one unit
		const at_cap = astral.repeat((API_TOKEN_NAME_LENGTH_MAX - 1) / 2) + 'a';
		assert.strictEqual(at_cap.length, API_TOKEN_NAME_LENGTH_MAX);
		assert.ok(is(TokenCreateInput, { ...base, name: at_cap }));
		assert.ok(!is(TokenCreateInput, { ...base, name: at_cap + 'a' }));
		assert.ok(
			!is(TokenCreateInput, { ...base, name: astral.repeat((API_TOKEN_NAME_LENGTH_MAX + 1) / 2) })
		);
	});
});

const SURFACE_FIXTURE_PATH = new URL(
	'../fixtures/surface/account_token_revoke.json',
	import.meta.url
);

describe('account_token_revoke schemas', () => {
	test('are fuz_schema schemas', () => {
		assert.ok(is_schema(TokenRevokeInput));
		assert.ok(is_schema(TokenRevokeOutput));
	});

	test('the surface entry is the captured one, byte for byte', () => {
		const surface = generate_app_surface({
			route_specs: [],
			middleware_specs: [],
			rpc_endpoints: [
				{
					path: '/api/rpc',
					actions: [{ spec: account_token_revoke_action_spec, handler: () => null }]
				}
			]
		});
		assert.deepStrictEqual(surface.diagnostics, []);
		const entry = surface.rpc_endpoints[0]!.methods[0];
		const expected = readFileSync(SURFACE_FIXTURE_PATH, 'utf8');
		assert.deepStrictEqual(entry, JSON.parse(expected));
		assert.strictEqual(JSON.stringify(entry, null, '\t') + '\n', expected);
	});

	test('the action manifest entry reads an object input', () => {
		assert.deepStrictEqual(action_manifest_entry(account_token_revoke_action_spec), {
			method: 'account_token_revoke',
			input: 'object',
			side_effects: true,
			account: 'required',
			actor: 'none',
			roles: [],
			credential_types: ['session'],
			rate_limit: null
		});
	});

	test('a token id off the pattern fails with a regex issue on `token_id`', () => {
		for (const token_id of ['tok_short', 'xyz_xxxxxxxxxxxx', 'tok_xxxxxxxxxxx!', '']) {
			const result = parse(TokenRevokeInput, { token_id });
			assert.ok(!result.ok, token_id);
			assert.strictEqual(result.issues.length, 1);
			assert.strictEqual(result.issues[0]!.kind, 'regex');
			assert.deepStrictEqual(result.issues[0]!.path, ['token_id']);
		}
		const valid = parse(TokenRevokeInput, { token_id: 'tok_aZ09_-aZ09_-' });
		assert.ok(valid.ok);
	});

	test('the input refuses an unknown key, the output a missing or wrong field', () => {
		const extra = parse(TokenRevokeInput, { token_id: 'tok_xxxxxxxxxxxx', extra: 1 });
		assert.ok(!extra.ok);
		assert.strictEqual(extra.issues[0]!.kind, 'unknown_key');
		assert.ok(parse(TokenRevokeOutput, { ok: true, revoked: false }).ok);
		assert.ok(!parse(TokenRevokeOutput, { ok: false, revoked: false }).ok);
		assert.ok(!parse(TokenRevokeOutput, { ok: true }).ok);
		assert.ok(!parse(TokenRevokeOutput, { ok: true, revoked: true, extra: 1 }).ok);
	});
});
