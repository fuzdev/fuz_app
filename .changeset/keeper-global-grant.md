---
'@fuzdev/fuz_app': patch
---

fix: `query_role_grant_find_account_id_for_role` (the daemon-token keeper resolution) matches only global grants of the role — for every role it is passed, not just `keeper` — so a scoped `keeper` row no longer resolves the keeper account
