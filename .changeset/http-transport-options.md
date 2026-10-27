---
'@fuzdev/fuz_app': minor
---

break: `FrontendHttpTransport` takes an options object — `new FrontendHttpTransport({url, headers?, lookup_action_spec, max_get_url_length?})` — and derives its request policy from each method's spec instead of a `has_side_effects` callback: a read (`side_effects: false`) goes as a `GET`, now without a `content-type`, and as a `POST` when its input carries a `'secret'` or `'personal'` value at any depth (new `schema_has_sensitive_field` in `schema_meta.ts`, walked once per spec) or its path and query exceed `max_get_url_length` (`DEFAULT_MAX_GET_URL_LENGTH`, 4096); a method the lookup doesn't know is a `POST`. To migrate: `new FrontendHttpTransport(url, headers, has_side_effects)` becomes `new FrontendHttpTransport({url, headers, lookup_action_spec})`, passing the lookup your dispatcher environment uses (`(method) => registry.spec_by_method.get(method)`); a transport that should send every call as a `POST` passes `() => undefined`
