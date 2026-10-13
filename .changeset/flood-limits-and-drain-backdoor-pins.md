---
'@fuzdev/fuz_app': patch
---

test: two shipped cross-backend suites pin more. `describe_ws_outbound_overflow_cross_tests` gains an HTTP case (with `rpc_path`) — a `_testing_flood_notifications` call at each of the action's limits (`count`, `size`, `count` × `size`) is refused for having no connection, and one past each is refused `invalid_params` with no reason, so a backend whose flood limits differ, or which looks for the connection before it checks them, fails it. `describe_testing_backdoor_cross_tests` adds `_testing_drain_effects` to the methods it fires as anonymous, session and bearer (and on a session socket when `ws` is passed), so a backend wiring the suite mounts that action on its RPC endpoint, and on its WS endpoint when it passes `ws`
