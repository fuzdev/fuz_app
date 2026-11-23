---
'@fuzdev/fuz_app': patch
---

fix: the Bun test-server adapter finishes a request in flight on a clean shutdown

- fix: `create_bun_testing_adapter`'s `shutdown` awaits `server.stop(false)`, as the Node adapter awaits `server.close()`. It called `server.stop(true)` without awaiting it, which reset a request still in flight when the SIGTERM landed: the client got no response while the binary exited `0`, so teardown's exit check passed
- fix: Bun 1.4.4 is the tested floor (was 1.4.3) — CI's `cross-ts` job pins it, since the clean shutdown that finishes a request in flight is verified on 1.4.4 only
