# 94 · The live exchange rate

docs/91 and docs/93 book foreign invoices and bills in rupees at a rate, and said the rate is
**typed**: there was no source in the system and an invented figure would turn a wrong number
into a confident one. That was the right call and the wrong experience — a person with a USD
invoice open is looking at a rate on Google and retyping it.

So the rate is now **looked up**, from a real source, and offered. It is still a suggestion.

## 1. What changes, and what must not

The rate field on the invoice form, the bill form and the re-book page fills itself with the rate
for the document's own date, and updates when the currency or the date changes (and every five
minutes while the form is open, until somebody has typed a rate). Beside it: where it came from and
a "use it" link if the field has been changed.

🔴 **The booked rate is frozen when the document is saved.** The live rate is copied into
`Invoice.fxRate` / `VendorBill.fxRate` and never read again — a rate that moves tomorrow must not
move an invoice issued today. An invoice opened as a draft for editing keeps the rate it already has
instead of being refilled. The lookup feeds a text box; nothing downstream reads it.

And it can always be overridden: the field is an ordinary input, and a person who books at their
bank's or the RBI's rate types it.

## 2. Where it comes from

In order:

1. **ECB reference rates** through `api.frankfurter.dev` — official, published each working day, and
   with history, so **a past date asks for its own rate**, not today's.
2. **`open.er-api.com`** — covers currencies the ECB does not publish (the dirham, the riyal, …)
   but only for *now*, so it is **never used to answer a past date**.

Neither is tick-by-tick. Both update about once a day, so this is a daily reference rate, not the
live quote a currency converter shows — on 6 Nov 2026 the converter read 94.14 and the ECB's latest
was 94.48 (5 Nov), the other source 94.54. Differences of a few tenths of a percent are normal and
are why the person can change it. Neither is the **RBI reference rate** or a bank's TT rate; which
rate the law wants for GST (rule 34), for TDS under s.195 and for the books is still a CA question
(docs/91 §1, docs/93 §4). A genuinely tick-by-tick feed needs a paid provider, which is a decision
and not a default.

## 3. What is remembered

`ExchangeRate` keeps every rate fetched: currency, the date asked for, the date the source says it
is from (earlier on a weekend), the rate and the source.

- A **past date is cached for good** — what the system offered for 10 September stays what it
  offered, whatever the source says later.
- **Today's** is refreshed after half an hour.
- If the source cannot be reached, the last rate held for that date is offered **marked stale**;
  failing that, the latest held for the currency, marked as being from a different date and **not
  auto-filled**. Failing that, nothing, and the person types it.
- A zero, a negative, a non-number or an absurd rate is rejected, not stored.

## 4. What leaves the server

A currency code and a date, in a GET request to those two hosts. Nothing about the company, the
customer, the vendor or the document. The route needs a signed-in user (it spends an outside call),
and `FX_LIVE_RATES=off` stops every lookup. **The deployed box must be able to reach both hosts over
HTTPS** — if it cannot, the forms say so and ask for a typed rate, exactly as before.

## 5. Where else it appears

The receipt form and the bill payment form show "about ₹X at the live rate" beside the field that
takes the rupees the bank credited or debited. It is a sanity check on the figure being typed, never
a replacement: the bank's figure is the one that books, and the gap from the invoice's rate is the
realised forex.

## 6. What is not done

- **No revaluation**, as docs/91 §5 — this only supplies rates for documents being booked.
- **No rate on an already-booked document is changed**, by design.
- **The rate is not recorded with its source on the document.** `ExchangeRate` records what was
  offered; whether the person kept it or typed another is not stored.
