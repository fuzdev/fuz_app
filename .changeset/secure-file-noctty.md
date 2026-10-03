---
'@fuzdev/fuz_app': patch
---

fix: open a secure file with `O_NOCTTY` so a terminal at its path can't become the controlling terminal
