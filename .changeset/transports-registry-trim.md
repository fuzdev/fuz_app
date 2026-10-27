---
'@fuzdev/fuz_app': minor
---

break: `Transports` keeps `register_transport` and `get_transport` — `set_current_transport`, `get_current_transport`, `get_current_transport_name`, `get_transport_by_name`, `is_ready`, and `allow_fallback` are removed (the first registered transport is the default, and fallback to a ready transport always applies). To migrate: name the transport per call (`transport_name`, `transport_for_method`) or register the preferred one first
