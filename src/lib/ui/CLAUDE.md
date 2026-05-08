# ui/

Frontend subsystem — Svelte 5 components, reactive state classes, and DOM
utilities. Cookie-based SPA auth; prerendered static HTML served by Hono
(no SvelteKit SSR for sessions). State classes extend `Loadable` and
hold `$state` fields exclusively via runes. Shared dependencies flow
through Svelte context, never through props — RPC adapters in particular
are provisioned once at the admin shell and read by every `Admin*.svelte`.

See ../../docs/usage.md for end-to-end wiring examples (sections "Permit
offer UI" and "Admin UI"). This file is a reference, not a tutorial.

## Key patterns

### RPC adapter contexts with `() => null` fallback

Five narrow RPC adapter contexts — `admin_accounts_rpc_context`,
`admin_invites_rpc_context`, `audit_log_rpc_context`,
`app_settings_rpc_context`, `account_sessions_rpc_context` — carry a
reactive `() => Rpc | null` accessor. All five declare a `() => () => null`
default so components mounted without a provisioner render the "rpc adapter
not wired" state instead of crashing. (`permit_offers_state_context` carries
a `PermitOffersState` directly, not an RPC accessor, and isn't counted
here.) The standard consumer shape:

```ts
const get_rpc = admin_accounts_rpc_context.get();
const admin_accounts = new AdminAccountsState({get_rpc});
```

or for direct calls:

```ts
const get_rpc = admin_accounts_rpc_context.get();
const rpc = $derived(get_rpc());
```

The provisioner calls `context.set(() => rpc)` once at the admin route
shell. Every admin component plus `OpenSignupToggle.svelte` consumes the
context — RPC adapters are never threaded through props.

### `has_rpc` gates fetch and mutations

Every state class backed by a narrow RPC interface exposes a `has_rpc`
getter. When `false`, `fetch()`, mutations, and `subscribe` no-op and
set `error` to `'rpc adapter not wired'`. Post-2026-04-23 RPC migration
this applies uniformly — `AdminSessionsState`'s listing + mutations all
run through the shared `AdminAccountsRpc`, so `has_rpc` gates the whole
surface.

### `$state.raw` Map keyed by id + `$derived` views

`PermitOffersState` maintains a single `Map<string, PermitOfferJson>` in
`$state.raw`, keyed by offer id, and exposes `incoming` / `outgoing` /
`history` as `$derived.by` arrays. Writes go through `#merge_offers`
(clone-and-replace) / `#remove_offer` — never mutate the Map in place
because `$state.raw` expects reference swaps.

### Reducer pattern for WS notifications

`PermitOffersState.apply_notification(notification)` is the single
reducer — `subscribe(subscribe_fn)` is a thin subscription adapter over
it. Six methods land on the reducer: `permit_offer_received` /
`_retracted` / `_accepted` / `_declined` / `_supersede` all merge a
`{offer}` payload; `permit_revoke` is ignored at this layer (permit
lifecycle lives in auth/permits state). The six notification specs and
their payload shapes are defined in `../auth/permit_offer_notifications.ts`
(see `../auth/CLAUDE.md` §WS notifications).

### Svelte 5 inline `$props` shape

Always `const {...}: {...} = $props()` — never `interface Props`.
Destructure defaults in the binding list; put the type literal inline.
This matches the user-memory Svelte props rule and the existing file
conventions.

### Context over props for shared deps

Auth, RPC adapters, sidebar, and permit offers all flow through
`create_context` from `@fuzdev/fuz_ui/context_helpers.js`. Components
consume with `const x = x_context.get()` (or a `get_rpc`/`$derived`
pair when the value may change reactively). New shared state joins the
pattern rather than reintroducing prop-drilling.

## Shell + layout

- `AppShell.svelte` — sidebar-and-main shell. Props: `children`,
  `sidebar` (Snippet), `sidebar_width = 180`, `sidebar_state?`,
  `keyboard_shortcut?`, `show_toggle?`, `toggle_button?`.
  Provisions `sidebar_state_context` internally (creates a fresh
  `SidebarState` if `sidebar_state` prop is not supplied).
- `ColumnLayout.svelte` — fixed `aside` column + fluid `children`
  column; `column_width = '280px'`.
- `MenuLink.svelte` — SvelteKit `<a>` with `selected`/`highlighted`
  derived from `page.url.pathname`. Takes `path` (resolved via
  `resolve` from `$app/paths`).
- `sidebar_state.svelte.ts` — `SidebarState` (with `activate()` cleanup
  pattern, optional reactive `enabled` getter), `sidebar_state_context`.

## Auth forms

All four consume `auth_state_context.get()`; all three form-driven ones
attach a `FormState` for Enter-advance + blur-touched validation.

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
  with per-row `revoke` and an optional `revoke all`. Calling
  `revoke_all` clears `auth_state.verified` so the UI falls back to
  the login page.

## Admin

Every admin component below consumes its RPC adapter via the matching
context and delegates rendering to `Datatable` + `ConfirmButton` for
destructive actions.

- `AdminAccounts.svelte` — accounts + permits + pending offers.
  Consumes `admin_accounts_rpc_context`. Per-row actions: grant (+role
  chip with `ConfirmButton`), revoke (`actor_id` + `permit_id`),
  retract pending offer. Tracks `granting_keys` / `revoking_ids` /
  `retracting_ids` for per-action spinners.
- `AdminAuditLog.svelte` — audit event stream. Consumes
  `audit_log_rpc_context`. Filter by `event_type`, manual refresh,
  toggle SSE streaming (via `EventSource` — not RPC).
- `AdminInvites.svelte` — invite CRUD + embeds `OpenSignupToggle`.
  Consumes `admin_invites_rpc_context`. Tracks `creating` +
  `deleting_ids`.
- `AdminOverview.svelte` — dashboard panels (accounts / sessions /
  invites / recent activity / security / system). Consumes all four
  RPC contexts plus `auth_state_context`; fetches in parallel on mount.
  Derives `role_counts`, `failed_logins`, `permit_changes` from
  the audit log.
- `AdminPermitHistory.svelte` — permit-grant/revoke history table.
  Consumes `audit_log_rpc_context`, calls
  `audit_log.fetch_permit_history()` once on mount.
- `AdminSessions.svelte` — cross-account active sessions.
  Both listing (`admin_session_list` RPC) and the two revoke-all
  mutations go through `admin_accounts_rpc_context` (reused).
  Per-row: revoke sessions, revoke tokens — both `ConfirmButton`.
- `AdminSettings.svelte` — shell for `OpenSignupToggle` + the logged-in
  account line + logout `ConfirmButton`. No direct RPC calls.
- `AdminSurface.svelte` — attack-surface viewer. Fetches
  `/api/surface` (REST) and delegates to `SurfaceExplorer`.
- `OpenSignupToggle.svelte` — single checkbox bound to
  `AppSettingsState.settings.open_signup`. Consumes
  `app_settings_rpc_context`; hides gracefully when `has_rpc` is `false`.
- `SurfaceExplorer.svelte` — reads-only `AppSurface` renderer. Props:
  `surface: AppSurface`. Filter routes by auth type; expand a row to
  dump `params`/`query`/`input`/`output`/`errors` schemas as JSON.
  Also tables middleware, env, events, and diagnostics.

## Permit offers

- `PermitOfferInbox.svelte` — recipient-side pending inbox; renders
  `PermitOffersState.incoming`. Props: `format_actor?`, `format_scope?`,
  `format_role?` — consumers plug in display names for actor/scope ids.
  Accept is a `PendingButton`; decline is a `ConfirmButton` whose
  popover contains a textarea (max `PERMIT_OFFER_MESSAGE_LENGTH_MAX`).
- `PermitOfferForm.svelte` — grantor-side create form. Props:
  `to_account_id`, `to_actor_id = null` (optional — narrows the offer
  to a specific actor on the recipient account; default account-grain),
  `roles: Array<string>` (pre-filtered upstream by `web_grantable`),
  `scope_id = null`, `on_created?`, `format_role?`. Surfaces five
  reason codes with friendly copy: `ERROR_OFFER_SELF_TARGET`,
  `ERROR_OFFER_ROLE_NOT_GRANTABLE`, `ERROR_OFFER_NOT_AUTHORIZED`,
  `ERROR_OFFER_ACTOR_ACCOUNT_MISMATCH`, `ERROR_OFFER_ACTOR_MISMATCH`
  — imported from `../auth/permit_offer_action_specs.js` (see
  `../auth/CLAUDE.md` for `permit_offer_action_specs.ts` +
  `permit_offer_actions.ts`).
- `PermitOfferHistory.svelte` — both-directions history (recipient +
  grantor, including terminal). Props: `current_actor_id: string | null`
  (classifies row as "sent" vs "received"), `format_actor?`,
  `format_scope?`, `format_role?`. Consumes
  `permit_offers_state_context`; caller seeds via
  `PermitOffersState.fetch_history()`.
- `permit_offers_state.svelte.ts` — `PermitOffersState` (extends
  `Loadable`) + `permit_offers_state_context`. Options:
  `rpc: PermitOffersRpc`, `account_id: () => string | null`,
  `actor_id: () => string | null`. The narrow `PermitOffersRpc`
  interface has six methods: `list`, `history`, `create`, `accept`,
  `decline`, `retract`. `$state.raw` Map keyed by offer id;
  `$derived.by` views: `incoming` (recipient-side pending, soonest-
  expiry first), `outgoing` (grantor-side pending, newest-created
  first), `history` (all known, newest-created first). Reducer
  `apply_notification` handles the six permit-offer notification
  methods; `permit_revoke` is deliberately ignored here (auth/permits
  concern). `reset()` clears the Map.

## State primitives

- `loadable.svelte.ts` — `Loadable<TError = string>` base class.
  `loading`, `error`, `error_data` (raw caught value for programmatic
  inspection). Protected `run(fn, map_error?)` wraps async operations
  with loading + error handling; subclasses add `$state` fields and
  call `run`. `reset()` clears state; subclasses override to clear
  domain data.
- `auth_state.svelte.ts` — `AuthState`, `auth_state_context`.
  Fields: `verifying`, `verified`, `verify_error`, `account`, `actor`
  (the caller's own `ActorSummaryJson` — surfaced directly so consumers
  don't derive `actor_id` from the permit list), `permits`,
  `active_permits` (derived via `is_permit_active`), `roles` (derived),
  `needs_bootstrap`. Methods: `check_session()`
  (GET `/api/account/status`), `login`, `bootstrap`, `signup`,
  `logout`. Handles 401/403/409/429 translations inline.
- `table_state.svelte.ts` — `TableState` extends `Loadable`.
  Paginated DB browser state: `table_name`, `columns`, `rows`,
  `total`, `offset`, `limit` (capped by `TABLE_LIMIT_MAX = 1000`),
  `primary_key`. Derived `showing_start`/`showing_end`/`has_prev`/
  `has_next`. Methods: `fetch`, `go_prev`/`go_next`, `delete_row`.
- `form_state.svelte.ts` — `FormState`. Enter-advance between
  focusable elements via `keydown`; per-field `touched` set via
  delegated `focusout`; form-level `attempted` set on submit attempt.
  Methods: `form()` (returns a Svelte `Attachment` for the form
  element), `show(field)` (touched OR attempted), `is_touched(field)`,
  `touch(field)` (programmatic), `focus(field)` (queries by `name`),
  `attempt()`, `reset()`. In DEV throws if an input loses focus
  without a `name` attribute — all tracked inputs must be named.
- `sidebar_state.svelte.ts` — see Shell + layout above.

## Per-domain state modules

- `account_sessions_state.svelte.ts` — `AccountSessionsState` extends
  `Loadable` + `account_sessions_rpc_context` + narrow
  `AccountSessionsRpc` (`list`, `revoke`, `revoke_all`). Wraps the
  `account_session_list` / `account_session_revoke` /
  `account_session_revoke_all` RPC actions. Derived `active_count`.
- `audit_log_state.svelte.ts` — `AuditLogState` extends `Loadable`
  - `audit_log_rpc_context` + narrow `AuditLogRpc` (`list` +
    `permit_history`). Fields: `events`, `permit_history_events`,
    `connected`. Internal `#last_seq` for SSE gap fill on reconnect.
    Methods: `fetch(options?)` (RPC), `fetch_permit_history`,
    `subscribe()` (opens `EventSource` at `#stream_url`, default
    `/api/admin/audit/stream`; prepends new events; refills gap
    via `since_seq`), `disconnect()`. SSE stays on `EventSource` —
    streaming is not an RPC concern.
- `admin_accounts_state.svelte.ts` — `AdminAccountsState` extends
  `Loadable` + `admin_accounts_rpc_context` + narrow
  `AdminAccountsRpc` (six methods: `list_accounts`, `grant_permit`,
  `revoke_permit`, `retract_offer`, `session_revoke_all`,
  `token_revoke_all` — the last two are also reused by
  `AdminSessionsState`). `SvelteSet`s for in-flight tracking:
  `granting_keys` (`${account_id}:${role}` for the account-grain
  default; `${account_id}:${role}:${to_actor_id}` when `grant_permit`
  is called with an actor-targeted offer), `revoking_ids` (permit id),
  `retracting_ids` (offer id). `revoke_permit` keys on `actor_id`
  (permits are actor-scoped — matches `row.actor.id` straight from the
  listing) with optional `reason`.
- `admin_invites_state.svelte.ts` — `AdminInvitesState` extends
  `Loadable` + `admin_invites_rpc_context` + narrow
  `AdminInvitesRpc` (`list`, `create`, `delete`). Fields:
  `invites`, `creating`, `deleting_ids`; derived `invite_count`,
  `unclaimed_count`.
- `admin_sessions_state.svelte.ts` — `AdminSessionsState` extends
  `Loadable`. **Reuses** `admin_accounts_rpc_context` /
  `AdminAccountsRpc` for the listing (`list_sessions` wraps
  `admin_session_list`) and the two revoke-all mutations. `SvelteSet`s:
  `revoking_account_ids`, `revoking_token_account_ids`. `has_rpc`
  gates the listing + both revoke controls.
- `app_settings_state.svelte.ts` — `AppSettingsState` extends
  `Loadable` + `app_settings_rpc_context` + narrow `AppSettingsRpc`
  (`get`, `update`). Fields: `settings`, `updating`. Single mutation
  `update_open_signup(boolean)`.
- `admin_rpc_adapters.ts` (plain `.ts`, no reactive state) — bundled
  wiring for the four admin RPC contexts. `create_admin_rpc_adapters(api)`
  takes the typed throwing Proxy from `create_frontend_rpc_client` (or
  any object satisfying the `AdminRpcApi` interface) and returns
  `{admin_accounts, admin_invites, audit_log, app_settings}` adapter
  objects. `provide_admin_rpc_contexts(adapters)` calls `set` on all
  four contexts in one shot. One line at the admin shell layout:
  `provide_admin_rpc_contexts(create_admin_rpc_adapters(api))`.
  Method-name mapping is in the module TSDoc (`grant_permit` →
  `permit_offer_create`, `retract_offer` → `permit_offer_retract`, etc.)
  and the `admin_rpc_adapters.test.ts` fixtures.

## RPC adapter contexts

All five RPC-carrying contexts have a `() => () => null` default and
share the same `has_rpc`-gated state-class shape; consumers wire a typed
RPC client to each narrow interface. See "Key patterns" above for the
provisioner pattern.

- `auth_state_context` — carries `AuthState` directly (not an RPC
  accessor). Used by every auth form, `AdminOverview`,
  `AdminSettings`, `AccountSessions`, `LogoutButton`.
- `admin_accounts_rpc_context` — `() => AdminAccountsRpc | null`.
  Consumed by `AdminAccounts`, `AdminSessions`, `AdminOverview`.
- `admin_invites_rpc_context` — `() => AdminInvitesRpc | null`.
  Consumed by `AdminInvites`, `AdminOverview`.
- `audit_log_rpc_context` — `() => AuditLogRpc | null`. Consumed by
  `AdminAuditLog`, `AdminPermitHistory`, `AdminOverview`.
- `app_settings_rpc_context` — `() => AppSettingsRpc | null`.
  Consumed by `OpenSignupToggle`, `AdminOverview`.
- `account_sessions_rpc_context` — `() => AccountSessionsRpc | null`.
  Consumed by `AccountSessions`.
- `permit_offers_state_context` — carries `PermitOffersState`
  directly. Consumed by `PermitOfferInbox`, `PermitOfferForm`,
  `PermitOfferHistory`. Wiring is ctor-bound (RPC + account/actor
  getters), so there's no separate `permit_offers_rpc_context`.
- `format_scope_context` — `() => FormatScope` (getter shape, matching
  the RPC contexts above). `FormatScope = ({scope_id, role}) => string |
null`; default returns `null` so callers fall back to the raw uuid.
  Provisioned by `provide_admin_rpc_contexts(adapters, {format_scope})`.
  Consumed by `AdminAccounts`, `AdminPermitHistory`, `PermitOfferInbox`,
  `PermitOfferHistory` via the `resolve_scope_label(scope_id, role,
format_scope, global_label)` helper — `global_label = null` renders no
  chip (admin tables); `'global'` renders an explicit label (offer
  surfaces). `PermitOfferInbox` / `PermitOfferHistory` accept a
  `format_scope?: FormatScope` prop — same shape as the context, prop
  wins when supplied.
- `sidebar_state_context` — `() => SidebarState`. Provisioned by
  `AppShell`.

## Popovers

- `popover.svelte.ts` — `Popover` class. Owns `visible`, `position`,
  `align`, `offset`, `popover_class`, `disable_outside_click` as
  `$state.raw`. Three `Attachment` factories: `container`,
  `trigger(params?)`, `content(params?)`. `show()` / `hide()` /
  `toggle()`, plus `update(params)` to swap config. ARIA roles +
  `aria-expanded` / `aria-controls` wired automatically.
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

- `Datatable.svelte` — generic grid (`<script generics="T">`).
  Props: `columns`, `rows`, `row_key = 'id'`, `height?`, optional
  `header` / `cell` / `empty` snippets. Sticky header, CSS-subgrid
  layout, pointer-based column resize (writes deltas to a keyed
  record). Default cell renders `column.format(value, row)` or
  `format_value(value)`.
- `datatable.ts` — `DatatableColumn<T>` interface (`key`, `label`,
  `width?`, `min_width?`, `format?`), `DATATABLE_COLUMN_WIDTH_DEFAULT`
  (120), `DATATABLE_MIN_COLUMN_WIDTH` (50).

## Fetch + format

- `ui_fetch.ts` — `ui_fetch(input, init?)` wraps `fetch` with
  `credentials: 'include'` for cookie-based session auth;
  `parse_response_error(response, fallback?)` safely extracts
  `body.error` even from non-JSON responses (HTML 404 pages, etc.).
- `ui_format.ts` — display helpers:
  - `format_relative_time(timestamp, now?)` — "2m ago", "3h ago",
    "5d ago", "2mo ago", "1y ago"; "just now" when under a minute;
    bidirectional (future timestamps render as "in 5m" etc.).
  - `format_uptime(ms)` — "45s", "12m", "3h 15m", "2d 5h".
  - `truncate_middle(str, max_length, separator = '…')`.
  - `truncate_uuid(uuid)` — 12-char middle-truncation.
  - `format_datetime_local(timestamp)` — absolute UTC string for
    `title` attributes.
  - `format_value(value)` — table-cell stringifier (NULL / undefined /
    JSON / primitive).
  - `format_audit_metadata(event_type, metadata)` — event-type-
    specific metadata summary (switch across every `AuditEventType`).
