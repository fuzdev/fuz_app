---
"@fuzdev/fuz_app": minor
---

**breaking** feat: `ColumnLayout` stacks below fuz_css's `sm` width, its aside hidden behind a toggle

Below 640px of its own width at the default font size - a container query,
so a nested layout decides for itself - `ColumnLayout` stacks its columns
and hides the aside by default behind a toggle button. Opened, the aside
sits in flow above the content and pushes it down, scrolled into view under
the toggle; navigation closes it. With a bounded height, the stacked layout
scrolls as one column and the toggle sticks to its top; under a parent that
grows with its content, the page scrolls and the toggle scrolls away with
it. Wider than that, it renders as before.

- the new `aside_label` prop (default `'menu'`) is the toggle's text and
  the `<aside>`'s `aria-label`
- **breaking** the root is now an `inline-size` query container, so a
  layout placed where it would shrink to fit its content collapses to zero
  width - give it a width from its context
- **breaking** the columns sit in a new inner element, so `.column-fixed`
  and `.column-fluid` are no longer children of `.column-layout`
- **breaking** `ColumnLayout` now imports `$app/navigation`, so it needs the
  SvelteKit runtime, as `AppShell` does
- `--column_toggle_bg` sets the stacked toggle bar's background (default
  `--shade_00`)
