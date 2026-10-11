---
'@fuzdev/fuz_app': minor
---

**breaking** feat: refuse `POST`s a browser can send cross-origin without a preflight, which carry the session cookie from any same-site page (every other port on the host included). Every `POST` route now requires `Content-Type: application/json`, bodyless or not, and answers 415 `unsupported_content_type` before auth, matching the Rust spine; mark raw-byte `POST` routes `raw_body: true` to accept any type but none, `text/plain`, form, and multipart. `merge_error_schemas` requires the route's `method` and derives 415 for `POST`s; `FrontendHttpTransport` merges caller headers over its JSON defaults; `AuthState.logout` sends JSON; a `bootstrap.route_prefix` outside `/api/` throws at assembly. Adds the `http/simple_request.ts` predicates and the `describe_simple_request_cross_tests` suite
