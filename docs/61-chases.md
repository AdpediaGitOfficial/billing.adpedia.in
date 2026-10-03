# 61 · Asking somebody outside this company for something

**Status: done.** 825 tests (365 unit + 460 integration), typecheck and lint clean,
production build passes.

Four registers in this system know exactly who owes it something, and none of them has ever
asked. The PAN register knows which vendor is being over-deducted for want of a number
(docs/47); the certificate register knows who is owed a Form 16A and has not been sent it
(docs/55); the 26AS reconciliation knows which client deducted tax and never reported it
(docs/27); the ageing report knows who has not paid (docs/36). Every one of them ends in a
sentence a human has to write, and none of those sentences was ever written.

docs/60 delivered the reminders that go to *our own* phones. This is the other half, and it
is the harder one, because the words leave the building.

---

## 1. 🔴 Nothing here sends anything, deliberately

A payment chase from `noreply@` is ignored. One from the owner's own address gets a reply,
because the relationship is with the person and not with the software. So the system does the
part it is genuinely better at — knowing *who* to ask, *what* for, and what it is costing
them — and hands the words to the person whose name goes at the bottom.

That is the same posture as everything else here: prepare for the CA, never file. It also
avoids the two things an SMTP integration would really buy: deliverability problems, and the
ability to send something in somebody's name that they never read.

🔴 And recording a chase is an explicit act, never inferred from the link being clicked. A
`mailto:` opens a composer; it does not send anything, and half of them are closed again. A
system that marked a vendor chased because somebody glanced at a draft would be worse than
one that recorded nothing — it would be confidently wrong about whether they had ever been
asked.

🔴 Asking is not getting, so the row **stays** until the thing actually arrives, marked with
when it was last asked. A chase that disappears on sending is a chase nobody follows up.

## 2. What the drafts had to get right, and did not

Reading the real output against the real books is the whole of this section.

### 🔴 An employee is not a vendor

The first draft told four salaried people that without a PAN we must deduct 20% *"instead of
0% (section 192)"*. That is false twice over. Salary TDS is not a rate — it is the year's
estimated liability spread over the months that remain (docs/57 §3) — and **s.206AA on salary
is a floor, not a flat rate**, which is precisely what docs/47 §1 established and this
message contradicted.

What an employee without a PAN actually loses is the credit and the certificate, so that is
what the message now says: the deduction cannot be reported against them, it will not reach
their Form 26AS, and Form 16 cannot be issued.

### 🔴 "instead of 0%"

A rate is quoted only where there is one. `correctRatePct` is zero for salary, and a sentence
offering to deduct 20% rather than 0% says nothing at all.

### 🔴 The signature was shouting

`legalName` is stored as registered — in block capitals. That is right on a letterhead and
wrong at the end of an email asking somebody for a favour. Title-cased in prose.

### Dates

The drafts read *"fell due on 2026-07-15"*, which is a log line in a letter about money. Dates
in a message to a person are written the way a person writes them, formatted in UTC like every
other day-marker here.

## 3. 🔴 The marker leak is now a test

The review marker has escaped into user-facing text four times — an engine note and screen
copy in docs/46 and docs/47, a field hint in docs/54, and here into the body of an email that
would have gone to a client, explaining to *them* that their unreported deduction was "a real
cost to us". Each time it was caught by reading the output, which means each time it could
have been missed.

`tests/marker-leak.test.ts` now strips the comments from every `.ts`, `.tsx` and `.html` file
in the repository and asserts the marker does not survive. The first version tested whether
the *line* began with a comment marker and reported thirty false positives — the body of every
multi-line block comment, whose continuation lines begin with prose. A guard that cries wolf
thirty times is a guard somebody deletes, so it understands comments instead. It was checked
by putting a real leak back and watching it fail.

## 4. The words are kept, not just the fact

`ChaseLog` holds the message text as sent, where it went, by what channel and when. "We
chased them" is an assertion; the words are the thing that can be produced when a notice asks
what steps were taken to obtain a payee's PAN.

It is deliberately separate from docs/60's `NotificationLog`. The audiences are different and
so is what the record is for: a push to the owner's handset is housekeeping, and an email to a
vendor is evidence.

## 5. Still open

- **Nothing follows up by itself.** The screen shows when each party was last asked; deciding
  to ask again is a person's call. A cadence like docs/60's could drive it, but a chase that
  escalates on its own needs a tone that escalates with it, and that is a judgement.
- **No address, no chase.** Several employees have no email or phone on file, and the card
  says so rather than pretending. Collecting those is itself a chase nobody can send.
- **Attachments are not attached.** The Form 16A draft says "attached is your Form 16A" and the
  person has to attach it — the file is in the register (docs/55), and a `mailto:` cannot
  carry it.
- **No templates per party.** One wording for everybody; a long-standing client and a
  one-invoice freelancer get the same sentence.
- Carried forward: service-item CRUD, note amendments (table 9C), refund vouchers,
  invoice-level GST reconciliation, swipe gestures and the performance budget.
