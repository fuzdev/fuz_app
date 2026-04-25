/**
 * Permit offer RPC action handlers — the consentful-permits action surface.
 *
 * Seven actions: six offer-lifecycle methods (create / accept / decline /
 * retract / list / history) plus `permit_revoke` (admin-only). All mount
 * on a consumer's JSON-RPC endpoint via `create_rpc_endpoint`. The action
 * specs themselves live in `./permit_offer_action_specs.js`. Mutations
 * declare `side_effects: true` so the RPC dispatcher wraps the handler in
 * a DB transaction; `permit_offer_list` and `permit_offer_history` declare
 * `side_effects: false` so they are addressable via GET.
 *
 * Authorization:
 * - `permit_offer_create` — the grantor must hold an active permit for the
 *   role being offered, and that role must be `web_grantable`. Consumers
 *   needing a richer policy (e.g., "teacher may offer student in *their*
 *   classroom") pass an `authorize` callback that overrides the default.
 * - `permit_offer_accept` / `permit_offer_decline` — keyed to the caller's
 *   account; `query_*` helpers enforce the IDOR guard.
 * - `permit_offer_retract` — keyed to the caller's actor.
 * - `permit_offer_list` / `permit_offer_history` — self by default;
 *   `{account_id}` is admin-only.
 * - `permit_revoke` — spec-level `auth: {role: 'admin'}`; the RPC
 *   dispatcher rejects non-admin callers before the handler runs.
 *   `web_grantable` gate prevents revoking keeper/daemon-scoped roles
 *   via this surface. Keys on `actor_id` to survive multi-actor accounts.
 *
 * Audit events are emitted in-transaction by the query layer (atomic with
 * the permit write on accept/revoke) or by the handler via
 * `audit_log_fire_and_forget` for single-event lifecycle transitions.
 * `on_audit_event` (SSE broadcast) fires post-commit in both paths.
 *
 * WS notifications fan out post-commit via `emit_after_commit` when a
 * `notification_sender` is wired: offer lifecycle transitions notify the
 * counterparty, `permit_revoke` notifies the revokee plus each superseded
 * pending offer's grantor.
 *
 * @module
 */

import {rpc_action, type ActionContext, type RpcAction} from '../actions/action_rpc.js';
import {jsonrpc_errors} from '../http/jsonrpc_errors.js';
import {emit_after_commit} from '../http/pending_effects.js';
import {BUILTIN_ROLE_OPTIONS, ROLE_ADMIN, type RoleSchemaResult} from './role_schema.js';
import {PERMIT_OFFER_DEFAULT_TTL_MS, to_permit_offer_json} from './permit_offer_schema.js';
import {
	query_permit_offer_create,
	query_permit_offer_decline,
	query_permit_offer_retract,
	query_permit_offer_list,
	query_permit_offer_history_for_account,
	query_accept_offer,
	PermitOfferAlreadyTerminalError,
	PermitOfferExpiredError,
	PermitOfferNotFoundError,
	PermitOfferSelfTargetError,
} from './permit_offer_queries.js';
import {
	query_permit_find_active_role_for_actor,
	query_permit_has_role,
	query_revoke_permit,
} from './permit_queries.js';
import {query_actor_by_id} from './account_queries.js';
import {audit_log_fire_and_forget} from './audit_log_queries.js';
import type {AuditLogEvent} from './audit_log_schema.js';
import {has_role, type RequestContext} from './request_context.js';
import type {RouteFactoryDeps} from './deps.js';
import {
	build_permit_offer_accepted_notification,
	build_permit_offer_declined_notification,
	build_permit_offer_received_notification,
	build_permit_offer_retracted_notification,
	build_permit_offer_supersede_notification,
	build_permit_revoke_notification,
	type NotificationSender,
} from './permit_offer_notifications.js';
import {
	ERROR_ACCOUNT_NOT_FOUND,
	ERROR_PERMIT_NOT_FOUND,
	ERROR_ROLE_NOT_WEB_GRANTABLE,
} from '../http/error_schemas.js';
import {
	ERROR_OFFER_EXPIRED,
	ERROR_OFFER_NOT_AUTHORIZED,
	ERROR_OFFER_NOT_FOUND,
	ERROR_OFFER_ROLE_NOT_GRANTABLE,
	ERROR_OFFER_SELF_TARGET,
	ERROR_OFFER_TERMINAL,
	permit_offer_create_action_spec,
	permit_offer_accept_action_spec,
	permit_offer_decline_action_spec,
	permit_offer_retract_action_spec,
	permit_offer_list_action_spec,
	permit_offer_history_action_spec,
	permit_revoke_action_spec,
	type PermitOfferCreateInput,
	type PermitOfferCreateOutput,
	type PermitOfferAcceptInput,
	type PermitOfferAcceptOutput,
	type PermitOfferDeclineInput,
	type PermitOfferOkOutput,
	type PermitOfferRetractInput,
	type PermitOfferListInput,
	type PermitOfferListOutput,
	type PermitOfferHistoryInput,
	type PermitOfferHistoryOutput,
	type PermitRevokeInput,
	type PermitRevokeOutput,
} from './permit_offer_action_specs.js';

/**
 * Authorization callback for `permit_offer_create`. Returns `true` to allow,
 * `false` to reject (handler converts to `forbidden`).
 *
 * Provided with the fully-resolved request context and the parsed input
 * (pre-TTL, pre-normalization). Consumers override the default to implement
 * policies like "teacher may offer classroom_student only in classrooms they
 * teach".
 */
export type PermitOfferCreateAuthorize = (
	auth: RequestContext,
	input: {to_account_id: string; role: string; scope_id: string | null},
	deps: Pick<RouteFactoryDeps, 'log'>,
	ctx: ActionContext,
) => boolean | Promise<boolean>;

/** Options for `create_permit_offer_actions`. */
export interface PermitOfferActionOptions {
	/**
	 * Role schema result from `create_role_schema()`. Defaults to builtin roles only.
	 * The `role_options` map is read for `web_grantable` lookups.
	 */
	roles?: RoleSchemaResult;
	/** TTL applied to newly-created offers. Defaults to `PERMIT_OFFER_DEFAULT_TTL_MS`. */
	default_ttl_ms?: number;
	/**
	 * Custom authorization for `permit_offer_create`. The default requires the
	 * caller to hold an active permit for the offered role *and* the role to
	 * be `web_grantable`. Consumers with richer policies (scope-aware, chained
	 * roles) override this.
	 */
	authorize?: PermitOfferCreateAuthorize;
}

// -- Helpers ----------------------------------------------------------------

/** Fire `on_audit_event` for each event — used by accept, whose events were written in-transaction. */
const fan_out_audit_events = (
	events: Array<AuditLogEvent>,
	on_audit_event: (event: AuditLogEvent) => void,
	log: ActionContext['log'],
): void => {
	for (const event of events) {
		try {
			on_audit_event(event);
		} catch (err) {
			log.error('on_audit_event callback failed:', err);
		}
	}
};

const default_authorize: PermitOfferCreateAuthorize = async (auth, input, _deps, ctx) => {
	// Caller must hold an active permit for the offered role. Global (no scope)
	// check — the scope-aware "only in this classroom" policy is consumer-level.
	return query_permit_has_role(ctx, auth.actor.id, input.role);
};

/**
 * Authorization callback that admits any admin and otherwise falls back to
 * the symmetric default (caller must hold the offered role globally).
 *
 * The `web_grantable` filter in `create_handler` runs **before** the
 * `authorize` callback, so this never sees non-web-grantable roles. Drop
 * into `create_permit_offer_actions({authorize: authorize_admin_or_holder})`
 * (or any factory that forwards `authorize`, e.g. `create_standard_rpc_actions`)
 * for the common "admins offer anything; users offer what they hold"
 * pattern. Scope-aware policies (e.g. classroom_teacher offering
 * classroom_student in their own scope) wrap this and short-circuit `true`
 * before delegating.
 */
export const authorize_admin_or_holder: PermitOfferCreateAuthorize = async (
	auth,
	input,
	_deps,
	ctx,
) => {
	if (has_role(auth, ROLE_ADMIN)) return true;
	return query_permit_has_role(ctx, auth.actor.id, input.role);
};

/**
 * Narrow `ctx.auth` to non-null. The RPC dispatcher has already enforced
 * `auth: 'authenticated'` before the handler runs — this is a type narrow,
 * not a runtime check that would otherwise fail.
 */
const require_request_auth = (auth: RequestContext | null): RequestContext => {
	if (!auth) throw new Error('unreachable: action auth guard did not enforce authentication');
	return auth;
};

// -- Action factory ---------------------------------------------------------

/**
 * Dependencies for `create_permit_offer_actions`.
 *
 * `notification_sender` is optional — when absent, WS fan-out is silently
 * skipped. Consumers wiring `BackendWebsocketTransport` assign its instance
 * directly (the transport's `send_to_account` signature accepts the broader
 * `JsonrpcMessageFromServerToClient`, which is contravariantly compatible).
 */
export interface PermitOfferActionDeps extends Pick<RouteFactoryDeps, 'log' | 'on_audit_event'> {
	/** Optional WS fan-out primitive. `null` or absent → notifications skipped. */
	notification_sender?: NotificationSender | null;
}

/**
 * Create the seven permit-offer RPC actions (six offer-lifecycle methods
 * plus `permit_revoke`).
 *
 * @param deps - stateless capabilities; needs `log` and `on_audit_event`; optional `notification_sender` for WS fan-out
 * @param options - role schema, default TTL, authorization override
 * @returns the `RpcAction` array to spread into a `create_rpc_endpoint` call
 */
export const create_permit_offer_actions = (
	deps: PermitOfferActionDeps,
	options: PermitOfferActionOptions = {},
): Array<RpcAction> => {
	const {on_audit_event, log, notification_sender = null} = deps;
	const role_options = options.roles?.role_options ?? BUILTIN_ROLE_OPTIONS;
	const default_ttl_ms = options.default_ttl_ms ?? PERMIT_OFFER_DEFAULT_TTL_MS;
	const authorize = options.authorize ?? default_authorize;

	// Three denial paths (web_grantable, authorize, self-target) all emit the
	// same failure-outcome audit event. Local closure over `log` + `on_audit_event`.
	const emit_create_failure_audit = (
		ctx: ActionContext,
		auth: RequestContext,
		input: Pick<PermitOfferCreateInput, 'to_account_id' | 'role' | 'scope_id'>,
	): void => {
		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'permit_offer_create',
				outcome: 'failure',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				target_account_id: input.to_account_id,
				ip: ctx.client_ip,
				metadata: {
					role: input.role,
					scope_id: input.scope_id ?? null,
					to_account_id: input.to_account_id,
				},
			},
			log,
			on_audit_event,
		);
	};

	// Returns {offer} only — no auto-accept. Recipient must call
	// permit_offer_accept; admin tests materialize permits via
	// query_accept_offer (see testing/admin_integration.ts `offer_and_accept`).
	const create_handler = async (
		input: PermitOfferCreateInput,
		ctx: ActionContext,
	): Promise<PermitOfferCreateOutput> => {
		const auth = require_request_auth(ctx.auth);

		// Role must be web_grantable — same gate as admin direct-grant.
		const rc = role_options.get(input.role);
		if (!rc?.web_grantable) {
			emit_create_failure_audit(ctx, auth, input);
			throw jsonrpc_errors.forbidden('role not grantable', {
				reason: ERROR_OFFER_ROLE_NOT_GRANTABLE,
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
				reason: ERROR_OFFER_NOT_AUTHORIZED,
			});
		}

		let offer;
		try {
			offer = await query_permit_offer_create(ctx, {
				from_actor_id: auth.actor.id,
				to_account_id: input.to_account_id,
				role: input.role,
				scope_id: input.scope_id ?? null,
				message: input.message ?? null,
				expires_at: new Date(Date.now() + default_ttl_ms),
			});
		} catch (err) {
			if (err instanceof PermitOfferSelfTargetError) {
				emit_create_failure_audit(ctx, auth, input);
				throw jsonrpc_errors.invalid_params('cannot offer to self', {
					reason: ERROR_OFFER_SELF_TARGET,
				});
			}
			throw err;
		}

		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'permit_offer_create',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				target_account_id: input.to_account_id,
				ip: ctx.client_ip,
				metadata: {
					offer_id: offer.id,
					role: offer.role,
					scope_id: offer.scope_id,
					to_account_id: offer.to_account_id,
				},
			},
			log,
			on_audit_event,
		);

		const offer_json = to_permit_offer_json(offer);
		if (notification_sender) {
			emit_after_commit(ctx, () => {
				notification_sender.send_to_account(
					offer.to_account_id,
					build_permit_offer_received_notification({offer: offer_json}),
				);
			});
		}

		return {offer: offer_json};
	};

	const accept_handler = async (
		input: PermitOfferAcceptInput,
		ctx: ActionContext,
	): Promise<PermitOfferAcceptOutput> => {
		const auth = require_request_auth(ctx.auth);
		let result;
		try {
			result = await query_accept_offer(ctx, {
				offer_id: input.offer_id,
				to_account_id: auth.account.id,
				ip: ctx.client_ip,
			});
		} catch (err) {
			if (err instanceof PermitOfferNotFoundError) {
				throw jsonrpc_errors.not_found('offer', {reason: ERROR_OFFER_NOT_FOUND});
			}
			if (err instanceof PermitOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_OFFER_TERMINAL});
			}
			if (err instanceof PermitOfferExpiredError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_OFFER_EXPIRED});
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

		const offer_json = to_permit_offer_json(result.offer);
		const supersede_payloads = result.superseded_offers.map((sib) => ({
			offer: to_permit_offer_json(sib),
			from_account_id: sib.from_account_id,
		}));

		// Audit events are written in-transaction by query_accept_offer; wire
		// them through on_audit_event post-commit so SSE broadcasts fire.
		// WS notifications piggyback on the same post-commit microtask so the
		// grantor sees "accepted" and each superseded grantor sees
		// "supersede" only once the accept has durably committed.
		emit_after_commit(ctx, () => {
			fan_out_audit_events(result.audit_events, on_audit_event, ctx.log);
			if (notification_sender && grantor_account_id) {
				notification_sender.send_to_account(
					grantor_account_id,
					build_permit_offer_accepted_notification({offer: offer_json}),
				);
			}
			if (notification_sender) {
				for (const sib of supersede_payloads) {
					notification_sender.send_to_account(
						sib.from_account_id,
						build_permit_offer_supersede_notification({
							offer: sib.offer,
							reason: 'sibling_accepted',
							cause_id: result.offer.id,
						}),
					);
				}
			}
		});

		return {
			permit_id: result.permit.id,
			offer: offer_json,
			superseded_offer_ids: result.superseded_offers.map((o) => o.id),
		};
	};

	const decline_handler = async (
		input: PermitOfferDeclineInput,
		ctx: ActionContext,
	): Promise<PermitOfferOkOutput> => {
		const auth = require_request_auth(ctx.auth);
		let declined;
		try {
			declined = await query_permit_offer_decline(
				ctx,
				input.offer_id,
				auth.account.id,
				input.reason ?? null,
			);
		} catch (err) {
			if (err instanceof PermitOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_OFFER_TERMINAL});
			}
			throw err;
		}
		if (!declined) {
			throw jsonrpc_errors.not_found('offer', {reason: ERROR_OFFER_NOT_FOUND});
		}

		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'permit_offer_decline',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {
					offer_id: declined.id,
					role: declined.role,
					scope_id: declined.scope_id,
					reason: input.reason ?? undefined,
				},
			},
			log,
			on_audit_event,
		);

		if (notification_sender) {
			// Look up the grantor's account (SELECT by PK, same tx) for the
			// notification target. The decline reason rides along on
			// `offer.decline_reason` — the DB set it in the RETURNING above.
			const grantor_actor = await query_actor_by_id(ctx, declined.from_actor_id);
			const grantor_account_id = grantor_actor?.account_id ?? null;
			if (grantor_account_id) {
				const offer_json = to_permit_offer_json(declined);
				emit_after_commit(ctx, () => {
					notification_sender.send_to_account(
						grantor_account_id,
						build_permit_offer_declined_notification({offer: offer_json}),
					);
				});
			}
		}

		return {ok: true};
	};

	const retract_handler = async (
		input: PermitOfferRetractInput,
		ctx: ActionContext,
	): Promise<PermitOfferOkOutput> => {
		const auth = require_request_auth(ctx.auth);
		let retracted;
		try {
			retracted = await query_permit_offer_retract(ctx, input.offer_id, auth.actor.id);
		} catch (err) {
			if (err instanceof PermitOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({reason: ERROR_OFFER_TERMINAL});
			}
			throw err;
		}
		if (!retracted) {
			throw jsonrpc_errors.not_found('offer', {reason: ERROR_OFFER_NOT_FOUND});
		}

		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'permit_offer_retract',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				ip: ctx.client_ip,
				metadata: {
					offer_id: retracted.id,
					role: retracted.role,
					scope_id: retracted.scope_id,
				},
			},
			log,
			on_audit_event,
		);

		if (notification_sender) {
			const offer_json = to_permit_offer_json(retracted);
			emit_after_commit(ctx, () => {
				notification_sender.send_to_account(
					retracted.to_account_id,
					build_permit_offer_retracted_notification({offer: offer_json}),
				);
			});
		}

		return {ok: true};
	};

	const list_handler = async (
		input: PermitOfferListInput,
		ctx: ActionContext,
	): Promise<PermitOfferListOutput> => {
		const auth = require_request_auth(ctx.auth);
		const target = input.account_id ?? auth.account.id;
		if (target !== auth.account.id && !has_role(auth, ROLE_ADMIN)) {
			throw jsonrpc_errors.forbidden('admin required to inspect another account');
		}
		const offers = await query_permit_offer_list(ctx, target);
		return {offers: offers.map(to_permit_offer_json)};
	};

	const history_handler = async (
		input: PermitOfferHistoryInput,
		ctx: ActionContext,
	): Promise<PermitOfferHistoryOutput> => {
		const auth = require_request_auth(ctx.auth);
		const target = input.account_id ?? auth.account.id;
		if (target !== auth.account.id && !has_role(auth, ROLE_ADMIN)) {
			throw jsonrpc_errors.forbidden('admin required to inspect another account');
		}
		const offers = await query_permit_offer_history_for_account(
			ctx,
			target,
			input.limit ?? undefined,
			input.offset ?? undefined,
		);
		return {offers: offers.map(to_permit_offer_json)};
	};

	const revoke_handler = async (
		input: PermitRevokeInput,
		ctx: ActionContext,
	): Promise<PermitRevokeOutput> => {
		const auth = require_request_auth(ctx.auth);

		// IDOR guard + role lookup. One SELECT — returns null when the
		// permit is revoked, missing, or belongs to a different actor.
		const permit_row = await query_permit_find_active_role_for_actor(
			ctx,
			input.permit_id,
			input.actor_id,
		);
		if (!permit_row) {
			throw jsonrpc_errors.not_found('permit', {reason: ERROR_PERMIT_NOT_FOUND});
		}

		// Resolve the target actor's account once — drives both the audit
		// `target_account_id` and the post-commit notification target.
		const target_actor = await query_actor_by_id(ctx, input.actor_id);
		if (!target_actor) {
			// The IDOR guard above already matched, so a missing actor here
			// indicates a race (account deleted between the two SELECTs).
			// Treat as account-not-found for the caller.
			throw jsonrpc_errors.not_found('account', {reason: ERROR_ACCOUNT_NOT_FOUND});
		}
		const target_account_id = target_actor.account_id;

		// web_grantable gate — keeper/daemon-scoped roles stay CLI-only.
		const rc = role_options.get(permit_row.role);
		if (!rc?.web_grantable) {
			void audit_log_fire_and_forget(
				ctx,
				{
					event_type: 'permit_revoke',
					outcome: 'failure',
					actor_id: auth.actor.id,
					account_id: auth.account.id,
					target_account_id,
					ip: ctx.client_ip,
					metadata: {role: permit_row.role, permit_id: input.permit_id},
				},
				log,
				on_audit_event,
			);
			throw jsonrpc_errors.forbidden('role not web-grantable', {
				reason: ERROR_ROLE_NOT_WEB_GRANTABLE,
			});
		}

		const result = await query_revoke_permit(
			ctx,
			input.permit_id,
			input.actor_id,
			auth.actor.id,
			input.reason ?? null,
		);
		if (!result) {
			// Raced with another revoker or the permit was revoked between
			// the IDOR check and the UPDATE.
			throw jsonrpc_errors.not_found('permit', {reason: ERROR_PERMIT_NOT_FOUND});
		}

		void audit_log_fire_and_forget(
			ctx,
			{
				event_type: 'permit_revoke',
				actor_id: auth.actor.id,
				account_id: auth.account.id,
				target_account_id,
				ip: ctx.client_ip,
				metadata: {
					role: result.role,
					permit_id: result.id,
					scope_id: result.scope_id,
					reason: input.reason ?? undefined,
				},
			},
			log,
			on_audit_event,
		);
		for (const offer of result.superseded_offers) {
			void audit_log_fire_and_forget(
				ctx,
				{
					event_type: 'permit_offer_supersede',
					actor_id: auth.actor.id,
					account_id: offer.to_account_id,
					ip: ctx.client_ip,
					metadata: {
						offer_id: offer.id,
						role: offer.role,
						scope_id: offer.scope_id,
						reason: 'permit_revoked',
						cause_id: result.id,
					},
				},
				log,
				on_audit_event,
			);
		}

		if (notification_sender) {
			const superseded = result.superseded_offers.map((o) => ({
				offer: to_permit_offer_json(o),
				from_account_id: o.from_account_id,
			}));
			const cause_id = result.id;
			const reason = input.reason ?? null;
			emit_after_commit(ctx, () => {
				notification_sender.send_to_account(
					target_account_id,
					build_permit_revoke_notification({
						permit_id: result.id,
						role: result.role,
						scope_id: result.scope_id,
						reason,
					}),
				);
				for (const sib of superseded) {
					notification_sender.send_to_account(
						sib.from_account_id,
						build_permit_offer_supersede_notification({
							offer: sib.offer,
							reason: 'permit_revoked',
							cause_id,
						}),
					);
				}
			});
		}

		return {ok: true, revoked: true};
	};

	return [
		rpc_action(permit_offer_create_action_spec, create_handler),
		rpc_action(permit_offer_accept_action_spec, accept_handler),
		rpc_action(permit_offer_decline_action_spec, decline_handler),
		rpc_action(permit_offer_retract_action_spec, retract_handler),
		rpc_action(permit_offer_list_action_spec, list_handler),
		rpc_action(permit_offer_history_action_spec, history_handler),
		rpc_action(permit_revoke_action_spec, revoke_handler),
	];
};
