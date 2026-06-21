/**
 * Daemon token rotation, persistence, and middleware.
 *
 * Manages the lifecycle of filesystem-resident daemon tokens: writing to disk,
 * rotation on an interval, and HTTP middleware for authentication.
 *
 * Pure token primitives (schema, generation, validation) live in `auth/daemon_token.ts`.
 * See docs/identity.md for design rationale.
 *
 * @module
 */

import {DEV} from 'esm-env';
import type {MiddlewareHandler} from 'hono';
import type {Logger} from '@fuzdev/fuz_util/log.ts';

import {type FsWriteDeps, type FsRemoveDeps, type EnvDeps} from '../runtime/deps.ts';
import {write_file_atomic} from '../runtime/fs.ts';
import {get_app_dir} from '../cli/config.ts';
import {ACCOUNT_ID_KEY, AUTH_API_TOKEN_ID_KEY, CREDENTIAL_TYPE_KEY} from '../hono_context.ts';
import {is_browser_context} from '../http/origin.ts';
import {query_role_grant_find_account_id_for_role} from './role_grant_queries.ts';
import type {QueryDeps} from '../db/query_deps.ts';
import {ROLE_KEEPER} from './role_schema.ts';
import {
	DaemonToken,
	DAEMON_TOKEN_HEADER,
	generate_daemon_token,
	validate_daemon_token,
	type DaemonTokenState,
} from './daemon_token.ts';

/** Default rotation interval in milliseconds (30 seconds). */
export const DEFAULT_ROTATION_INTERVAL_MS = 30_000;

/** Deps for writing the daemon token to disk. */
export type DaemonTokenWriteDeps = Pick<EnvDeps, 'env_get'> &
	Pick<FsWriteDeps, 'mkdir' | 'write_text_file' | 'rename'> & {
		/** Set file permissions. Optional — consumers provide when available (e.g. `Deno.chmod`). */
		chmod?: (path: string, mode: number) => Promise<void>;
	};

/**
 * Get the daemon token file path (`~/.{name}/run/daemon_token`).
 *
 * @param runtime - runtime with `env_get` capability
 * @param name - application name
 * @returns path to `daemon_token`, or `null` if `$HOME` is not set
 */
export const get_daemon_token_path = (
	runtime: Pick<EnvDeps, 'env_get'>,
	name: string,
): string | null => {
	const app_dir = get_app_dir(runtime, name);
	return app_dir ? `${app_dir}/run/daemon_token` : null;
};

/**
 * Write the current token to disk atomically.
 *
 * Uses `write_file_atomic` (temp file + rename) and optionally sets mode 0600.
 *
 * On-disk format is JSON `{"token": "..."}` — the wrapper leaves room for
 * future fields (rotated_at, version) without changing every reader. Both
 * the TS cross-backend harness reader (`spawn_backend.read_daemon_token`)
 * and the Rust daemon-token writer match this shape.
 *
 * @param runtime - runtime with file write capabilities
 * @param token_path - path to write the token
 * @param token - the raw token string
 * @mutates filesystem - writes `token_path` atomically and `chmod 0600` when supported
 */
export const write_daemon_token = async (
	runtime: DaemonTokenWriteDeps,
	token_path: string,
	token: string,
): Promise<void> => {
	await write_file_atomic(runtime, token_path, JSON.stringify({token}) + '\n');
	if (runtime.chmod) {
		await runtime.chmod(token_path, 0o600);
	}
};

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

/** Options for daemon token rotation. */
export interface DaemonTokenRotationOptions {
	/**
	 * Absolute path the token file is written to. Caller computes from
	 * its own conventions — e.g. `get_daemon_token_path(runtime, app_name)`
	 * for the standard `~/.{name}/run/daemon_token` layout, or a path
	 * derived from `PUBLIC_<APP>_DIR` for cross-process test setups that
	 * isolate the app dir to a tmpdir.
	 */
	token_path: string;
	/** Rotation interval in ms. Default: `30000` (30s). */
	rotation_interval_ms?: number;
}

/** Result of starting daemon token rotation. */
export interface DaemonTokenRotation {
	/** The mutable runtime state. Pass to `create_daemon_token_middleware`. */
	state: DaemonTokenState;
	/** Stop rotation, clean up the interval, and delete the token file. Call on graceful shutdown. */
	stop: () => Promise<void>;
}

/**
 * Start daemon token rotation.
 *
 * Generates an initial token, writes it to disk, resolves the keeper account,
 * and sets up periodic rotation. Returns the mutable state object and a stop function.
 *
 * @param runtime - runtime with file and remove capabilities
 * @param deps - query dependencies for resolving keeper account
 * @param options - rotation configuration
 * @param log - the logger instance
 * @returns rotation state and stop function
 * @mutates filesystem - writes the token file on each rotation; `stop` removes it
 */
export const start_daemon_token_rotation = async (
	runtime: DaemonTokenWriteDeps & FsRemoveDeps,
	deps: QueryDeps,
	options: DaemonTokenRotationOptions,
	log: Logger,
): Promise<DaemonTokenRotation> => {
	const {token_path, rotation_interval_ms = DEFAULT_ROTATION_INTERVAL_MS} = options;

	// ensure parent directory exists
	const last_slash = token_path.lastIndexOf('/');
	if (last_slash > 0) {
		await runtime.mkdir(token_path.slice(0, last_slash), {recursive: true});
	}

	// resolve keeper account (may be null pre-bootstrap; the middleware
	// lazily refreshes on the first null hit to cover the
	// rotation-starts-before-bootstrap case)
	const keeper_account_id = await resolve_keeper_account_id(deps);

	// generate initial token and write to disk
	const initial_token = generate_daemon_token();
	await write_daemon_token(runtime, token_path, initial_token);

	const state: DaemonTokenState = {
		current_token: initial_token,
		previous_token: null,
		rotated_at: new Date(),
		keeper_account_id,
	};

	let writing = false;

	const interval_id = setInterval(async () => {
		if (writing) return; // skip if previous rotation write still in progress
		writing = true;
		try {
			const new_token = generate_daemon_token();
			state.previous_token = state.current_token;
			state.current_token = new_token;
			state.rotated_at = new Date();
			await write_daemon_token(runtime, token_path, new_token);
		} catch (err) {
			log.error('Failed to write rotated token:', err);
		} finally {
			writing = false;
		}
	}, rotation_interval_ms);

	const stop = async (): Promise<void> => {
		clearInterval(interval_id);
		try {
			await runtime.remove(token_path);
		} catch {
			// already removed or never written
		}
	};

	return {state, stop};
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
	log: Logger,
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
		c.set(AUTH_API_TOKEN_ID_KEY, null);

		await next();
	};
};
