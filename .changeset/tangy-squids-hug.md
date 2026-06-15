---
'@fuzdev/fuz_app': minor
---

test: improve cross-backend tests and tighten some inputs

- `Email`: structural `local@domain.tld` regex (replaces `z.email()`), 254-**byte** bound (RFC 5321 octets), rejects `White_Space ∪ {U+FEFF}`, accepts `a@b.c` + consecutive dots
- signup `email` now `nullish` (`null` = absent)
- `SMTP_USER` → `sensitivity: 'secret'` (masked in startup summary); `PORT` → integer `1..=65535`
