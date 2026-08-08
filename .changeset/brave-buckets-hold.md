---
'@fuzdev/fuz_app': minor
---

fix: stop a successful auth from refunding the per-IP rate limit budget, and give each auth surface its own IP bucket

**Behavior change on every auth route.** A successful login, password change,
signup, or bootstrap no longer calls `reset` on a per-IP limiter. The
account-grain reset stays where one exists — login, password change, and signup.
Bootstrap has no account-grain bucket (it predates any account), so a successful
bootstrap now clears nothing at all.

The per-IP bucket is the distributed-spray backstop, and refunding it on success
made that budget unbounded: an attacker holding any one credential could
interleave their own logins with guesses against arbitrary victim usernames and
spray indefinitely from a single address. The per-account limiter still bounds
any single target, but the IP-level aggregate — the thing that bounds guessing
*across* targets — was neutralized by one login. Under `open_signup` the cheapest
version needs no credential at all: creating a throwaway account zeroed the
budget, and the per-account limiter never applies to the attacker's own signups.

Clearing the account-grain bucket is safe for the reason the IP one isn't: that
key *is* the account being attacked, so clearing it requires that account's
credential and can only widen the budget against an account the caller already
holds.

Rejected alternative worth naming: decrementing instead of zeroing. It reads as
the moderate option and is not one — at the cap the attacker cycles
success-then-guess forever, doubling the cost per guess while leaving the budget
unbounded. The cross-backend and in-process tests both bound total requests
specifically so that implementation fails them.

**Breaking: `ip_rate_limiter` is gone, replaced by three per-surface fields.**
On `AppServerOptions` and `AppServerContext`:
`login_ip_rate_limiter` (login + password change), `signup_ip_rate_limiter`,
`bootstrap_ip_rate_limiter`. The route-factory options follow —
`AccountRouteOptions.login_ip_rate_limiter`,
`SignupRouteOptions.signup_ip_rate_limiter`,
`BootstrapRouteOptions.bootstrap_ip_rate_limiter` — and
`AuthSessionRouteOptions` no longer carries a limiter field at all (each factory
names its own). Each defaults to its own 5/15min limiter when omitted; `null`
still disables. **A consumer that passed `ip_rate_limiter: null` to disable
rate limiting must now pass all three**, or signup and bootstrap silently get
live default limiters. Startup config diagnostics now name the disabled surface.

The split is what makes the monotone bucket affordable. Once a success no longer
refunds it, one shared instance means a failure on any surface spends the budget
that bounds guessing on every other one: a fumbled bootstrap token leaves the
operator's *login* budget nearly exhausted on a deployment where their new
account is the only one that exists, and an open-signup bot denies login to
every user behind its egress. Login and password change still share one instance
— password change is password-bearing on the same account grain, and the Rust
spine shares `login_ip_rate_limiter` across both.

The 5-attempt cap was deliberately **not** widened. Widening buys NAT'd-egress
headroom by loosening the one bound that caps credential guessing from a single
address; splitting the shared bucket buys the same headroom without touching
that bound. Consumers wanting the old single-budget posture pass the same
`RateLimiter` instance to all three fields.

**Costs to accept**, now bounded per-surface but not eliminated: on a NAT'd
egress the IP budget is unforgiving within its window, and accidental exhaustion
is likelier than under the refund. Sustaining a *deliberate* lockout also got
cheaper — under the refund an attacker holding an egress at the cap lost the
whole bucket the moment any user logged in successfully; now losing that race
costs them nothing. The refund was never a defense against this (a full bucket
refuses the very success that would clear it), but it did make the attack
fragile. There is no operator "clear this IP" action; within a window the
remedies are waiting it out or restarting. All documented in `docs/security.md`
§Rate Limiting.

Converges with the Rust spine, which had the identical refund defect and already
kept `signup_ip_rate_limiter` separate from `login_ip_rate_limiter`. Pinned on
both impls over real HTTP by a new `login_security` cross-backend case
(interleaved successes must still 429 within a bounded request budget) and
in-process by `rate_limiter.handlers.test.ts` (login + signup),
`password_change.test.ts`, and `rate_limiter.bootstrap.db.test.ts`.
