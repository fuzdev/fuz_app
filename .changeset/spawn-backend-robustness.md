---
'@fuzdev/fuz_app': minor
---

fix: `spawn_backend` refuses a `base_url` whose port already accepts connections, deletes a stale daemon-token file before spawning, bounds each health probe by a request timeout, keeps a bounded stderr tail, reports an early exit's code or signal, logs an unexpected exit after startup, and tears down the child's whole process group even once the child itself has exited; new `is_port_accepting` and `create_output_tail`
