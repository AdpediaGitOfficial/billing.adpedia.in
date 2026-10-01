# 46 · The electronic cash and credit ledgers

**Status: done.** 567 tests (314 unit + 253 integration), typecheck and lint clean,
production build passes.

Docs/45 could record that GST had been paid. This models **how** it is paid — and in doing
so found three things that were wrong, one of which had been wrong since docs/45 and one of
which was understating the cash the company owes.

---

## 1. 🔴 Paying GST is two events, and the system only had one

On the portal, money moves twice:

| | |
|---|---|
| **Challan (PMT-06)** | credits the **electronic cash ledger**. The money is now with the government, and still the company's. |
| **Set-off (GSTR-3B table 6.1)** | debits the cash ledger *and* the **electronic credit ledger**, and discharges the liability. |

Docs/45 collapsed the two: a challan debited `2110`/`2120`/`2130` directly. Three things
followed, and all three are real:

1. **Money deposited but not offset read as settled.** It is not. It is an asset, refundable
   under s.54(1), and the liability is still outstanding.
2. 🔴 **Interest kept running and nothing said so.** Under **rule 88B(1)** interest runs from
   the due date to the date the cash ledger is **debited** — not to the date it was funded.
   Funding the ledger early does not stop the clock; offsetting does.
3. **Credit was netted, not utilised.** Which is §3.

The challan now posts `Dr 1251/1252/1253/1254 · Cr 1010`, and the set-off posts the discharge.

## 2. The chart of accounts gained five accounts

```
1250  Electronic Cash Ledger
1251    — IGST          1252  — CGST          1253  — SGST
1254    — interest, fee & penalty
```

🔴 One per **major head**, because cash under one head cannot pay another without Form
PMT-09. A single "GST paid in advance" account would balance perfectly and still tell a filer
they could settle SGST with money sitting under CGST.

Both ledgers are **derived from journal lines**, never stored — a challan debits a cash head,
a vendor bill debits a credit head, a set-off credits both. So they cannot disagree with the
trial balance, which is the same rule every report in this system follows.

🔴 The portal's vocabulary is the mirror of double entry: a *credit* to the cash ledger is
money **in**, which is a **debit** to the asset. The UI columns are labelled "In" and "Used"
to avoid ever having to resolve that ambiguity on screen.

## 3. 🔴 Credit is utilised head-wise — the old netting understated the cash

The previous table 6.1 did `min(total output tax, total ITC)`. That is wrong, and not
harmlessly:

> 9,000 of CGST liability, 9,000 of SGST liability, and 18,000 of CGST credit.
> Netting says **nothing is payable**. The portal asks for **9,000 in cash**, because
> **s.49(5)(e)** forbids CGST credit from touching SGST.

`planSetOff` in `gst-setoff-engine.ts` is pure, and implements the order exactly:

| | |
|---|---|
| s.49(5)(a) | IGST credit → IGST, then CGST or SGST **in any order** |
| rule 88A | CGST and SGST credit may be used **only after IGST credit is fully utilised** |
| s.49(5)(b) · (c) | CGST credit → CGST then IGST · SGST credit → SGST then IGST |
| 🔴 s.49(5)(e) · (f) | CGST credit **never** to SGST · SGST credit **never** to CGST |
| s.2(82) + s.49(4) | reverse charge is not "output tax", so **no credit may discharge it** |
| — | the credit ledger is for **tax only** — never interest, fee or penalty |

The schema has no `cgstToSgst` column. The prohibition is not expressible, rather than
checked.

### 🔴 "In any order" is a real choice, and the obvious one is wrong

Rule 88A leaves the filer to decide where the remaining IGST credit goes. Sending it to CGST
first looks neutral and is not:

> CGST 100 and SGST 100 of liability; 100 of IGST credit and 100 of **CGST** credit.
> IGST→CGST first strands the CGST credit, which can reach nothing else, and leaves 100 of
> SGST to be funded **in cash that was never due**. Sending it to SGST costs nothing.

So the remaining IGST credit goes first to the heads whose own credit will not cover them.
Two tests pin both mirror cases; a property test over 300 random positions asserts that no
balance ever goes negative, that each head's settled-plus-short equals its liability, that
CGST/SGST credit is never used while IGST credit remains, and that the journal balances.

## 4. 🔴 A period's return was reading the previous period's payment

Found while writing the integration tests, and **present since docs/45**.

`gstPosition` computed a period's tax as the *movement on the account during the period*. But
a quarter is settled in the following quarter — Q1 is paid on 24 July, which falls in Q2. So
Q2's output CGST read 4,500 instead of 9,000: the return under-reported the quarter's own
supplies by exactly what the previous quarter had just settled, and the figure moved every
time a payment was recorded.

Settlements (`GST_PAYMENT`, `GST_SET_OFF`) are now excluded from the position. A return
reports the tax on the supplies **of that period**; the account's true balance lives in the
trial balance, where it belongs.

## 5. What the set-off posts

| | |
|---|---|
| Dr | `2110` `2120` `2130` output GST, `2140` RCM — the liabilities discharged |
| Dr | `5600` interest and late fee — 🔴 a **cost**, recognised when the ledger is debited |
| Cr | `1210` `1220` `1230` `1240` — the credit ledger utilised, head by head |
| Cr | `1251`–`1254` — the cash ledger debited, head by head |

IGST credit sits in two accounts (ordinary input IGST, and the credit arising on reverse
charge). They are one pot to the portal, so the ordinary one is consumed first and the RCM one
takes the remainder.

A set-off is **all or nothing**. It is refused if the cash ledger is short, naming each head,
because the portal will not accept a return with part of the tax unpaid — and the UI does not
offer a button that could only fail. A second set-off against a discharged period is refused
too: the liability is read net of what earlier set-offs cleared.

## 6. What rendering it found

🔴 Four things, again — the same lesson as docs/33. Every one of them passed the tests.

- **The payment form defaulted to the wrong period.** The deposit amounts shown were the
  selected quarter's and the dropdown opened on the first quarter in the list. A challan
  raised against the wrong period is not something the portal will move back.
- 🔴 **A blank amount field crashed the form.** Leaving CGST empty on an IGST-only challan is
  the normal way to fill it in; `new Decimal('')` throws a `DecimalError` that no handler
  recognises, so the screen said only *"could not record that payment"*. Blank is now zero,
  and an unreadable value says which one it was.
- **The preview and the form disagreed about the date.** The plan was computed for today
  while the form posted whatever date was typed. One `?on=` date now drives both.
- **"Nothing left to discharge" was styled as a warning.** It is the answer, not a problem.

The stat card reading "Net payable — output less ITC" went the same way: it was the netting
this module exists to correct, sitting next to a table 6.1 that disagreed with it.

## 7. Still open

- **Minor heads are simplified.** The cash ledger carries one pot for interest, fee and
  penalty rather than one per major head. PMT-09 can move it, and for this company the
  amounts are small — but it is not the portal's full shape.
- **Nothing reconciles either ledger against the portal.** The balances are derived from our
  own postings, which is right, and nobody has compared them with PMT-05 on the GST site.
- **Rule 86B is not implemented.** Where monthly taxable turnover exceeds ₹50 lakh, 1% of the
  liability must be paid in cash regardless of credit, subject to exceptions that turn on the
  income tax paid in the previous two years. Below the threshold today; a judgement call for
  the CA if the company crosses it.
- **A set-off cannot be reversed.** It posts a journal like everything else, so the pattern
  from docs/40 applies — but the downstream consequences (a filed return, a locked period)
  want their own thinking.
- Carried forward: credit-note PDF, debit notes, vendor and project edit pages, the unmatch
  button, payroll and challan cancellation.
