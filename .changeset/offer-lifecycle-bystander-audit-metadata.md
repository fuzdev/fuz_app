---
'@fuzdev/fuz_app': minor
---

break: shipped cross suites parse audit metadata against its event's schema and drive more verbs

- `list_audit_events` (`testing/cross_backend/audit_cross_helpers.ts`) and the audit reads of `describe_standard_admin_integration_tests` parse every row's `metadata` against `audit_metadata_schemas[event_type]` as declared, through the new `assert_audit_event_metadata` (`testing/audit_drift_guard.ts`): a mistyped, `null`, or missing field fails the read; a key the event doesn't declare passes, and consumer-registered event types pass unexamined. A backend whose metadata drifts from its event's schema now turns these suites red
- `assert_audit_event_metadata(event, {reject_unknown_keys: true})` also refuses undeclared keys; the setups take `reject_unknown_audit_metadata_keys` (`default_cross_process_setup`, `default_in_process_setup`, `default_in_process_suite_options`), exposed on the fixture, which every reader above passes through — for a spine's own suite, where no consumer adds fields; `assert_audit_metadata_fields` (`audit_cross_helpers.ts`) checks a row's metadata values field by field, comparing the whole object only under that flag
- the admin suite's completeness test also drives `account_token_revoke`, `account_session_revoke`, `invite_create` + `invite_delete`, and `app_settings_update`, expecting their audit rows; a step whose actions the surface doesn't mount is skipped
- `describe_account_lifecycle_cross_tests` reads the `account_delete`, `account_undelete` and `account_purge` success rows, each snapshotting the target's username, and the refused undelete's `outcome=failure` row naming the probed id
- `describe_role_grant_offer_notification_ws_tests` opens a third account's socket in every case and fails when it receives anything but the answers to its own requests
- adds `describe_role_grant_offer_lifecycle_cross_tests` (`testing/cross_backend/role_grant_offer_lifecycle.ts`): a decline or retract by a non-party → 404 identical to a missing offer, a decided offer → 400 `role_grant_offer_terminal`, and one audit row per success, none per refusal
