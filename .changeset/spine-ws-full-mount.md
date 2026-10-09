---
'@fuzdev/fuz_app': minor
---

**breaking** feat: the TS spine test binary serves its full action set on WebSocket, and the WS action rate-limit suite drives the account axis at the WS dispatcher

- testing: **breaking** `full_spine_rpc_endpoints` is replaced by `build_full_spine_mount(deps, options)` (`testing/cross_backend/full_spine_mount.ts`), returning `FullSpineMount` (`{rpc_actions, ws_actions}`) built from one action list: the RPC list is `build_full_spine_rpc_actions`'s, and the WS list is `protocol_actions` plus every RPC action not already among them. Mount `rpc_actions` on an `rpc_endpoints` entry at `SPINE_RPC_PATH` and `ws_actions` on the `ws_endpoints` entry
- testing: fuz_app's own spine binary mounts that WS list on `/api/ws` (it mounted the protocol and account actions), so its WS method set matches the Rust `testing_spine_stub`, which serves one registry on RPC and WS — cell verbs, admin, role-grant-offer, actor resolvers, and the daemon-token-gated `_testing_*` actions included
- testing: `describe_ws_action_rate_limit_cross_tests` adds two `cell_create` cases over a real socket — refused with `rate_limited` on the WS call past the cap, and one account budget across HTTP RPC and WS — pinning the account axis of both spines' WS dispatchers
