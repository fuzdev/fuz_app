---
'@fuzdev/fuz_app': patch
---

fix: the attack-surface harnesses test the gate, not the stub deps

- fix: `describe_adversarial_404`'s stub answers its 404 definition's fields beside the code, generated from the definition's schema, so a 404 whose body requires a field (a `message`) passes its own schema; fields the generator can't satisfy throw at collection, naming the route
- fix: `describe_rpc_attack_surface_tests`' "correct auth passes" sends each protected method valid params (`input_overrides` or generated) to a rebuilt endpoint whose handlers are recording stubs, and asserts the handler was reached at 200 — a handler's own refusal over stub deps (`account_verify`'s live account re-read answering 401) no longer reads as the gate's. A consumer that filtered such methods out of the surface can drop the filter
