---
'@fuzdev/fuz_app': patch
---

fix: the testing harnesses send each route's content type on every probe (`to_route_content_type`: JSON, or `application/octet-stream` for `raw_body`), so a bodyless `POST` reaches the gate a case asserts instead of the 415; the derived 415 is now `UnsupportedContentTypeError`; the cross-backend standard bundle forwards `data_exposure_skip_routes`
