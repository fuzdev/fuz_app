---
'@fuzdev/fuz_app': patch
---

feat: `declare_skips(reason, paths)` in `testing/cross_backend/declared_skips.ts`

- feat: `declare_skips(reason, paths)` (`testing/cross_backend/declared_skips.ts`) — each test name path mapped to one reason, the entries an `expected_skips` spreads in per cause. To migrate: replace a local `declare_skips` helper in `spine_suites.cross.test.ts` with the import
