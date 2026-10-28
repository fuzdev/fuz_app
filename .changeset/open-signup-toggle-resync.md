---
'@fuzdev/fuz_app': minor
---

fix: `OpenSignupToggle` re-syncs its checkbox to the server's `open_signup` once a write settles, so a refused write no longer leaves the box showing the state the server refused
