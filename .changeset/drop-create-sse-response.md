---
'@fuzdev/fuz_app': minor
---

break: remove `create_sse_response` from `realtime/sse.ts`

- break: a handler outside the route system that answered with `create_sse_response(c, log, options)` defines a route instead — `route.open_sse(options)` (`create_sse_stream`) and `route_sse(stream)`, which builds the response after the commit with `SSE_RESPONSE_HEADERS`; no library code or consumer called it
- `create_sse_stream`'s framing, outbound budget, keep-alive and client-disconnect tests now pin it directly; the stream's bytes are unchanged
