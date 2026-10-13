---
'@fuzdev/fuz_app': patch
---

test: `describe_body_size_cross_tests` gains four cases — a declared `Content-Length` over the cap answers `413` with a disallowed `Origin` (not `403`; the same `Origin` on an under-limit body still answers `403`) and with no credentials (not `401`), and an authenticated chunked body past the cap answers `413`. `describe_body_size_smuggling_cross_tests` gains two — a request carrying both `Content-Length` and `Transfer-Encoding`, in either order, with a `GET` pipelined behind it: the status is the backend's, the server must close the connection, and the `GET` must not be served. A backend whose body cap sits inside its origin check, or whose HTTP server keeps the connection after such a request (hyper before 1.11.1), fails them
