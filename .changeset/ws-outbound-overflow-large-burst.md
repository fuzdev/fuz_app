---
'@fuzdev/fuz_app': patch
---

test: `describe_ws_outbound_overflow_cross_tests` gains a case — a burst of 3 MiB in megabyte frames (`_testing_flood_notifications {count: 3, size: 1048576}`), within the 4 MiB default budget, must arrive whole and in order with its response last and the socket still answering. A backend whose WebSocket outbound budget is under about 3.1 MiB, or whose flood action refuses that burst, fails it
