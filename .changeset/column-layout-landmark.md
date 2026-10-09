---
"@fuzdev/fuz_app": minor
---

**breaking** feat: `ColumnLayout`'s aside column is no longer a landmark, and `AppShell`'s content floor is the small viewport

- **breaking** the aside column is a plain `<div>`, not a complementary
  `<aside>`, as with `AppShell`'s sidebar - render the landmark inside the
  `aside` snippet, a `<nav aria-label>` for navigation links (a snippet that
  already renders one needs only the `toggle_label` rename)
- **breaking** `aside_label` is renamed to `toggle_label` (default `'menu'`),
  since it now only names the stacked toggle
- `AppShell`'s `.app-shell-content` floor is `min-height: 100svh`, not
  `100vh`, so on mobile it never scrolls the page with the toolbar shown and
  doesn't relayout as the toolbar moves
