---
'@fuzdev/fuz_app': minor
---

break: remove exports nothing imports — `query_cell_list_by_creator` (`db/cell_queries.ts`), `query_cell_field_get` (`db/cell_field_queries.ts`), `query_cell_item_get` (`db/cell_item_queries.ts`), `parse_action_event` (`actions/action_event.ts`), `get_audit_metadata` (`auth/audit_log_schema.ts`), `needs_account` (`http/auth_shape.ts`), and the testing helpers `create_expired_test_cookie` / `check_error_response_fields` (`testing/integration_helpers.ts`). To migrate: read `metadata` off the event directly where `get_audit_metadata` narrowed it, and test `auth.account !== 'none'` for `needs_account`
