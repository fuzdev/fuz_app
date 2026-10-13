---
'@fuzdev/fuz_app': minor
---

**breaking** fix: `describe_body_size_cross_tests` no longer loses its `413` to the close that follows it — against a fast backend that closes with the upload unread, a whole over-cap body sent through `fetch` could fail on its own write (`EPIPE`) before reading the answer. Over a real socket the over-cap cases now write the bytes themselves and send nothing the server leaves unread: a declared `Content-Length` over the cap is sent as the request head alone, and the chunked body stops one byte past the cap, unterminated. Each `413` must arrive within two seconds, so a backend that reads the body before refusing a declared length, or waits for a chunked body's end, fails the suite

- testing: `describe_body_size_cross_tests` takes a required `base_url` — the spawned backend's URL (`handle.config.base_url`) for a cross-process run, `null` for an in-process one, which keeps sending whole bodies through the fixture's transport
- testing: new `testing/transports/raw_http.ts` — `raw_http_exchange` (write caller-built HTTP/1.1 bytes to a raw socket, read until the server closes or until one whole response has arrived), `raw_http_parse_response`, `raw_http_count_responses`, `raw_http_first_status`; the body-size, body-size smuggling and credential-header suites share it
