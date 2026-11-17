---
'@fuzdev/fuz_app': minor
---

breaking: remove `ui/AppShell.svelte`, `ui/sidebar_state.svelte.ts`, `ui/MenuLink.svelte`, and `ui/ColumnLayout.svelte`, which moved to fuz_ui 0.229.0 as `@fuzdev/fuz_ui/AppShell.svelte`, `@fuzdev/fuz_ui/sidebar_state.svelte.ts`, `@fuzdev/fuz_ui/MenuLink.svelte`, and `@fuzdev/fuz_ui/ColumnLayout.svelte`

- switch all four imports in one change: fuz_ui's `AppShell` provides its own `sidebar_state_context`, which fuz_app's never matched
- the API changed in the move (fuz_ui's 0.229.0 changelog has the full list): `SidebarState`'s `show_sidebar*`, `toggle_sidebar`, and `sidebar_id` are now `show*`, `toggle()`, and `id`; `MenuLink` takes a resolved `href` in place of `path`; a link to the site root now needs `exact` (it used to match only itself, and now contains every page), and other links select as before, with `exact` available to select an overview only on its own page; `AppShell`'s `sidebar_width` is a CSS length, its `toggle_button` snippet is gone, and its cascade layers are `fuz_ui.app_shell_base` / `fuz_ui.app_shell_narrow`, so a sheet that ordered `@layer fuz_app, overrides;` now orders `fuz_ui`; `ColumnLayout`'s `column_width` and `--column_width` are now `aside_width` and `--column_layout_aside_width`
