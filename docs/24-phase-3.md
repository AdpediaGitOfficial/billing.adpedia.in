# 24 · Phase 3 — Purchases

**Status: done.** Typecheck and lint clean, **163 tests** (90 unit + 73 integration).

---

## 1. The TDS resolver

`src/server/services/tax/tds-resolver.ts` — five cases, in order, each naming its reason.

| # | Case | Behaviour |
|---|---|---|
| 1 | **No verified PAN** | s.206AA — flat 20%, and the annual threshold gives no relief |
| 2 | **s.197 certificate** | the certificate rate, while valid and under its cap |
| 3 | **Under both thresholds** | nothing deducted; warns when the headroom runs low |
| 4 | 🔴 **Threshold crossed** | deduct on the **whole year**, not the excess |
| 5 | Normal | the ordinary rate on this bill |

### The 194C rate comes from the PAN

The 4th character of an Indian PAN encodes the entity type — `P` individual, `C` company,
`F` firm, `H` HUF. 194C is 1% for an individual or HUF and 2% for a company or firm, so
the rate is **derived rather than asked for and got wrong**.

### Case 4, live

Praveen C D in the demo data:

```
PCD/001   12 Jul   ₹8,500    no TDS — under the limit
PCD/002   18 Aug   ₹10,000   no TDS — warns "₹21,500 of headroom left"
PCD/003   20 Sep   ₹40,000   TDS ₹5,850
```

₹5,850 is **not** 10% of ₹40,000. It is 10% of ₹58,500 — everything paid to him this
financial year — because that is what crossing the threshold means. The bill form says so
before you approve:

> This bill takes the vendor's FY total to ₹58,500, crossing the ₹50,000 limit for 194J.
> TDS is now due on the whole ₹58,500, not just this bill — ₹5,850 in total.

### One bug the tests caught

The cumulative lookup originally counted only bills where TDS had been **deducted**. A
bill below the threshold was therefore invisible to it, and the limit never appeared to be
crossed. The section is now stored on **every** bill, deducted or not, because a threshold
is measured on total payments rather than taxed payments.

## 2. Reverse charge

`deriveRcm(country, gstin)` — a vendor with no **Indian GSTIN** is an import of service:

| Vendor | Billed by | Treatment |
|---|---|---|
| AWS | AWS India Pvt Ltd | normal purchase, full ITC |
| GoDaddy | GoDaddy India | normal purchase, full ITC |
| **DigitalOcean** | DigitalOcean LLC (US) | 🔴 **reverse charge** |
| **Afrizon Crenergy Trade Pte** | Singapore | 🔴 reverse charge + s.195 + 15CA/15CB |

Approving such a bill posts two halves that cancel:

```
Dr 1240 Input IGST — RCM   4,500      claimable in the same GSTR-3B
Cr 2140 IGST Payable — RCM 4,500      payable in CASH, never set off against ITC
```

and allocates a self-invoice number from its own series (`ADPS/26-27/0001`) under
s.31(3)(f). Net cost is nil — **provided it is done**, which is the whole reason it is
automatic rather than a reminder.

The non-resident warning fires separately: Form 15CA and a CA-certified 15CB are required
**before** the remittance, and the treaty rate needs a Tax Residency Certificate and
Form 10F from the payee.

## 3. Input credit is real now

The GST screen was showing ₹0 of ITC with the note *"vendor bills arrive in phase 3"*.
It no longer does. Because the GST position reads the **ledger** rather than documents
(`23-phase-2.md` §1), bills and expenses started counting the moment they posted — no
change to the GST code at all.

## 4. s.17(5) blocked credit

Eligibility defaults from the expense category; overriding it **requires a named clause**:

| Clause | |
|---|---|
| `S17_5_B_FOOD` | food, beverages, restaurant, outdoor catering |
| `S17_5_B_CAB` | cab or taxi — passenger transport |
| `NO_REGISTRATION_IN_STATE` | hotel GST in a state where Adpedia has no registration |
| `S17_5_G_PERSONAL` | personal consumption |
| `UNREGISTERED_SUPPLIER` / `NO_GSTIN_ON_INVOICE` | nothing to claim |

When the credit is blocked, **the tax becomes part of the cost**:

```
claimable     Dr 5320 Internet 2,000 · Dr 1210 CGST 180 · Dr 1220 SGST 180 · Cr Bank 2,360
blocked       Dr 5400 Travel 4,200                                          · Cr Bank 4,200
```

Nothing sits in 1210/1220 pretending to be recoverable. There is a test for exactly that.

## 5. AP ageing mirrors AR

```
outstanding = grandTotal − tdsWithheld − paid
```

A ₹2,36,000 bill with ₹4,000 of TDS is settled by paying the vendor ₹2,32,000 — the rest
goes to the government. `payBill` refuses an overpayment by name:

> Paying ₹236000.00 exceeds the ₹232000.00 outstanding on EX/2026/114 — TDS of ₹4000 is
> withheld, not paid to the vendor.

## 6. Cancellation, and a second bug

Cancelling an approved bill reverses the bill entry, the TDS entry and the RCM
self-invoice. The first attempt **deleted** the `TdsDeduction` rows — and the
no-hard-delete trigger refused, correctly.

Deductions now carry `reversedAt` and are excluded from challans and the quarterly return.
Nothing financial is deleted, including the record of a deduction that was undone.

## 7. Screens

| Route | |
|---|---|
| `/vendors` | list with PAN / RCM / TDS status, and a banner for vendors missing a PAN |
| `/vendors/new` | warnings appear as you type — reverse charge, 206AA, 15CA/15CB |
| `/bills` | payable, due this week, **TDS to deposit by section**, RCM count |
| `/bills/new` | live TDS, reverse charge and ITC as you type, via `/api/bills/preview` |
| `/bills/[id]` | approve, pay, cancel, and every ledger entry behind it |
| `/expenses` | list with claimable / blocked |
| `/expenses/new` | category-driven, an override demands a clause |

## 8. Still open

- 🔴 **TDS rates remain placeholders.** The resolver is right; the numbers it reads are not

> **Superseded:** the rates and slabs were filled in later — see [32-tax-rates.md](32-tax-rates.md). They are statutory as at 01 Apr 2025 and still need the CA's sign-off.
  confirmed. `prisma/seed/tax-rates.ts` — this blocks the first live deduction.
- ⚠️ **Which section for each freelancer** — 194J or 194C. Most freelance dev and design
  work is 194J, but Exalture (a company, working to spec) is likely 194C.
- ⚠️ **PANs for the nine freelancers.** Until each is on file they are deducted at 20%.
- **Challans and the 26Q export** arrive in phase 5 — `tdsPayableSummary` already totals
  what is owed by section, which is what the challan will consume.
