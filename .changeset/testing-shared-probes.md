---
'@fuzdev/fuz_app': minor
---

feat: add `raw_http_send_head` and `RawHttpHeadRequest` (`testing/transports/raw_http.ts`), the head-only over-cap probe that reads the refusal without racing the upload, and `RAW_WS_UPGRADE_HEADERS` (`testing/transports/ws_raw_client.ts`), an upgrade request's headers for probing an upgrade refusal
