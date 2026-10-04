# 63 · Reverse charge, head by head — and a caveat that was not true

**Status: done.** 853 tests (381 unit + 472 integration), typecheck and lint clean,
production build passes.

The last item on docs/56's list was *"split account 1240 three ways"*. Looking at what
actually posts to it showed that the premise behind that item was wrong, and that the
remedy — a chart-of-accounts change and a reclassification entry — would have been work done
to fix something that was not broken.

---

## 1. 🔴 The caveat said the figures could not be trusted. They could.

docs/56 §7 reasoned that reverse-charge credit sits in one account here and is split across
heads on the portal, so one account cannot say which — and put a banner on the screen:

> *₹3,600 of reverse-charge credit sits in one account here and is split across heads on the
> portal. The head-wise lines below are approximate while that is true; the total is exact.*

That appeared every month a foreign supplier billed, which is every month. And it was wrong,
because in this system **every reverse charge is an import of services, and an import of
services is IGST**:

- the only trigger is `vendor.rcmApplicable`, which docs/04 §2 confirmed with the client means
  a foreign supplier with no Indian GSTIN — AWS India and GoDaddy India are ordinary domestic
  purchases, and DigitalOcean is the single exception
- the liability is a single `rcmIgst` field, at a single `RCM_RATE` of 18%
- `postRcmSelfInvoice` posts exactly one input line
- the chart of accounts has called `1240` **"Input IGST — RCM"** since it was seeded

So folding `1240` into the IGST head is exact. The banner was telling the owner not to rely
on a number they could rely on — which is worse than saying nothing, because a reader who
learns to discount one figure discounts the next one too.

## 2. 🔴 Dropping a caveat is only safe if something holds the assumption up

Two guards, and deliberately of different kinds.

**In the tests**, because the invariant lives in code: `postRcmSelfInvoice` posts one debit,
to the IGST reverse-charge account, never to the CGST or SGST input accounts; the seeded chart
of accounts says IGST; and `bill.ts` has exactly one reverse-charge trigger and no
`rcmCgst`/`rcmSgst` anywhere.

**In the data**, because an invariant that holds today is not a fact about tomorrow. The
screen no longer asserts anything about reverse charge — it *reads* `1240`'s own entries, and
if any of them came from something other than an import self-invoice the caveat returns by
itself, naming what landed there:

> *…includes entries from MANUAL, which are not import self-invoices. A domestic reverse
> charge is CGST + SGST, not IGST, so the head-wise lines below are approximate until 1240 is
> split.*

A test drives exactly that: post something else into `1240`, and the hedge comes back.

🔴 That test could not tidy up after itself. Deleting the probe entry was refused by the
append-only trigger — *"financial records are never hard-deleted"* — which is the rule the
whole system is built on, caught enforcing itself in a test that had forgotten it.

## 3. ⚠️ What has never been asked, and would break this

Section 9(3) notifies services where a **domestic** supplier charges nothing and the recipient
pays the tax — and those are **CGST + SGST** when the supplier is in Kerala. The ones a film
company could plausibly meet:

| | |
|---|---|
| **Goods transport agency** | a lorry hired to move equipment |
| **Legal services from an advocate** | any retainer or one-off opinion |
| **Sponsorship** | received from a body corporate |
| **Security services** | from a non-corporate provider |
| **A director's services to the company** | 🔴 *not* salary — Schedule III puts an employment contract outside GST altogether, and Shinelal is paid as salary under s.192 (docs/00 §2), so this does not currently arise |

**None of this has been confirmed with the client**, and nothing in the books suggests it has
occurred. It is written down rather than built, because building a domestic reverse-charge
path on a guess would add a rate table, a head split and a self-invoice variant that nobody
has asked for — and the system would still not know when to apply them.

What the module does instead is make sure that if one ever appears, the screen says so rather
than quietly mis-heading it. The question itself belongs to the CA, and is now in the
handover where the other unconfirmed facts live.

## 4. Still open

- **1240 is still one account**, and should stay one until a domestic reverse charge actually
  occurs. Splitting it then is a chart-of-accounts change plus a reclassification entry, and
  the entry is derivable because each posting carries its source bill.
- **The GSTR-3B 3.1(d) line** reports reverse-charge inward supplies as a single figure, which
  is right while they are all IGST and would need the same split if they stop being.
- Carried forward: service-item CRUD, note amendments (table 9C), refund vouchers, swipe
  gestures and the performance budget.
