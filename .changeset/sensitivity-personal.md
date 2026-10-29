---
'@fuzdev/fuz_app': minor
---

feat: new `Sensitivity` level `'personal'` (`sensitivity.ts`) for personal data such as search terms about people — kept out of URLs (a sensitive read goes as a `POST`, by the `FrontendHttpTransport` rule) but, unlike `'secret'`, not masked in logs or UI; `schema_sensitivity` answers the strongest level reached, `'secret'` over `'personal'`. `actor_search`'s `query` is tagged `'personal'`
