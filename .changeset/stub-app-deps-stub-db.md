---
'@fuzdev/fuz_app': patch
---

fix: `create_stub_app_deps`'s `db` is a fresh `create_stub_db()`

- fix: the stub deps carried a shared no-op proxy as `db`, whose `transaction` resolved without calling its callback and whose `in_transaction` read truthy, so work on stub deps that opened a transaction (an auth cleanup pass) silently skipped its body. Each call now gets a `create_stub_db()`: the callback runs on a transaction-scoped stub, and the pool-level `Db` reads as outside a transaction
