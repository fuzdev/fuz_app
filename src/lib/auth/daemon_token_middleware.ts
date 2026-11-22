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

import type { MiddlewareHandler } from 'hono';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import { RESOLVED_AUTH_KEY } from '../hono_context.ts';
import { get_resolved_auth } from './resolved_auth.ts';
import { get_header_lines } from '../http/header_lines.ts';
import { is_browser_context } from '../http/request_headers.ts';
import { query_role_grant_find_account_id_for_role } from './role_grant_queries.ts';
import { query_account_by_id } from './account_queries.ts';
import type { QueryDeps } from '../db/query_deps.ts';
import { ROLE_KEEPER } from './role_schema.ts';
import { read_daemon_token } from './credential_headers.ts';
import {
	DAEMON_TOKEN_HEADER,
	validate_daemon_token,
	type DaemonTokenState
} from './daemon_token.ts';

/**
 * Resolve the keeper account ID by querying for the account with an active
 * keeper role_grant.
 *
 * There is exactly one keeper account (the bootstrap account). Run once by
 * `create_app_server` at assembly for a daemon-token state with no keeper
 * (and by `start_daemon_token_rotation`) — the result is cached in
 * `DaemonTokenState.keeper_account_id`, which a live bootstrap sets after its
 * commit and nothing re-reads per request (a keeper seeded by another process
 * needs a restart, as on the Rust spine). The acting actor is resolved
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
 * Create middleware that authenticates via daemon token — the first leg of the
 * auth middleware chain, as in the Rust spine's `resolve_auth_from_headers`.
 *
 * Being first, it starts the chain from a clean slate: it clears
 * `RESOLVED_AUTH_KEY` on entry, so a layer mounted before the credential legs
 * cannot pre-set an identity that every leg would then skip past.
 *
 * Reads the `X-Daemon-Token` header's lines through `read_daemon_token`.
 * Behavior:
 * - No header, a malformed value (fails `is_daemon_token_shaped`), or the
 *   header sent as more than one line: soft-fail discard (pass through, not
 *   401) — mirrors the bearer guard and the Rust spine's `resolve.rs`
 *   (`None`). Downstream a daemon-gated action returns
 *   `credential_type_required`; a public action proceeds anonymous.
 * - A shaped token + `Origin` / `Referer` present: discard the credential
 *   (browser context) and pass through — daemon tokens are loopback-only and
 *   never carry an `Origin` in production, so a header-bearing request is not
 *   a legitimate daemon caller. Silent on the wire (anti-enumeration), logged
 *   at debug as on the Rust spine.
 * - Header present + invalid value (not the current/previous token): soft-fail
 *   discard (pass through, not 401) — same downstream behavior.
 * - Header present + valid + `keeper_account_id` null (pre-bootstrap — the
 *   keeper is resolved at assembly and set by the bootstrap route after its
 *   commit, never re-read per request): soft-fail discard (pass through, not 503) —
 *   mirrors the Rust spine's `resolve.rs` (`None`), so the request falls
 *   through to anonymous and a daemon-gated action returns
 *   `credential_type_required` downstream.
 * - Header present + valid + ok: set the `daemon_token` arm of `ResolvedAuth`
 *   (`RESOLVED_AUTH_KEY`) for the keeper account. The session and bearer legs
 *   after it see the request resolved and skip, so a cookie or bearer sent
 *   beside the daemon token is never looked up.
 *
 * Acting-actor resolution + `RequestContext` construction are deferred
 * to the dispatcher's authorization phase. Multi-actor keeper accounts
 * surface `actor_required` from there if a daemon caller doesn't pass
 * an explicit `acting` value.
 *
 * @param state - the daemon token runtime state
 * @param deps - query dependencies (pool-level db for the keeper's account row)
 * @param log - the logger instance
 * @mutates Hono context - clears `RESOLVED_AUTH_KEY` on entry, then sets it on a valid token
 */
export const create_daemon_token_middleware = (
	state: DaemonTokenState,
	deps: QueryDeps,
	log: Logger
): MiddlewareHandler => {
	return async (c, next): Promise<Response | void> => {
		// the chain's clean slate — nothing before the credential legs resolves
		const cleared = get_resolved_auth(c);
		if (cleared !== null) {
			log.debug(`daemon token leg cleared a credential (${cleared.credential_type}) set before it`);
		}
		c.set(RESOLVED_AUTH_KEY, null);
		// The header's one shaped value, or nothing: absent, malformed, and sent
		// as more than one line all read `null` and pass through — a soft-fail
		// discard, not a 401, mirroring the bearer guard and the Rust spine's
		// `resolve.rs`. On a daemon-gated action the dispatcher returns
		// `credential_type_required` downstream; a public action proceeds
		// anonymous.
		const token_lines = get_header_lines(c, DAEMON_TOKEN_HEADER);
		const token_header = read_daemon_token(token_lines);
		if (token_header === null) {
			if (token_lines.length > 0) log.debug('daemon token auth soft-fail: malformed token');
			await next();
			return;
		}

		// Silently discard daemon tokens in browser context (`is_browser_context`
		// — an Origin or Referer line present) — mirrors the bearer guard (and the Rust
		// spine's `resolve.rs`, which returns `None`). Daemon tokens are
		// loopback-only and never carry an `Origin` in production, so a
		// header-bearing request is not a legitimate daemon caller. Discards
		// (next()) rather than 401 so the dispatcher returns
		// `credential_type_required` downstream rather than a hard fail.
		if (is_browser_context(get_header_lines(c, 'origin'), get_header_lines(c, 'referer'))) {
			log.debug('daemon token auth rejected: browser context (Origin/Referer present)');
			await next();
			return;
		}

		// Well-formed but not the current/previous token — soft-fail discard, not
		// a 401, for the same reason: no downgrade, falls through to downstream
		// `credential_type_required` (matching the Rust spine's `None`).
		if (!validate_daemon_token(token_header, state)) {
			log.debug('daemon token auth soft-fail: token not found or invalid');
			await next();
			return;
		}

		// Valid token but no keeper configured — soft-fail discard (pass through),
		// not a 503. The keeper is resolved at assembly and set by the
		// bootstrap route after its commit; never re-read here. Mirrors the Rust
		// spine's `resolve.rs`, which returns `None` when the daemon leg can't
		// resolve a keeper: the request falls through to the next auth leg →
		// anonymous, so a daemon-gated action returns `credential_type_required`
		// downstream. The no-keeper state is a transient pre-bootstrap window.
		if (!state.keeper_account_id) {
			log.debug('daemon token auth soft-fail: keeper account not configured');
			await next();
			return;
		}
		// The keeper's row, read per request as every credential leg reads its
		// account, so the authorization phase builds on it. A keeper account
		// gone or tombstoned (no API path removes it) authenticates nothing —
		// as the Rust spine's daemon leg.
		const account = await query_account_by_id(deps, state.keeper_account_id);
		if (!account) {
			log.warn('daemon token auth soft-fail: keeper account not found');
			await next();
			return;
		}

		// Full authority (`resolved_auth_scope`): singular, filesystem-proved,
		// keeper-bound — no minting step at which a narrowing could have been
		// chosen. No row, no expiry.
		c.set(RESOLVED_AUTH_KEY, {
			credential_type: 'daemon_token',
			account,
			credential_deadline: null
		});

		await next();
	};
};
