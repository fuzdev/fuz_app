---
'@fuzdev/fuz_app': minor
---

fix: an invite-gated signup whose invite claim matches no row (a broken `FOR UPDATE` invariant) now throws, rolling the account back and answering 500 with an `internal_error` audit, instead of keeping an account no invite admitted
