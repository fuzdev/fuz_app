---
'@fuzdev/fuz_app': minor
---

fix: a login or signup failure floor of `0` or less (`login_fail_floor_ms` / `signup_fail_floor_ms`), which turns off the username-enumeration timing defense, is announced once per fuz_app module instance (per resolved copy) on stderr (`LOGIN_FAIL_FLOOR_DISABLED_BANNER` / `SIGNUP_FAIL_FLOOR_DISABLED_BANNER` from `auth/fail_floor.ts`, the Rust spine's text) and logged at warn by the route factory; login and signup share `start_fail_floor`
