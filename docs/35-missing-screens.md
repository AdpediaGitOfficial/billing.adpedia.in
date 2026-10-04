# 35 · The six dead nav links

**Status: done.** 404 tests (241 unit + 163 integration), typecheck and lint clean,
production build passes.

---

## 1. What was broken

The navigation promised six routes that had no page:

| Route | Who hit it |
|---|---|
| `/receipts` | 🔴 **owner and accountant mobile tab — "Money"** |
| `/approvals` | 🔴 **owner mobile tab — "Approvals"** |
| `/payroll/me` | 🔴 **employee mobile tab — "Payslips"** |
| `/projects` | sidebar, Sales |
| `/settings/company` | sidebar, Settings |
| `/settings/users` | sidebar, Settings |

Three of them are **bottom tabs on a phone**. An owner tapping "Money" got a 404 — the most
visible possible breakage, and invisible from the desktop sidebar.

All the domain services already existed, so these are wiring, not new logic.

## 2. Receipts

Money actually received, the TDS clients withheld on the way, and what is still outstanding.
Links back to the reconcile screen, because most receipts are booked from a matched bank line
rather than keyed by hand — and a receipt booked that way is identical to one that was.

## 3. Approvals

Draft bills waiting on a decision, oldest first, with what is already past due.

Two things it does that a plain list would not:

- 🔴 **A refusal from the TDS resolver is shown in full**, not reduced to "could not
  approve". When a threshold has been crossed retrospectively, or a PAN is missing, that
  message **is** the decision the person has to make.
- **A vendor with no PAN is flagged before approval**, with a link to the PAN register —
  s.206AA forces 20% instead of the section rate, and Form 16A cannot be issued.

Someone without approval rights still sees the list, with a line saying they cannot act on
it. Hiding it would leave them guessing why nothing moves.

## 4. Projects

List with live margin from the same `projectPnl` the report uses, a billed-against-contract
bar, and a create form. The code is uppercased and **unique per company** — it appears on
every project report, so a clash is reported rather than silently suffixed.

## 5. My payslips

🔴 **Matched by email, and scoped to the company.** `Employee` has no `userId`, so the link
is the email address — and without the company filter a shared address could surface another
entity's payslips. A payslip is about as private as this system gets.

Only **approved** runs are shown. A draft can still change, and showing someone a net figure
that later moves is worse than showing nothing.

It explains why the tax moves month to month: s.192 is the estimated annual liability spread
over the remaining months, not a flat rate — and flags the employee's own missing PAN, since
without it their TDS never reaches their 26AS and no Form 16 can be issued.

## 6. Company and Users

Both **read-only, and say so**. Editing company identity changes what appears on documents
already issued, so it should arrive as a migration with an audit trail, not a text box.

The users page renders the **actual permission matrix**, every capability against every role.
To make that possible, `CAPABILITIES` is now a runtime list and the `Capability` type is
**derived from it**:

```ts
export const CAPABILITIES = [...] as const
export type Capability = (typeof CAPABILITIES)[number]
```

🔴 Previously the type was declared beside the matrix with no runtime counterpart. Had the
screen carried its own list, a capability could exist in the matrix and not the list — and
the page would quietly omit a row the server was still enforcing, reading as "nobody can do
this". A test now asserts the list covers every role/capability pair.

## 7. A demo-data bug this surfaced

The **Nuvé — Brand Film** project was created against **Click AR**. Client P&L therefore
attributed ₹1,60,200 of Nuvé's cost to the wrong customer, and the project showed no revenue
because its invoice was never tagged to it. Both fixed; Nuvé now reads ₹2,00,000 revenue at
19.9% margin, and Click AR no longer carries someone else's cost.

## 8. Still open

- ~~**Editing** company details and inviting users (§6) — deliberately not wired.~~ Company
  details were done in `docs/67`, invitations in `docs/73`.
- **Project status changes** have a server action but no UI control yet.
- **Service items** still have no CRUD screen; the catalogue is seeded and used by the
  invoice form.
- `/payroll/me` would be better keyed on a real `Employee.userId` than on an email match.
