---
'@fuzdev/fuz_app': minor
---

break: the `zod` peer floor moves from `^4` to `^4.6`. Zod 4.3 accepts an ISO datetime without seconds (`HH:MMZ`) that 4.6 refuses, so `Datetime` and every schema built on `z.iso.datetime()` read differently by the installed zod; the floor makes the grammar one across consumers. To migrate: upgrade `zod` to `^4.6` alongside fuz_app.
