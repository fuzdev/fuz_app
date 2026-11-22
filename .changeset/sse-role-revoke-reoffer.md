---
'@fuzdev/fuz_app': minor
---

feat: shipped cross suites cover the audit stream's role revoke and the re-offer

- `describe_cross_process_sse_tests` closes a second admin's stream on `role_grant_revoke` of its global `admin` grant, and leaves it open and receiving after a revoke of a global grant of a role the stream isn't gated on — the role-matched close, held until now only by unit tests. Scope matching stays with `describe_ws_role_gated_cross_tests`, as the stream's `admin` gate is global-only. New option `other_role` (default `SPINE_PARTICIPANT_ROLE`; `ROLE_ADMIN` skips the keep case); `describe_spine_cross_suites` passes `suite_roles.conferral` as `other_role`
- `describe_role_grant_offer_lifecycle_cross_tests` holds the re-offer: the same grantor re-offering while the offer is pending answers the same offer with the new `message` and `to_actor_id` — naming the recipient's actor narrows it, naming none widens it back — and the inbox holds the one offer; after a decline, a re-offer is a new offer
