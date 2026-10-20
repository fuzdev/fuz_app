---
'@fuzdev/fuz_app': minor
---

feat: `describe_login_security_cross_tests` pins that every `X-Forwarded-For` line is read

- `LoginSecurityCrossTestOptions` gains an optional `base_url`; given one, a raw-socket case exhausts a forwarded IP and then sends a login with a spoofed `X-Forwarded-For` line ahead of that IP's line, which must still `429` — a backend that read only the first line would key it on the spoofed address. Without `base_url` the case is skipped
