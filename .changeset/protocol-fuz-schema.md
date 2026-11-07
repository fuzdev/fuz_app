---
'@fuzdev/fuz_app': minor
---

break: the JSON-RPC envelopes and the protocol actions are `@fuzdev/fuz_schema`, and a peer's error reply is read as the Rust spine reads it.

**What moved.** Every schema of `http/jsonrpc.ts` (`JsonrpcRequestId`, `JsonrpcMethod`, the params, `JsonrpcResult`, `JsonrpcRequest`, `JsonrpcNotification`, `JsonrpcResponse`, `JsonrpcServerErrorCode`, `JsonrpcErrorCode`, `JsonrpcErrorObject`, `JsonrpcErrorResponse`, `JsonrpcResponseOrError`), `ActionEventData` (`actions/action_event_data.ts`), the enums `ActionKind`, `ActionInitiator`, `ActionEventPhase` (`actions/action_spec.ts`), `ActionExecutor` and `ActionEventStep` (`actions/action_event_types.ts`), `CancelNotificationParams` and the `cancel` spec's output, the `heartbeat` spec's input and output, `PingActionInput`, `PingRequestParams`, and `PingResponse` (`actions/peer_ping.ts`), and the input and output of the `/api/rpc` routes `create_rpc_endpoint` makes (`literal(null)` and `unknown`). The envelopes are `loose_object`s, the enums `one_of`s, `PingActionInput` a `with_default` that reads an omitted input as `{}`. The types keep their names, read by `Infer`.

**Removed.** `JsonrpcMcpMeta`, `JsonrpcRequestParamsMeta`, and `JsonrpcProgressToken`, which nothing read. `JsonrpcMessage`, `JsonrpcMessageFromClientToServer`, `JsonrpcMessageFromServerToClient`, and `TransportName` are types only, no longer schemas.

**Verdicts.** Every schema accepts and refuses what it did on any value `JSON.parse` makes, but two (`JsonrpcServerErrorCode` and its dependents, and `JsonrpcResult` and its dependents):

- `JsonrpcServerErrorCode` (and so `JsonrpcErrorCode`, `JsonrpcErrorObject`, and `JsonrpcErrorResponse`) refuses a fractional code, as `is_jsonrpc_error_code` and the Rust spine's `i32` codes do. Only a client reading a server's error response parses one, and no server writes a fraction.
- `JsonrpcResult` is `unknown`, typed `unknown` where Zod's `z.json()` typed a JSON value: it needs its key, so the success and error envelopes still tell apart. It takes `±Infinity` anywhere in a result (so `JsonrpcResponse`, `JsonrpcResponseOrError`, and `ActionEventData`'s `response` do too), which `JSON.parse` makes of an out-of-range number such as `1e400` and Zod refused; no server writes one. It also takes values no JSON text holds (`undefined` at a present key, a `Date`).

A parse returns the frame itself, not a copy in schema key order. The issues of a refused request envelope, which only DEV responses carry, are fuz_schema's.

**A peer's error reply.** When a connected client answers a server-initiated request (`peer/ping`) with an error, the TS spine reads its `error` as the Rust spine's `parse_inbound_error` does, with the new `parse_inbound_jsonrpc_error` (`http/jsonrpc_errors.ts`): a code off the base set of `JSONRPC_ERROR_CODES` — a consumer's code included, and any non-integer — is `internal_error`, a `message` that isn't a string is `'peer error'`, and a present `data` is kept as sent. A code written as an integral float (`-32002.0`) reads as that integer on both spines. It forwarded the error unread before: a consumer code reached the caller as itself, a fractional code dropped the client's message, and `error: null` threw inside the handler. A cross-backend case pins both spines.

**The surface: the input moves.** `peer/ping`'s `timeout_ms` is written `minimum: 1` in place of `exclusiveMinimum: 0`, the same integers, on the RPC and the WS endpoint. Nothing else on a surface moves.

**Migration.**

1. Regenerate the action collections (`gro gen`): the protocol rows of a generated `action_collections.ts` read `Infer<typeof …>` in place of `z.infer<typeof …>`.
2. A Zod schema that embeds one of these can't: port it to fuz_schema, or wrap it, as `z.custom<ActionEventData>((v) => is(ActionEventData, v))` does for a Zod cell schema holding `ActionEventData`. An output holding a `JsonrpcRequestId` is a fuz_schema `object`.
3. `X.safeParse(v)` becomes fuz_schema's `parse(X, v)` or `is(X, v)`, `X.parse(v)` becomes `parse_or_throw(X, v)`, and an enum's `.options` is `.def`.
4. Drop imports of the removed MCP schemas; import `JsonrpcMessage*` and `TransportName` as types.
5. A client that answers a server-initiated request with an error uses a base-set code, or the caller sees `internal_error` with its message.
6. Regenerate any committed surface snapshot and review it: the two `peer/ping` `timeout_ms` nodes, and nothing else. The surface move also regenerates the adversarial input cases made from it: `timeout_ms` is now tested below `minimum` and at zero and negative.
