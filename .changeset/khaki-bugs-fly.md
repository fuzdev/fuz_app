---
'@fuzdev/fuz_app': minor
---

feat: emit `outcome=failure` audit rows on every signup denial path (`reason: 'no_match' | 'race_lost' | 'signup_conflict'`); widen `signup` metadata schema to declare `reason` + `email` for forensic correlation
