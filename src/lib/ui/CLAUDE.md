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
`{offer}` payload; `role_grant_revoke` is ignored at this layer (role_grant
lifecycle lives in auth/role_grants state). The six notification specs and
their payload shapes are defined in `auth/role_grant_offer_notifications.ts`
(see `auth/CLAUDE.md` §WS notifications).

### Context over props for shared deps

Auth, RPC adapters, sidebar, and role_grant offers all flow through
`create_context` from `@fuzdev/fuz_ui/context_helpers.ts`. Components
consume with `const x = x_context.get()` (or a `get_rpc`/`$derived`
pair when the value may change reactively). New shared state joins the
pattern rather than reintroducing prop-drilling.

## Shell + layout

- `AppShell.svelte` — sidebar-and-main shell. Props: `children`,
  `sidebar` (Snippet), `sidebar_width = 180`, `sidebar_label = 'sidebar'`
  (the open overlay's accessible name), `sidebar_state?`,
  `keyboard_shortcut?`, `show_toggle?`, `toggle_button?` (receives
  `{title, show_sidebar, toggle, sidebar_id}`). Provisions
  `sidebar_state_context` internally (creates one `SidebarState` if the
  `sidebar_state` prop is not supplied). Requires the SvelteKit runtime
  (`afterNavigate` from `$app/navigation`). The toggle renders only while
  `show_toggle && sidebar_state.enabled`, before the sidebar in the DOM;
  the built-in one is a disclosure (`aria-expanded` + `aria-controls`
  pointing at the sidebar's id — `SidebarState.sidebar_id` when set, else
  one from `$props.id()`) with the static name
  `aria-label="sidebar"`, a dynamic `title`, `aria-keyshortcuts` when
  `keyboard_shortcut` is set, and a `←` glyph CSS mirrors when closed.
  The shortcut acts only while the sidebar is enabled, on the current
  mode's field (so it drives the overlay at narrow widths).
  - **Custom toggles** (`toggle_button`): give the button
    `class="app-shell-toggle"` — it renders as a direct child of the root,
    where a `:global` rule (the snippet's markup carries no scope hash)
    stacks it one above the sidebar; the z-index applies only to a
    positioned button, so position it (e.g. `position: fixed`, like the
    built-in one) — and `aria-controls={sidebar_id}`, which the
    focus fallback looks up (the first match that takes focus wins).
    `show_sidebar` is viewport-dependent (the server renders it as wide):
    attributes are repaired on hydration, but visible content keyed on it
    changes at narrow widths, so key visible content on CSS or the
    viewport-free fields.
  - **Toggles outside the shell** (a top nav's hamburger) set
    `SidebarState`'s `sidebar_id` option and carry
    `aria-controls={sidebar_state.sidebar_id}`, so the focus fallback finds
    them too. `aria-controls` is read as an id list. A set id assumes one
    shell per state — shells sharing it at the same time would render the
    same id.
  - **Two modes, split by `SidebarState.narrow_query`.** Wide: the sidebar
    sits beside the content (padded by `--sidebar_offset`) and follows
    `show_sidebar_wide`. Narrow: it starts closed and opens as an overlay
    (capped at `85vw`) over a scrim, following `show_sidebar_narrow`; the
    content is `inert` while open. The overlay closes on navigation
    (`afterNavigate` inside `AppShell` — consumers write nothing), Escape,
    a scrim click, and widening out of narrow mode (a crossing `$effect`).
  - **The open overlay is a modal dialog.** While it's open the sidebar
    carries `role="dialog"`, `aria-modal="true"`, and `aria-label` from
    `sidebar_label`. They key on the open overlay (`overlay_open`), which
    reads the viewport — that's what keeps the persistent wide sidebar (the
    same element) from ever being a dialog — and the server render matches
    hydration because the overlay always starts closed, as with `inert`.
    Opening moves
    focus into it — the content went `inert`, which dropped focus — to the
    first control that takes focus (`tabIndex >= 0`, checked after each
    `focus()`), else to the sidebar itself, `tabindex="-1"` while it's the
    overlay (script-focusable, skipped by Tab; the wide sidebar has none, so
    a click on its background leaves focus where it was). No focus trap:
    `inert` already keeps Tab out of the content, and the built-in toggle
    stays Tab-reachable as a close control. `aria-modal` lets assistive
    tech hide everything outside the sidebar, the toggle included
    (Chromium keeps it exposed; WebKit may not), so a sidebar whose
    screen-reader users need a close control beyond Escape and navigation
    renders its own.
  - **Escape** is a window `keydown` listener registered by an `$effect`
    only while the overlay is open, so listeners registered earlier (a
    contextmenu's, mounted with the page) see Escape first and can swallow
    it. It never calls `preventDefault`, so the browser's close requests
    (dialog `cancel`, `popover="auto"`) stay intact, and it bails while a
    modal is open (`document.querySelector(':modal')` matches). An open
    `popover="auto"` isn't `:modal`, so one Escape closes it and the overlay
    together. Closing is `flushSync`ed so the content leaves `inert` before
    focus returns. When focus was inside the sidebar or had fallen to `body`
    (opening from the content makes it `inert`, which drops focus there), it
    goes back to the opener if still connected and focusable, else to the
    first `[aria-controls]` naming the sidebar's id that takes focus (Safari
    doesn't focus a clicked button, so the opener can be `null`). A
    narrow-mode close from `keyboard_shortcut` or a scrim click goes through
    the same close-and-return path; wide mode just toggles. The shortcut
    bails on an open modal too, so pressing it inside a dialog opened from
    the overlay doesn't close the overlay behind it.
  - **No hydration flash.** The mode rules sit in two cascade layers
    nested under `fuz_app`. `@layer fuz_app.app_shell_base` in the scoped
    `<style>` holds the base and state rules, which apply in both modes;
    the narrow overrides are one `<style media={narrow_query}>` in
    `<svelte:head>` (Svelte attribute-escapes the query; the CSS text is
    constant), inside `@layer fuz_app.app_shell_narrow`, rendered only
    while `narrow_query` isn't `null`. Both sheets open with
    `@layer fuz_app.app_shell_base, fuz_app.app_shell_narrow;`, so the
    narrow layer wins whatever the selectors' specificity (the scoped ones
    carry the hash) and whichever sheet the browser meets first — a
    client-mounted shell appending its head style late changes nothing.
    The root's state classes read only the viewport-free fields, so the
    server render and hydration agree and CSS picks the mode; `narrow` only
    drives `inert`, ARIA, and input routing. The narrow rules are unscoped
    (they match every `.app-shell` by plain class names), so shells mounted
    at the same time must share a `narrow_query`. CSP: needs
    `style-src-elem 'unsafe-inline'` (fuz_ui's CSP default allows it) or
    the style's hash.
  - **Layer names are namespaced** under one top-level `fuz_app` layer, so
    they can't collide with a consumer's and a consumer that layers its own
    CSS has one name to order against: `@layer fuz_app, overrides;` in a
    sheet that loads before the shell puts `overrides` above it.
  - **Never layer a property the reset sets.** fuz_css's reset
    (`*, ::before, ::after, ::backdrop`) sets `box-sizing`, `border`,
    `margin`, and `padding`, and it's unlayered, so it beats every layered
    declaration of those at any specificity. The shell routes such a value
    through a custom property the layers set and one unlayered rule reads.
    The content offset is the one case: the layers set `--sidebar_offset`
    on `.app-shell-content` (`--sidebar_width` under `.wide-open`, `0px`
    otherwise and in the narrow layer), and
    `:global(div:where(.app-shell > .app-shell-content)) { padding-left: var(--sidebar_offset, 0px) }`
    reads it, unscoped at (0,0,1) — above the reset's (0,0,0), below any
    class selector. The SSR test fails any layered `padding*`, `margin*`,
    `border*`, or `box-sizing` declaration. No other layered declaration
    overlaps the reset or fuz_css's element base rules (the sidebar, scrim,
    and content are `div`s and the glyph a `span`, which fuz_css leaves
    unstyled; the toggle's only layered property is `z-index`, which
    `button`'s base rule doesn't set).
  - **Public class hooks**: `.app-shell` (state classes `.wide-open` /
    `.narrow-open`), `.app-shell-content`, `.app-shell-sidebar`,
    `.app-shell-scrim`, `.app-shell-toggle`, `.app-shell-toggle-glyph`.
    **Any unlayered rule overrides the shell**, at any specificity and in
    any sheet order, so no specificity matching is needed. The flip side
    is the reset case above: an unlayered rule that sets a property the
    shell layers wins over it, which is why the shell keeps reset-owned
    properties out of its layers. A consumer's own layered rules order
    against `fuz_app` by first appearance in the document, so keep
    overrides unlayered or order `fuz_app` first. The rules that must
    reach consumer markup are `:global` under the scoped root: the toggle's
    z-index (`.app-shell > .app-shell-toggle`), the glyph mirroring
    (`.app-shell > .app-shell-toggle .app-shell-toggle-glyph`, so a custom
    toggle can reuse `.app-shell-toggle-glyph` inside its
    `.app-shell-toggle`; going through the root's own toggle keeps an outer
    shell's state off a nested shell's glyph), and
    `.app-shell-sidebar :modal { visibility: visible }`, which keeps a
    top-layer dialog opened from the sidebar shown while the sidebar hides.
  - **CSS variables**: `--sidebar_width` (always the configured width, set
    from the prop — not the effective offset), `--sidebar_offset` (the
    effective offset, set on `.app-shell-content`: `--sidebar_width` while
    the wide sidebar is open, else `0px`; the content's descendants can
    read it, e.g. to inset a fixed header), `--sidebar_bg` (default
    `--shade_05`), `--sidebar_z_index` (default `200` in both modes; the
    scrim shares it, the toggle sits one above), `--sidebar_scrim_bg`
    (default `--darken_40`). Override the offset by setting
    `--sidebar_offset` or writing a `padding-left` rule on
    `.app-shell-content`; a consumer `padding` shorthand there overrides it
    too. Either applies in both modes and open or closed, since the state
    classes don't track the viewport — wrap it in the narrow query's negation
    to keep narrow mode at `0px`. To change only the wide open offset, target
    `.app-shell.wide-open > .app-shell-content`, also inside that negation.
- `ColumnLayout.svelte` — fixed `aside` column + fluid `children`
  column; `column_width = '280px'`.
- `MenuLink.svelte` — SvelteKit `<a>` with `selected` derived from
  `page.url.pathname` (fires for exact match + descendant pages).
  Exact matches additionally get `aria-current="page"`. Takes `path`
  (resolved via `resolve` from `$app/paths`). The `.highlighted` name is
  intentionally free for orthogonal emphasis (badges, recent activity).
- `sidebar_state.svelte.ts` — `SidebarState`, `sidebar_state_context`,
  `SIDEBAR_NARROW_QUERY_DEFAULT` (`'(max-width: 800px)'`). Options:
  `enabled?` (reactive getter overriding the internal field) and
  `narrow_query?` (`null` disables narrow mode; must contain parentheses
  since it feeds both CSS `media` and `MediaQuery`, which would auto-wrap a
  paren-less query while CSS wouldn't — throws in DEV), and `sidebar_id?`
  (the sidebar element's id, read back as the readonly `sidebar_id`, `null`
  when unset — for toggles outside `AppShell`). Visibility is two
  viewport-free fields, `show_sidebar_wide` (default `true`, the desktop
  preference narrow interactions never touch) and `show_sidebar_narrow`
  (default `false`). `narrow` is the viewport match (`false` in SSR);
  `show_sidebar` is the effective visibility for the current mode and its
  setter writes that mode's field, as does `toggle_sidebar` (routed at call
  time). `close_narrow()` closes the overlay. `activate()` enables and
  shows wide; its disposer clears `enabled` and both fields — pair with
  `$effect` for scoped activation.

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
  with per-row `revoke` and an optional `revoke all`. Calling
  `revoke_all` clears `auth_state.verified` so the UI falls back to
  the login page.

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
  `audit_log_rpc_context`. Filter by `event_type`, manual refresh,
  toggle SSE streaming (via `EventSource` — not RPC).
- `AdminInvites.svelte` — invite CRUD + embeds `OpenSignupToggle`.
  Consumes `admin_invites_rpc_context`. Per-row delete reads
  `state.remove.loading(invite_id)` / `state.remove.error(invite_id)`
  with inline per-row error display.
- `AdminOverview.svelte` — dashboard panels (accounts / sessions /
  invites / recent activity / security / system). Consumes all four
  RPC contexts plus `auth_state_context`; fetches in parallel on mount.
  Derives `role_counts`, `failed_logins`, `role_grant_changes` from
  the audit log. `role_counts` is display-only and scope-blind — an account
  counts under each role it holds at any scope.
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
  `/api/surface` (REST) and delegates to `SurfaceExplorer`.
- `OpenSignupToggle.svelte` — single checkbox bound to
  `AppSettingsState.settings.open_signup`. Consumes
  `app_settings_rpc_context`.
- `SurfaceExplorer.svelte` — reads-only `AppSurface` renderer. Props:
  `surface: AppSurface`. Filter routes by auth type; expand a row to
  dump `params`/`query`/`input`/`output`/`errors` schemas as JSON.
  Also tables middleware, env, events, and diagnostics.

## Role grant offers

- `RoleGrantOfferInbox.svelte` — recipient-side pending inbox; renders
  `RoleGrantOffersState.incoming`. Props: `format_actor?`, `format_scope?`,
  `format_role?` — consumers plug in display names for actor/scope ids.
  Accept is a `PendingButton`; decline is a `ConfirmButton` whose
  popover contains a textarea (max `ROLE_GRANT_OFFER_MESSAGE_LENGTH_MAX`).
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
  `history`, `create`, `accept`, `decline`, `retract`. Holds six
  `AsyncSlot`s — five `AsyncSlot<void>` for status/error tracking
  (`list` / `list_history` / `accept` / `decline` / `retract`) plus
  one `AsyncSlot<RoleGrantOfferJson>` (`create`) that owns the
  created offer so `submit_create` returns it via the slot's
  supersession-safe `data` path. The `$state.raw` Map cache keyed by
  offer id stays on the class (multiple ops + WS notifications merge
  into it). Methods use the `submit_*` prefix to avoid slot-name
  collisions (`submit_create` / `submit_accept` / `submit_decline` /
  `submit_retract`); the fetch slot is named `list_history` so the
  derived view stays natural as `history`. `$derived.by` views:
  `incoming` (recipient-side pending, soonest-expiry first),
  `outgoing` (grantor-side pending, newest-created first), `history`
  (all known, newest-created first). Reducer `apply_notification`
  handles the six role-grant-offer notification methods;
  `role_grant_revoke` is deliberately ignored here (auth/role_grants
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
- `sidebar_state.svelte.ts` — see Shell + layout above.

## Per-domain state modules

All state classes hold per-op `AsyncSlot`s for the fetch + singular
write verbs, and `KeyedAsyncSlot`s for per-row write verbs (the
`SvelteSet<id>` pattern is retired — per-row tracking lives on the
keyed slot's `loading(key)` / `error(key)` accessors). Method names use
the `submit_*` prefix where the verb collides with a slot name.

- `account_sessions_state.svelte.ts` — `AccountSessionsState` +
  `account_sessions_rpc_context` + narrow `AccountSessionsRpc`
  (`list`, `revoke`, `revoke_all`). Slots: `list` (AsyncSlot),
  `revoke` (`KeyedAsyncSlot<string, void>` keyed by `session_id` for
  per-row independence), `revoke_all` (AsyncSlot). Methods: `fetch`,
  `submit_revoke(id)`, `submit_revoke_all`. Derived `active_count`.
- `audit_log_state.svelte.ts` — `AuditLogState` +
  `audit_log_rpc_context` + narrow `AuditLogRpc` (`list` +
  `role_grant_history`). Slots: `list`, `role_grant_history`. Fields:
  `events`, `role_grant_history_events`, `connected`. Internal
  `#last_seq` for SSE gap fill on reconnect. Methods:
  `fetch(options?)` (RPC), `fetch_role_grant_history`, `subscribe()`
  (opens `EventSource` at `#stream_url`, default
  `/api/admin/audit/stream`; prepends new events to `events`; refills
  gap via `since_seq`), `disconnect()`. SSE stays on `EventSource` —
  streaming is not an RPC concern.
- `admin_accounts_state.svelte.ts` — `AdminAccountsState` +
  `admin_accounts_rpc_context` + narrow `AdminAccountsRpc` (nine
  methods: `list_accounts` (`include_deleted?`), `delete_account`,
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
null`; default returns `null` so callers fall back to the raw uuid.
  Provisioned by `provide_admin_rpc_contexts(adapters, {format_scope})`.
  Consumed by `AdminAccounts`, `AdminRoleGrantHistory`, `RoleGrantOfferInbox`,
  `RoleGrantOfferHistory` via the `resolve_scope_label(scope_id, role,
format_scope, global_label)` helper — `global_label = null` renders no
  chip (admin tables); `'global'` renders an explicit label (offer
  surfaces). `RoleGrantOfferInbox` / `RoleGrantOfferHistory` accept a
  `format_scope?: FormatScope` prop — same shape as the context, prop
  wins when supplied.
- `sidebar_state_context` — `() => SidebarState`. Provisioned by
  `AppShell`. A toggle reading it for `aria-controls` needs the state's
  `sidebar_id` option set (see Shell + layout).

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
    specific metadata summary (bespoke cases for the common event types,
    JSON-stringified fallback for the rest).
