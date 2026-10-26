---
'@fuzdev/fuz_app': minor
---

break: the cross-backend fixture names one account shape — `TestAccountFixture` and `ExtraAccountFixture` are gone, `fixture.create_account` and `fixture.extra_accounts` hand out `TestAccount` (`testing/app_server.ts`); `build_extra_account_fixture` is `to_test_account`, which the cross-process `create_account` now builds through too; `TestFixtureBase` is folded into `TestFixture`
