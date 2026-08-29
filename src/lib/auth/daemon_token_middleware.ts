/**
 * Daemon token middleware — the credential **consumer**.
 *
 * Validates a presented `X-Daemon-Token` and resolves the keeper account.
 * The producer half (rotation + file persistence) lives in
 * `testing/daemon_token_rotation.ts` behind the dev-env guard: no production
 * assembly mints daemon tokens — the credential's only remaining role is the
 * cross-process test harness's keeper channel — mirroring the Rust spine,
 * whose producer is confined to `fuz_testing`.
 *
 * Pure token primitives (schema, generation, validation) live in `auth/daemon_token.ts`.
 * See docs/identity.md for design rationale.
 *
 * @module
 */

import { DEV } from 'esm-env';
import type { MiddlewareHandler } from 'hono';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	ACCOUNT_ID_KEY,
	AUTH_API_TOKEN_ID_KEY,
	CREDENTIAL_TYPE_KEY,
	TOKEN_SCOPE_KEY
} from '../hono_context.ts';
import { token_scope_full } from './token_scope.ts';
import { is_browser_context } from '../http/origin.ts';
import { query_role_grant_find_account_id_for_role } from './role_grant_queries.ts';
import type { QueryDeps } from '../db/query_deps.ts';
import { ROLE_KEEPER } from './role_schema.ts';
import {
	DaemonToken,
	DAEMON_TOKEN_HEADER,
	validate_daemon_token,
	type DaemonTokenState
} from './daemon_token.ts';

/**
 * Resolve the keeper account ID by querying for the account with an active
 * keeper role_grant.
 *
 * There is exactly one keeper account (the bootstrap account). Runs once
 * at server startup — the result is cached in
 * `DaemonTokenState.keeper_account_id`. The acting actor is resolved
 * per-request by the dispatcher's authorization phase (which runs
 * `resolve_acting_actor` against this account id), so multi-actor keeper
 * accounts surface `actor_required` if a daemon caller doesn't pass an
 * explicit `acting`.
 *
 * @param deps - query dependencies
 * @returns the keeper account ID, or `null` if no keeper exists yet (pre-bootstrap)
 */
export const resolve_keeper_account_id = async (deps: QueryDeps): Promise<string | null> => {
	return query_role_grant_find_account_id_for_role(deps, ROLE_KEEPER);
};

/**
 * Create middleware that authenticates via daemon token.
 *
 * Checks the `X-Daemon-Token` header. Behavior:
 * - No header: pass through (don't touch existing context).
 * - Header present + `Origin` / `Referer` present: discard the credential
 *   (browser context) and pass through — daemon tokens are loopback-only and
 *   never carry an `Origin` in production, so a header-bearing request is not
 *   a legitimate daemon caller. Mirrors the bearer guard: `next()` rather than
 *   401, so downstream auth enforcement returns `credential_type_required`
 *   (not a hard fail). Silent on the wire (anti-enumeration); in `DEV` only,
 *   sets `X-Fuz-Auth-Debug: daemon_token_discarded_browser_context`.
 * - Header present + Zod-invalid (malformed): soft-fail discard (pass through,
 *   not 401) — mirrors the bearer guard and the Rust spine's `resolve.rs`
 *   (`None`). Downstream a daemon-gated action returns `credential_type_required`;
 *   a public action proceeds anonymous.
 * - Header present + invalid value (not the current/previous token): soft-fail
 *   discard (pass through, not 401) — same downstream behavior.
 * - Header present + valid + `keeper_account_id` null (still pre-bootstrap
 *   after the lazy refresh): soft-fail discard (pass through, not 503) —
 *   mirrors the Rust spine's `resolve.rs` (`None`), so the request falls
 *   through to anonymous and a daemon-gated action returns
 *   `credential_type_required` downstream.
 * - Header present + valid + ok: set `c.var.auth_account_id =
 *   state.keeper_account_id`, `CREDENTIAL_TYPE_KEY = 'daemon_token'`
 *   (overrides any existing session / bearer identity).
 *
 * Acting-actor resolution + `RequestContext` construction are deferred
 * to the dispatcher's authorization phase. Multi-actor keeper accounts
 * surface `actor_required` from there if a daemon caller doesn't pass
 * an explicit `acting` value.
 *
 * @param state - the daemon token runtime state
 * @param deps - query dependencies (pool-level db for keeper-account resolution)
 * @param log - the logger instance
 * @mutates Hono context - sets `ACCOUNT_ID_KEY`, `CREDENTIAL_TYPE_KEY`, and `AUTH_API_TOKEN_ID_KEY` on a valid token
 */
export const create_daemon_token_middleware = (
	state: DaemonTokenState,
	deps: QueryDeps,
	log: Logger
): MiddlewareHandler => {
	return async (c, next): Promise<Response | void> => {
		const token_header = c.req.header(DAEMON_TOKEN_HEADER);

		if (!token_header) {
			await next();
			return;
		}

		// Silently discard daemon tokens in browser context (`is_browser_context`
		// — Origin or Referer present) — mirrors the bearer guard (and the Rust
		// spine's `resolve.rs`, which returns `None`). Daemon tokens are
		// loopback-only and never carry an `Origin` in production, so a
		// header-bearing request is not a legitimate daemon caller. Discards
		// (next()) rather than 401 so the dispatcher returns
		// `credential_type_required` downstream rather than a hard fail.
		if (is_browser_context(c)) {
			log.debug('daemon token auth rejected: browser context (Origin/Referer present)');
			if (DEV) c.header('X-Fuz-Auth-Debug', 'daemon_token_discarded_browser_context');
			await next();
			return;
		}

		// Zod-validate the token format at the I/O boundary. A malformed token is
		// a soft-fail discard (pass through), not a 401 — mirroring the bearer
		// guard and the Rust spine's `resolve.rs`, which return `None` on an
		// unparseable credential. The request falls through: on a daemon-gated
		// action the dispatcher returns `credential_type_required` downstream; on
		// a public action it proceeds anonymous.
		const parse_result = DaemonToken.safeParse(token_header);
		if (!parse_result.success) {
			log.debug('daemon token auth soft-fail: malformed token');
			await next();
			return;
		}

		// Well-formed but not the current/previous token — soft-fail discard, not
		// a 401, for the same reason: no downgrade, falls through to downstream
		// `credential_type_required` (matching the Rust spine's `None`).
		if (!validate_daemon_token(parse_result.data, state)) {
			log.debug('daemon token auth soft-fail: token not found or invalid');
			await next();
			return;
		}

		// daemon token valid — resolve keeper account. `start_daemon_token_rotation`
		// resolves the keeper once at startup, but rotation often starts before the
		// keeper account exists (e.g. cross-process test harnesses spawn the binary
		// then POST /bootstrap). Lazily refresh from the DB on the first null hit
		// so the post-bootstrap state lands without a separate hook.
		if (!state.keeper_account_id) {
			state.keeper_account_id = await resolve_keeper_account_id(deps);
		}
		// Valid token but no keeper configured (still pre-bootstrap after the lazy
		// refresh) — soft-fail discard (pass through), not a 503. Mirrors the Rust
		// spine's `resolve.rs`, which returns `None` when the daemon leg can't
		// resolve a keeper: the request falls through to the next auth leg →
		// anonymous, so a daemon-gated action returns `credential_type_required`
		// downstream. The no-keeper state is a transient pre-bootstrap window.
		if (!state.keeper_account_id) {
			log.debug('daemon token auth soft-fail: keeper account not configured');
			await next();
			return;
		}

		c.set(ACCOUNT_ID_KEY, state.keeper_account_id);
		c.set(CREDENTIAL_TYPE_KEY, 'daemon_token');
		// Singular, filesystem-proved, keeper-bound — no minting step at which a
		// narrowing could have been chosen.
		c.set(TOKEN_SCOPE_KEY, token_scope_full());
		c.set(AUTH_API_TOKEN_ID_KEY, null);

		await next();
	};
};
