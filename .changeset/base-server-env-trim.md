---
'@fuzdev/fuz_app': minor
---

break: `BaseServerEnv` declares only the vars the spine reads (`NODE_ENV`, `PORT`, `HOST`, `DATABASE_URL`, `SECRET_FUZ_COOKIE_KEYS`, `FUZ_ALLOWED_ORIGINS`, `FUZ_ALLOW_ORIGIN_WILDCARDS`, `FUZ_BOOTSTRAP_TOKEN_PATH`), matching the Rust spine; `PUBLIC_FUZ_API_URL`, `PUBLIC_FUZ_WEBSOCKET_URL`, `PUBLIC_FUZ_CONTACT_EMAIL`, `SMTP_HOST`, `SMTP_USER`, `SMTP_PASSWORD`, `FUZ_FACTS_DIR`, and `FUZ_FACTS_X_ACCEL_REDIRECT_PREFIX` are gone (nothing read them — setting the X-Accel prefix never enabled redirect delivery). To migrate: an app that needs one declares it with `.extend()` and, for X-Accel, builds the `XAccelConfig` from it; regenerate any attack-surface snapshot whose `env` table lists the removed vars
