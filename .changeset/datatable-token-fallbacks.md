---
'@fuzdev/fuz_app': patch
---

fix: `Datatable` reads the `--shade_00` and `--border_width` fuz_css tokens without redundant fallbacks, so svelte-docinfo no longer lists them as its styling API
