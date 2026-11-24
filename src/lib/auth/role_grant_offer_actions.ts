/**
 * Role grant offer RPC action handlers — the consentful-role-grants action surface.
 *
 * The offer-lifecycle methods (create / accept / decline / retract / list /
 * history) plus `role_grant_revoke` and `role_grant_assign` (both
 * admin-only). All mount
 * on a consumer's JSON-RPC endpoint through `rpc_endpoints`. The action
 * specs themselves live in `auth/role_grant_offer_action_specs.ts`. Mutations
 * declare `side_effects: true` so the RPC dispatcher wraps the handler in
 * a DB transaction; `role_grant_offer_list` and `role_grant_offer_history` declare
 * `side_effects: false` so they are addressable via GET.
 *
 * Authorization:
 * - `role_grant_offer_create` — the role's `grant_paths` must include `'admin'`,
 *   and by default the grantor must hold a **global** `admin`. Consumers needing
 *   a richer policy (e.g., "teacher may offer student in *their* classroom")
 *   pass an `authorize` callback that overrides the default — for app roles
 *   only: a builtin role (`admin` / `keeper`) is global-only (a scoped one is
 *   refused with `role_grant_builtin_scoped`) and offered only by a global
 *   admin, both decided before the callback runs.
 * - `role_grant_offer_accept` / `role_grant_offer_decline` — keyed to the caller's
 *   account; `query_*` helpers enforce the IDOR guard. Accept also refuses a
 *   builtin-role offer that must not mint (`keeper`, scoped, or a grantor who
 *   no longer holds a global admin), auditing the refusal and leaving the
 *   offer pending.
 * - `role_grant_offer_retract` — keyed to the caller's actor.
 * - `role_grant_offer_list` / `role_grant_offer_history` — self by default;
 *   `{account_id}` is admin-only.
 * - `role_grant_revoke` — spec-level `auth: {role: 'admin'}`; the RPC
 *   dispatcher rejects non-admin callers before the handler runs.
 *   The admin-grant-path gate prevents revoking keeper / daemon-scoped
 *   roles via this surface. Keys on `actor_id` to survive multi-actor accounts.
 * - `role_grant_assign` — spec-level `auth: {role: 'admin'}` (a **global**
 *   grant, re-checked in the handler); the immediate consent-free conferral
 *   path. The admin-grant-path gate prevents assigning keeper / daemon-scoped
 *   roles via this surface, and a scoped `admin` is refused. No
 *   holder-propagation — only a global admin confers; holding a role grants
 *   no power to assign it.
 *
 * Audit events are emitted in-transaction by the query layer (atomic with
 * the role_grant write on accept) or by the handler via the bound
 * `deps.audit.emit_role_grant_target` helper (revoke, assign, and the
 * single-event lifecycle transitions — a success row written in the request
 * transaction, a failure row on the pool). `audit.notify` (SSE/WS broadcast)
 * fires post-commit in both paths.
 *
 * WS notifications go through the handler context's sender
 * (`ctx.notification_sender`), queued post-commit (`queue_offer_notification`,
 * `queue_supersede_notifications`): offer lifecycle transitions notify the
 * counterparty, `role_grant_revoke` notifies the revokee (`role_grant_revoked`)
 * plus both parties of each superseded pending offer, and an accept each
 * superseded sibling's grantor. `role_grant_revoke` of a global
 * grant also closes the revokee's connections gated on the role through
 * `deps.connection_closer`, after the commit.
 *
 * @module
 */

import type { Uuid } from '../primitive_schemas.ts';
import type { Logger } from '@fuzdev/fuz_util/log.ts';

import {
	rpc_action,
	type ActionActorContext,
	type ActionContext,
	type RpcAction
} from '../actions/action_types.ts';
import { jsonrpc_errors, type ThrownJsonrpcError } from '../http/jsonrpc_errors.ts';
import { emit_after_commit } from '../http/pending_effects.ts';
import { queue_connection_close } from '../actions/connection_closer.ts';
import {
	builtin_role_specs,
	is_builtin_role,
	ROLE_ADMIN,
	ROLE_KEEPER,
	role_has_grant_path,
	type RoleRegistry
} from './role_schema.ts';
import { GRANT_PATH_ADMIN } from './grant_path_schema.ts';
import {
	ROLE_GRANT_OFFER_DEFAULT_TTL_MS,
	to_role_grant_offer_json,
	type SupersededOffer
} from './role_grant_offer_schema.ts';
import {
	query_role_grant_offer_create,
	query_role_grant_offer_decline,
	query_role_grant_offer_retract,
	query_role_grant_offer_list,
	query_role_grant_offer_history_for_account,
	query_accept_offer,
	RoleGrantOfferActorAccountMismatchError,
	RoleGrantOfferActorMismatchError,
	RoleGrantOfferGrantorNotActiveError,
	RoleGrantOfferRecipientNotActiveError,
	RoleGrantOfferAlreadyTerminalError,
	RoleGrantOfferBuiltinRefusedError,
	RoleGrantOfferExpiredError,
	RoleGrantOfferNotFoundError,
	RoleGrantOfferSelfTargetError,
	query_revoke_role_grant
} from './role_grant_offer_queries.ts';
import {
	query_account_has_active_global_role,
	query_account_has_global_role,
	query_count_active_accounts_with_global_role_locked,
	query_create_role_grant,
	query_role_grant_find_active_role_for_actor,
	query_scope_lock_shared
} from './role_grant_queries.ts';
import { query_account_lock_live_many, query_active_actors_by_account } from './account_queries.ts';
import type { AuditLogEvent } from './audit_log_schema.ts';
import {
	has_scoped_role,
	type RequestActorContext,
	type RequestContext
} from './request_context.ts';
import type { RevokingActionFactoryDeps } from './deps.ts';
import type { AuditEmitter } from './audit_emitter.ts';
import {
	build_role_grant_offer_accepted_notification,
	build_role_grant_offer_declined_notification,
	build_role_grant_offer_received_notification,
	build_role_grant_offer_retracted_notification,
	build_role_grant_revoked_notification,
	queue_offer_notification,
	queue_supersede_notifications,
	type RoleGrantOfferSupersedeParams,
	type SupersedeCause
} from './role_grant_offer_notifications.ts';
import {
	ERROR_AUTHENTICATION_REQUIRED,
	ERROR_INSUFFICIENT_PERMISSIONS,
	ERROR_ROLE_GRANT_NOT_FOUND,
	ERROR_ROLE_NOT_WEB_GRANTABLE
} from '../http/error_schemas.ts';
import {
	ERROR_CANNOT_REVOKE_KEEPER_ADMIN,
	ERROR_CANNOT_REVOKE_LAST_ADMIN,
	ERROR_ROLE_GRANT_BUILTIN_SCOPED,
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
	role_grant_assign_action_spec,
	type RoleGrantOfferCreateInput,
	type RoleGrantOfferCreateOutput,
	type RoleGrantOfferAcceptInput,
	type RoleGrantOfferAcceptOutput,
	type RoleGrantOfferDeclineInput,
	type RoleGrantOfferDeclineOutput,
	type RoleGrantOfferRetractInput,
	type RoleGrantOfferRetractOutput,
	type RoleGrantOfferListInput,
	type RoleGrantOfferListOutput,
	type RoleGrantOfferHistoryInput,
	type RoleGrantOfferHistoryOutput,
	type RoleGrantRevokeInput,
	type RoleGrantRevokeOutput,
	type RoleGrantAssignInput,
	type RoleGrantAssignOutput
} from './role_grant_offer_action_specs.ts';

/**
 * Emit one `role_grant_offer_supersede` audit row per offer a cascade ended —
 * the revokes (`role_grant_revoke` and the self-service disable, both
 * `'role_grant_revoked'` with the revoked grant as `cause_id`) and account
 * removal (`'account_deleted'`, the removed account). The acting pair is the
 * caller's; the target pair is the offer's recipient (`to_account_id`, and
 * `to_actor_id` when the offer named an actor). Twin of the Rust
 * `emit_supersede_audits`.
 *
 * @param ctx - the handler context; the rows are the caller's
 * @param audit - the emitter
 * @param superseded - the offers the cascade ended
 * @param reason - why they were superseded
 * @param cause_id - the row that caused it
 */
export const emit_supersede_audits = async (
	ctx: ActionActorContext,
	audit: AuditEmitter,
	superseded: ReadonlyArray<SupersededOffer>,
	reason: RoleGrantOfferSupersedeParams['reason'],
	cause_id: Uuid
): Promise<void> => {
	for (const offer of superseded) {
		await audit.emit_role_grant_target(ctx, ctx.auth, {
			event_type: 'role_grant_offer_supersede',
			target_account_id: offer.to_account_id,
			target_actor_id: offer.to_actor_id,
			metadata: {
				offer_id: offer.id,
				role: offer.role,
				scope_id: offer.scope_id,
				reason,
				cause_id
			}
		});
	}
};

/**
 * Authorization callback for `role_grant_offer_create` and `role_grant_assign`.
 * Returns `true` to allow, `false` to reject (handler converts to `forbidden`
 * with `role_grant_offer_not_authorized`).
 *
 * Provided with the fully-resolved request context and the parsed input
 * (pre-TTL, pre-normalization). Consumers override the default to implement
 * policies like "teacher may offer classroom_student only in classrooms they
 * teach". `role_grant_assign` — the global-admin path that confers a grant
 * with no offer — runs it too, so a policy over which grants may exist (a
 * role that must be scoped, a scope that must be real) holds on both paths.
 * Twin of the Rust `OfferCreateAuthorize`.
 *
 * An offer authorized by a scoped grant must stay at that grant's scope: a
 * scope teardown (`query_role_grant_revoke_for_scope`) supersedes only that
 * scope's offers, so a revokee's offers elsewhere survive it.
 *
 * `ctx` is the request's: both verbs have side effects, so `ctx.db` is the
 * request transaction, and a callback needing the database (a scope-existence
 * check, say) reads through it. **Read-only** — the callback decides, it never
 * writes; a write would commit or roll back with the request, and nothing
 * enforces this but the callback.
 *
 * **Runs under the scope lock** when the input is scoped: both verbs take
 * `scope_id`'s lock shared (`query_scope_lock_shared`) before calling it, so
 * a scope-existence read sees every teardown that committed first (READ
 * COMMITTED's per-statement snapshot, which `ensure_read_committed` holds the
 * database to) and a teardown still to come waits for the request to commit.
 * That holds only for a consumer teardown that goes through
 * `query_role_grant_revoke_for_scope` before it removes the scope row, or
 * takes `query_scope_lock_exclusive` first; one that removes the row first
 * leaves the window open, and one that locks the row first deadlocks with a
 * callback that locks it.
 */
export type RoleGrantOfferCreateAuthorize = (
	auth: RequestContext,
	input: {
		to_account_id: string;
		role: string;
		scope_kind: string | null;
		scope_id: string | null;
	},
	deps: { log: Logger },
	ctx: ActionContext
) => boolean | Promise<boolean>;

/** Options for `create_role_grant_offer_actions`. */
export interface RoleGrantOfferActionOptions {
	/**
	 * Role registry from `create_role_registry()`. Defaults to builtin roles only.
	 * Drives the grantability gate: a role is offerable / revocable through
	 * this surface only when its `RoleSpec.grant_paths` includes `'admin'`
	 * (the `GRANT_PATH_ADMIN` constant).
	 */
	roles?: RoleRegistry;
	/** TTL applied to newly-created offers. Defaults to `ROLE_GRANT_OFFER_DEFAULT_TTL_MS`. */
	default_ttl_ms?: number;
	/**
	 * Custom authorization for `role_grant_offer_create` and `role_grant_assign`. The default requires the
	 * caller to hold a **global** `admin` grant; the role's
	 * `RoleSpec.grant_paths` must include `'admin'` either way. Consumers with
	 * richer policies (scope-aware, chained roles) override this. A builtin
	 * role never reaches the callback unless the caller holds a global `admin`
	 * and the offer is unscoped — the spine decides builtin-role offers itself,
	 * so a callback needs no builtin handling of its own.
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

/**
 * Whether a grant input binds a builtin role to a scope — refused on every
 * grant path (see `ERROR_ROLE_GRANT_BUILTIN_SCOPED`).
 */
const is_scoped_builtin = (role: string, scope_id: string | null | undefined): boolean =>
	scope_id != null && is_builtin_role(role);

/** The `invalid_params` a scoped builtin-role grant input answers. */
const builtin_scoped_error = (): ThrownJsonrpcError =>
	jsonrpc_errors.invalid_params('builtin roles are global-only and cannot be scoped', {
		reason: ERROR_ROLE_GRANT_BUILTIN_SCOPED
	});

// eslint-disable-next-line @typescript-eslint/require-await
const default_authorize: RoleGrantOfferCreateAuthorize = async (auth, _input, _deps, _ctx) => {
	// Admin-only conferral: the caller must hold a *global* `admin` grant. Holding
	// the offered role itself confers no power to offer it (no holder-propagation).
	// The global check (scope_id null) stops a scoped `admin` escalating into
	// global authority over the offer surface. Reads the in-memory
	// `auth.role_grants` snapshot; no DB roundtrip.
	return has_scoped_role(auth, ROLE_ADMIN, null);
};

// -- Action factory ---------------------------------------------------------

/**
 * Create the role-grant-offer RPC actions: the offer-lifecycle methods plus
 * `role_grant_revoke` and the immediate `role_grant_assign`.
 *
 * @param deps - `RevokingActionFactoryDeps`: `log`, `audit`, and the `connection_closer` a revoked global grant closes the revokee's role-gated connections through. WS notifications go through the handler context's `notification_sender`, not a dep
 * @param options - role registry, default TTL, authorization override
 * @returns the `RpcAction` array to spread into an `RpcEndpointSpec`'s `actions`
 */
export const create_role_grant_offer_actions = (
	deps: RevokingActionFactoryDeps,
	options: RoleGrantOfferActionOptions = {}
): Array<RpcAction> => {
	const { log, audit, connection_closer } = deps;
	const role_specs = options.roles?.role_specs ?? builtin_role_specs;
	const default_ttl_ms = options.default_ttl_ms ?? ROLE_GRANT_OFFER_DEFAULT_TTL_MS;
	const authorize = options.authorize ?? default_authorize;

	// Every denial path (admin-grant-path gate, scoped builtin, builtin without a
	// global admin, authorize, self-target, actor-account mismatch) emits the
	// same failure-outcome audit event. `target_actor_id` is populated when the
	// caller supplied a `to_actor_id` so failure rows match the success-shape
	// envelope of actor-targeted offers.
	const emit_create_failure_audit = async (
		ctx: ActionContext,
		auth: RequestActorContext,
		input: Pick<
			RoleGrantOfferCreateInput,
			'to_account_id' | 'to_actor_id' | 'role' | 'scope_kind' | 'scope_id'
		>
	): Promise<void> => {
		await audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_offer_create',
			outcome: 'failure',
			target_account_id: input.to_account_id,
			target_actor_id: input.to_actor_id ?? null,
			metadata: {
				role: input.role,
				scope_id: input.scope_id ?? null,
				to_account_id: input.to_account_id
			}
		});
	};

	// Answer (and audit) an accept the query refused as a builtin-role offer that
	// must not mint. The refusal is a forensic event — someone holds an offer of a
	// builtin role the spine won't confer — so it is audited as a failed
	// `role_grant_offer_accept` (pool-routed, surviving the rollback), like
	// offer-create refusals. Metadata is the success row's shape minus
	// `role_grant_id` (no grant was minted), plus the wire `reason`. The offer
	// stays pending. Returns the error the verb answers.
	const refuse_builtin_accept = async (
		ctx: ActionContext,
		auth: RequestActorContext,
		err: RoleGrantOfferBuiltinRefusedError
	): Promise<ThrownJsonrpcError> => {
		let error: ThrownJsonrpcError;
		let data: { reason: string };
		switch (err.refusal) {
			case 'bootstrap_only':
				// `keeper`'s grant path is bootstrap-only — the offer-create answer
				// for a role no offer may confer
				data = { reason: ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE };
				error = jsonrpc_errors.forbidden('role not grantable', data);
				break;
			case 'scoped':
				data = { reason: ERROR_ROLE_GRANT_BUILTIN_SCOPED };
				error = jsonrpc_errors.invalid_request(data);
				break;
			case 'grantor_not_authorized':
				data = { reason: ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED };
				error = jsonrpc_errors.forbidden(
					"the offer's grantor can no longer confer this role",
					data
				);
				break;
		}
		await audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_offer_accept',
			outcome: 'failure',
			target_account_id: auth.account.id,
			target_actor_id: auth.actor.id,
			metadata: {
				offer_id: err.offer.id,
				role: err.offer.role,
				scope_id: err.offer.scope_id,
				reason: data.reason
			}
		});
		return error;
	};

	// The refusal for a recipient that is missing or soft-deleted: an actor
	// named that is no active actor of the account is the mismatch, else the
	// account is not found. Offer-create and assign answer a deleted recipient
	// exactly as a missing one, so the call says nothing a missing id wouldn't.
	const recipient_not_found_error = (to_actor_id: Uuid | null | undefined): ThrownJsonrpcError =>
		to_actor_id != null
			? jsonrpc_errors.invalid_params('to_actor_id does not belong to to_account_id', {
					reason: ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH
				})
			: jsonrpc_errors.not_found('account');

	// Returns {offer} only — no auto-accept. Recipient must call
	// role_grant_offer_accept; admin tests drive the full consent flow over
	// RPC (see testing/admin_integration.ts `offer_and_accept`), or seed
	// role_grants directly via create_test_role_grant_direct when the
	// test isn't about the consent path.
	const create_handler = async (
		input: RoleGrantOfferCreateInput,
		ctx: ActionActorContext
	): Promise<RoleGrantOfferCreateOutput> => {
		const auth = ctx.auth;

		// Role must include the admin grant path — same gate as admin direct-grant.
		if (!role_has_grant_path(role_specs, input.role, GRANT_PATH_ADMIN)) {
			await emit_create_failure_audit(ctx, auth, input);
			throw jsonrpc_errors.forbidden('role not grantable', {
				reason: ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE
			});
		}

		// Builtin roles are global-only — refused before the injected callback,
		// so no consumer authorizer can admit a scoped `admin` / `keeper` offer.
		if (is_scoped_builtin(input.role, input.scope_id)) {
			await emit_create_failure_audit(ctx, auth, input);
			throw builtin_scoped_error();
		}

		// Offering a builtin role is global-admin authority, decided here rather
		// than by the injected callback: a consumer callback answering by holding
		// the role (a scope-blind check) would otherwise let a scoped `admin`
		// row offer a global `admin` to a second account it controls. Same denial
		// the default callback gives.
		if (is_builtin_role(input.role) && !has_scoped_role(auth, ROLE_ADMIN, null)) {
			await emit_create_failure_audit(ctx, auth, input);
			throw jsonrpc_errors.forbidden('not authorized to offer this role', {
				reason: ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED
			});
		}

		// A scoped offer takes the scope lock before the callback reads the scope,
		// so a teardown that committed first is seen (the callback refuses the
		// dead scope) and one still to come waits for this offer, then supersedes
		// it. The query takes it again, free.
		if (input.scope_id != null) await query_scope_lock_shared(ctx, input.scope_id);
		const authorized = await authorize(
			auth,
			{
				to_account_id: input.to_account_id,
				role: input.role,
				scope_kind: input.scope_kind ?? null,
				scope_id: input.scope_id ?? null
			},
			{ log },
			ctx
		);
		if (!authorized) {
			await emit_create_failure_audit(ctx, auth, input);
			throw jsonrpc_errors.forbidden('not authorized to offer this role', {
				reason: ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED
			});
		}

		// Both parties' rules live in the query, after every authority gate above,
		// so a caller refused the conferral learns nothing of the recipient.
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
				expires_at: new Date(Date.now() + default_ttl_ms)
			});
		} catch (err) {
			if (err instanceof RoleGrantOfferSelfTargetError) {
				await emit_create_failure_audit(ctx, auth, input);
				throw jsonrpc_errors.invalid_params('cannot offer to self', {
					reason: ERROR_ROLE_GRANT_OFFER_SELF_TARGET
				});
			}
			if (
				err instanceof RoleGrantOfferActorAccountMismatchError ||
				err instanceof RoleGrantOfferRecipientNotActiveError
			) {
				await emit_create_failure_audit(ctx, auth, input);
				// a named actor is the mismatch, else the account is not found —
				// the answers `role_grant_assign` gives the same recipient
				throw recipient_not_found_error(input.to_actor_id);
			}
			// The caller's own account was deleted while the request was in flight:
			// refused as the dead credential it now is, as `account_token_create`
			// refuses it, with no audit row from an account that is gone.
			if (err instanceof RoleGrantOfferGrantorNotActiveError) {
				throw jsonrpc_errors.unauthenticated('unauthenticated', {
					reason: ERROR_AUTHENTICATION_REQUIRED
				});
			}
			throw err;
		}

		// `target_actor_id` is populated when the offer is actor-targeted
		// (per the offer's `to_actor_id`), null for account-grain offers
		// — closes the audit hole where offer-shape events used to leave
		// actor-grain forensics blank even when the binding was known.
		await audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_offer_create',
			target_account_id: input.to_account_id,
			target_actor_id: offer.to_actor_id,
			metadata: {
				offer_id: offer.id,
				role: offer.role,
				scope_id: offer.scope_id,
				to_account_id: offer.to_account_id
			}
		});

		const offer_json = to_role_grant_offer_json(offer);
		queue_offer_notification(
			ctx,
			offer.to_account_id,
			build_role_grant_offer_received_notification({ offer: offer_json })
		);

		return { offer: offer_json };
	};

	const accept_handler = async (
		input: RoleGrantOfferAcceptInput,
		ctx: ActionActorContext
	): Promise<RoleGrantOfferAcceptOutput> => {
		const auth = ctx.auth;
		let result;
		try {
			result = await query_accept_offer(ctx, {
				offer_id: input.offer_id,
				to_account_id: auth.account.id,
				actor_id: auth.actor.id,
				ip: ctx.client_ip
			});
		} catch (err) {
			if (err instanceof RoleGrantOfferNotFoundError) {
				throw jsonrpc_errors.not_found('offer', { reason: ERROR_ROLE_GRANT_OFFER_NOT_FOUND });
			}
			if (err instanceof RoleGrantOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({ reason: ERROR_ROLE_GRANT_OFFER_TERMINAL });
			}
			if (err instanceof RoleGrantOfferExpiredError) {
				throw jsonrpc_errors.invalid_request({ reason: ERROR_ROLE_GRANT_OFFER_EXPIRED });
			}
			if (err instanceof RoleGrantOfferActorMismatchError) {
				throw jsonrpc_errors.forbidden('offer is targeted to a different actor', {
					reason: ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH
				});
			}
			if (err instanceof RoleGrantOfferBuiltinRefusedError) {
				throw await refuse_builtin_accept(ctx, auth, err);
			}
			// The caller's own account was deleted while the request was in flight:
			// refused as the dead credential it now is, as offer-create refuses a
			// grantor deleted in flight, with no audit row from an account that is gone.
			if (err instanceof RoleGrantOfferRecipientNotActiveError) {
				throw jsonrpc_errors.unauthenticated('unauthenticated', {
					reason: ERROR_AUTHENTICATION_REQUIRED
				});
			}
			throw err;
		}

		const offer_json = to_role_grant_offer_json(result.offer);

		// Audit events are written in-transaction by query_accept_offer; wire
		// them through `audit.notify` post-commit so SSE/WS broadcasts fire.
		// The WS notifications are queued behind them on the same post-commit
		// queue, so the grantor sees "accepted" and each superseded grantor sees
		// "supersede" only once the accept has durably committed — and never if
		// it rolls back (the dispatch site discards `post_commit_effects` on
		// rollback). A replay (or a race loser) wrote nothing — the accept that
		// minted the grant already audited it and notified the grantor — so it
		// queues nothing; repeating the notification would let any replay send
		// them without bound. Only the siblings' grantors hear the supersede: their
		// recipient is the caller, whose answer lists `superseded_offer_ids`.
		if (result.created) {
			emit_after_commit(ctx, () => {
				fan_out_audit_events(result.audit_events, audit);
			});
			queue_offer_notification(
				ctx,
				result.from_account_id,
				build_role_grant_offer_accepted_notification({ offer: offer_json })
			);
			queue_supersede_notifications(ctx, result.superseded_offers, 'sibling_accepted', {
				grantor: { kind: 'id', id: result.offer.id },
				recipient: null
			});
		}

		return {
			role_grant_id: result.role_grant.id,
			offer: offer_json,
			superseded_offer_ids: result.superseded_offers.map((o) => o.id)
		};
	};

	const decline_handler = async (
		input: RoleGrantOfferDeclineInput,
		ctx: ActionActorContext
	): Promise<RoleGrantOfferDeclineOutput> => {
		const auth = ctx.auth;
		let declined;
		try {
			declined = await query_role_grant_offer_decline(
				ctx,
				input.offer_id,
				auth.account.id,
				input.reason ?? null
			);
		} catch (err) {
			if (err instanceof RoleGrantOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({ reason: ERROR_ROLE_GRANT_OFFER_TERMINAL });
			}
			throw err;
		}
		if (!declined) {
			throw jsonrpc_errors.not_found('offer', { reason: ERROR_ROLE_GRANT_OFFER_NOT_FOUND });
		}

		// `role_grant_offer_decline` is *to* the offering actor — populate both
		// `target_actor_id` (the grantor actor) and `target_account_id`
		// (the grantor account, joined in the decline RETURNING via CTE).
		// The "both populated → same account" invariant holds: the
		// grantor's actor↔account binding is 1:1 by definition of `actor`.
		await audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_offer_decline',
			target_account_id: declined.from_account_id,
			target_actor_id: declined.from_actor_id,
			metadata: {
				offer_id: declined.id,
				role: declined.role,
				scope_id: declined.scope_id,
				reason: input.reason ?? undefined
			}
		});

		const offer_json = to_role_grant_offer_json(declined);
		// Grantor's account_id rides on `declined.from_account_id` from the
		// decline RETURNING — no second SELECT needed. The decline reason rides
		// along on `offer.decline_reason` — the DB set it in the RETURNING above.
		queue_offer_notification(
			ctx,
			declined.from_account_id,
			build_role_grant_offer_declined_notification({ offer: offer_json })
		);

		// the terminal offer, as accept answers its own
		return { offer: offer_json };
	};

	const retract_handler = async (
		input: RoleGrantOfferRetractInput,
		ctx: ActionActorContext
	): Promise<RoleGrantOfferRetractOutput> => {
		const auth = ctx.auth;
		let retracted;
		try {
			retracted = await query_role_grant_offer_retract(ctx, input.offer_id, auth.actor.id);
		} catch (err) {
			if (err instanceof RoleGrantOfferAlreadyTerminalError) {
				throw jsonrpc_errors.invalid_request({ reason: ERROR_ROLE_GRANT_OFFER_TERMINAL });
			}
			throw err;
		}
		if (!retracted) {
			throw jsonrpc_errors.not_found('offer', { reason: ERROR_ROLE_GRANT_OFFER_NOT_FOUND });
		}

		// `role_grant_offer_retract` is *from* the recipient inbox —
		// `target_account_id` is the recipient account; `target_actor_id`
		// inherits the offer's `to_actor_id` (set on actor-targeted
		// offers, null on account-grain offers).
		await audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_offer_retract',
			target_account_id: retracted.to_account_id,
			target_actor_id: retracted.to_actor_id,
			metadata: {
				offer_id: retracted.id,
				role: retracted.role,
				scope_id: retracted.scope_id
			}
		});

		const offer_json = to_role_grant_offer_json(retracted);
		queue_offer_notification(
			ctx,
			retracted.to_account_id,
			build_role_grant_offer_retracted_notification({ offer: offer_json })
		);

		// the terminal offer, as accept answers its own
		return { offer: offer_json };
	};

	const list_handler = async (
		input: RoleGrantOfferListInput,
		ctx: ActionActorContext
	): Promise<RoleGrantOfferListOutput> => {
		const auth = ctx.auth;
		const target = input.account_id ?? auth.account.id;
		// Cross-account inspection requires **global** admin — a scoped admin
		// role_grant must not be able to read another account's offer list.
		if (target !== auth.account.id && !has_scoped_role(auth, ROLE_ADMIN, null)) {
			throw jsonrpc_errors.forbidden('admin required to inspect another account');
		}
		const offers = await query_role_grant_offer_list(ctx, target);
		return { offers: offers.map(to_role_grant_offer_json) };
	};

	const history_handler = async (
		input: RoleGrantOfferHistoryInput,
		ctx: ActionActorContext
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
			input.offset ?? undefined
		);
		return { offers: offers.map(to_role_grant_offer_json) };
	};

	const revoke_handler = async (
		input: RoleGrantRevokeInput,
		ctx: ActionActorContext
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
			input.actor_id
		);
		if (!role_grant_row) {
			throw jsonrpc_errors.not_found('role_grant', { reason: ERROR_ROLE_GRANT_NOT_FOUND });
		}
		const target_account_id = role_grant_row.account_id;
		const target_actor_id = input.actor_id;

		// Admin-grant-path gate — keeper / daemon-scoped roles stay CLI-only
		// (their `grant_paths` does not include `'admin'`).
		const emit_revoke_failure = async (): Promise<void> => {
			await audit.emit_role_grant_target(ctx, auth, {
				event_type: 'role_grant_revoke',
				outcome: 'failure',
				target_account_id,
				target_actor_id,
				metadata: { role: role_grant_row.role, role_grant_id: input.role_grant_id }
			});
		};
		if (!role_has_grant_path(role_specs, role_grant_row.role, GRANT_PATH_ADMIN)) {
			await emit_revoke_failure();
			throw jsonrpc_errors.forbidden('role not web-grantable', {
				reason: ERROR_ROLE_NOT_WEB_GRANTABLE
			});
		}

		// The global `admin` grant is guarded like the account that holds it:
		// the keeper account's is never revoked (no web path re-grants it, so the
		// keeper would be locked out of the admin surface for good), and the
		// grant goes only when an active admin account remains without it — the
		// count leaves this grant out, so a second admin actor on the same
		// account still counts. The count locks what it counted, so a concurrent
		// revoke or account removal can't pass the same guard.
		if (role_grant_row.role === ROLE_ADMIN && role_grant_row.scope_id === null) {
			if (await query_account_has_global_role(ctx, target_account_id, ROLE_KEEPER)) {
				await emit_revoke_failure();
				throw jsonrpc_errors.forbidden("cannot revoke the keeper account's admin grant", {
					reason: ERROR_CANNOT_REVOKE_KEEPER_ADMIN
				});
			}
			if (
				(await query_account_has_active_global_role(ctx, target_account_id, ROLE_ADMIN)) &&
				(await query_count_active_accounts_with_global_role_locked(
					ctx,
					ROLE_ADMIN,
					input.role_grant_id
				)) === 0
			) {
				await emit_revoke_failure();
				throw jsonrpc_errors.forbidden("cannot revoke the last admin's admin grant", {
					reason: ERROR_CANNOT_REVOKE_LAST_ADMIN
				});
			}
		}

		// The revoke ends the revokee's incoming siblings and every offer its
		// actor made, taking the revokee's account row and then those offers
		// before the grant (`query_revoke_role_grant` has the order). After the
		// guard, which holds an admin revokee's row already.
		const result = await query_revoke_role_grant(
			ctx,
			input.role_grant_id,
			input.actor_id,
			auth.actor.id,
			input.reason ?? null
		);
		if (!result) {
			// Raced with another revoker or the role_grant was revoked between
			// the IDOR check and the UPDATE.
			throw jsonrpc_errors.not_found('role_grant', { reason: ERROR_ROLE_GRANT_NOT_FOUND });
		}
		// Close the revokee's connections gated on the role once the revoke has
		// committed — queued, so never before the commit or on rollback, and not
		// riding on the audit row's announcement below (the revocation guard
		// repeats it when the row is announced). Global grants only: a role gate admits on global grants
		// alone, so a scoped revoke has nothing to close.
		if (result.scope_id === null) {
			queue_connection_close(ctx, connection_closer, {
				kind: 'role',
				account_id: target_account_id,
				role: result.role
			});
		}

		await audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_revoke',
			target_account_id,
			target_actor_id,
			metadata: {
				role: result.role,
				role_grant_id: result.id,
				scope_id: result.scope_id,
				reason: input.reason ?? undefined
			}
		});
		// Supersede cascade — one row per offer the revoke ended.
		await emit_supersede_audits(
			ctx,
			audit,
			result.superseded_offers,
			'role_grant_revoked',
			result.id
		);

		queue_offer_notification(
			ctx,
			target_account_id,
			build_role_grant_revoked_notification({
				role_grant_id: result.id,
				role: result.role,
				scope_kind: result.scope_kind,
				scope_id: result.scope_id,
				reason: input.reason ?? null
			})
		);
		// Both parties of each superseded offer: the revokee is the recipient of
		// its incoming siblings and the grantor of its outgoing offers, and the
		// other party of each is told as well.
		const revoked_grant: SupersedeCause = { kind: 'id', id: result.id };
		queue_supersede_notifications(ctx, result.superseded_offers, 'role_grant_revoked', {
			grantor: revoked_grant,
			recipient: revoked_grant
		});

		return { ok: true, revoked: true };
	};

	// The immediate admin-only conferral path — the consent-free sibling of
	// `role_grant_offer_create`. Gated at the dispatcher on a **global** admin
	// (`roles: ['admin']`) and re-checked here, it re-checks admin-grantability
	// (so keeper / CLI-only roles can't be web-assigned), refuses a scoped
	// builtin role, runs the consumer's `authorize` callback, locks both
	// parties' account rows and refuses either one removed, resolves the
	// target actor, writes the idempotent grant with
	// the input's `(scope_kind, scope_id)` pair, and emits a `role_grant_create`
	// audit row — the same event the offer-accept and self-service paths emit.
	// No WS notification in v1 (the grantee picks the capability up on its next
	// authenticated request).
	const assign_handler = async (
		input: RoleGrantAssignInput,
		ctx: ActionActorContext
	): Promise<RoleGrantAssignOutput> => {
		const auth = ctx.auth;

		// Defense in depth behind the dispatcher's role gate: conferring roles is
		// global-admin authority. A scoped `admin` must never reach the write, or
		// it could assign itself a global `admin`.
		if (!has_scoped_role(auth, ROLE_ADMIN, null)) {
			throw jsonrpc_errors.forbidden('forbidden', { reason: ERROR_INSUFFICIENT_PERMISSIONS });
		}

		// Admin-grant-path gate — the same registry check the offer/revoke gates
		// use; keeper / daemon-scoped roles stay CLI-only. A builtin role asked
		// for with a scope is refused the same way, with its own reason: builtin
		// roles are global-only. Denial is forensic-audited (`role_grant_id`
		// omitted — no grant was created).
		const admin_grantable = role_has_grant_path(role_specs, input.role, GRANT_PATH_ADMIN);
		const builtin_scoped = is_scoped_builtin(input.role, input.scope_id);
		const emit_assign_failure_audit = async (): Promise<void> => {
			await audit.emit_role_grant_target(ctx, auth, {
				event_type: 'role_grant_create',
				outcome: 'failure',
				target_account_id: input.to_account_id,
				target_actor_id: input.to_actor_id ?? null,
				metadata: {
					role: input.role,
					scope_kind: input.scope_kind ?? null,
					scope_id: input.scope_id ?? null
				}
			});
		};
		if (builtin_scoped || !admin_grantable) {
			await emit_assign_failure_audit();
			if (builtin_scoped && admin_grantable) throw builtin_scoped_error();
			throw jsonrpc_errors.forbidden('role not web-grantable', {
				reason: ERROR_ROLE_NOT_WEB_GRANTABLE
			});
		}

		// The consumer's offer policy binds the immediate path too: assign is an
		// offer the grantee doesn't get to decline, so a grant the `authorize`
		// callback would refuse as an offer (a scope that doesn't exist, a role
		// that must be scoped) is refused here, with the offer path's reason. A
		// scoped grant takes the scope lock first, as offer-create does, so the
		// callback reads the scope after any teardown that committed first, and a
		// teardown still to come waits for this grant and then revokes it.
		if (input.scope_id != null) await query_scope_lock_shared(ctx, input.scope_id);
		const authorized = await authorize(
			auth,
			{
				to_account_id: input.to_account_id,
				role: input.role,
				scope_kind: input.scope_kind ?? null,
				scope_id: input.scope_id ?? null
			},
			{ log },
			ctx
		);
		if (!authorized) {
			await emit_assign_failure_audit();
			throw jsonrpc_errors.forbidden('not authorized to grant this role', {
				reason: ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED
			});
		}

		// Both parties' account rows, locked in one statement in id order — the
		// lock offer-create takes (`query_role_grant_offer_create`), at its
		// position after every authority gate, so a caller refused the conferral
		// learns nothing of the recipient. The credential was read before this
		// transaction and nothing held the recipient: a delete or a purge of
		// either, committed since, is waited for and seen, and one still to come
		// waits for the grant to commit — so no grant lands on a tombstone (an
		// undelete would bring it back) or meets a purged actor's foreign key.
		// Judged recipient first, then the caller, as offer-create judges them.
		const live = await query_account_lock_live_many(ctx, [input.to_account_id, auth.account.id]);
		// The recipient: a live account with an active actor (the named one, when
		// an actor is named). A missing or removed recipient 404-masks.
		const actors = live.has(input.to_account_id)
			? await query_active_actors_by_account(ctx, input.to_account_id)
			: [];
		if (
			input.to_actor_id != null
				? !actors.some((a) => a.id === input.to_actor_id)
				: actors.length === 0
		) {
			throw recipient_not_found_error(input.to_actor_id);
		}
		// The caller: a live actor of a live account. One removed since its
		// credential was read is refused as the dead credential it now is, as
		// offer-create refuses its grantor, with no audit row from an account
		// that is gone.
		if (
			!live.has(auth.account.id) ||
			!(await query_active_actors_by_account(ctx, auth.account.id)).some(
				(a) => a.id === auth.actor.id
			)
		) {
			throw jsonrpc_errors.unauthenticated('unauthenticated', {
				reason: ERROR_AUTHENTICATION_REQUIRED
			});
		}

		// The grant's target actor: the named one, else the account's sole active
		// actor (a multi-actor account must name one).
		let target_actor_id: Uuid;
		if (input.to_actor_id != null) {
			target_actor_id = input.to_actor_id;
		} else if (actors.length === 1) {
			target_actor_id = actors[0]!.id;
		} else {
			throw jsonrpc_errors.invalid_params('to_actor_id is required for a multi-actor account');
		}

		// Idempotent write — re-assigning an already-held grant returns the
		// existing row. `scope_kind` + `scope_id` land as the pair the input
		// carried. `granted_by` is the assigning admin.
		const grant = await query_create_role_grant(ctx, {
			actor_id: target_actor_id,
			role: input.role,
			scope_kind: input.scope_kind ?? null,
			scope_id: input.scope_id ?? null,
			granted_by: auth.actor.id
		});

		await audit.emit_role_grant_target(ctx, auth, {
			event_type: 'role_grant_create',
			target_account_id: input.to_account_id,
			target_actor_id,
			metadata: {
				role: grant.role,
				role_grant_id: grant.id,
				scope_kind: input.scope_kind ?? null,
				scope_id: grant.scope_id
			}
		});

		return { ok: true, role_grant_id: grant.id };
	};

	return [
		rpc_action(role_grant_offer_create_action_spec, create_handler),
		rpc_action(role_grant_offer_accept_action_spec, accept_handler),
		rpc_action(role_grant_offer_decline_action_spec, decline_handler),
		rpc_action(role_grant_offer_retract_action_spec, retract_handler),
		rpc_action(role_grant_offer_list_action_spec, list_handler),
		rpc_action(role_grant_offer_history_action_spec, history_handler),
		rpc_action(role_grant_revoke_action_spec, revoke_handler),
		rpc_action(role_grant_assign_action_spec, assign_handler)
	];
};
