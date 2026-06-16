/**
 * `dev_only(value)` is the single gate that keeps internal diagnostic detail
 * out of production error responses — Zod `issues` (the `error.data` object on
 * JSON-RPC errors, the `issues` field on flat REST bodies) and raw exception
 * messages (the `internal_error` 500 message on both transports). It returns
 * the value in development and `undefined` in production, so `JSON.stringify`
 * drops the field. Vitest runs with `DEV=true`, so the production branch — the
 * one that actually closes the leaks — is never hit incidentally. This forces
 * `DEV=false` via a scoped `esm-env` mock + a fresh module graph and asserts
 * the value is dropped, pinning the production short-circuit nothing else
 * exercises.
 *
 * @module
 */

import {test, assert, afterEach, vi} from 'vitest';

afterEach(() => {
	vi.doUnmock('esm-env');
	vi.resetModules();
});

test('dev_only drops the value in production (DEV=false)', async () => {
	vi.resetModules();
	vi.doMock('esm-env', () => ({DEV: false}));
	const {dev_only} = await import('$lib/http/jsonrpc_errors.ts');
	// The leak shapes both call patterns produce: a wrapped `data` object (RPC)
	// and a bare issues array (REST) — both must vanish in production.
	assert.strictEqual(dev_only({issues: [{code: 'custom', message: 'x', path: []}]}), undefined);
	assert.strictEqual(dev_only([{code: 'custom', message: 'x', path: []}]), undefined);
	// Internal-error masking composes through the same gate: a raw exception
	// message drops to undefined, so the `internal_error` builder falls back to
	// its generic default and the REST body omits `message`.
	const err = new Error('boom: /var/secret leaked');
	assert.strictEqual(dev_only(err instanceof Error ? err.message : undefined), undefined);
});

test('dev_only passes the value through in development (DEV=true)', async () => {
	vi.resetModules();
	vi.doMock('esm-env', () => ({DEV: true}));
	const {dev_only} = await import('$lib/http/jsonrpc_errors.ts');
	const issues = [{code: 'custom', message: 'x', path: []}];
	assert.strictEqual(dev_only(issues), issues);
});
