---
'@fuzdev/fuz_app': minor
---

feat: the login-security suite's concurrent correct-login burst asserts the account ends at exactly the session cap

- feat: `describe_login_security_cross_tests` takes `max_sessions` (default `DEFAULT_MAX_SESSIONS`) and `rpc_path` (default `SPINE_RPC_PATH`); a backend with `concurrent_transactions` that overrides the TS session cap passes it
