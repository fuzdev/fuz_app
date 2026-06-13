/**
 * Role grant offer RPC action handlers — the consentful-role-grants action surface.
 *
 * Seven actions: six offer-lifecycle methods (create / accept / decline /
 * retract / list / history) plus `role_grant_revoke` (admin-only). All mount
 * on a consumer's JSON-RPC endpoint via `create_rpc_endpoint`. The action
 * specs themselves live in `auth/role_grant_offer_action_specs.ts`. Mutations
 * declare `side_effects: true` so the RPC dispatcher wraps the handler in
 * a DB transaction; `role_grant_offer_list` and `role_grant_offer_history` declare
 * `side_effects: false` so they are addressable via GET.
 *
 * Authorization:
 * - `role_grant_offer_create` — the grantor must hold an active role_grant for the
 *   role being offered, and that role's `grant_paths` must include `'admin'`.
 *   Consumers needing a richer policy (e.g., "teacher may offer student in
 *   *their* classroom") pass an `authorize` callback that overrides the default.
 * - `role_grant_offer_accept` / `role_grant_offer_decline` — keyed to the caller's
 *   account; `query_*` helpers enforce the IDOR guard.
 * - `role_grant_offer_retract` — keyed to the caller's actor.
 * - `role_grant_offer_list` / `role_grant_offer_history` — self by default;
 *   `{account_id}` is admin-only.
 * - `role_grant_revoke` — spec-level `auth: {role: 'admin'}`; the RPC
 *   dispatcher rejects non-admin callers before the handler runs.
 *   The admin-grant-path gate prevents revoking keeper / daemon-scoped
 *   roles via this surface. Keys on `actor_id` to survive multi-actor accounts.
 *
 * Audit events are emitted in-transaction by the query layer (atomic with
 * the role_grant write on accept/revoke) or by the handler via the bound
 * `deps.audit.emit_role_grant_target` helper for single-event lifecycle
 * transitions. `audit.notify` (SSE/WS broadcast) fires post-commit in both
 * paths.
 *
 * WS notifications fan out post-commit via `emit_after_commit` when a
 * `notification_sender` is wired: offer lifecycle transitions notify the
 * counterparty, `role_grant_revoke` notifies the revokee plus each superseded
 * pending offer's grantor.
 *
 * @module
 */

import {
	rpc_action,
	type ActionActorContext,
	type ActionContext,
	type RpcAction,
} from '../actions/action_rpc.js';
import {jsonrpc_errors} from '../http/jsonrpc_errors.js';
import {emit_after_commit} from '../http/pending_effects.js';
import {
	builtin_role_specs_by_name,
	ROLE_ADMIN,
	role_has_grant_path,
	type RoleSchemaResult,
} from './role_schema.js';
import {GRANT_PATH_ADMIN} from './grant_path_schema.js';
import {
	ROLE_GRANT_OFFER_DEFAULT_TTL_MS,
	to_role_grant_offer_json,
} from './role_grant_offer_schema.js';
import {
	query_role_grant_offer_create,
	query_role_grant_offer_decline,
	query_role_grant_offer_retract,
	query_role_grant_offer_list,
	query_role_grant_offer_history_for_account,
	query_accept_offer,
	RoleGrantOfferActorAccountMismatchError,
	RoleGrantOfferActorMismatchError,
	RoleGrantOfferAlreadyTerminalError,
	RoleGrantOfferExpiredError,
	RoleGrantOfferNotFoundError,
	RoleGrantOfferSelfTargetError,
} from './role_grant_offer_queries.js';
import {
	query_role_grant_find_active_role_for_actor,
	query_revoke_role_grant,
} from './role_grant_queries.js';
import {query_actor_by_id} from './account_queries.js';
import type {AuditLogEvent} from './audit_log_schema.js';
import {has_scoped_role, type RequestActorContext, type RequestContext} from './request_context.js';
import type {RouteFactoryDeps} from './deps.js';
import type {AuditEmitter} from './audit_emitter.js';
import {
	build_role_grant_offer_accepted_notification,
	build_role_grant_offer_declined_notification,
	build_role_grant_offer_received_notification,
	build_role_grant_offer_retracted_notification,
	build_role_grant_offer_supersede_notification,
	build_role_grant_revoke_notification,
	type NotificationSender,
} from './role_grant_offer_notifications.js';
import {ERROR_ROLE_GRANT_NOT_FOUND, ERROR_ROLE_NOT_WEB_GRANTABLE} from '../http/error_schemas.js';
import {
	ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH,
	ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH,
	ERROR_ROLE_GRANT_OFFER_EXPIRED,
	ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
	ERROR_ROLE_GRANT_OFFER_NOT_FOUND,
	ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE,
	ERROR_ROLE_GRANT_OFFER_SELF_TARGET,
	ERROR_ROLE_GRANT_OFFER_TERMINAL,
	role_grant_offer_create_action_spec,
	role_grant_offer_accept_action_spec,
	role_grant_offer_decline_action_spec,
	role_grant_offer_retract_action_spec,
	role_grant_offer_list_action_spec,
	role_grant_offer_history_action_spec,
	role_grant_revoke_action_spec,
	type RoleGrantOfferCreateInput,
	type RoleGrantOfferCreateOutput,
	type RoleGrantOfferAcceptInput,
	type RoleGrantOfferAcceptOutput,
	type RoleGrantOfferDeclineInput,
	type RoleGrantOfferOkOutput,
	type RoleGrantOfferRetractInput,
	type RoleGrantOfferListInput,
	type RoleGrantOfferListOutput,
	type RoleGrantOfferHistoryInput,
	type RoleGrantOfferHistoryOutput,
	type RoleGrantRevokeInput,
	type RoleGrantRevokeOutput,
} from './role_grant_offer_action_specs.js';

/**
 * Authorization callback for `role_grant_offer_create`. Returns `true` to allow,
 * `false` to reject (handler converts to `forbidden`).
 *
 * Provided with the fully-resolved request context and the parsed input
 * (pre-TTL, pre-normalization). Consumers override the default to implement
 * policies like "teacher may offer classroom_student only in classrooms they
 * teach".
 */
export type RoleGrantOfferCreateAuthorize = (
	auth: RequestContext,
	input: {to_account_id: string; role: string; scope_id: string | null},
	deps: Pick<RouteFactoryDeps, 'log'>,
	ctx: ActionContext,
) => boolean | Promise<boolean>;

/** Options for `create_role_grant_offer_actions`. */
export interface RoleGrantOfferActionOptions {
	/**
	 * Role schema result from `create_role_schema()`. Defaults to builtin roles only.
	 * Drives the grantability gate: a role is offerable / revocable through
	 * this surface only when its `RoleSpec.grant_paths` includes `'admin'`
	 * (the `GRANT_PATH_ADMIN` constant).
	 */
	roles?: RoleSchemaResult;
	/** TTL applied to newly-created offers. Defaults to `ROLE_GRANT_OFFER_DEFAULT_TTL_MS`. */
	default_ttl_ms?: number;
	/**
	 * Custom authorization for `role_grant_offer_create`. The default requires the
	 * caller to hold an active role_grant for the offered role *and* the role's
	 * `RoleSpec.grant_paths` to include `'admin'`. Consumers with richer
	 * policies (scope-aware, chained roles) override this.
	 */
	authorize?: RoleGrantOfferCreateAuthorize;
}

// -- Helpers ----------------------------------------------------------------

/**
 * Fan out a batch of pre-written audit rows to the bound emitter's
 * `notify` listener chain. Used by accept, whose events were written
 * in-transaction by `query_accept_offer` — the rows are already in the DB,
 * we just need SSE/WS subscribers to see them.
 *
 * Per-listener exceptions are isolated inside `audit.notify`; one failing
 * subscriber does not starve siblings, and a failure on the first event
 * does not skip the rest.
 */
const fan_out_audit_events = (events: Array<AuditLogEvent>, audit: AuditEmitter): void => {
	for (const event of events) {
		audit.notify(event);
	}
};

// eslint-disable-next-line @typescript-eslint/require-await
const default_authorize: RoleGrantOfferCreateAuthorize = async (auth, input, _deps, _ctx) => {
	// Caller must hold an active role_grant for the offered role. Global (no scope)
	// check — the scope-aware "only in this classroom" policy is consumer-level.
	// Reads from the in-memory `auth.role_grants` snapshot loaded once per request
	// by `create_request_context_middleware`; no DB roundtrip needed.
	return has_scoped_role(auth, input.role, null);
};

/**
 * Authorization callback that admits any admin and otherwise falls back to
 * the symmetric default (caller must hold the offered role globally).
 *
 * The admin-grant-path filter in `create_handler` runs **before** the
 * `authorize` callback, so this never sees roles whose `grant_paths`
 * omits `'admin'`. Drop into
 * `create_role_grant_offer_actions({authorize: authorize_admin_or_holder})`
 * (or any factory that forwards `authorize`, e.g. `create_standard_rpc_actions`)
 * for the common "admins offer anything; users offer what they hold"
 * pattern. Scope-aware policies (e.g. classroom_teacher offering
 * classroom_student in their own scope) wrap this and short-circuit `true`
 * before delegating.
 */
export const authorize_admin_or_holder: RoleGrantOfferCreateAuthorize = async (
	auth,
	input,
	_deps,
	_ctx,
	// eslint-disable-next-line @typescript-eslint/require-await
) => {
	// Admin bypass keys on **global** admin role_grants only — `has_scoped_role(_, _, null)`
	// rejects scoped admin role_grants. Without this, a `{role: 'admin', scope_id: scope_X}`
	// role_grant would let the holder offer any admin-grant-path role without holding it
	// themselves, escalating scoped admin to global authority over the offer surface.
	if (has_scoped_role(auth, ROLE_ADMIN, null)) return true;
	return has_scoped_role(auth, input.role, null);
};

// -- Action factory ---------------------------------------------------------

/**
 * Create the seven role-grant-offer RPC actions (six offer-lifecycle methods
 * plus `role_grant_revoke`).
 *
 * @param deps - `RouteFactoryDeps` (`log`, `audit`, …) plus optional `notification_sender` for WS fan-out — when absent, WS fan-out is silently skipped (DB-only side effects still happen). Consumers wiring `BackendWebsocketTransport` assign its instance directly (the transport's `send_to_account` signature accepts the broader `JsonrpcMessageFromServerToClient`, which is contravariantly compatible)
 * @param options - role schema, default TTL, authorization override
 * @returns the `RpcAction` array to spread into a `create_rpc_endpoint` call
 */
export const create_role_grant_offer_actions = (
	deps: Pick<RouteFactoryDeps, 'log' | 'audit'> & {
		notification_sender?: NotificationSender | null;
	},
	options: RoleGrantOfferActionOptions = {},
): Array<RpcAction> => {
	const {log, audit, notification_sender = null} = deps;
	const role_specs = options.roles?.role_specs ?? builtin_role_specs_by_name;
	const default_ttl_ms = options.default_ttl_ms ?? ROLE_GRANT_OFFER_DEFAULT_TTL_MS;
	const authorize = options.authorize ?? default_authorize;

	// Four denial paths (admin-grant-path gate, authorize, self-target,
	// actor-account mismatch) all emit the same failure-outcome audit
	// event. `target_actor_id` is populated when the caller supplied a
	// `to_actor_id` so failure rows match the success-shape envelope of
	// actor-targeted offers.
	const emit_create_failure_audit = (
		ctx: ActionContext,
		auth: RequestActorContext,
		input: Pick<
			RoleGrantOfferCreateInput,
			'to_account_id' | 'to_actor_id' | 'role' | 'scope_kind' | 'scope_id'
		>,
	): void => {
		audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_offer_create',
			outcome: 'failure',
			target_account_id: input.to_account_id,
			target_actor_id: input.to_actor_id ?? null,
			metadata: {
				role: input.role,
				scope_id: input.scope_id ?? null,
				to_account_id: input.to_account_id,
			},
		});
	};

	// Returns {offer} only — no auto-accept. Recipient must call
	// role_grant_offer_accept; admin tests drive the full consent flow over
	// RPC (see testing/admin_integration.ts `offer_and_accept`), or seed
	// role_grants directly via create_test_role_grant_direct when the
	// test isn't about the consent path.
	const create_handler = async (
		input: RoleGrantOfferCreateInput,
		ctx: ActionActorContext,
	): Promise<RoleGrantOfferCreateOutput> => {
		const auth = ctx.auth;

		// Role must include the admin grant path — same gate as admin direct-grant.
		if (!role_has_grant_path(role_specs, input.role, GRANT_PATH_ADMIN)) {
			emit_create_failure_audit(ctx, auth, input);
			throw jsonrpc_errors.forbidden('role not grantable', {
				reason: ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE,
			});
		}

		const authorized = await authorize(
			auth,
			{
				to_account_id: input.to_account_id,
				role: input.role,
				scope_id: input.scope_id ?? null,
			},
			{log},
			ctx,
		);
		if (!authorized) {
			emit_create_failure_audit(ctx, auth, input);
			throw jsonrpc_errors.forbidden('not authorized to offer this role', {
				reason: ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED,
			});
		}

		let offer;
		try {
			offer = await query_role_grant_offer_create(ctx, {
				from_actor_id: auth.actor.id,
				to_account_id: input.to_account_id,
				to_actor_id: input.to_actor_id ?? null,
				role: input.role,
				scope_kind: input.scope_kind ?? null,
				scope_id: input.scope_id ?? null,
				message: input.message ?? null,
				expires_at: new Date(Date.now() + default_ttl_ms),
			});
		} catch (err) {
			if (err instanceof RoleGrantOfferSelfTargetError) {
				emit_create_failure_audit(ctx, auth, input);
				throw jsonrpc_errors.invalid_params('cannot offer to self', {
					reason: ERROR_ROLE_GRANT_OFFER_SELF_TARGET,
				});
			}
			if (err instanceof RoleGrantOfferActorAccountMismatchError) {
				emit_create_failure_audit(ctx, auth, input);
				throw jsonrpc_errors.invalid_params('to_actor_id does not belong to to_account_id', {
					reason: ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH,
				});
			}
			throw err;
		}

		// `target_actor_id` is populated when the offer is actor-targeted
		// (per the offer's `to_actor_id`), null for account-grain offers
		// — closes the audit hole where offer-shape events used to leave
		// actor-grain forensics blank even when the binding was known.
		audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_offer_create',
			target_account_id: input.to_account_id,
			target_actor_id: offer.to_actor_id,
			metadata: {
				offer_id: offer.id,
				role: offer.role,
				scope_id: offer.scope_id,
				to_account_id: offer.to_account_id,
			},
		});

		const offer_json = to_role_grant_offer_json(offer);
		if (notification_sender) {
			emit_after_commit(ctx, () => {
				notification_sender.send_to_account(
					offer.to_account_id,
					build_role_grant_offer_received_notification({offer: offer_json}),
				);
			});
		}

		return {offer: offer_json};
	};

	const accept_handler = async (
		input: RoleGrantOfferAcceptInput,
		ctx: ActionActorContext,
	): Promise<RoleGrantOfferAcceptOutput> => {
		const auth = ctx.auth;
		let result;
		try {
			result = await query_accept_offer(ctx, {
				offer_id: input.offer_id,
				to_account_id: auth.account.id,
				actor_id: auth.actor.id,
				ip: ctx.client_ip,
			});
		} catch (err) {
			if (err instanceof RoleGrantOfferNotFoundError) {
				throw jsonrpc_errors.not_found('offer', {reason: ERROR_ROLE_GRANT_OFFER_NOT_FOUND});
			}
			if (err instanceof RoleGrantOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_ROLE_GRANT_OFFER_TERMINAL});
			}
			if (err instanceof RoleGrantOfferExpiredError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_ROLE_GRANT_OFFER_EXPIRED});
			}
			if (err instanceof RoleGrantOfferActorMismatchError) {
				throw jsonrpc_errors.forbidden('offer is targeted to a different actor', {
					reason: ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH,
				});
			}
			throw err;
		}

		// Look up the grantor's account_id inside the transaction so the
		// post-commit notification has a valid target. One cheap SELECT by
		// PK — the alternative (widening `query_accept_offer` again) would
		// bleed transport concerns into the query layer.
		const grantor_actor = notification_sender
			? await query_actor_by_id(ctx, result.offer.from_actor_id)
			: null;
		const grantor_account_id = grantor_actor?.account_id ?? null;

		const offer_json = to_role_grant_offer_json(result.offer);
		const supersede_payloads = result.superseded_offers.map((sib) => ({
			offer: to_role_grant_offer_json(sib),
			from_account_id: sib.from_account_id,
		}));

		// Audit events are written in-transaction by query_accept_offer; wire
		// them through `audit.notify` post-commit so SSE/WS broadcasts fire.
		// WS notifications ride the same deferred post-commit thunk so the
		// grantor sees "accepted" and each superseded grantor sees "supersede"
		// only once the accept has durably committed — and never if it rolls
		// back (the dispatch site discards `post_commit_effects` on rollback).
		emit_after_commit(ctx, () => {
			fan_out_audit_events(result.audit_events, audit);
			if (notification_sender && grantor_account_id) {
				notification_sender.send_to_account(
					grantor_account_id,
					build_role_grant_offer_accepted_notification({offer: offer_json}),
				);
			}
			if (notification_sender) {
				for (const sib of supersede_payloads) {
					notification_sender.send_to_account(
						sib.from_account_id,
						build_role_grant_offer_supersede_notification({
							offer: sib.offer,
							reason: 'sibling_accepted',
							cause_id: result.offer.id,
						}),
					);
				}
			}
		});

		return {
			role_grant_id: result.role_grant.id,
			offer: offer_json,
			superseded_offer_ids: result.superseded_offers.map((o) => o.id),
		};
	};

	const decline_handler = async (
		input: RoleGrantOfferDeclineInput,
		ctx: ActionActorContext,
	): Promise<RoleGrantOfferOkOutput> => {
		const auth = ctx.auth;
		let declined;
		try {
			declined = await query_role_grant_offer_decline(
				ctx,
				input.offer_id,
				auth.account.id,
				input.reason ?? null,
			);
		} catch (err) {
			if (err instanceof RoleGrantOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_ROLE_GRANT_OFFER_TERMINAL});
			}
			throw err;
		}
		if (!declined) {
			throw jsonrpc_errors.not_found('offer', {reason: ERROR_ROLE_GRANT_OFFER_NOT_FOUND});
		}

		// `role_grant_offer_decline` is *to* the offering actor — populate both
		// `target_actor_id` (the grantor actor) and `target_account_id`
		// (the grantor account, joined in the decline RETURNING via CTE).
		// The "both populated → same account" invariant holds: the
		// grantor's actor↔account binding is 1:1 by definition of `actor`.
		audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_offer_decline',
			target_account_id: declined.from_account_id,
			target_actor_id: declined.from_actor_id,
			metadata: {
				offer_id: declined.id,
				role: declined.role,
				scope_id: declined.scope_id,
				reason: input.reason ?? undefined,
			},
		});

		if (notification_sender) {
			// Grantor's account_id rides on `declined.from_account_id` from
			// the decline RETURNING — no second SELECT needed. The decline
			// reason rides along on `offer.decline_reason` — the DB set it
			// in the RETURNING above.
			const offer_json = to_role_grant_offer_json(declined);
			emit_after_commit(ctx, () => {
				notification_sender.send_to_account(
					declined.from_account_id,
					build_role_grant_offer_declined_notification({offer: offer_json}),
				);
			});
		}

		return {ok: true};
	};

	const retract_handler = async (
		input: RoleGrantOfferRetractInput,
		ctx: ActionActorContext,
	): Promise<RoleGrantOfferOkOutput> => {
		const auth = ctx.auth;
		let retracted;
		try {
			retracted = await query_role_grant_offer_retract(ctx, input.offer_id, auth.actor.id);
		} catch (err) {
			if (err instanceof RoleGrantOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_ROLE_GRANT_OFFER_TERMINAL});
			}
			throw err;
		}
		if (!retracted) {
			throw jsonrpc_errors.not_found('offer', {reason: ERROR_ROLE_GRANT_OFFER_NOT_FOUND});
		}

		// `role_grant_offer_retract` is *from* the recipient inbox —
		// `target_account_id` is the recipient account; `target_actor_id`
		// inherits the offer's `to_actor_id` (set on actor-targeted
		// offers, null on account-grain offers).
		audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_offer_retract',
			target_account_id: retracted.to_account_id,
			target_actor_id: retracted.to_actor_id,
			metadata: {
				offer_id: retracted.id,
				role: retracted.role,
				scope_id: retracted.scope_id,
			},
		});

		if (notification_sender) {
			const offer_json = to_role_grant_offer_json(retracted);
			emit_after_commit(ctx, () => {
				notification_sender.send_to_account(
					retracted.to_account_id,
					build_role_grant_offer_retracted_notification({offer: offer_json}),
				);
			});
		}

		return {ok: true};
	};

	const list_handler = async (
		input: RoleGrantOfferListInput,
		ctx: ActionActorContext,
	): Promise<RoleGrantOfferListOutput> => {
		const auth = ctx.auth;
		const target = input.account_id ?? auth.account.id;
		// Cross-account inspection requires **global** admin — a scoped admin
		// role_grant must not be able to read another account's offer list.
		if (target !== auth.account.id && !has_scoped_role(auth, ROLE_ADMIN, null)) {
			throw jsonrpc_errors.forbidden('admin required to inspect another account');
		}
		const offers = await query_role_grant_offer_list(ctx, target);
		return {offers: offers.map(to_role_grant_offer_json)};
	};

	const history_handler = async (
		input: RoleGrantOfferHistoryInput,
		ctx: ActionActorContext,
	): Promise<RoleGrantOfferHistoryOutput> => {
		const auth = ctx.auth;
		const target = input.account_id ?? auth.account.id;
		if (target !== auth.account.id && !has_scoped_role(auth, ROLE_ADMIN, null)) {
			throw jsonrpc_errors.forbidden('admin required to inspect another account');
		}
		const offers = await query_role_grant_offer_history_for_account(
			ctx,
			target,
			input.limit ?? undefined,
			input.offset ?? undefined,
		);
		return {offers: offers.map(to_role_grant_offer_json)};
	};

	const revoke_handler = async (
		input: RoleGrantRevokeInput,
		ctx: ActionActorContext,
	): Promise<RoleGrantRevokeOutput> => {
		const auth = ctx.auth;

		// IDOR guard + role lookup + actor → account JOIN. One SELECT —
		// returns null when the role_grant is revoked, missing, or belongs
		// to a different actor. The JOIN supplies `account_id` for the
		// audit envelope's `target_account_id` and the post-commit
		// SSE/WS socket-close fan-out target. `role_grant_revoke` is the
		// canonical actor-bound-subject event: `target_actor_id` is the
		// role_grant's grantee (input.actor_id); `target_account_id` is the
		// account hosting that actor (sessions remain account-grain
		// after multi-actor lands).
		const role_grant_row = await query_role_grant_find_active_role_for_actor(
			ctx,
			input.role_grant_id,
			input.actor_id,
		);
		if (!role_grant_row) {
			throw jsonrpc_errors.not_found('role_grant', {reason: ERROR_ROLE_GRANT_NOT_FOUND});
		}
		const target_account_id = role_grant_row.account_id;
		const target_actor_id = input.actor_id;

		// Admin-grant-path gate — keeper / daemon-scoped roles stay CLI-only
		// (their `grant_paths` does not include `'admin'`).
		if (!role_has_grant_path(role_specs, role_grant_row.role, GRANT_PATH_ADMIN)) {
			audit.emit_role_grant_target(ctx, auth, {
				event_type: 'role_grant_revoke',
				outcome: 'failure',
				target_account_id,
				target_actor_id,
				metadata: {role: role_grant_row.role, role_grant_id: input.role_grant_id},
			});
			throw jsonrpc_errors.forbidden('role not web-grantable', {
				reason: ERROR_ROLE_NOT_WEB_GRANTABLE,
			});
		}

		const result = await query_revoke_role_grant(
			ctx,
			input.role_grant_id,
			input.actor_id,
			auth.actor.id,
			input.reason ?? null,
		);
		if (!result) {
			// Raced with another revoker or the role_grant was revoked between
			// the IDOR check and the UPDATE.
			throw jsonrpc_errors.not_found('role_grant', {reason: ERROR_ROLE_GRANT_NOT_FOUND});
		}

		audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_revoke',
			target_account_id,
			target_actor_id,
			metadata: {
				role: result.role,
				role_grant_id: result.id,
				scope_id: result.scope_id,
				reason: input.reason ?? undefined,
			},
		});
		// Supersede cascade — the recipient is known (`offer.to_account_id`),
		// so populate `target_account_id` rather than leaving it null;
		// `target_actor_id` inherits the offer's `to_actor_id` (actor-grain
		// when the superseded offer was actor-targeted, null otherwise).
		for (const offer of result.superseded_offers) {
			audit.emit_role_grant_target(ctx, auth, {
				event_type: 'role_grant_offer_supersede',
				target_account_id: offer.to_account_id,
				target_actor_id: offer.to_actor_id,
				metadata: {
					offer_id: offer.id,
					role: offer.role,
					scope_id: offer.scope_id,
					reason: 'role_grant_revoked',
					cause_id: result.id,
				},
			});
		}

		if (notification_sender) {
			const superseded = result.superseded_offers.map((o) => ({
				offer: to_role_grant_offer_json(o),
				from_account_id: o.from_account_id,
			}));
			const cause_id = result.id;
			const reason = input.reason ?? null;
			emit_after_commit(ctx, () => {
				notification_sender.send_to_account(
					target_account_id,
					build_role_grant_revoke_notification({
						role_grant_id: result.id,
						role: result.role,
						scope_id: result.scope_id,
						reason,
					}),
				);
				for (const sib of superseded) {
					notification_sender.send_to_account(
						sib.from_account_id,
						build_role_grant_offer_supersede_notification({
							offer: sib.offer,
							reason: 'role_grant_revoked',
							cause_id,
						}),
					);
				}
			});
		}

		return {ok: true, revoked: true};
	};

	return [
		rpc_action(role_grant_offer_create_action_spec, create_handler),
		rpc_action(role_grant_offer_accept_action_spec, accept_handler),
		rpc_action(role_grant_offer_decline_action_spec, decline_handler),
		rpc_action(role_grant_offer_retract_action_spec, retract_handler),
		rpc_action(role_grant_offer_list_action_spec, list_handler),
		rpc_action(role_grant_offer_history_action_spec, history_handler),
		rpc_action(role_grant_revoke_action_spec, revoke_handler),
	];
};
