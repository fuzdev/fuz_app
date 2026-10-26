import { assert, describe, test } from 'vitest';
import { z } from 'zod';

import type { ConformanceCase } from '#lib/testing/cross_backend/conformance_case.ts';
import { send_conformance_case } from '#lib/testing/cross_backend/conformance_table.ts';
import {
	check_known_divergence_ledger,
	DIFFERENTIAL_REQUEST_HEADERS,
	describe_differential_conformance_tests,
	type DifferentialBackend,
	type KnownDivergence
} from '#lib/testing/cross_backend/differential.ts';
import type { TestFixture } from '#lib/testing/cross_backend/setup.ts';
import type { FetchTransport } from '#lib/testing/transports/fetch_transport.ts';
import type { AppSurfaceSpec } from '#lib/http/surface.ts';
import { rpc_action } from '#lib/actions/action_rpc.ts';
import { create_session_config } from '#lib/auth/session_cookie.ts';

const case_on = (name: string, method: string): ConformanceCase => ({
	name,
	request: { method, as: 'keeper' },
	expect: { status: 400 }
});

const CASES: ReadonlyArray<ConformanceCase> = [
	case_on('scope refusal one', 'account_token_create'),
	case_on('scope refusal two', 'account_token_create'),
	case_on('a list read', 'admin_account_list')
];

const entry = (match: Pick<KnownDivergence, 'case_name' | 'method'>): KnownDivergence =>
	({
		...match,
		tracking_id: 'probe',
		reason: 'probe',
		what_differs: ['body.error.data.reason']
	}) as KnownDivergence;

describe('check_known_divergence_ledger', () => {
	test('a ledger naming only real cases and methods has no problems', () => {
		assert.deepEqual(
			check_known_divergence_ledger(CASES, [
				entry({ case_name: ['scope refusal one', 'scope refusal two'] }),
				entry({ method: 'admin_account_list' })
			]),
			[]
		);
	});

	test('a dead case name behind a live one is reported', () => {
		assert.deepEqual(
			check_known_divergence_ledger(CASES, [
				entry({ case_name: ['scope refusal one', 'ghost case'] })
			]),
			["'probe' names no such case: 'ghost case'"]
		);
	});

	test('a dead method behind a live one is reported', () => {
		assert.deepEqual(
			check_known_divergence_ledger(CASES, [
				entry({ method: ['admin_account_list', 'admin_acount_list'] })
			]),
			["'probe' names a method no case sends: 'admin_acount_list'"]
		);
	});

	test('an entry matching no case is reported once', () => {
		assert.deepEqual(check_known_divergence_ledger(CASES, [entry({ case_name: 'ghost case' })]), [
			"'probe' matches no case — fix its case name or method"
		]);
		assert.deepEqual(check_known_divergence_ledger(CASES, [entry({ method: 'no_such_method' })]), [
			"'probe' matches no case — fix its case name or method"
		]);
	});
});

/** One endpoint mounting one read, for the fake backends below. */
const probe_rpc_endpoints = [
	{
		path: '/api/rpc',
		actions: [
			rpc_action(
				{
					method: 'probe_read',
					kind: 'request_response',
					initiator: 'frontend',
					auth: { account: 'required', actor: 'none' },
					side_effects: false,
					input: z.strictObject({}),
					output: z.strictObject({}),
					async: true,
					description: 'A read.'
				},
				() => ({})
			)
		]
	}
];

const probe_read_case: ConformanceCase = {
	name: 'a read',
	request: { method: 'probe_read', as: 'keeper' },
	expect: { status: 200 }
};

// A backend that negotiates content encoding the way `Deno.serve` does: it
// compresses when the request accepts gzip, and a request naming no
// `accept-encoding` accepts it, as Node's `fetch` sends `gzip, deflate` by
// default. The other answers as is. Equal bodies, so the only difference a
// differential could see is the negotiation's headers.
const create_negotiating_backend = (name: string, compresses: boolean): DifferentialBackend => {
	const transport = (async (_url: string, init: RequestInit): Promise<Response> => {
		const accepted = new Headers(init.headers).get('accept-encoding') ?? 'gzip, deflate';
		const headers = new Headers({ 'content-type': 'application/json' });
		if (compresses && accepted.includes('gzip')) {
			headers.set('content-encoding', 'gzip');
			headers.set('vary', 'Accept-Encoding');
		}
		return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'test', result: {} }), { headers });
	}) as FetchTransport;
	const fixture = {
		transport,
		fresh_transport: () => transport,
		actor: { id: '00000000-0000-4000-8000-000000000001' },
		create_session_headers: () => ({})
	} as unknown as TestFixture;
	return { name, setup_test: async () => fixture };
};

describe('the differential asks for uncompressed responses', () => {
	describe_differential_conformance_tests({
		suite_name: 'a compressing and a plain backend',
		cases: [probe_read_case],
		backends: [
			create_negotiating_backend('compressing', true),
			create_negotiating_backend('plain', false)
		],
		surface_source: {} as AppSurfaceSpec,
		rpc_endpoints: probe_rpc_endpoints,
		session_options: create_session_config('test_differential_session')
	});
});

describe('send_conformance_case request_headers', () => {
	// the differential's headers sit beneath the principal's, so a principal
	// header is never replaced by them
	test('the principal header wins on a clash, the others reach the request', async () => {
		const received: Array<Headers> = [];
		const transport = (async (_url: string, init: RequestInit): Promise<Response> => {
			received.push(new Headers(init.headers));
			return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'test', result: {} }), {
				headers: { 'content-type': 'application/json' }
			});
		}) as FetchTransport;
		const fixture = {
			transport,
			fresh_transport: () => transport,
			actor: { id: '00000000-0000-4000-8000-000000000001' },
			create_session_headers: () => ({ 'accept-encoding': 'gzip', cookie: 'session=principal' })
		} as unknown as TestFixture;

		await send_conformance_case(probe_read_case, {
			fixture,
			surface_source: {} as AppSurfaceSpec,
			resolved_rpc_endpoints: probe_rpc_endpoints,
			request_headers: { ...DIFFERENTIAL_REQUEST_HEADERS, 'x-request-only': 'kept' }
		});

		assert.strictEqual(received.length, 1);
		const headers = received[0]!;
		assert.strictEqual(headers.get('accept-encoding'), 'gzip');
		assert.strictEqual(headers.get('cookie'), 'session=principal');
		assert.strictEqual(headers.get('x-request-only'), 'kept');
	});
});
