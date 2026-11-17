# ui/

Frontend subsystem — Svelte 5 components, reactive state classes, and DOM
utilities. Cookie-based SPA auth; prerendered static HTML served by Hono
(no SvelteKit SSR for sessions). State classes hold one or more `AsyncSlot`s
via composition (one per distinct async operation — e.g. `list` + `create` +
`revoke`); per-row write ops use `KeyedAsyncSlot<K, T = void, E = string>`
so concurrent rows don't abort each other and failures surface per-row via
`slot.error(key)`. Payload lives as `$state.raw` fields on the class.
Shared dependencies flow through Svelte context, never through props —
RPC adapters are provisioned once at the admin shell and read by every
`Admin*.svelte`.

For Svelte 5 patterns (runes, inline `$props`, contexts, snippets,
attachments), see Skill(fuz-stack) svelte-patterns. See ../../../docs/usage.md
for end-to-end wiring examples ("Role grant offer UI", "Admin UI"). This
file is a reference, not a tutorial.

## Key patterns

### RPC adapter contexts (required, no fallback)

Five narrow RPC adapter contexts — `admin_accounts_rpc_context`,
`admin_invites_rpc_context`, `audit_log_rpc_context`,
`app_settings_rpc_context`, `account_sessions_rpc_context` — carry a
reactive `() => Rpc` accessor. None declares a fallback, so `get()` throws
when a component mounts without a provisioner above it — the adapter is
required, and a missing wire fails loudly at mount rather than degrading
silently. (`role_grant_offers_state_context` carries a `RoleGrantOffersState`
directly, not an RPC accessor, and isn't counted here.) The standard consumer
shape:

```ts
const get_rpc = admin_accounts_rpc_context.get();
const admin_accounts = new AdminAccountsState({ get_rpc });
```

or for direct calls:

```ts
const get_rpc = admin_accounts_rpc_context.get();
const rpc = $derived(get_rpc());
```

The provisioner calls `context.set(() => rpc)` once at the admin route
shell. Every admin component plus `OpenSignupToggle.svelte` consumes the
context — RPC adapters are never threaded through props.

### `$state.raw` Map keyed by id + `$derived` views

`RoleGrantOffersState` maintains a single `Map<string, RoleGrantOfferJson>` in
`$state.raw`, keyed by offer id, and exposes `incoming` / `outgoing` /
`history` as `$derived.by` arrays. Writes go through `#merge_offers`
(clone-and-replace) / `#remove_offer` — never mutate the Map in place
because `$state.raw` expects reference swaps.

### Reducer pattern for WS notifications

`RoleGrantOffersState.apply_notification(notification)` is the single
reducer — `subscribe(subscribe_fn)` is a thin subscription adapter over
it. Six methods land on the reducer: `role_grant_offer_received` /
`_retracted` / `_accepted` / `_declined` / `_supersede` all merge a
`{offer}` payload; `role_grant_revoked` is ignored at this layer (role_grant
lifecycle lives in auth/role_grants state). The notification specs and
their payload shapes are defined in `auth/role_grant_offer_notifications.ts`
(see `auth/CLAUDE.md` §WS notifications).

### Context over props for shared deps

Auth, RPC adapters, and role_grant offers all flow through
`create_context` from `@fuzdev/fuz_ui/context_helpers.ts`. Components
consume with `const x = x_context.get()` (or a `get_rpc`/`$derived`
pair when the value may change reactively). New shared state joins the
pattern rather than reintroducing prop-drilling.

## Auth forms

All four consume `auth_state_context.get()`; all three form-driven ones
attach a `FormState` for Enter-advance + blur-touched validation. While a
submit is in flight their fields are `readonly` and the `PendingButton` is
`aria-disabled` (with `disabled={false}` overriding its disable-while-pending
default), never `disabled` — disabling the focused element drops focus to
`<body>`. So the handler guards re-entry itself (`if (auth_state.verifying)
return;`), since Enter and clicks still reach it.

- `LoginForm.svelte` — props `username_label = 'username or email'`,
  `redirect_on_login`. Clears `auth_state.verify_error` on input.
- `BootstrapForm.svelte` — token + username + password + confirm;
  validates `Username` schema and `PASSWORD_LENGTH_MIN`; focuses the
  first invalid field on submit.
- `SignupForm.svelte` — username + optional email + password + confirm;
  calls `auth_state.signup(username, password, email?)`.
- `LogoutButton.svelte` — wraps `PendingButton`; calls
  `auth_state.logout()` when `onclick` doesn't `preventDefault()`.

## Account

- `AccountSessions.svelte` — self-serve session list for the logged-in
  account. Instantiates `AccountSessionsState`, renders a `Datatable`
  with per-row `revoke` and a `ConfirmButton` `revoke all`. The row the
  server marks `is_current` is this browser's session: it reads
  `current` and offers `log out` (`auth_state.logout`, the logout
  request) in place of revoke, and a `revoke all` that succeeded logs
  out the same way, so the UI falls back to the login page.

## Admin

Every admin component below consumes its RPC adapter via the matching
context and delegates rendering to `Datatable` + `ConfirmButton` for
destructive actions.

- `AdminAccounts.svelte` — accounts + role_grants + pending offers.
  Consumes `admin_accounts_rpc_context`. Per-row actions: grant (+role
  chip with `ConfirmButton`), revoke (`actor_id` + `role_grant_id`),
  retract pending offer. The grant button offers the role globally, so it
  shows per `can_offer_global_role` — hidden by a global grant or pending
  global offer of that role, not by a scoped one. Reads per-row spinner +
  error state via `state.grant.loading(key)` / `state.revoke.loading(role_grant_id)` /
  `state.retract.loading(offer_id)` and their `.error(key)` siblings —
  per-row error displays inline next to the failing button (no
  top-level rollup).
- `AdminAuditLog.svelte` — audit event stream. Consumes
  `audit_log_rpc_context`. Filter by `event_type` (the stream reopens with
  it), manual refresh, toggle SSE streaming (via `EventSource` — not RPC);
  a closed stream shows a retry in place of the stream toggle (a filter
  change leaves it closed), and a
  failed or truncated gap fill says events may be missing.
- `AdminInvites.svelte` — invite CRUD + embeds `OpenSignupToggle`.
  Consumes `admin_invites_rpc_context`. Per-row delete reads
  `state.remove.loading(invite_id)` / `state.remove.error(invite_id)`
  with inline per-row error display.
- `AdminOverview.svelte` — dashboard panels (accounts / sessions /
  invites / recent activity / security / system). Consumes the admin
  RPC contexts plus `auth_state_context`; fetches in parallel on mount.
  Recent activity is the newest audit slice; the security counts come from
  their own queries — failed logins from `audit_log_list` filtered to
  `login` + `failure`, role grant changes from `audit_log_role_grant_history`
  — each fetched up to `AUDIT_LOG_LIST_LIMIT_MAX` rows and counted over the
  last 24 hours (`count_in_window`), `N+` when the cap may cut the window off.
  The public-signup chip renders only once settings load, labeled
  `open` / `invite-only` in both the Invites and System panels.
  `role_counts` is display-only and scope-blind — an account counts under
  each role it holds at any scope.
- `AdminRoleGrantHistory.svelte` — role-grant-create/revoke history table.
  Consumes `audit_log_rpc_context`, calls
  `audit_log.fetch_role_grant_history()` once on mount.
- `AdminSessions.svelte` — cross-account active sessions.
  Both listing (`admin_session_list` RPC) and the two revoke-all
  mutations go through `admin_accounts_rpc_context` (reused).
  Per-row: revoke sessions, revoke tokens — both `ConfirmButton`.
- `AdminSettings.svelte` — shell for `OpenSignupToggle` + the logged-in
  account line + logout `ConfirmButton`. No direct RPC calls.
- `AdminSurface.svelte` — attack-surface viewer. Fetches
  `/api/surface` (REST) and delegates to `SurfaceExplorer`. The server must
  opt in with `create_app_server({surface_route: true})`; the route is
  admin-only and refused to a narrowed API token.
- `OpenSignupToggle.svelte` — single checkbox bound to
  `AppSettingsState.settings.open_signup`. Consumes
  `app_settings_rpc_context`.
- `SurfaceExplorer.svelte` — reads-only `AppSurface` renderer. Props:
  `surface: AppSurface`. Filter routes by auth type; expand a row with the
  disclosure `<button aria-expanded>` in its first cell to dump
  `params`/`query`/`input`/`output`/`errors` schemas as JSON. One
  classification gives each auth chip its label and color (`none`,
  `keeper`, `role:…`, `credential:…`, `authenticated`).
  Also tables middleware, env, events, and diagnostics.

## Role grant offers

- `RoleGrantOfferInbox.svelte` — recipient-side pending inbox; renders
  `RoleGrantOffersState.incoming`. Props: `format_actor?`, `format_scope?`,
  `format_role?` — consumers plug in display names for actor/scope ids.
  Accept is a `PendingButton`; decline is a `ConfirmButton` whose
  popover contains a textarea (max `ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX`).
  Each row reads its own pending state and error from the keyed `accept` /
  `decline` slots, so one row's failure never shows on another.
- `RoleGrantOfferForm.svelte` — grantor-side create form. Props:
  `to_account_id`, `to_actor_id = null` (optional — narrows the offer
  to a specific actor on the recipient account; default account-grain),
  `roles: Array<string>` (pre-filtered upstream by admin-grant-path —
  `RoleSpec.grant_paths` includes `'admin'`),
  `scope_kind` + `scope_id` (`RoleGrantOfferScope` — together, or neither
  for a global offer; the prop types refuse one alone), `on_created?`,
  `format_role?`. Surfaces the RPC error reasons with friendly copy:
  `ERROR_ROLE_GRANT_OFFER_SELF_TARGET`,
  `ERROR_ROLE_GRANT_OFFER_ROLE_NOT_GRANTABLE`, `ERROR_ROLE_GRANT_OFFER_NOT_AUTHORIZED`,
  `ERROR_ROLE_GRANT_BUILTIN_SCOPED`,
  `ERROR_ROLE_GRANT_OFFER_ACTOR_ACCOUNT_MISMATCH`, `ERROR_ROLE_GRANT_OFFER_ACTOR_MISMATCH`
  — imported from `auth/role_grant_offer_action_specs.ts` (see
  `auth/CLAUDE.md` for `role_grant_offer_action_specs.ts` +
  `role_grant_offer_actions.ts`). Submits like the auth forms (`readonly`
  textarea, `aria-disabled` button, re-entry guard); its select stays
  `disabled`, having no `readonly` — safe, since the button has focus.
- `RoleGrantOfferHistory.svelte` — both-directions history (recipient +
  grantor, including terminal). Props: `current_actor_id: string | null`
  (classifies row as "sent" vs "received"), `format_actor?`,
  `format_scope?`, `format_role?`. Consumes
  `role_grant_offers_state_context`; caller seeds via
  `RoleGrantOffersState.fetch_history()`.
- `role_grant_offers_state.svelte.ts` — `RoleGrantOffersState` +
  `role_grant_offers_state_context`. Options: `rpc: RoleGrantOffersRpc`,
  `account_id: () => string | null`, `actor_id: () => string | null`.
  The narrow `RoleGrantOffersRpc` interface has six methods: `list`,
  `history`, `create`, `accept`, `decline`, `retract`. Slots:
  `AsyncSlot<void>` for `list` / `list_history`, one
  `AsyncSlot<RoleGrantOfferJson>` (`create`) that owns the created offer
  so `submit_create` returns it via the slot's supersession-safe `data`
  path, and `KeyedAsyncSlot<string>` keyed by offer id for the per-row
  `accept` / `decline` / `retract` (per-row pending + error;
  `RoleGrantOfferInbox` binds each row to its own). The `$state.raw` Map
  cache keyed by offer id stays on the class (multiple ops + WS
  notifications merge into it; a pending copy never replaces a terminal
  one). Each verb stamps the terminal offer its RPC answers into the
  cache, so `history` shows it without waiting on the WS notification. Methods use the `submit_*` prefix to avoid slot-name
  collisions (`submit_create` / `submit_accept` / `submit_decline` /
  `submit_retract`); the fetch slot is named `list_history` so the
  derived view stays natural as `history`. `$derived.by` views:
  `incoming` (recipient-side pending, soonest-expiry first),
  `outgoing` (grantor-side pending, newest-created first), `history`
  (all known, newest-created first). Reducer `apply_notification`
  handles the role-grant-offer notification methods;
  `role_grant_revoked` is deliberately ignored here (auth/role_grants
  concern). `reset()` clears every slot + the Map.

## State primitives

- `async_slot.svelte.ts` — `AsyncSlot<T = void, E = string>`. Composable
  reactive container for one async operation. Surface: explicit
  four-value `status` (`'initial' | 'pending' | 'success' | 'failure'`),
  derived `initial` / `loading` / `succeeded` / `failed`, supersession
  via internal `AbortController` (a second `run()` aborts the first
  and silently drops its commit), `AbortSignal` threaded to the
  callback + external-signal hookup via `RunOptions`, per-slot
  `map_error` set once in the constructor, opt-in
  `preserve_error_on_retry`, public `run()` / `abort()` / `set()` /
  `reset()`. Slots are HELD by state classes via composition (one per
  distinct async op), not subclassed. Payload typically lives on the
  state class as `$state.raw` fields; `slot.data` is reserved for
  cases where the slot owns the result.
- `keyed_async_slot.svelte.ts` — `KeyedAsyncSlot<K, T = void, E = string>`.
  Keyed sibling of `AsyncSlot` — lazily creates a child slot per key
  in a `SvelteMap`, propagating `map_error` / `preserve_error_on_retry`
  to each child. Replaces the `AsyncSlot` + `SvelteSet<id>` pair: each
  key has its own `AbortController`, so a `run(b, ...)` does NOT abort
  an in-flight `run(a, ...)`, and `error(key)` surfaces per-row.
  Reactive sugar: `loading(key)`, `error(key)`, `failed(key)`,
  `succeeded(key)`, `has(key)`, `size`, plus `get(key)` for full slot
  access. Resolved entries persist (no auto-cleanup) so components can
  render per-row error indicators after the run completes; call
  `delete(key)` to dismiss an entry or `reset()` to wipe everything.
  `abort(key)` / `abort_all()` cancel without removing entries.
  `entries()` / `keys()` / `values()` iterate for cross-key views.
- `auth_state.svelte.ts` — `AuthState`, `auth_state_context`.
  Fields: `verifying`, `verified`, `verify_error`, `account`, `actor`
  (the caller's own `ActorSummaryJson` — surfaced directly so consumers
  don't derive `actor_id` from the role_grant list), `role_grants`,
  `active_role_grants` (derived via `is_role_grant_active`, every scope),
  `global_roles` (derived `ReadonlySet` — the roles of active grants with
  `scope_id === null`), `is_admin` (derived — a global `admin` grant),
  `needs_bootstrap`. Methods: `check_session()`
  (GET `/api/account/status`), `login`, `bootstrap`, `signup`,
  `logout`, `has_global_role(role)`. Handles 401/403/409/429 translations
  inline.
  **Role gates in the UI read the global view** — `is_admin` /
  `has_global_role(role)`, the client form of the server's
  `has_scoped_role(ctx, role, null)`. There is no scope-blind list of role
  names: matching a grant on its role alone reads one scoped to a single
  resource as global (and a scoped `admin` grant confers nothing). A scoped
  check reads `active_role_grants` by `scope_id`; outside the class, the pure
  `has_global_role(role_grants, role)` (`auth/account_schema.ts`) answers the
  same question over any grant list.
- `table_state.svelte.ts` — `TableState`. Paginated DB browser state.
  Holds one `AsyncSlot` (`list`) + payload fields (`table_name`,
  `columns`, `rows`, `total`, `offset`, `limit` capped by
  `http/db_routes.ts`'s `DB_TABLE_ROWS_LIMIT_MAX`, `primary_key`,
  `deletable`). Derived
  `showing_start`/`showing_end`/`has_prev`/`has_next`, plus
  `can_delete` (`deletable && primary_key !== null`) — gate the
  delete affordance on that, not on `primary_key`, or a
  policy-excluded table shows a button that only ever refuses.
  Methods: `fetch`, `go_prev`/`go_next`, `delete_row`. `delete_row` uses
  plain try/catch + scalar `deleting` / `delete_error` fields (no
  slot — error must survive past `list.run()` retries).
- `form_state.svelte.ts` — `FormState`. Enter-advance between
  focusable elements via `keydown`; per-field `touched` set via
  delegated `focusout`; form-level `attempted` set on submit attempt.
  Methods: `form()` (returns a Svelte `Attachment` for the form
  element), `show(field)` (touched OR attempted), `is_touched(field)`,
  `touch(field)` (programmatic), `focus(field)` (queries by `name`),
  `attempt()`, `reset()`. Generic over its field names —
  `new FormState<'username' | 'password'>()` makes a misspelled field a
  compile error (defaults to `string`). In DEV throws if an input loses
  focus without a `name` attribute — all tracked inputs must be named.

## Per-domain state modules

All state classes hold per-op `AsyncSlot`s for the fetch + singular
write verbs, and `KeyedAsyncSlot`s for per-row write verbs (the
`SvelteSet<id>` pattern is retired — per-row tracking lives on the
keyed slot's `loading(key)` / `error(key)` accessors). Method names use
the `submit_*` prefix where the verb collides with a slot name. Every
narrow `*Rpc` adapter method takes its action's input as one params object
and returns its output, both typed from the action specs — `params?` where
the input defaults to `{}`, nothing where the action takes no input — so an
adapter over the typed throwing client is a one-line pass-through per
method. `AdminAccountsRpc.delete_account` narrows its params: its input
defaults too, but the empty input deletes the caller, so the adapter type
requires `account_id` as a `Uuid` (`{}` and a `null` id don't typecheck).

- `account_sessions_state.svelte.ts` — `AccountSessionsState` +
  `account_sessions_rpc_context` + narrow `AccountSessionsRpc`
  (`list`, `revoke`, `revoke_all`). Slots: `list` (AsyncSlot),
  `revoke` (`KeyedAsyncSlot<string, void>` keyed by `session_id` for
  per-row independence), `revoke_all` (AsyncSlot). Methods: `fetch`,
  `submit_revoke(id)`, `submit_revoke_all`. Derived `active_count`.
- `audit_log_state.svelte.ts` — `AuditLogState` +
  `audit_log_rpc_context` + narrow `AuditLogRpc` (`list` +
  `role_grant_history`). Slots: `list`, `role_grant_history`, `gap_fill`
  (the catch-up fetch each stream open runs; its `error` surfaces a failed
  fill). Fields: `events`, `role_grant_history_events`, `stream_status`
  (`AuditLogStreamStatus`: `'off' | 'connecting' | 'open' | 'closed'` —
  `'closed'` once `EventSource` stops retrying, e.g. after a revocation's
  reconnect is refused; `subscribe` again to retry), `gap_truncated` (a gap
  fill returned a full `AUDIT_LOG_LIST_LIMIT_MAX` page, so events may be
  missing). Internal `#last_seq` anchors the gap fill (`fetch` sets it from
  its result, `0` for an empty first page), and `#fill_since` keeps the start
  a fill still owes — one a reopen, retry or failure cut short, or an open
  deferred to a newest-page `fetch` that failed — so the next fill starts
  there rather than past the live rows that arrived meanwhile. Methods:
  `fetch(options?)` (RPC; clears `gap_truncated` and a failed `gap_fill`,
  and a newest-page fetch aborts an in-flight fill; mid-stream it keeps
  live events newer than the page that match its filter),
  `fetch_role_grant_history`,
  `subscribe(filter?: AuditLogFilter)` (opens `EventSource` at
  `#stream_url`, default `/api/admin/audit/stream`; keeps live events that
  pass the filter and gap-fills via `since_seq` with the same filter — only
  while `events` was fetched with that filter: an open the list doesn't
  match, or one during a newest-page `fetch`, defers its fill to the `fetch`
  with the stream's filter, which fills from its page; a fill merges only
  while the list keeps its filter; and live events under another filter
  merge only when they match the list's, without advancing the anchor),
  `disconnect()` (also aborts an in-flight gap fill). Live and
  gap rows merge by `seq`, deduplicated by `id`, so `events` stays
  newest-first. `audit_log_filter_matches(event, filter)` is the client-side
  twin of the list query's filter. SSE stays on `EventSource` — streaming is
  not an RPC concern.
- `admin_accounts_state.svelte.ts` — `AdminAccountsState` +
  `admin_accounts_rpc_context` + narrow `AdminAccountsRpc` (nine
  methods: `list_accounts` (`{include_deleted?, …}`), `delete_account`,
  `undelete_account`, `list_sessions`, `create_role_grant`,
  `revoke_role_grant`, `retract_offer`, `session_revoke_all`,
  `token_revoke_all` — `delete_account`/`undelete_account` back
  `submit_delete`/`submit_undelete` (the `account_lifecycle` capability);
  `session_revoke_all`/`token_revoke_all` are also reused by
  `AdminSessionsState`). Slots: `list` (AsyncSlot), `grant`
  (`KeyedAsyncSlot<string, RoleGrantOfferJson>` — slot owns the
  created offer; key composed by exported
  `grant_key(account_id, role, to_actor_id?)`, 2-segment for
  account-grain, 3-segment when actor-targeted), `revoke`
  (`KeyedAsyncSlot<Uuid, void>` keyed by `role_grant_id`), `retract`
  (`KeyedAsyncSlot<Uuid, void>` keyed by `offer_id`). `submit_revoke`
  takes `actor_id` as the first arg (role_grants are actor-scoped —
  matches `row.actor.id` straight from the listing) with optional
  `reason`. Also exports the pure `can_offer_global_role(entry, role)` —
  whether a listing row has neither a global grant nor a pending global
  offer of the role.
- `admin_invites_state.svelte.ts` — `AdminInvitesState` +
  `admin_invites_rpc_context` + narrow `AdminInvitesRpc` (`list`,
  `create`, `delete`). Slots: `list`, `create` (both AsyncSlot),
  `remove` (`KeyedAsyncSlot<Uuid, void>` keyed by `invite_id`).
  Field: `invites`; derived `invite_count`, `unclaimed_count`.
  Methods: `fetch`, `submit_create`, `submit_delete`. (Slot `remove`
  instead of `delete` to avoid keyword shadowing.)
- `admin_sessions_state.svelte.ts` — `AdminSessionsState`. **Reuses**
  `admin_accounts_rpc_context` / `AdminAccountsRpc` for the listing
  (`list_sessions` wraps `admin_session_list`) and the two revoke-all
  mutations. Slots: `list` (AsyncSlot), `revoke_sessions` /
  `revoke_tokens` (`KeyedAsyncSlot<Uuid, void>` keyed by
  `account_id`). Methods: `fetch`, `submit_revoke_sessions`, `submit_revoke_tokens`.
- `app_settings_state.svelte.ts` — `AppSettingsState` +
  `app_settings_rpc_context` + narrow `AppSettingsRpc` (`get`,
  `update`). Slots: `list`, `update`. Field: `settings`. Single
  mutation `update_open_signup(boolean)`.
- `admin_rpc_adapters.ts` (plain `.ts`, no reactive state) — bundled
  wiring for the four admin RPC contexts. `create_admin_rpc_adapters(api)`
  takes the typed throwing Proxy from `create_frontend_rpc_client` (or
  any object satisfying the `AdminRpcApi` interface) and returns
  `{admin_accounts, admin_invites, audit_log, app_settings}` adapter
  objects. `provide_admin_rpc_contexts(adapters)` calls `set` on all
  four contexts in one shot. One line at the admin shell layout:
  `provide_admin_rpc_contexts(create_admin_rpc_adapters(api))`.
  Method-name mapping is in the module TSDoc (`create_role_grant` →
  `role_grant_offer_create`, `retract_offer` → `role_grant_offer_retract`, etc.)
  and the `admin_rpc_adapters.test.ts` fixtures.

## RPC adapter contexts

All five RPC-carrying contexts are required (no fallback) — `get()` throws
when unprovisioned; consumers wire a typed RPC client to each narrow
interface. See "Key patterns" above for the provisioner pattern.

- `auth_state_context` — carries `AuthState` directly (not an RPC
  accessor). Used by every auth form, `AdminOverview`,
  `AdminSettings`, `AccountSessions`, `LogoutButton`.
- `admin_accounts_rpc_context` — `() => AdminAccountsRpc`.
  Consumed by `AdminAccounts`, `AdminSessions`, `AdminOverview`.
- `admin_invites_rpc_context` — `() => AdminInvitesRpc`.
  Consumed by `AdminInvites`, `AdminOverview`.
- `audit_log_rpc_context` — `() => AuditLogRpc`. Consumed by
  `AdminAuditLog`, `AdminRoleGrantHistory`, `AdminOverview`.
- `app_settings_rpc_context` — `() => AppSettingsRpc`.
  Consumed by `OpenSignupToggle`, `AdminOverview`.
- `account_sessions_rpc_context` — `() => AccountSessionsRpc`.
  Consumed by `AccountSessions`.
- `role_grant_offers_state_context` — carries `RoleGrantOffersState`
  directly. Consumed by `RoleGrantOfferInbox`, `RoleGrantOfferForm`,
  `RoleGrantOfferHistory`. Wiring is ctor-bound (RPC + account/actor
  getters), so there's no separate `role_grant_offers_rpc_context`.
- `format_scope_context` — `() => FormatScope` (getter shape, matching
  the RPC contexts above). `FormatScope = ({scope_id, role}) => string |
null`; default returns `null` so callers fall back to the truncated uuid.
  Provisioned by `provide_admin_rpc_contexts(adapters, {format_scope})`.
  Consumed by `AdminAccounts`, `AdminRoleGrantHistory`, `RoleGrantOfferInbox`,
  `RoleGrantOfferHistory` via the `resolve_scope_label(scope_id, role,
format_scope, global_label)` helper — `global_label = null` renders no
  chip (admin tables); `'global'` renders an explicit label (offer
  surfaces). `RoleGrantOfferInbox` / `RoleGrantOfferHistory` accept a
  `format_scope?: FormatScope` prop — same shape as the context, prop
  wins when supplied.

## Popovers

- `popover.svelte.ts` — `Popover` class. Owns `visible`, `position`,
  `align`, `offset`, `popover_class`, `disable_outside_click` as
  `$state.raw`. Three `Attachment` factories: `container`,
  `trigger(params?)`, `content(params?)`. `show()` / `hide()` /
  `toggle()`, plus `update(params)` to swap config. ARIA wired
  automatically: the content gets `role="dialog"` (unless it sets a role)
  and `aria-labelledby` the trigger (unless it carries its own name); the
  trigger gets `aria-expanded`, and `aria-controls` only while visible with
  content mounted (cleared on hide). While visible, a `document` `keydown`
  listener hides on Escape — preventing the default so enclosing layers
  (fuz_ui's `AppShell` overlay, pinned by
  `src/test/ui/app_shell_popover.dom.test.ts`) leave it alone, skipping an Escape already
  prevented, and returning focus to the trigger when it was in the content.
  Only the newest visible popover handles Escape (a module-level stack), so
  nested ones close innermost first, and while a `:modal` is open a popover
  outside it leaves Escape to the modal's close request.
- `position_helpers.ts` — `Position` / `Alignment` / `CardinalPosition`
  types; `generate_position_styles(position, align, offset)` returns
  CSS styles record for absolute positioning (left/right/top/bottom/
  center/overlay).
- `PopoverButton.svelte` — button + popover composition. Required
  `popover_content: Snippet<[Popover]>`. Either `children` (simple
  content inside the default `<button>`) or `button: Snippet<[Popover]>`
  (custom trigger) — logs in DEV if both or neither are supplied.
  Auto-hides when `disabled`.
- `ConfirmButton.svelte` — wraps `PopoverButton` for destructive
  actions. Required `onconfirm: (Popover) => void`. `hide_on_confirm`
  default `true`. `position` default `'left'`. Three optional
  snippets — `children`, `popover_content`, `popover_button_content` —
  each receiving `(Popover, confirm)`. Falls back to a remove-glyph
  button when no snippets are supplied.

## Data

- `Datatable.svelte` — generic table (`<script generics="T">`), exposed
  as ARIA `table` / `row` / `columnheader` / `cell` (no `grid` — it has no
  grid keyboard model); the empty state is a full-width row.
  Props: `columns`, `rows`, `row_key: (row: T) => PropertyKey` (required —
  the keyed-each key, so per-row state follows its row; a `null`/`undefined`
  key throws in DEV, no index fallback), `height?`, optional
  `header` / `cell` / `empty` snippets. Sticky header, CSS-subgrid
  layout, pointer-based column resize (writes deltas to a keyed
  record). Default cell renders `column.format(value, row)` or
  `format_value(value)`.
- `datatable.ts` — `DatatableColumn<T>` interface (`key`, `label`,
  `width?`, `min_width?`, `format?`), `DATATABLE_COLUMN_WIDTH_DEFAULT`
  (120), `DATATABLE_MIN_COLUMN_WIDTH` (50).

## Fetch + format

- `backend_probe.svelte.ts` — `probe_backend({fetch_health?, timeout_ms?, signal?}?)`
  → `BackendProbeResult` (`{ok: true}` or `{ok: false, error}`): live only when
  `HEALTH_PATH` answers `2xx` with a body whose `status` is `'ok'` (read
  loosely, so an added field never reads as down; the route spec's own schema
  stays strict), so a static SPA fallback's `200` HTML, a non-`2xx`, a
  network error (a dropped body included), and no reply within
  `BACKEND_PROBE_TIMEOUT_MS` (10 s, applied to the default fetch's reply and
  body; a supplied fetch keeps its own signal) are all down
  (`BACKEND_PROBE_NOT_HEALTH` names a `2xx` whose body isn't the health reply
  or isn't JSON). A timeout's error names the ms only for the default fetch; a
  supplied fetch's `TimeoutError` reads `timed out`. `signal` cancels the
  default fetch alongside its timeout, and a probe it aborted reports
  `BACKEND_PROBE_ABORTED`; a supplied fetch ignores it.
  `BackendProbe` wraps it for a login gate — `AuthState.check_session` can't
  tell a down backend from a logged-out caller: `probing`, `reachable`
  (`null` until a probe settles, through SSR and prerender too), `error`, and
  `probe()`, where a later probe supersedes one in flight.
  `probe_backend` takes `BackendProbeOptions` (`fetch_health?`, `timeout_ms?`,
  `signal?`); `BackendProbe` takes all but `signal`, since a reusable state's
  one signal, once aborted, would fail every later probe.
- `ui_fetch.ts` — `ui_fetch(input, init?)` wraps `fetch` with
  `credentials: 'include'` for cookie-based session auth;
  `parse_response_error(response, fallback?)` safely extracts the text to
  show even from non-JSON responses (HTML 404 pages, etc.) through
  `format_error_body(body, fallback)`: the body's `message`, else its
  `error` code. `table_state` and `auth_state` show refusals through it.
- `ui_format.ts` — display helpers:
  - `format_relative_time(timestamp, now?)` — "2m ago", "3h ago",
    "5d ago", "2mo ago", "1y ago"; "just now" when under a minute;
    bidirectional (future timestamps render as "in 5m" etc.).
  - `format_uptime(ms)` — "45s", "12m", "3h 15m", "2d 5h".
  - `truncate_middle(str, max_length, separator = '…')`.
  - `truncate_uuid(uuid)` — 12-char middle-truncation.
  - `format_datetime_local(timestamp)` — absolute UTC string for
    `title` attributes.
  - `count_in_window(rows, window_start, cap)` — count of newest-first
    rows created since `window_start`, labeled `N+` when a full capped
    list's oldest row is still inside the window.
  - `format_value(value)` — table-cell stringifier (NULL / undefined /
    JSON / primitive).
  - `format_audit_metadata(event_type, metadata)` — event-type-
    specific metadata summary (bespoke cases for the common event types,
    JSON-stringified fallback for the rest).
