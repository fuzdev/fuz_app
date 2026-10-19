---
'@fuzdev/fuz_app': minor
---

feat: validate the origin allowlist strictly, to the grammar the Rust spine shares

- `parse_allowed_origins(raw)` now returns `Result<{origins}, {errors}>` instead of throwing, and reports every refused entry as `{kind, index, entry}` (a blank value is `{kind: 'no_origins'}`); `validate_server_env` returns one error line per refused entry
- nothing is normalized any more: entries a browser would never send are refused — a non-ASCII host (write its punycode), the scheme's default port (`https://example.com:443`), IPv4 or IPv6 written other than a browser writes it (`127.1`, `[::ffff:127.0.0.1]`), a leading-zero port, a stray comma, and anything that isn't http or https
- `should_allow_origin` refuses an `Origin` that isn't visible ASCII, and a repeated `Origin` (which the runtimes join into one value) matches nothing
- adds `OriginPatternErrorKind`, `AllowedOriginsErrorKind`, `ALLOWED_ORIGINS_ERROR_MESSAGES`, and `format_allowed_origins_error` to `http/origin.ts`
- adds the shared conformance table `testing/cross_backend/origin_conformance.json` with `testing/cross_backend/origin_conformance.ts` (`describe_origin_conformance_cross_tests`, `load_origin_conformance`), and the `_testing_origin_check` action (`create_testing_origin_check_action`, not in `create_testing_actions`)
- the front-door table gains unreadable-`Origin` and duplicated-`Origin` rows (403 on every surface)
