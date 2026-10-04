# 31 · Phase 10 — E-invoice readiness (built, and deliberately switched off)

**Status: done.** Typecheck and lint clean, **345 tests** (193 unit + 152 integration).

---

## 1. Read this first: the mandate does not apply to Adpedia

E-invoicing applies at **₹5 Cr aggregate turnover**. Adpedia's peak turnover on file is
**₹4.05 L** — about **0.8%** of the threshold. My own analysis back in
[`01-company-profile.md`](01-company-profile.md) reached the same conclusion from the bank
statement (≈₹39L annualised), and nothing since has changed it.

So this phase did **not** build a live IRP integration, and the system will not generate an
IRN. That is a deliberate decision, not an omission:

> 🔴 An IRN is a **government record of a document**. Generating one for a taxpayer outside
> the mandate is not a harmless dry run — it creates a reporting footprint that then has to
> be explained.

What this phase built instead is everything that is useful *before* the threshold, plus
everything that makes crossing it a configuration change rather than a project.

## 2. The applicability monitor — the part that matters today

`applicability.ts` computes aggregate turnover **from the ledger** and says plainly where
the company stands. Three decisions inside it are worth stating:

- **Turnover is invoices raised, not cash collected.** A company can cross the threshold on
  billing it has not been paid for. Reading receipts would under-report and miss the
  crossing entirely.
- **GST is excluded.** It is posted to its own liability accounts and never touches 4xxx, so
  revenue accounts already hold exactly the s.2(6) figure. The tax was never the company's
  revenue.
- 🔴 **Liability is permanent once crossed.** It does not lapse because a later year is
  smaller. Checking only the current year would silently drop the obligation — so every
  year on file is tested, and the peak governs.

The threshold has ratcheted down repeatedly — ₹500 Cr → 100 → 50 → 20 → 10 → ₹5 Cr — so the
real question is *when*, not *whether*. The screen warns from 75% of the threshold, because
the obligation starts the moment it is crossed, not at the start of the next year.

## 3. The dry run — useful now, free to run

`previewEInvoice()` validates any real invoice against the IRP schema **without contacting
anything**, and it works regardless of applicability. That is the point: a missing buyer
GSTIN or a 4-digit SAC is a five-minute correction today and a **blocked invoice on the day
the threshold is crossed** — when every invoice needs an IRN before it can be issued.

All three demo invoices currently pass. The screen lists any that would not, field by field.

## 4. What the validator actually checks

Everything checkable offline is checked here, where a test can prove it, rather than
discovered as a terse IRP error code on an invoice that is already numbered.

| Rule | Why it bites |
|---|---|
| Doc number ≤ 16 chars, not starting `0`, `/` or `-` | the same Rule 46 limit that broke `ADP/EXP/26-27/0004` in phase 1 |
| Date as `dd/mm/yyyy` | the only format the IRP accepts |
| Buyer GSTIN mandatory | **B2C is not eligible for an IRN at all** |
| PIN exactly 6 digits | a common silent rejection |
| HSN/SAC 4–8 digits, present on every line | the IRP rejects a line without one |
| Line foots: taxable + tax = total, ±₹1 | rejects the **whole document**, not the line |
| Tax charged matches the rate claimed | catches a rate typo before it is filed |
| Intra-state carries no IGST; inter-state no CGST/SGST | the split must match the supply type |
| Export under LUT carries **no tax at all** | zero-**rated** means the rate is 0, not 18% with the tax omitted |
| Header totals equal the sum of lines | ±₹1, as the IRP does |

### 🔴 Exports: URP, PIN 999999, state 96

An overseas buyer has no GSTIN. The IRP wants `URP`, PIN `999999` and state code `96` for
both the buyer and the place of supply. **Sending the seller's own state here is the classic
export rejection**, and Adpedia does export — under LUT, so `EXPWOP`.

## 5. Two bugs this phase found in its own work

1. 🔴 **The document-number regex admitted a leading zero.** `^[A-Za-z0-9]...` includes `0`,
   so the rule quietly contradicted the message it printed. Now `^[A-Za-z1-9]`, with a
   comment saying why the class excludes `0` deliberately.
2. **An export fixture claimed 18% with no tax attached.** The validator was right to refuse
   it — an LUT export is zero-*rated*, so `GstRt` is `0`. The test was wrong, not the code.

## 6. 🔴 The live IRP client is intentionally not implemented

`LiveIrpAdapter` throws, and says why. Writing an untested HTTP client against a government
API — auth-token caching, public-key encryption of the payload, a provider-specific error
table — and leaving it *looking* finished would be worse than an honest gap: it would be
discovered at the moment it is first needed, on a real invoice, with a deadline.

`MockIrpAdapter` is deterministic, names itself **"MOCK — not a real IRP"**, and exists so
the surrounding code (validation, persistence, cancellation windows) is tested.

**To complete it when the threshold is near:**

1. Choose a GSP (ClearTax, Masters India, IRIS) or NIC direct — a commercial decision nobody
   has made.
2. Implement `IrpAdapter.generate` / `.cancel` against that provider. Nothing else changes:
   invoicing talks to the interface.
3. Auth token caching (NIC tokens last ~6 hours), AES payload encryption under the IRP
   public key, and the provider's error-code table mapped onto `IrpError`.
4. Set `IRP_MODE=live` and `EINVOICE_ENABLED=true`. **Both gates must pass** — the ledger
   must say the company is liable *and* the integration must be switched on.
5. Print the IRN and the signed QR on the invoice template (the `signedQr` field already
   stores it). Note this is the *e-invoice* QR, which is unrelated to the payment QR that
   was removed from the template at your request.

## 7. The 24-hour window

An IRN can be cancelled on the IRP for **24 hours from the acknowledgement**, with no
extension and no exception. After that the only lawful route is a **credit note** — which is
an accounting event with its own GSTR-1 row, not an undo.

`cancelEInvoice()` checks the window before calling out, so the person is told that in words
rather than via a rejection they have to interpret.

## 8. Still open

- **Live IRP client** (§6) — on purpose.
- ~~**IRN/QR on the PDF template**~~ — done in `docs/75`, which first had to make a mock IRN
  distinguishable from a real one: the mock writes into the same four columns, so the document
  would have printed a forgery nobody set out to make.
- **E-way bills** — a separate mandate on goods movement. Adpedia supplies services only, so
  it does not apply at all; not built, and not a gap.
- **6-digit SAC** switches on at the same threshold. `hsnOrSac` already accepts 4–8 digits,
  and `hsn6Required` reports when it becomes mandatory — but the stored SAC is still the
  unresolved **998314 vs 998519** question for your CA.
