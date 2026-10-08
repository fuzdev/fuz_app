---
"@fuzdev/fuz_app": minor
---

**breaking** deps: bump @fuzdev/fuz_css@0.65.0 and add it as an optional peer dependency (`>=0.65.0`)

The `ui/` components use the 0.65 class names - `palette_X` chips and buttons,
`sized_sm`, and `background-color:var(--bg_100)` on confirm buttons - so
consumers styling them with fuz_css need 0.65 or later.
