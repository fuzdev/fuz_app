---
'@fuzdev/fuz_app': minor
---

feat: add shared testing helpers — `raw_http_send_head` and `RawHttpHeadRequest` (`testing/transports/raw_http.ts`), the head-only over-cap probe that reads the refusal without racing the upload; `RAW_WS_UPGRADE_HEADERS` (`testing/transports/ws_raw_client.ts`), an upgrade request's headers for probing an upgrade refusal; `empty_owned_database` and `EmptyOwnedDatabaseOptions` (`testing/cross_backend/postgres_database.ts`), which empties the one database a cross-backend setup owns and reports a missing database or an unreachable server with what to check; and `TEST_ORIGIN` + `create_test_request_headers` (`testing/test_origin.ts`), the origin the in-process test server allows and the headers its requests start from
