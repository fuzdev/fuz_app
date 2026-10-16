---
'@fuzdev/fuz_app': patch
---

fix: `create_extract_global_flags` resolves a global `no-` pair given both ways (`--color -C`, `-C --color`) to the side given last, not the side declared last in the schema, with `@fuzdev/fuz_util` >=0.75.1; of two aliases of one global given without its canonical name, the one given first wins, not the one listed first in the schema; an arg named `__proto__` is an own key of `remaining`, and an entry named like an `Object.prototype` member reads as absent when not given
