import './assert_dev_env.ts';

/**
 * Schema-driven round-trip validation test suite.
 *
 * For every route spec in the supplied `surface_source`, generates a
 * valid request (auth, params, body) and validates the response against
 * declared output or error schemas. DB-backed via the suite's
 * `setup_test` fixture-producing callback.
 *
 * Cadence: per-describe `setup_test()` call. Each test in the suite
 * fires one HTTP request against a shared fixture, so the per-test cost of
 * re-bootstrapping isn't paid here. A mutation called as the authed account
 * runs on a fresh account of its own (`round_trip_uses_fresh_account`) — a
 * generated logout or self-delete would otherwise end the shared account's
 * credential — and a 401 to any non-public request fails
 * (`is_unauthenticated_refusal`), so a credential lost some other way goes
 * red rather than vacuous. Suites with state-isolation requirements
 * (integration, admin_integration, audit_completeness) call `setup_test()`
 * per test.
 *
 * @module
 */

import { describe, test, beforeAll, assert } from 'vitest';

import { ROLE_ADMIN } from '../auth/role_schema.ts';
import { needs_actor, input_schema_declares_acting } from '../http/auth_shape.ts';
import type { TestAccount } from './app_server.ts';
import {
	assert_response_matches_spec,
	is_unauthenticated_refusal,
	pick_auth_headers,
	pick_auth_principal,
	round_trip_uses_fresh_account,
	to_principal_headers,
	type AuthPrincipal
} from './integration_helpers.ts';
import {
	resolve_valid_path,
	generate_valid_body,
	to_route_content_type
} from './schema_generators.ts';
import type { SetupTest, TestFixture } from './cross_backend/setup.ts';
import type { AppSurfaceSpec } from '../http/surface.ts';

/** Options for `describe_round_trip_validation`. */
export interface RoundTripTestOptions {
	/**
	 * Per-test fixture-producing function. `describe_round_trip_validation`
	 * invokes this once in `beforeAll` (per-describe cadence — see module
	 * docstring) to share a single bootstrapped keeper + accounts across
	 * every route case.
	 */
	setup_test: SetupTest;
	/**
	 * App surface (with route specs) for route iteration. Constructed in
	 * TS by the consumer; same shape for in-process and cross-process tests.
	 */
	surface_source: AppSurfaceSpec;
	/** Routes to skip, in `'METHOD /path'` format. */
	skip_routes?: Array<string>;
	/** Override generated bodies for specific routes (`'METHOD /path'` → body). */
	input_overrides?: Map<string, Record<string, unknown>>;
	/**
	 * Success-case fixtures for routes whose **populated success body** the
	 * generic nil-id input can't reach — referential REST routes whose path
	 * params / body must point at existing rows. Maps `'METHOD /path'` to an
	 * async factory that receives the per-test `fixture` (so it can seed the
	 * referenced state) and returns `{url?, body?}`: an explicit resolved `url`
	 * (when the factory built it from the ids it just seeded) and/or a request
	 * `body`. Omit `url` to fall back to the generated valid path.
	 *
	 * Distinct from `input_overrides` (body-only, accepts a valid error
	 * envelope): a `success_fixtures` entry **asserts a 2xx response** and
	 * validates it against the route's `output` schema — the success-shape
	 * parity check the nil-id round-trip can't perform.
	 */
	success_fixtures?: Map<
		string,
		(fixture: TestFixture) => Promise<{ url?: string; body?: Record<string, unknown> }>
	>;
}

/**
 * Guard against a refusal that says the request carried no valid credential
 * when it carried one (`is_unauthenticated_refusal`), the REST twin of
 * `assert_rpc_authenticated`. Every non-public route is sent a live
 * credential its auth admits, so a 401 reading `authentication_required`, or
 * naming no reason, means the credential stopped working — most often because
 * an earlier request ended it. A public route may answer 401 (a login with a
 * wrong password), and so may a handler refusing an authenticated request
 * with a reason of its own (`invalid_credentials`).
 *
 * @param route_key - the route, as `METHOD /path`
 * @param status - the HTTP status
 * @param body - the parsed response body, or `undefined` when not JSON
 * @param principal - the principal the request was sent as
 */
export const assert_route_authenticated = (
	route_key: string,
	status: number,
	body: unknown,
	principal: AuthPrincipal
): void => {
	if (principal === 'public') return;
	const reason =
		body !== null && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
	if (!is_unauthenticated_refusal(status, reason)) return;
	assert.fail(
		`${route_key} answered 401 (${JSON.stringify(reason ?? null)}) to the ${principal}` +
			` principal's credential — the request carried a credential its auth admits,` +
			` so a 401 here means that credential stopped working`
	);
};

/**
 * Run schema-driven round-trip validation tests.
 *
 * For each route:
 * 1. Resolve URL with valid params
 * 2. Generate a valid request body (or use override)
 * 3. Pick auth headers matching the route's auth requirement
 * 4. Fire the request through `fixture.transport` and validate the response
 *
 * SSE routes are skipped by Content-Type sniff. Routes returning non-2xx
 * with valid input are still validated against their declared error schemas.
 */
export const describe_round_trip_validation = (options: RoundTripTestOptions): void => {
	const describe_time_specs = options.surface_source.route_specs;
	const skip_set = new Set(options.skip_routes);

	describe('round-trip validation', () => {
		let fixture: TestFixture;
		let authed_account: TestAccount;
		let admin_account: TestAccount;

		beforeAll(async () => {
			fixture = await options.setup_test();
			authed_account = await fixture.create_account({
				username: 'round_trip_authed',
				roles: []
			});
			admin_account = await fixture.create_account({
				username: 'round_trip_admin',
				roles: [ROLE_ADMIN]
			});
		});

		// The actor id of whichever account the principal calls as — so an
		// `actor: 'required'` route that declares `acting?: ActingActor` gets the
		// matching actor supplied explicitly (its sole actor, here), rather than
		// relying on implicit single-actor resolution. Keeps such routes drivable
		// without a consumer skip-list entry. `null` for public routes.
		const to_acting_actor_id = (principal: AuthPrincipal, authed: TestAccount): string | null => {
			switch (principal) {
				case 'public':
					return null;
				case 'admin':
					return admin_account.actor.id;
				case 'authed':
					return authed.actor.id;
				case 'daemon_token':
				case 'keeper':
					return fixture.actor.id;
			}
		};

		test.each(describe_time_specs)('$method $path produces schema-valid response', async (spec) => {
			const route_key = `${spec.method} ${spec.path}`;
			if (skip_set.has(route_key)) return;
			// Raw-byte / streaming routes (git smart-HTTP, binary upload/download)
			// can't be round-tripped — no meaningful body to synthesize, no JSON
			// shape to assert. Auto-skip by the spec marker rather than making
			// every consumer hand-list them in `skip_routes`.
			if (spec.raw_body) return;

			const url = resolve_valid_path(spec.path, spec.params);

			const override = options.input_overrides?.get(route_key);
			let body = override ?? generate_valid_body(spec.input);

			// a mutation called as the authed account runs on a fresh one, so a
			// logout or a self-delete can't end the shared account's credential
			const principal = pick_auth_principal(spec.auth);
			const authed = round_trip_uses_fresh_account(principal, spec.method !== 'GET')
				? await fixture.create_account({ roles: [] })
				: authed_account;
			const headers = to_principal_headers(principal, fixture, authed, admin_account);

			// Auto-supply `acting` for actor-required routes that declare it. The
			// `actor !== 'none' ⟺ acting declared` registry invariant means a
			// route either declares `acting` in `query` (REST GET/body-less) or
			// `input` — supply the picked account's actor in the matching channel.
			let request_url = url;
			const acting_id = needs_actor(spec.auth) ? to_acting_actor_id(principal, authed) : null;
			if (acting_id !== null) {
				if (spec.query && input_schema_declares_acting(spec.query)) {
					request_url = `${url}${url.includes('?') ? '&' : '?'}acting=${acting_id}`;
				} else if (input_schema_declares_acting(spec.input) && body) {
					body = { ...body, acting: acting_id };
				}
			}

			const request_init: RequestInit = {
				method: spec.method,
				headers: { ...headers, 'content-type': to_route_content_type(spec) },
				...(body ? { body: JSON.stringify(body) } : {})
			};

			const res = await fixture.transport(request_url, request_init);

			if (res.headers.get('Content-Type')?.includes('text/event-stream')) {
				await res.body?.cancel();
				return;
			}

			try {
				if (res.status === 401) {
					const body: unknown = await res
						.clone()
						.json()
						.catch(() => undefined);
					assert_route_authenticated(route_key, res.status, body, principal);
				}
				await assert_response_matches_spec(describe_time_specs, spec.method, url, res);
			} catch (e) {
				throw new Error(
					`Round-trip validation failed for ${route_key} (status ${res.status}): ${
						(e as Error).message
					}`
				);
			}
		});

		test('declared success fixtures produce schema-valid success bodies', async () => {
			const success_fixtures = options.success_fixtures;
			if (!success_fixtures || success_fixtures.size === 0) return;
			for (const [route_key, build] of success_fixtures) {
				const space = route_key.indexOf(' ');
				const method = route_key.slice(0, space);
				const path = route_key.slice(space + 1);
				const spec = describe_time_specs.find((s) => s.method === method && s.path === path);
				assert.ok(spec, `success_fixtures references unknown route '${route_key}'`);

				const seeded = await build(fixture);
				const url = seeded.url ?? resolve_valid_path(spec.path, spec.params);
				const body = seeded.body;
				const headers = pick_auth_headers(spec, fixture, authed_account, admin_account);

				const res = await fixture.transport(url, {
					method: spec.method,
					headers: { ...headers, 'content-type': to_route_content_type(spec) },
					...(body ? { body: JSON.stringify(body) } : {})
				});

				try {
					assert.ok(
						res.ok,
						`success fixture expected a 2xx response, got status ${res.status}: ${await res
							.clone()
							.text()
							.catch(() => '<unreadable>')}`
					);
					await assert_response_matches_spec(describe_time_specs, spec.method, url, res);
				} catch (e) {
					throw new Error(
						`Round-trip success-fixture failed for ${route_key} (status ${res.status}): ${
							(e as Error).message
						}`
					);
				}
			}
		});
	});
};
