---
'@fuzdev/fuz_app': minor
---

break: `create_app_server` throws at assembly when `allowed_origins` is empty — the list refused every browser request — as `FUZ_ALLOWED_ORIGINS` parsing already refuses an empty value — and likewise when a `ws_endpoints` entry sets its own `allowed_origins: []`, which refused every browser upgrade, the error naming the endpoint path. To migrate: a server that passed `allowed_origins: []` lists at least one origin pattern, and a WS endpoint that set an empty list lists one or omits it to take the server's
