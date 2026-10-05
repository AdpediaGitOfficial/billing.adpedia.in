# 77 · Removing somebody, and changing what they are

**Status: done.** 1,011 tests (411 unit + 600 integration), typecheck and lint clean,
production build passes.

`docs/73 §7` left these as *"both one field and the same guard"*. The field turned out to be one
field. The guard turned out to be three — and building them found that the role a request runs
under was not being read from the database at all.

---

## 1. 🔴 The role came from the token, so a demotion took fifteen minutes

`getContext()` read `claims.role` — the role as it stood when the access token was signed.
`ACCESS_TOKEN_TTL_SECONDS` is 900, so somebody demoted from owner to employee kept **owner
rights for up to fifteen minutes**, across the 145 places that ask `ctx.role`.

Nothing about that was visible. The demotion saved, the page redrew, the audit log recorded it,
and the person it was done to could still close the year.

The fix is one column on a query that was already running on every request: `getContext` reads
the membership's role from the database alongside `tokenVersion` and `isActive`. The claim is
still signed, so tokens issued before the change keep working, and it must never be read again
— a value that is authoritative in one place and stale in another is `docs/56 §2`'s *two
balances with the same name*.

🔴 **And no membership is no access.** The same query now returns null when the person has no
`UserCompany` row for the company in the token, which ends a session on the next request rather
than at the next token expiry.

## 2. 🔴 The three guards

**The last active owner may not be demoted or deactivated.** `settings.users` is owner-only, so
removing the last one leaves a company nobody can administer and no way back except the
database. A system that can lock its own owner out has one failure mode worse than all the
others.

**Nobody may change their own membership.** Not because it is unsafe — guard 1 covers the
lockout — but because it cannot be satisfied honestly: a demotion takes effect on the *next*
request, so the page it was done from is the page that then refuses. By guard 1 there is always
another owner who can do it, so refusing costs nothing.

**A reason, recorded, before it happens.** The same rule as every correction in this system, and
asked in the same breath as the change rather than after it. The question an auditor asks about
a period is who could see what, and from when.

## 3. 🔴 Removing somebody is deactivating them

The user row is never deleted. Every audit entry, every journal entry and every document points
at a user id that has to keep resolving; deleting the row turns a year of history into entries
attributed to nobody. The membership stays too, for the same reason.

`isActive` is checked on every request, so this takes effect at once.

🔴 **Deactivating also revokes the refresh tokens and bumps `tokenVersion`.** Belt and braces
for the one case that matters: a refresh token lives for days, and reactivating somebody months
later must not silently restore the session they held before they were removed.

## 4. Still open

- **No second company**, so "remove from the company" and "deactivate the account" are the same
  act. With a second, they would not be, and the membership would be the thing to delete.
- **A deactivated user's passkeys and push subscriptions stay.** Harmless — neither grants
  access without a session — but a tidier removal would clear them.
- Carried forward from `docs/00 §7`: server-side pagination on the three 100-row lists, and
  splitting account 1240 if a domestic s.9(3) reverse charge is ever confirmed.
