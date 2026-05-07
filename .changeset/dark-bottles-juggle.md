---
'@fuzdev/fuz_app': minor
---

audit_log: `target_actor_id` column + actor-targetable offers + dispatcher-resolved acting actor

Authentication is account-only; authorization (acting actor + permits) is per-request, resolved by the route-spec wrapper / RPC dispatcher after input validation. Routes opt in by declaring `acting?: ActingActor` on their input schema or using permit-requiring auth (`role` / `keeper`); account-grain routes (logout, password_change, account_verify, etc.) skip resolution and run with `RequestContext.actor: null`. Multi-actor accounts can hit account-grain routes without picking a persona.

Schema

- `audit_log.target_actor_id UUID REFERENCES actor(id)` + index. Populated when the event subject is actor-bound; see `AuditLogEvent.target_actor_id` doc for the populated/null list.
- `permit_offer.to_actor_id UUID REFERENCES actor(id)` + partial index. When set, only that actor can accept and offer-shape audit envelopes inherit it. When null, account-grain (any actor on `to_account_id`).
- `auth_session` and `api_token` carry no actor binding.

Breaking

- `RequestContext.actor` widens to `Actor | null`; `permits` is `[]` on account-grain contexts. `has_role` / `has_scoped_role` / `has_any_scoped_role` already null-tolerant; account-grain contexts return `false` for the same reason as null ctx.
- Authentication middleware (`create_request_context_middleware`, `bearer_auth`, `daemon_token_middleware`) no longer loads actor / permits or sets `REQUEST_CONTEXT_KEY`. They set `c.var.account_id` + `CREDENTIAL_TYPE_KEY` only. Authorization moves to the per-route layer.
- `apply_route_specs` gains an authorization phase that runs **before** input validation. Per-route order is now params → query → pre-validation auth (401) → authorization phase → post-authorization auth (403) → input validation → handler. The authorization phase reads `acting` from raw query (GET) or pre-parsed body (POST/PUT/...) — Hono caches the parsed body so input validation does not re-parse. Routes that need an acting actor either declare `acting?: ActingActor` on their input schema or use `auth.type: 'role' | 'keeper'`. Resolution failures return 400 `ERROR_ACTOR_REQUIRED` (with `available[]`) or `ERROR_ACTOR_NOT_ON_ACCOUNT`. **Behavior change**: role-gated REST routes with required input previously returned 400 `invalid_request_body` for unauthenticated callers; they now return 401 `unauthenticated` because the auth gate fires before body parsing. **Behavior change**: an authenticated multi-actor caller hitting an `acting`-declaring route with malformed JSON previously got 400 `invalid_json_body`; the authorization phase now runs first and treats the unreadable body as `acting: undefined`, so multi-actor accounts get 400 `actor_required` instead. Single-actor accounts still receive `invalid_json_body` because resolution succeeds with the unique actor and input validation surfaces the parse error.
- RPC dispatcher (`create_rpc_endpoint`) uses the same auth-before-validation order so HTTP RPC and REST surface failures in the same priority.
- Every fuz_app RPC action input that uses the caller's acting actor now declares `acting?: ActingActor`: every spec in `admin_action_specs.ts`, `permit_offer_action_specs.ts`, `account_action_specs.ts`, `self_service_role_action_specs.ts` (except `account_verify`, which is account-grain).
- `account_verify` (REST + RPC), `/logout`, `/password` are account-grain — handlers no longer read `ctx.actor`. Audit emits drop `actor_id` (account-grain operation).
- `query_accept_offer` requires `actor_id` (was picking silently under multi-actor).
- `query_accept_offer` race-loser branch throws `PermitOfferAlreadyTerminalError` on actor mismatch (was returning the winner's permit row).
- `permit_offer_create` input: optional `to_actor_id?: Uuid`. New errors `permit_offer_actor_mismatch`, `permit_offer_actor_account_mismatch`.
- `RevokeForScopeResult.revoked` carries both `actor_id` and `account_id`.
- `permit_offer_accept` / `_decline` / `_supersede` audit envelopes populate both target columns (were partially or fully null).
- Self-service `permit_grant` / `permit_revoke` audit emits populate both target columns (was account-only).
- `query_first_actor_by_account` removed; replaced with `query_actors_by_account` (returns `Array<Actor>`) and `query_actor_by_id`. Login is account-only.
- `testing/middleware.ts`: `mock_find_by_account` → `mock_find_actor_by_id` + new `mock_find_actors_by_account`.

Additions

- `ActingActor = Uuid.optional()` exported from `account_schema.ts` — shared Zod schema for the `acting` field on RPC action inputs and route bodies/queries. Declaring it on an input is the duck-typed signal that triggers the authorization phase.
- `resolve_acting_actor(deps, account_id, acting_actor_id)` in `request_context.ts` — uniform resolution. Discriminated `{ok}` / `actor_required` / `actor_not_on_account` / `no_actors`.
- `ERROR_ACTOR_REQUIRED`, `ERROR_ACTOR_NOT_ON_ACCOUNT` error codes (declared in `error_schemas.ts`; emitted by the dispatcher's authorization phase).
- `emit_permit_target_event(ctx, auth, deps, {...})` — permit-shape audit-emit helper.
- Typed RPC client codegen surfaces `acting?: ActingActor` on every method that declares it.

Consumer migration

- Audit consumer routes / RPC actions: any handler that uses the acting actor (audit emit, permit grant/revoke, business logic keyed on actor) needs `acting?: ActingActor` on its input. The dispatcher 400s `actor_required` on multi-actor accounts otherwise.
- Drop any code that read `auth_session.active_actor_id` or `api_token.actor_id` — those columns no longer exist.
- Pass `actor_id` to `query_accept_offer`.
- Account-grain consumer handlers (logout-shaped, password-change-shaped) drop `actor_id` from audit emits.
- `RequestContext.actor` may now be null — handlers that need an actor either declare `acting?` (dispatcher resolves) or call `require_request_context` and assert `ctx.actor !== null` (only safe on routes the dispatcher would have rejected without an actor).
- Add `to_actor_id` / `target_actor_id` to fixtures and round-trip schemas.
- Handle new error codes if surfacing actor-targeted offers.

Schema migration

Body-edits v0 (`full_auth_schema`) and v1 (`permit_offer_and_scoped_permits`) in place. Fresh DBs pick up the new shape; consumers on v0.54.0 must reset dev DB or hand-apply:

- `ALTER TABLE audit_log ADD COLUMN target_actor_id UUID REFERENCES actor(id) ON DELETE SET NULL` + `idx_audit_log_target_actor` index
- `ALTER TABLE permit_offer ADD COLUMN to_actor_id UUID REFERENCES actor(id) ON DELETE CASCADE`

No production fuz_app at v0.54.0; ships as one slice.
