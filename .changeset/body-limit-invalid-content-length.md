---
'@fuzdev/fuz_app': minor
---

**breaking** fix: the body limit refuses a `Content-Length` that is not a plain run of ASCII digits — `abc`, `-1`, `+5`, `1e9`, `0x1F4`, an empty value, a combined `5, 500` — with `400` `{error: 'invalid_content_length'}` (new `ERROR_INVALID_CONTENT_LENGTH`) and `Connection: close`, before auth and without reading the body. Before, such a value compared as not over the cap and Hono's `bodyLimit` passed the request on without counting its body, so the cap held only because the runtime's HTTP parser refused the request first. Node's parser refuses every such form; the requests that now answer `400` where they used to pass are a repeated `Content-Length` header on Deno (equal values) and Bun (equal or differing values), and an empty one on Bun. A digit run too long to hold exactly is over the cap (`413`)
