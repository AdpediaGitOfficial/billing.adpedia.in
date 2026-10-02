# 55 · Certificates — the documents this system must not produce

**Status: done.** 684 tests (314 unit + 370 integration), typecheck and lint clean,
production build passes.

The compliance calendar has asked for Form 16A every quarter since docs/43, and nothing could
ever answer. This answers it — by building a register and a chase rather than a generator,
which is the only honest thing to build.

---

## 1. 🔴 Only TRACES may generate these

Rule 31(1) requires Form 16 and Form 16A to be **generated and downloaded from the TRACES
portal**. The obvious module here is a PDF renderer — this codebase already has one, and the
template work would have taken an afternoon.

It would have been the wrong thing to ship. A certificate produced anywhere else carries no
digital signature the deductee can verify, and it evidences a credit **the department never
saw**: the figure that matters is the one in TRACES, generated from the filed statement. A
convincing imitation is worse than nothing, because the deductee files against it.

So what is built is the part nobody can see otherwise: who is owed a certificate, by when,
what stands in the way, and whether the real one was downloaded and actually sent.

## 2. The register is derived, never maintained

A vendor paid once in Q2 and never again is owed a Form 16A for Q2 and nothing else, and
nobody would remember to add them to a list. So the register is built from the deductions —
one row per vendor per quarter for 16A, one row per employee for the year for 16, because the
two forms key differently.

Each row carries the one thing standing in its way, in order:

| | |
|---|---|
| **No PAN** | TRACES cannot produce a certificate at all, and the deduction has been reported against a blank |
| **Return not filed** | 🔴 TRACES generates the certificate *from the statement* — there is nothing to download yet |
| **Not downloaded** | the ordinary state |
| **Downloaded, no file on record** | §3 |
| **Not issued** | it exists and the deductee still does not have it |

🔴 That second one is why docs/50 had to come first. Before the filing record existed, nothing
in this system could tell whether a certificate was even possible.

## 3. 🔴 "Issued" with nothing attached is refused

Recording a certificate as issued requires the downloaded file to be on record (docs/38
storage, `TDS_CERTIFICATE`). A tick with no document behind it is a claim nobody can check —
and the moment it matters is a year later, when the deductee asks for it again and the only
honest answer is the file.

Where it was sent is recorded too, because "issued" and "issued to accounts@… on 12 November"
are different facts at an assessment.

## 4. The calendar can finally be satisfied

*"Issue Form 16A for Q2"* now reads **"3 of 4 still to issue — download them from TRACES"**,
and goes quiet when they are all out. Form 16 is marked not applicable when no salary TDS has
been deducted, rather than nagging a company that owes nobody one.

## 5. Still open

- **Nothing requests the download.** TRACES has an API for bulk requests behind a login; this
  records what a person did there, as the rest of this system records what the CA does.
- **Nothing emails the certificate.** Recording that it was issued is not the same as issuing
  it — the file is here and the sending is still manual.
- **Form 16 Part B** is prepared from the salary details in the 24Q annexure II, which this
  system has; it is still downloaded from TRACES, so the same rule applies.
- **A certificate is not re-issued after a correction.** A C5 that fixes a PAN (docs/52)
  produces a new certificate on TRACES, and nothing here notices that the one on file is stale.
- Carried forward: portal reconciliation, payslip documents, statement PDFs, journal export,
  service-item CRUD, the mobile tail, chases that nobody sends.
