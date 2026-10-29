---
'@fuzdev/fuz_app': minor
---

fix: the cell-scoped fact read (`create_serve_cell_fact_route_spec`) runs the cell view check before the `cell.refs` check, so a cell the caller can't view does the same work, and answers the same bodyless `404`, whether or not it references the hash — its refs no longer show through response timing; `describe_fact_serving_cross_tests` pins the alike answer for an unviewable private cell
