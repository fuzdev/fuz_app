---
'@fuzdev/fuz_app': patch
---

fix: `actor_lookup` (`query_actors_by_ids`) and `actor_search` (`query_actor_search`, both paths) return only active actors of active accounts — a soft-deleted actor, or any actor of a soft-deleted account, drops out as an unknown id does
