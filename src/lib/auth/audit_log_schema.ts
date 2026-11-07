/**
 * Audit log types and client-safe `@fuzdev/fuz_schema` schemas: the
 * event-type and outcome vocabularies, the builtin metadata schemas, and the
 * wire rows.
 *
 * Records auth mutations (login, logout, grant, revoke, etc.) for
 * security monitoring and operational visibility.
 *
 * Table DDL and indexes live in `auth/audit_log_ddl.ts`.
 *
 * @module
 */

import { meta } from '@fuzdev/fuz_schema/meta.ts';
import {
	boolean,
	format_issue,
	literal,
	loose_object,
	message,
	nullable,
	number,
	object,
	one_of,
	optional,
	parse,
	pipe,
	record,
	regex,
	safe_integer,
	string,
	unknown,
	type AnySchema,
	type Infer
} from '@fuzdev/fuz_schema/schema.ts';

import { bounded_string, Email, Timestamp, Uuid } from '../primitive_schemas.ts';
import { assert_validation_schema } from '../schema_issues.ts';
import { AuthSessionJson, SessionId } from './account_schema.ts';
import { ApiTokenId } from './api_token.ts';
import { BUILTIN_CREDENTIAL_TYPES } from './credential_type_schema.ts';
import { NAME_LENGTH_MAX } from './name_schema.ts';

/**
 * Defense-in-depth audit field — records the credential channel
 * (`session` / `api_token` / `daemon_token`) the request arrived on.
 * Present on events whose specs declare `credential_types: ['session']`
 * so forensics survive a future loosening or bypass of the spec gate.
 * See `docs/security.md` §Credential-channel gating.
 */
const credential_type_meta = meta(optional(one_of(BUILTIN_CREDENTIAL_TYPES)), {
	description:
		'Credential channel the request arrived on. Defense in depth — the spec gate restricts to `session`, but the row preserves what actually authenticated the request in case the gate is loosened or bypassed in a future refactor.'
});

/**
 * All tracked auth event types. Frozen to convert accidental in-process
 * mutation (test cross-contamination, cast escapes) into loud TypeErrors.
 * Not a security boundary — in-process code has many other paths to subvert
 * audit logging.
 */
export const AUDIT_EVENT_TYPES = Object.freeze([
	'login',
	'logout',
	'bootstrap',
	'signup',
	'password_change',
	'session_revoke',
	'session_revoke_all',
	'token_create',
	'token_revoke',
	'token_revoke_all',
	'role_grant_create',
	'role_grant_revoke',
	'role_grant_offer_create',
	'role_grant_offer_accept',
	'role_grant_offer_decline',
	'role_grant_offer_retract',
	'role_grant_offer_expire',
	'role_grant_offer_supersede',
	'invite_create',
	'invite_delete',
	'account_delete',
	'account_purge',
	'account_undelete',
	'actor_delete',
	'actor_purge',
	'actor_undelete',
	'app_settings_update',
	'db_admin_row_delete'
] as const);

/** A builtin audit event type, one of `AUDIT_EVENT_TYPES`. */
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

/**
 * What a **successful** audit row invalidates — the axis the revocation
 * listener (`create_revocation_guard`) dispatches on.
 *
 * - `none` — the row invalidates no live connection.
 * - `session` — one session: the connections whose session-token hash equals
 *   the row's `metadata.session_id`.
 * - `token` — one API token: the connections whose `api_token.id` equals the
 *   row's `metadata.token_id`.
 * - `account` — every connection of `target_account_id ?? account_id`.
 * - `role` — the target account's connections gated on the row's
 *   `metadata.role`, when the revoked grant was global
 *   (`to_global_role_revocation`).
 *
 * The scope says what the row invalidated; the listener acts on every scope
 * alike, for every transport. On `role` that matters for the WebSocket too: per-message dispatch
 * re-authorizes each request against its own action, but a socket admitted by
 * a role gate also receives every server push its endpoint sends, which no
 * dispatch ever re-checks — so a socket that lost the gating role is closed,
 * like a stream.
 *
 * Twin of the Rust spine's `RevocationScope`.
 */
export type RevocationScope = 'none' | 'session' | 'token' | 'account' | 'role';

/**
 * The `RevocationScope` of every builtin audit event — declared once, the one
 * answer the revocation listener reads, and the twin of the Rust spine's table. Typed over `AuditEventType`, so a new event type does not compile
 * until it declares its scope here.
 *
 * A scope other than `none` marks an event whose success invalidates a live
 * connection's credential or access: `logout`, `password_change`,
 * `session_revoke_all`, `token_revoke_all`, `account_delete`, and
 * `account_purge` are account-wide, `session_revoke` and `token_revoke` name
 * the one credential they ended, and `role_grant_revoke` names the lost role.
 * Granting access revokes nothing, and neither does an event about a subject
 * other than a connection's identity.
 *
 * Twin of the `revocation_scope` column of the Rust spine's
 * `AUDIT_EVENT_SPECS`.
 */
export const audit_event_revocation_scopes: Readonly<Record<AuditEventType, RevocationScope>> =
	Object.freeze({
		login: 'none',
		logout: 'account',
		bootstrap: 'none',
		signup: 'none',
		password_change: 'account',
		session_revoke: 'session',
		session_revoke_all: 'account',
		token_create: 'none',
		token_revoke: 'token',
		token_revoke_all: 'account',
		role_grant_create: 'none',
		role_grant_revoke: 'role',
		role_grant_offer_create: 'none',
		role_grant_offer_accept: 'none',
		role_grant_offer_decline: 'none',
		role_grant_offer_retract: 'none',
		role_grant_offer_expire: 'none',
		role_grant_offer_supersede: 'none',
		invite_create: 'none',
		invite_delete: 'none',
		account_delete: 'account',
		account_purge: 'account',
		account_undelete: 'none',
		actor_delete: 'none',
		actor_purge: 'none',
		actor_undelete: 'none',
		app_settings_update: 'none',
		db_admin_row_delete: 'none'
	});

/**
 * The `RevocationScope` of an `audit_log.event_type` string.
 *
 * An event type with no builtin entry — a consumer's own event — resolves to
 * `none`: an event fuz_app has never heard of must not close connections. A
 * consumer whose own event revokes closes the connections from its handler,
 * with `queue_connection_close`.
 */
export const to_revocation_scope = (event_type: string): RevocationScope =>
	Object.hasOwn(audit_event_revocation_scopes, event_type)
		? audit_event_revocation_scopes[event_type as AuditEventType]
		: 'none';

/**
 * The account and role a successful `role`-scope row took away, when the
 * revoked grant was **global** — `null` otherwise.
 *
 * A role gate (`register_action_ws`'s `required_roles`, the audit stream's
 * `require_role`) admits on global grants only, so revoking a scoped grant
 * takes away nothing a gate admitted on and closes nothing. A row with no
 * `metadata.scope_id` reads as global: when unsure, closing is the safe side.
 * The target is `target_account_id ?? account_id`, as for the `account` scope.
 * The revocation guard reads it for every transport, so a socket and a
 * stream gated on one role close on the same rows.
 *
 * Twin of the role arm of the Rust spine's
 * `ConnectionCloseTarget::from_audit_event`.
 *
 * @param event - a row whose scope is `role` (the caller dispatched on it)
 * @returns the account and role to close on, or `null` when the row names no
 *   role or target, or revoked a scoped grant
 */
export const to_global_role_revocation = (
	event: AuditLogEvent
): { account_id: Uuid; role: string } | null => {
	const role = event.metadata?.role;
	if (typeof role !== 'string' || role.length === 0) return null;
	const scope_id = event.metadata?.scope_id;
	if (scope_id !== undefined && scope_id !== null) return null;
	const account_id = event.target_account_id ?? event.account_id;
	if (!account_id) return null;
	return { account_id, role };
};

/**
 * Letter start, then letters, digits, `_`, `.`, `/`, `-`. Accepts snake_case,
 * dotted, and namespaced consumer conventions; rejects empty strings, leading
 * separators, whitespace, and control characters. The audit event type's own
 * grammar, wider than the shared name grammar (`auth/name_schema.ts`), whose
 * length cap `AuditEventTypeName` takes.
 */
export const AUDIT_EVENT_TYPE_NAME_REGEX = /^[A-Za-z][A-Za-z0-9_./-]*$/;

/** The message of an audit event-type name past `NAME_LENGTH_MAX`. */
export const AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE = `must be at most ${NAME_LENGTH_MAX} characters`;

/** The message of an audit event-type name off `AUDIT_EVENT_TYPE_NAME_REGEX`. */
export const AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE =
	'must start with a letter; only letters, digits, _ . / - allowed';

/**
 * Valid audit event-type name strings: `AUDIT_EVENT_TYPE_NAME_REGEX`, at most
 * `NAME_LENGTH_MAX` UTF-16 code units. A string it refuses gets
 * `AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE` or
 * `AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE`, the length one alone for a string
 * both too long and off the grammar; a value that is no string, fuz_schema's
 * message. Twin of the Rust spine's `is_valid_audit_event_type_name`.
 */
export const AuditEventTypeName = pipe(
	bounded_string({ max: NAME_LENGTH_MAX, max_message: AUDIT_EVENT_TYPE_NAME_LENGTH_MESSAGE }),
	message(regex(AUDIT_EVENT_TYPE_NAME_REGEX), AUDIT_EVENT_TYPE_NAME_PATTERN_MESSAGE)
);
export type AuditEventTypeName = Infer<typeof AuditEventTypeName>;

/** Audit event outcome. */
export const AuditOutcome = one_of(['success', 'failure']);
export type AuditOutcome = Infer<typeof AuditOutcome>;

/**
 * Per-event-type metadata schemas, `@fuzdev/fuz_schema` `loose_object`s so
 * consumers can add fields while known ones are validated. The record is
 * frozen to catch mutation bugs at the key level (e.g. tests that try to swap
 * in a stub schema); freeze isn't a security boundary.
 */
export const audit_metadata_schemas = Object.freeze({
	login: nullable(
		loose_object({
			username: meta(string, { description: 'Username submitted with the login attempt.' })
		})
	),
	logout: literal(null),
	bootstrap: nullable(
		loose_object({
			error: meta(string, { description: 'Error message for a failed bootstrap attempt.' })
		})
	),
	signup: loose_object({
		username: meta(string, { description: 'Username submitted at signup.' }),
		invite_id: meta(optional(Uuid), {
			description:
				'Invite consumed by this signup. Set on success and on `signup_conflict` failure rows when an invite was matched at attempt time.'
		}),
		open_signup: meta(optional(boolean), {
			description:
				'True when the signup occurred via the `open_signup` setting (no invite required). Set on success rows under `open_signup` and on failure rows when the attempt was made under `open_signup`.'
		}),
		reason: meta(optional(string), {
			description:
				'Failure category: `no_match` (no unclaimed invite matched), `signup_conflict` (username/email already exists, raised by the DB unique constraint), `internal_error` (catch-all for non-classified tx failures — Argon2 fault, session create error, DB outage mid-tx). Set only on `outcome=failure`.'
		}),
		email: meta(optional(Email), {
			description:
				'Email submitted at signup — recorded on failure rows for forensic correlation. Omitted on success rows because the email is already tied to the resulting account.'
		})
	}),
	password_change: nullable(
		loose_object({
			sessions_revoked: meta(optional(number), {
				description:
					'Number of sessions revoked as a side effect of the password change. Present on `outcome=success`.'
			}),
			tokens_revoked: meta(optional(number), {
				description:
					'Number of API tokens revoked as a side effect of the password change. Present on `outcome=success`.'
			}),
			reason: meta(optional(literal('concurrent_change')), {
				description:
					'Failure category. `concurrent_change` indicates another password change committed first against the same starting hash (verify-write race loser). Absent for typed-wrong-password failures.'
			}),
			credential_type: credential_type_meta
		})
	),
	session_revoke: loose_object({
		session_id: meta(SessionId, {
			description: 'Blake3 hash identifying the revoked session row.'
		}),
		credential_type: credential_type_meta
	}),
	session_revoke_all: loose_object({
		// Omitted on `outcome='failure'` (no revocation attempted — e.g. target
		// account not found); `reason` carries the failure category, and
		// `attempted_account_id` preserves the probed id (the `target_account_id`
		// column is null in that case because it's a FK to `account`).
		count: meta(optional(number), {
			description:
				'Number of sessions revoked. Omitted on `outcome=failure` because no revocation was attempted.'
		}),
		reason: meta(optional(string), {
			description: 'Failure category. Set only on `outcome=failure`.'
		}),
		attempted_account_id: meta(optional(Uuid), {
			description:
				'Probed account id when the target lookup missed (FK constraint forces `target_account_id` to null).'
		}),
		credential_type: credential_type_meta
	}),
	token_create: loose_object({
		token_id: meta(ApiTokenId, { description: 'Public id of the created API token (`tok_…`).' }),
		name: meta(string, { description: 'Operator-supplied label for the token.' }),
		credential_type: credential_type_meta
	}),
	token_revoke: loose_object({
		token_id: meta(ApiTokenId, { description: 'Public id of the revoked API token (`tok_…`).' }),
		credential_type: credential_type_meta
	}),
	token_revoke_all: loose_object({
		// Same shape as `session_revoke_all` for failures.
		count: meta(optional(number), {
			description:
				'Number of tokens revoked. Omitted on `outcome=failure` because no revocation was attempted.'
		}),
		reason: meta(optional(string), {
			description: 'Failure category. Set only on `outcome=failure`.'
		}),
		attempted_account_id: meta(optional(Uuid), {
			description:
				'Probed account id when the target lookup missed (FK constraint forces `target_account_id` to null).'
		})
	}),
	// `role_grant_id` is optional on `role_grant_create` because failed grants
	// (e.g. admin-grant-path denied) never produce a role_grant row.
	// `self_service: true` is set by the self-service role toggle in
	// `self_service_role_actions.ts` — declared explicitly rather than
	// riding on `loose_object` permissiveness so the field is part of
	// the documented schema surface.
	role_grant_create: loose_object({
		role: meta(string, { description: 'Role being granted.' }),
		role_grant_id: meta(optional(Uuid), {
			description:
				'Id of the resulting role_grant row. Omitted when the grant failed (e.g. admin-grant-path denial).'
		}),
		scope_kind: meta(optional(nullable(string)), {
			description:
				'Kind tag paired with `scope_id` on a `role_grant_assign` row; null for a global grant.'
		}),
		scope_id: meta(optional(nullable(Uuid)), {
			description: 'Scope of the granted role_grant; null for global role_grants.'
		}),
		source_offer_id: meta(optional(Uuid), {
			description: 'Offer this grant resolved, when the grant originated from an accepted offer.'
		}),
		self_service: meta(optional(boolean), {
			description: 'True when the grant came from the self-service role toggle.'
		})
	}),
	role_grant_revoke: loose_object({
		role: meta(string, { description: 'Role being revoked.' }),
		role_grant_id: meta(Uuid, { description: 'Id of the revoked role_grant row.' }),
		scope_id: meta(optional(nullable(Uuid)), {
			description: 'Scope of the revoked role_grant; null for global role_grants.'
		}),
		reason: meta(optional(string), {
			description: 'Optional admin-supplied or self-service reason text.'
		}),
		self_service: meta(optional(boolean), {
			description: 'True when the revoke came from the self-service role toggle.'
		})
	}),
	// `offer_id` is optional because failed creates (e.g. admin-grant-path
	// denied, `authorize` callback denied) never produce an offer row.
	role_grant_offer_create: loose_object({
		offer_id: meta(optional(Uuid), {
			description: 'Id of the created offer row. Omitted when the create failed before insert.'
		}),
		role: meta(string, { description: 'Role being offered.' }),
		scope_id: meta(optional(nullable(Uuid)), {
			description: 'Scope of the offered role; null for global offers.'
		}),
		to_account_id: meta(Uuid, { description: 'Account the offer is directed to.' })
	}),
	// `role_grant_create` is emitted alongside on accept — two events per accept by
	// design: offer-lifecycle audit + role-grant-lifecycle audit. A refused
	// accept (a builtin-role offer that must not mint) is an `outcome=failure`
	// row with no `role_grant_id` (nothing was minted) and the wire `reason`.
	role_grant_offer_accept: loose_object({
		offer_id: meta(Uuid, { description: 'Id of the accepted (or refused) offer.' }),
		role_grant_id: meta(optional(Uuid), {
			description:
				'Id of the resulting role_grant row. Omitted on `outcome=failure` because no grant was minted.'
		}),
		role: meta(string, { description: 'Role granted by the offer.' }),
		scope_id: meta(optional(nullable(Uuid)), {
			description: 'Scope of the resulting role_grant; null for global role_grants.'
		}),
		reason: meta(optional(string), {
			description: 'Wire error reason of a refused accept. Set only on `outcome=failure`.'
		})
	}),
	role_grant_offer_decline: loose_object({
		offer_id: meta(Uuid, { description: 'Id of the declined offer.' }),
		role: meta(string, { description: 'Role that was offered.' }),
		scope_id: meta(optional(nullable(Uuid)), {
			description: 'Scope of the offered role; null for global offers.'
		}),
		reason: meta(optional(string), {
			description: 'Optional decline reason text from the recipient.'
		})
	}),
	role_grant_offer_retract: loose_object({
		offer_id: meta(Uuid, { description: 'Id of the retracted offer.' }),
		role: meta(string, { description: 'Role that was offered.' }),
		scope_id: meta(optional(nullable(Uuid)), {
			description: 'Scope of the offered role; null for global offers.'
		})
	}),
	role_grant_offer_expire: loose_object({
		offer_id: meta(Uuid, { description: 'Id of the expired offer.' }),
		role: meta(string, { description: 'Role that was offered.' }),
		scope_id: meta(optional(nullable(Uuid)), {
			description: 'Scope of the offered role; null for global offers.'
		})
	}),
	// Emitted when an offer is obsoleted by an external event. `reason`
	// distinguishes the trigger; `cause_id` points to the accepted offer
	// (for `sibling_accepted`), the revoked role_grant (for `role_grant_revoked`
	// — the recipient's grant of the offered role, or a grant of the grantor's),
	// the destroyed parent scope row (for `scope_destroyed`), or the grantor's
	// removed account (for `account_deleted`).
	role_grant_offer_supersede: loose_object({
		offer_id: meta(Uuid, { description: 'Id of the superseded offer.' }),
		role: meta(string, { description: 'Role that was offered.' }),
		scope_id: meta(optional(nullable(Uuid)), {
			description: 'Scope of the offered role; null for global offers.'
		}),
		reason: meta(
			one_of(['sibling_accepted', 'role_grant_revoked', 'scope_destroyed', 'account_deleted']),
			{
				description:
					"Trigger that obsoleted the offer: a sibling offer was accepted, the resulting role_grant or one of the grantor's was revoked, the parent scope row was destroyed, or the grantor's account was deleted or purged."
			}
		),
		cause_id: meta(Uuid, {
			description:
				"Row that caused the supersede: accepted offer (`sibling_accepted`), revoked role_grant (`role_grant_revoked`), destroyed parent scope row (`scope_destroyed`), or the grantor's account (`account_deleted`)."
		})
	}),
	invite_create: loose_object({
		invite_id: meta(Uuid, { description: 'Id of the created invite.' }),
		email: meta(nullable(string), { description: 'Invited email address; null when not set.' }),
		username: meta(nullable(string), { description: 'Invited username; null when not set.' })
	}),
	invite_delete: loose_object({
		invite_id: meta(Uuid, { description: 'Id of the deleted invite.' })
	}),
	// Account/actor deletion snapshots identity into metadata so the
	// identity behind a now-orphaned audit id survives a purge (the
	// `audit_log` id columns carry no FK). `delete` = soft (reversible
	// tombstone), `purge` = hard (irreversible cascading removal). Known
	// fields are optional so the same schema validates the success
	// snapshot and the not-found failure shape (`reason` /
	// `attempted_account_id`). See `auth/CLAUDE.md` §Account/actor deletion
	// (delete = soft, purge = hard).
	account_delete: loose_object({
		username: meta(optional(string), { description: 'Username at soft-delete time.' }),
		email: meta(optional(nullable(string)), {
			description: 'Email at soft-delete time; null when unset.'
		}),
		reason: meta(optional(string), {
			description: 'Failure category. Set only on `outcome=failure`.'
		}),
		attempted_account_id: meta(optional(Uuid), {
			description: 'Probed account id when the target was missing (`outcome=failure`).'
		})
	}),
	account_purge: loose_object({
		username: meta(optional(string), { description: 'Username at purge time.' }),
		email: meta(optional(nullable(string)), {
			description: 'Email at purge time; null when unset.'
		}),
		reason: meta(optional(string), {
			description: 'Failure category. Set only on `outcome=failure`.'
		}),
		attempted_account_id: meta(optional(Uuid), {
			description: 'Probed account id when the target was missing (`outcome=failure`).'
		})
	}),
	// `account_undelete` / `actor_undelete` are the reactivation events
	// (clearing the soft-delete tombstone). Same identity-snapshot shape as
	// the delete events so reviewers see who was reactivated; `reason` /
	// `attempted_account_id` carry the not-found failure shape. Admin-only —
	// the self path is unreachable (a tombstoned account can't authenticate).
	account_undelete: loose_object({
		username: meta(optional(string), { description: 'Username at reactivation time.' }),
		email: meta(optional(nullable(string)), {
			description: 'Email at reactivation time; null when unset.'
		}),
		reason: meta(optional(string), {
			description: 'Failure category. Set only on `outcome=failure`.'
		}),
		attempted_account_id: meta(optional(Uuid), {
			description: 'Probed account id when the target was missing/not-deleted (`outcome=failure`).'
		})
	}),
	actor_delete: loose_object({
		name: meta(optional(string), { description: 'Actor display name at soft-delete time.' })
	}),
	actor_purge: loose_object({
		name: meta(optional(string), { description: 'Actor display name at purge time.' })
	}),
	actor_undelete: loose_object({
		name: meta(optional(string), { description: 'Actor display name at reactivation time.' })
	}),
	app_settings_update: loose_object({
		setting: meta(string, { description: 'Name of the setting that changed.' }),
		old_value: meta(unknown, { description: 'Setting value before the update.' }),
		new_value: meta(unknown, { description: 'Setting value after the update.' })
	}),
	// Row deleted through the generic db-admin table browser
	// (`http/db_routes.ts` / the Rust spine's `fuz_db_admin`). Account-grain
	// attribution (`account_id`, no `actor_id`) — the browser's gate is
	// account-grain by construction. Emitted only on a successful delete;
	// post-composite-refusal the delete is provably single-row, so no count.
	db_admin_row_delete: loose_object({
		table: meta(string, { description: 'Table the row was deleted from.' }),
		pk_column: meta(string, {
			description: 'Single primary-key column the `DELETE` filtered on.'
		}),
		id: meta(string, {
			description:
				"Primary-key value of the deleted row, as the row's canonical `::text` rendering."
		})
	})
}) satisfies Record<AuditEventType, AnySchema>;

/** Mapped type of metadata shapes per event type, inferred from the schemas. */
export type AuditMetadataMap = {
	[K in AuditEventType]: Infer<(typeof audit_metadata_schemas)[K]>;
};

/** Audit log row from the database. See `AuditLogEventJson` for `event_type` widening rationale. */
export interface AuditLogEvent {
	id: Uuid;
	seq: number;
	event_type: AuditEventTypeName;
	outcome: AuditOutcome;
	/**
	 * Operator (the actor that initiated the event) — populated when the
	 * request resolved an acting actor.
	 *
	 * Resolution is driven per-request by the route-spec wrapper / RPC
	 * dispatcher; a route gets an acting actor when its input schema
	 * declares `acting?: ActingActor` or its auth requires role_grants
	 * (`role` / `keeper`). Account-grain operations declare neither,
	 * so no actor is resolved and `actor_id` is null: login (also
	 * pre-credential), logout, signup, bootstrap, password_change,
	 * session/token revoke, app_settings_update, invite events.
	 * Role grant events, admin actions, and actor-targeted offers
	 * populate this with the initiator's actor.
	 */
	actor_id: Uuid | null;
	account_id: Uuid | null;
	target_account_id: Uuid | null;
	/**
	 * Actor-grain target — populated when the event subject is bound to
	 * a specific actor.
	 *
	 * Concretely:
	 * - Always populated: `role_grant_revoke` and `role_grant_create`
	 *   (admin direct-grant, self-service toggle, and in-tx
	 *   `role_grant_offer_accept` all populate both target columns — the
	 *   role_grant's grantee is the actor-grain subject regardless of who
	 *   initiated the grant), `role_grant_offer_accept` on accept (the
	 *   accept binds the actor deterministically), `role_grant_offer_decline`
	 *   (the grantor actor — decline is *to* the offering actor).
	 * - Conditionally populated: offer-shape events
	 *   (`role_grant_offer_create`, `_expire`, `_retract`, `_supersede`)
	 *   carry the actor when the offer was actor-targeted at create time
	 *   (`role_grant_offer.to_actor_id` set), null when the offer was
	 *   account-grain (any actor on `to_account_id` may accept).
	 * - Not populated: admin actions, account-shape events (login,
	 *   logout, signup, bootstrap, password_change, session/token
	 *   revoke, app_settings_update, invite events) — subject is the
	 *   account or no specific resource, not an actor-bound role_grant.
	 * - Not populated: events whose principal isn't an actor-bound
	 *   resource (e.g. consumer events that name a non-actor scope in
	 *   metadata).
	 *
	 * Multi-actor invariants this column relies on: when both
	 * `target_actor_id` and `target_account_id` are populated they refer
	 * to the same account (`actor.account_id`-derivable). The invariant
	 * holds uniformly across every populated event including decline
	 * (the grantor's account is joined into the decline RETURNING) and
	 * the supersede cascade (the recipient account is known on
	 * `role_grant_offer.to_account_id`). `target_account_id` stays the
	 * SSE/WS socket-close key because sessions remain account-grain
	 * after multi-actor lands.
	 */
	target_actor_id: Uuid | null;
	ip: string | null;
	created_at: string;
	metadata: Record<string, unknown> | null;
}

/** Input for creating an audit log entry. */
export interface AuditLogInput<T extends string = AuditEventType> {
	event_type: T;
	outcome?: AuditOutcome;
	actor_id?: Uuid | null;
	account_id?: Uuid | null;
	target_account_id?: Uuid | null;
	target_actor_id?: Uuid | null;
	ip?: string | null;
	/**
	 * Per-event-type metadata. Builtin `T` narrows to `AuditMetadataMap[T]`;
	 * consumer strings widen to a generic record (validation runs against
	 * `AuditLogConfig.metadata_schemas` at insert time).
	 */
	metadata?: T extends AuditEventType
		? (AuditMetadataMap[T] & Record<string, unknown>) | null
		: Record<string, unknown> | null;
}

/**
 * Configuration bundle for audit-log event types and metadata schemas.
 *
 * Lets consumers extend the closed `AUDIT_EVENT_TYPES` enum with their own
 * event strings (and `@fuzdev/fuz_schema` metadata schemas) without
 * forking. Pass to
 * `create_audit_emitter` (or `query_audit_log` for in-tx call sites) as the
 * optional `config` argument; both default to `builtin_audit_log_config`.
 *
 * The DB column is `TEXT NOT NULL` and never enforced an enum, so consumer
 * event types round-trip through `query_audit_log_list` and SSE identically
 * to builtins.
 *
 * Constructed configs are deep-frozen (wrapper, `event_types`,
 * `metadata_schemas`) to catch accidental mutation bugs early. Not a
 * security boundary against in-process code, which can subvert audit
 * logging through other paths.
 */
export interface AuditLogConfig {
	/** All recognized event-type strings — fuz_app builtins plus consumer extras. */
	readonly event_types: ReadonlyArray<string>;
	/**
	 * Per-event-type metadata schemas. Missing entries skip metadata
	 * validation for that type (row still written; metadata stored as raw JSONB).
	 */
	readonly metadata_schemas: Readonly<Record<string, AnySchema>>;
}

/** Builtin fuz_app audit-log config — every existing event type and its metadata schema. */
export const builtin_audit_log_config: AuditLogConfig = Object.freeze({
	event_types: AUDIT_EVENT_TYPES,
	metadata_schemas: audit_metadata_schemas
});

/** Options for `create_audit_log_config`. */
export interface CreateAuditLogConfigOptions {
	/**
	 * Extra event types keyed by event-type string. Value is a metadata
	 * schema (`@fuzdev/fuz_schema`), or `null` to register the type
	 * without validation (row still written, metadata stored as raw JSONB).
	 *
	 * Collisions with builtin event-type strings throw at construction, and so
	 * does a value that is neither `null` nor a schema.
	 * Schemas are run via `parse` at insert time; mismatches log + count
	 * but never throw (fail-open — see the drift counters in `auth/audit_log_queries.ts`).
	 */
	extra_events?: Readonly<Record<string, AnySchema | null>>;
}

/**
 * Build an `AuditLogConfig` by merging fuz_app builtins with consumer extras.
 *
 * Throws when an `extra_events` key collides with a builtin event type, or
 * fails `AuditEventTypeName` format validation.
 *
 * Call once at startup; pass the result into the consumer's `audit_factory`
 * body — typically `({db, log}) => create_audit_emitter({db, log,
 * audit_log_config, ...})` — so it gets captured inside the bound
 * `AppDeps.audit` emitter. Builtin handlers omit the `audit_log_config`
 * slot and pick up `builtin_audit_log_config`.
 *
 * @throws Error when an `extra_events` key collides with a builtin event type or fails `AuditEventTypeName` format validation, or its value is neither `null` nor a schema
 */
export const create_audit_log_config = (options?: CreateAuditLogConfigOptions): AuditLogConfig => {
	const extras = options?.extra_events;
	if (!extras) return builtin_audit_log_config;
	const extra_entries = Object.entries(extras);
	if (extra_entries.length === 0) return builtin_audit_log_config;
	const builtin_set: ReadonlySet<string> = new Set(AUDIT_EVENT_TYPES);
	const extra_keys: Array<string> = [];
	const metadata_schemas: Record<string, AnySchema> = { ...audit_metadata_schemas };
	for (const [t, schema] of extra_entries) {
		if (builtin_set.has(t)) {
			throw new Error(
				`extra_events key "${
					t
				}" collides with a builtin event type — pick a distinct string (e.g. "app_${t}")`
			);
		}
		const name_check = parse(AuditEventTypeName, t);
		if (!name_check.ok) {
			throw new Error(
				`extra_events key "${t}" has invalid format: ${format_issue(name_check.issues[0]!)}`
			);
		}
		extra_keys.push(t);
		if (schema !== null) {
			assert_validation_schema(schema, `extra_events key "${t}"`);
			metadata_schemas[t] = schema;
		}
	}
	return Object.freeze({
		event_types: Object.freeze([...AUDIT_EVENT_TYPES, ...extra_keys]),
		metadata_schemas: Object.freeze(metadata_schemas)
	});
};

/** Default page size for audit log listings. */
export const AUDIT_LOG_DEFAULT_LIMIT = 50;

/** Options for listing audit log entries. */
export interface AuditLogListOptions {
	limit?: number;
	offset?: number;
	/**
	 * Event-type filter. Accepts any string — builtins or consumer-registered
	 * via `create_audit_log_config({extra_events})`. The DB column is
	 * `TEXT NOT NULL` with no CHECK, so unknown strings simply match nothing.
	 */
	event_type?: string;
	event_type_in?: Array<string>;
	account_id?: Uuid;
	outcome?: AuditOutcome;
	/**
	 * When set, only return events with `seq` greater than this value. Enables
	 * SSE reconnection gap fill. `seq` is assigned at INSERT; an in-transaction
	 * row commits later, so a row can become visible after a higher `seq` — a
	 * gap fill can miss one that commits while the stream is down.
	 */
	since_seq?: number;
}

/**
 * Client-safe audit log event, a `@fuzdev/fuz_schema` schema.
 *
 * `event_type` is `AuditEventTypeName` (regex-validated string, at most
 * `NAME_LENGTH_MAX` characters) — matches
 * the `AuditLogEvent` row and the DB's `TEXT NOT NULL` column. Consumer
 * types registered via `create_audit_log_config({extra_events})` round-trip
 * through queries, `on_audit_event` callbacks, and JSON-RPC responses
 * identically to builtins. `AuditLogInput<T>` stays parameterized on the
 * write side so `AuditMetadataMap` narrows metadata per event type. `seq` is
 * an integer within `Number.MAX_SAFE_INTEGER`, the integers a JSON number
 * holds exactly.
 */
export const AuditLogEventJson = object({
	id: Uuid,
	seq: pipe(number, safe_integer),
	event_type: AuditEventTypeName,
	outcome: AuditOutcome,
	actor_id: nullable(Uuid),
	account_id: nullable(Uuid),
	target_account_id: nullable(Uuid),
	target_actor_id: nullable(Uuid),
	ip: nullable(string),
	created_at: Timestamp,
	metadata: nullable(record(unknown))
});
export type AuditLogEventJson = Infer<typeof AuditLogEventJson>;

/** Audit log events with resolved usernames, a `@fuzdev/fuz_schema` schema. */
export const AuditLogEventWithUsernamesJson = object({
	...AuditLogEventJson.def,
	username: nullable(string),
	target_username: nullable(string)
});
export type AuditLogEventWithUsernamesJson = Infer<typeof AuditLogEventWithUsernamesJson>;

/** Role_grant history events with resolved usernames, a `@fuzdev/fuz_schema` schema. */
export const RoleGrantHistoryEventJson = object({
	...AuditLogEventJson.def,
	username: nullable(string),
	target_username: nullable(string)
});
export type RoleGrantHistoryEventJson = Infer<typeof RoleGrantHistoryEventJson>;

const { is_current: _, ...admin_session_entries } = AuthSessionJson.def;

/**
 * Admin session listing (session + username, without `is_current`), a
 * `@fuzdev/fuz_schema` schema. `username` is a plain string.
 */
export const AdminSessionJson = object({
	...admin_session_entries,
	username: string
});
export type AdminSessionJson = Infer<typeof AdminSessionJson>;
