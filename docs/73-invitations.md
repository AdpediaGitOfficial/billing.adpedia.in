# 73 · Inviting somebody

**Status: done.** 983 tests (411 unit + 572 integration), typecheck and lint clean,
production build passes.

The last module-sized item on `docs/00 §7`. `docs/35 §6` left the users page read-only and said
why: *"inviting a user is creating a credential"*. That is the whole design — everything here
follows from treating the invitation as one.

---

## 1. 🔴 The token is a credential, and is held like one

Thirty-two random bytes, and **only its sha256 is stored** — the same discipline as the refresh
tokens in `auth/tokens.ts`. A database leak cannot be replayed, and nobody can read an
invitation back afterwards, including the owner who sent it. It is returned once, by
`createInvitation`, and shown once, on the page that created it.

🔴 **It is not in the audit log either.** The log records the email, the role and the expiry;
it does not record the token. An audit log is a thing people read, which is the point of it.

It expires after seven days and it is single-use.

## 2. 🔴 Accepting it does not create a session

A link in an email that signs you in **is a password**: forwarded without thinking, logged by
a proxy, and sitting in a mailbox for years afterwards. Accepting sets a password and stops;
the action redirects to `/login`, and the person signs in like anybody else, through everything
that guards an ordinary sign-in.

The service returns `{ email }` and a test asserts those are the only keys, so that nothing
usable as a session can drift into it later.

The role is fixed by the inviter. The invitee supplies a password and nothing else.

## 3. 🔴 The public half must not be an oracle

`/invite/[token]` is reachable by anybody. Unknown, expired, revoked and already-accepted all
render **the same page** and raise **the same error**, and a test asserts the three refusals are
one string. Distinguishing them turns the page into a way to ask whether a token ever existed
and whether it is still live.

🔴 The inviter's side is the opposite, and deliberately. `createInvitation` refuses by name —
"they are already on this company", "that address already has an account" — because the inviter
can already read every membership on this page. Saying it leaks nothing *there*; the rule is
about who is asking, not about the sentence.

🔴 **An invitation must not be able to set an existing user's password.** An address that
already has an account anywhere on the system is refused, and says so. The obvious convenience
— "invite them again, they'll just set a new password" — is a password reset with no identity
check in front of it.

## 4. 🔴 Claim it before creating anything

```ts
const claimed = await tx.invitation.updateMany({
  where: { id, acceptedAt: null, revokedAt: null },
  data: { acceptedAt: new Date() },
})
if (claimed.count !== 1) throw bad
```

Two submissions racing — a double-click, a retried POST — both find an unaccepted invitation if
they read before either writes, and would then both create a user. The conditional update is
the claim; the second one matches nothing and loses. It is the same discipline as the offline
queue's `clientKey` in `docs/30 §1`, asked of a different race.

## 5. 🔴 The middleware is where a route disappears

`/invite` has to be reachable without a session, because the person has no account yet. A
redirect to `/login` turns an invitation into a dead end, and the only symptom is somebody
saying the link does not work.

This is exactly `docs/30 §8`, where the auth matcher excluded `api`, `_next`, `brand` and the
manifest but not `/sw.js` — so the service worker was redirected to `/login`, registration
failed silently, and the whole offline expense queue went with it. It was caught then by
*requesting* the routes rather than reading the config, and nothing was left behind to catch it
again.

`tests/public-routes.test.ts` is that guard, and it checks both halves, which fail differently:

1. the **matcher** decides whether the middleware runs at all — a path excluded there is
   invisible to every rule below it;
2. the **middleware** decides whether to redirect.

⚠️ The matcher is evaluated in the test as a plain `RegExp`. Next compiles it with
path-to-regexp, which is not identical — but for the negative-lookahead shape this one uses the
two agree, and the question being asked is whether a path was forgotten.

## 6. Nothing is emailed

This system has no mailer, and `docs/61` settled why: a message that matters goes from a
person's own address, under their own name. The owner gets a link and sends it the way they
send a chase.

That also means **the link is shown once and cannot be recovered** — which the page says, rather
than letting somebody discover it by coming back tomorrow.

## 7. Still open

- **Removing somebody** is still deactivating their user, not removing the membership. That is
  the right default for a finance system — an audit log points at a user id that has to keep
  resolving — but there is no screen for it, and `/settings/users` now says so.
- **Changing somebody's role** has no screen either. It is one field and the same guard.
- **No invitation for a second company.** The model carries `companyId` and the system has one
  company; a user joining a second would want the membership added rather than an account
  created, which is the branch §3 currently refuses.
- Carried forward from `docs/00 §7`: opening balances at year-end close, IRN and QR on the
  invoice template, server-side pagination on the three 100-row lists, and the ITR/GSTR-9
  financial-year question from `docs/72 §2`.
