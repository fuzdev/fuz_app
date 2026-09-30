---
'@fuzdev/fuz_app': minor
---

**breaking** feat: `AppShell`'s open narrow overlay is a focused modal dialog, and toggles outside the shell can target the sidebar

- while open, the sidebar has `role="dialog"`, `aria-modal="true"`, `tabindex="-1"`, and `aria-label` from the new `sidebar_label` prop (default `'sidebar'`); the wide sidebar gets none of them
- `aria-modal` lets assistive tech hide everything outside the sidebar, the built-in toggle included — a sidebar whose screen-reader users need a close control beyond Escape and navigation renders its own
- opening moves focus into the sidebar — to its first control that takes focus, else the sidebar itself — where before it fell to the body as the content went `inert`
- a scrim click now returns focus like Escape
- new `SidebarState` option `sidebar_id` sets the sidebar's id, so a toggle outside `AppShell` can carry `aria-controls` and be the focus-return fallback when the opener never took focus (Safari doesn't focus a clicked button); `aria-controls` is now read as an id list
