---
'@fuzdev/fuz_app': patch
---

fix: the Node cross-backend test adapter (`create_node_testing_adapter`) sets the `ws` frame cap at twice `max_message_bytes`, as the Bun adapter does, so a message just over the limit closes with `WS_CLOSE_MESSAGE_TOO_BIG` and `WS_CLOSE_MESSAGE_TOO_BIG_REASON` rather than the frame layer's reasonless 1009 — the `ws_round_trip` cross suite now pins the reason on every backend
