---
'@fuzdev/fuz_app': patch
---

fix: refuse a FIFO, device node, or directory at a secure-file path (`load_secure_file_node` opens with `O_NONBLOCK` and checks for a regular file; the Deno runtime checks before and after its open)
