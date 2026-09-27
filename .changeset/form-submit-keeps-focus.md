---
'@fuzdev/fuz_app': patch
---

fix: keep focus in the auth and role grant offer forms while submitting

- `LoginForm`, `SignupForm`, `BootstrapForm`, and `RoleGrantOfferForm` mark fields `readonly` and the button `aria-disabled` while submitting, not `disabled`; fields no longer dim, and tests asserting `disabled` should check `readonly` / `aria-disabled`
- `FormState` takes optional field names, `new FormState<'username' | 'password'>()`; the default `string` needs no change
