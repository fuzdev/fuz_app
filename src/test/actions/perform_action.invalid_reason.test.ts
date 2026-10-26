/**
 * Declared input reasons on the RPC dispatcher — an `invalid_params` refusal
 * carries the `invalid_reason` the failing field declares, on every fault
 * kind, and none for an undeclared field or a whole-input fault.
 *
 * @module
 */

import { describe, assert, test } from 'vitest';
import { Hono } from 'hono';
import { z } from 'zod';
import { Logger } from '@fuzdev/fuz_util/log.ts';

import { create_rpc_endpoint } from '#lib/actions/action_rpc.ts';
import { to_invalid_params_error } from '#lib/actions/perform_action.ts';
import type { RequestResponseActionSpec } from '#lib/actions/action_spec.ts';
import { create_action_event } from '#lib/actions/action_event.ts';
import type { ActionEventEnvironment } from '#lib/actions/action_event_types.ts';
import { apply_route_specs } from '#lib/http/route_spec.ts';
import { fuz_auth_guard_resolver } from '#lib/auth/auth_guard_resolver.ts';
import { create_stub_db } from '#lib/testing/stubs.ts';
import { JSONRPC_ERROR_CODES } from '#lib/http/jsonrpc_errors.ts';
import {
	ERROR_TOKEN_LIFETIME_INVALID,
	ERROR_TOKEN_SCOPE_INVALID,
	TokenCreateInput
} from '#lib/auth/account_action_specs.ts';
import { AdminAccountListInput, AuditLogListInput } from '#lib/auth/admin_action_specs.ts';
import { RoleGrantOfferHistoryInput } from '#lib/auth/role_grant_offer_action_specs.ts';
import {
	ERROR_LIMIT_INVALID,
	ERROR_OFFSET_INVALID,
	ERROR_OUTCOME_INVALID,
	ERROR_SINCE_SEQ_INVALID
} from '#lib/http/error_schemas.ts';

const log = new Logger('test', { level: 'off' });
const db = create_stub_db();

const ThingInput = z.strictObject({
	count: z.number().int().min(1).max(10).meta({ invalid_reason: 'count_invalid' }),
	page: z
		.strictObject({
			size: z.number().int().min(1).meta({ invalid_reason: 'page_size_invalid' }),
			cursor: z.string().optional()
		})
		.optional()
		.meta({ invalid_reason: 'page_invalid' }),
	label: z.string().optional()
});

const thing_spec: RequestResponseActionSpec = {
	method: 'thing_put',
	kind: 'request_response',
	initiator: 'frontend',
	auth: { account: 'none', actor: 'none' },
	side_effects: true,
	input: ThingInput,
	output: z.strictObject({ ok: z.literal(true) }),
	async: true,
	description: 'a thing with declared reasons'
};

const create_app = (): Hono => {
	const app = new Hono();
	apply_route_specs(
		app,
		create_rpc_endpoint({
			path: '/api/rpc',
			actions: [{ spec: thing_spec, handler: () => ({ ok: true }) }],
			log,
			action_ip_rate_limiter: null,
			action_account_rate_limiter: null
		}),
		fuz_auth_guard_resolver,
		log,
		db
	);
	return app;
};

/** POST `params`, return the status and `error`. */
const send = async (
	app: Hono,
	params: unknown
): Promise<{ status: number; error: { code: number; message: string; data?: any } }> => {
	const res = await app.request('/api/rpc', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ jsonrpc: '2.0', id: '1', method: 'thing_put', params })
	});
	const body = await res.json();
	return { status: res.status, error: body.error };
};

describe('declared invalid_reason on the RPC dispatcher', () => {
	test('every fault kind on a declared field carries its reason', async () => {
		const app = create_app();
		for (const params of [
			{},
			{ count: null },
			{ count: 'not_a_number' },
			{ count: 0 },
			{ count: 11 },
			{ count: 1.5 }
		]) {
			const { status, error } = await send(app, params);
			assert.strictEqual(status, 400, JSON.stringify(params));
			assert.strictEqual(error.code, JSONRPC_ERROR_CODES.invalid_params);
			assert.strictEqual(error.message, 'invalid params');
			assert.strictEqual(error.data?.reason, 'count_invalid', JSON.stringify(params));
			// the Zod issues stay beside it under DEV
			assert.ok(Array.isArray(error.data?.issues));
		}
	});

	test('a fault inside a nested field takes the deepest declaration', async () => {
		const app = create_app();
		assert.strictEqual(
			(await send(app, { count: 1, page: { size: 0 } })).error.data?.reason,
			'page_size_invalid'
		);
		// `cursor` declares none, so the declared parent answers
		assert.strictEqual(
			(await send(app, { count: 1, page: { size: 1, cursor: 4 } })).error.data?.reason,
			'page_invalid'
		);
		assert.strictEqual(
			(await send(app, { count: 1, page: 'x' })).error.data?.reason,
			'page_invalid'
		);
	});

	test('an undeclared field or a whole-input fault carries none', async () => {
		const app = create_app();
		for (const params of [
			{ count: 1, label: 4 },
			{ count: 1, extra: true }
		]) {
			const { status, error } = await send(app, params);
			assert.strictEqual(status, 400);
			assert.strictEqual(error.code, JSONRPC_ERROR_CODES.invalid_params);
			assert.ok(error.data, 'DEV keeps the issues');
			assert.notProperty(error.data, 'reason', JSON.stringify(params));
		}
	});

	test('an unknown key on the input answers none, whatever else is wrong', async () => {
		// the Rust twin refuses unknown keys before reading any field, so a stale
		// client sending an extra key gets one answer from both spines
		const app = create_app();
		for (const params of [
			{ count: 0, extra: true },
			{ extra: true, count: 'x' },
			{ count: 1, page: { size: 0 }, extra: true }
		]) {
			const { status, error } = await send(app, params);
			assert.strictEqual(status, 400);
			assert.strictEqual(error.code, JSONRPC_ERROR_CODES.invalid_params);
			assert.ok(error.data, 'DEV keeps the issues');
			assert.notProperty(error.data, 'reason', JSON.stringify(params));
		}
	});

	test('the first issue picks the field', async () => {
		// both fields fail; Zod reports `count` first, in shape order
		const { error } = await send(create_app(), { count: 0, page: { size: 0 } });
		assert.strictEqual(error.data?.reason, 'count_invalid');
	});

	test('a local ActionEvent parse carries the same reason', () => {
		const environment: ActionEventEnvironment = {
			executor: 'frontend',
			lookup_action_handler: () => undefined,
			lookup_action_spec: (method) => (method === thing_spec.method ? thing_spec : undefined)
		};
		const event = create_action_event(environment, thing_spec, { count: 0 });
		event.parse();
		assert.strictEqual(event.data.step, 'failed');
		const error = event.data.error as { code: number; data?: any };
		assert.strictEqual(error.code, JSONRPC_ERROR_CODES.invalid_params);
		assert.strictEqual(error.data?.reason, 'count_invalid');
		assert.ok(Array.isArray(error.data?.validation_errors));
		const extra = create_action_event(environment, thing_spec, { count: 0, extra: true });
		extra.parse();
		const extra_error = extra.data.error as { data?: any };
		assert.ok(Array.isArray(extra_error.data?.validation_errors));
		assert.notProperty(extra_error.data, 'reason');
	});
});

/** The reason `input` answers `params` with, through the dispatcher's mapping. */
const reason_for = (input: z.ZodType, params: unknown): unknown => {
	const result = input.safeParse(params);
	assert.ok(!result.success, `refused: ${JSON.stringify(params)}`);
	const data = to_invalid_params_error(input, result.error.issues).data as
		{ reason?: unknown } | undefined;
	return data?.reason;
};

describe('the spine inputs declare the reasons the Rust twin sends', () => {
	test('paged reads', () => {
		for (const input of [AdminAccountListInput, AuditLogListInput, RoleGrantOfferHistoryInput]) {
			for (const limit of [0, 100_000, 1.5, 'x', true]) {
				assert.strictEqual(reason_for(input, { limit }), ERROR_LIMIT_INVALID);
			}
			for (const offset of [-1, 1e16, 0.5, 'x']) {
				assert.strictEqual(reason_for(input, { offset }), ERROR_OFFSET_INVALID);
			}
			// an undeclared field on the same input carries none
			assert.strictEqual(reason_for(input, { acting: 'not-a-uuid' }), undefined);
		}
		for (const since_seq of [-1, 1e16, 'x']) {
			assert.strictEqual(reason_for(AuditLogListInput, { since_seq }), ERROR_SINCE_SEQ_INVALID);
		}
		for (const outcome of ['maybe', 42]) {
			assert.strictEqual(reason_for(AuditLogListInput, { outcome }), ERROR_OUTCOME_INVALID);
		}
	});

	test('account_token_create', () => {
		const scope = { kind: 'full' };
		const lifetime = { kind: 'eternal' };
		for (const params of [
			{ lifetime },
			{ scope: null, lifetime },
			{ scope: { kind: 'nope' }, lifetime },
			{ scope: { kind: 'full', version: 1 }, lifetime },
			{ scope: { kind: 'methods', methods: null }, lifetime }
		]) {
			assert.strictEqual(reason_for(TokenCreateInput, params), ERROR_TOKEN_SCOPE_INVALID);
		}
		for (const params of [
			{ scope },
			{ scope, lifetime: null },
			{ scope, lifetime: { kind: 'ttl', days: 0 } },
			{ scope, lifetime: { kind: 'forever' } }
		]) {
			assert.strictEqual(reason_for(TokenCreateInput, params), ERROR_TOKEN_LIFETIME_INVALID);
		}
		assert.strictEqual(reason_for(TokenCreateInput, { name: 4, scope, lifetime }), undefined);
	});
});
