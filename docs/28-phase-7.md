# 28 · Phase 7 — Bank reconciliation

**Status: done.** Typecheck and lint clean, **270 tests** (142 unit + 128 integration).

This is the phase the whole brainstorm started with: *"bank statement reconciliation
against invoices and TDS calculation"*. Everything built in phases 1–6 — invoices,
bills, TDS, the journal — now gets confronted with what the bank actually did.

---

## 1. The shape of the problem

A bank statement is the **only** record in this system that Adpedia did not write. It is
ground truth, and it disagrees with the books in four routine ways:

| The books say | The bank says | Why |
|---|---|---|
| Invoice ₹1,41,600 | Credit ₹1,29,600 | the client deducted ₹12,000 of TDS u/s 194J |
| Invoice $2,000 | Credit $1,985 | correspondent bank charges on the inward SWIFT |
| Bill ₹40,000 | Debit ₹34,150 | Adpedia withheld TDS on the way out |
| Nothing at all | Debit ₹118 | bank charges, and the GST on them |

Reconciliation is not "tick off the obvious ones". It is **deciding what each line means**,
and the TDS row above is why a generic matcher is useless here: ₹1,29,600 does not equal
₹1,41,600, so by amount alone it looks like a short payment or a different invoice.

## 2. Import — the balance check is the gate

`parse.ts` carries a `BankProfile` per bank (`AXIS`, `HDFC`): column aliases, date format,
and how debit/credit is signalled. Headers are found **positionally**, so a bank adding a
column does not shift the parse.

🔴 **The batch is rejected if opening ± Σ(credits − debits) ≠ closing.** It costs one pass
to compute and it catches every parsing error before a single wrong figure reaches the
ledger. A mis-read sign, a swallowed row, a date column read as an amount — all of them
break the balance identity. `force: true` exists for genuinely truncated exports, and it
is the only way past.

Each line also gets a **dedupe hash** over account + date + amount + narration, so
re-importing an overlapping statement — the normal case, since people export by month and
months overlap — adds nothing.

`enrichNarration()` pulls the structure out of the free-text field: UTR, IMPS RRN, mode,
counterparty, trailing remark. Everything downstream reads those fields, not the raw string.

## 3. The tiered matcher

`match.ts` returns **suggestions with reasons in words**, never a bare score. The user is
approving an accounting entry; they need to know why.

| Tier | Name | Confidence | Fires when |
|---|---|---|---|
| 0 | UTR identity | 100 | the UTR is recorded on a payment advice |
| 1 | Exact amount | 95 | the credit equals what is outstanding |
| 2 | **TDS-aware** | 92 | the shortfall **is** the TDS expected on that invoice |
| 3 | Charge tolerance | 88 | short by bank/intermediary charges |
| 4 | Part / combined | 70–80 | a part payment, or one receipt covering several invoices |
| 5 | Party recognised | 50 | the payer is known but nothing fits — an advance |
| 6 | Learned rule / contra | 80–95 | a saved rule, or the mirror leg of an own-account transfer |

**Tier 2 is the one that matters.** It asks a question no generic tool asks: *is the gap
exactly the tax the client was supposed to withhold?* If so the line is not a short
payment — it is full settlement, and the ₹12,000 is a **receivable from the government**
that must reach Form 26AS. It books the receipt and the TDS credit in one move, and the
reason says so:

> ₹1,29,600.00 plus ₹12,000.00 of TDS u/s 194J settles ADP/26-27/0028 exactly

### Export vs domestic tolerance

Tier 3 is split, because the two cases are not alike:

```ts
const DOMESTIC_TOLERANCE = new Decimal('250')   // NEFT arrives whole
const EXPORT_TOLERANCE   = new Decimal('2000')  // inward SWIFT loses correspondent charges
```

A domestic NEFT arrives to the rupee, so a ₹500 gap is **suspicious** and should not be
waved through as "charges". An inward remittance routinely loses ₹500–2,000 to banks
nobody chose. One tolerance for both would either hide domestic errors or block every
export receipt.

### Overlapping rules — earliest match wins

Two seeded rules both hit `GST @18% on Monthly Service Chrgs`: the GST rule and the
bank-charge rule. 🔴 Picking wrong posts input GST to an expense account and **forfeits the
credit silently** — nothing ever errors, the money is just gone.

Only the most specific rule fires, and specificity is the **earliest** match, not the
longest. A bank narration is built prefix-first: the qualifier that says what the line *is*
leads, and the thing being qualified trails. Longest-wins gets this exactly backwards —
`Monthly Service Chrgs` is the longer pattern but the less specific rule.

## 4. Applying a match

`applyMatch()` deliberately routes through **`createReceipt` / `payBill` / `postJournal`** —
the same services the manual screens use. A receipt booked from the bank is byte-identical
to one keyed by hand: same journal shape, same TDS receivable row, same audit entry. There
is no second code path to keep in step, and no "bank-booked" variant of anything.

## 5. The learning loop

`learnFrom()` reduces a narration to its **signature** — the party, not the reference
numbers, which change every time — and saves it. After **two** confirmations the rule
starts auto-applying. The user sees this as one toggle: *"Remember this for similar lines."*

Four **starter rules** ship seeded, because they are the *bank's* own wording and identical
on every Axis account — there is nothing company-specific to learn about a service charge:

| Pattern | Posts to |
|---|---|
| `Monthly Service Chrgs` | 5600 Bank charges |
| `Monthly Avg Bal Chrgs` | 5600 Bank charges |
| `GST @18% on` | 1210 Input GST |
| `Int.pd` | 4910 Interest income |

## 6. Screens

- **`/banking/import`** — paste or upload, pick the profile, see the balance check pass or
  fail *before* anything is written.
- **`/banking/reconcile`** — a card at a time, with a progress bar, confidence pills, the
  reason in words, and the remember toggle. One decision per screen, which is what makes it
  work on a phone.

## 7. What this phase found

Two defects in work from earlier phases, both caught by running the matcher against a
realistic statement rather than by a test:

1. **`SEED_RULES` was declared and never wired up.** The constant sat in `match.ts`
   referenced by nothing, so every company started with an empty rule book and the four
   narrations nobody should have to teach produced no suggestion at all.
2. **`BankRule.accountId` held an account *code*, not an id.** The round trip was
   self-consistent so nothing failed, but the column had no FK and the name invited exactly
   the bug it looked like. Renamed to `accountCode`, with the comment saying what it holds.

## 8. Still open

- **Mobile swipe gestures** on the reconcile queue — the card UI is there and works by tap;
  swipe-to-accept is not wired.
- **Subset-sum across 26AS rows** for aggregated credits (noted in phase 6).
- Statement **file upload** is paste-and-upload for CSV; a true `.xls` binary reader is not
  in yet, which is still the format Axis exports by default.
