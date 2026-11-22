---
'@fuzdev/fuz_app': minor
---

feat: `register_spine_suites` runs a chosen set of the spine cross suites as `describe_spine_cross_suites` builds them

- feat: `register_spine_suites(handle, options, {names?, wrap_setup_test?})` (`testing/cross_backend/spine_suites.ts`, `@internal`) — the one call over the suites `names` lists, each suite's `setup_test` passed through `wrap_setup_test` after the override merge (a setup an override supplies included); `describe_spine_cross_suites` is it with every suite and no wrapper. An empty, unknown or repeated name throws at collection, as does an `exclude` or override for a suite the registration neither runs nor reads beside one it runs (the mount suite reads its probes' siblings), or an `exclude_cases` entry for a suite it doesn't run
- feat: each registry entry states whether fuz_app's transcript differential runs it (`SpineSuiteTranscript`: `'http'`, or `{excluded: reason}`), read with `get_spine_suite_transcript` (`@internal`); the transcript's suite list is the `'http'` entries, so it runs them with the options the one call derives
