---
'@fuzdev/fuz_app': minor
---

break: `SseStream.comment()` is removed — nothing called it, and it wrote no terminating blank line; the stream's keep-alive writes its own comment. To migrate: drop `comment` from a hand-built `SseStream`
