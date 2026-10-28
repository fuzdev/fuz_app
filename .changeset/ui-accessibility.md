---
'@fuzdev/fuz_app': minor
---

fix: UI accessibility — `Popover` closes on Escape while visible (before an enclosing `AppShell` overlay, which stays open; the newest visible popover first; never past an open modal it isn't inside), labels its dialog by the trigger, and sets `aria-controls` only while visible; `Datatable` is an ARIA `table` with `row`/`cell` roles and an empty state inside a row spanning every column; `SurfaceExplorer` rows expand from a keyboard-reachable `<button aria-expanded>`, and its auth chips label credential-gated routes instead of `other`
