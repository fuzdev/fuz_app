---
'@fuzdev/fuz_app': minor
---

fix: the full spine mount's `_testing_reset` (`build_full_spine_rpc_actions`) empties the cell and fact tables too, so a cross-backend test no longer sees the cells and facts a previous test left
