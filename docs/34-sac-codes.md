# 34 · SAC codes

**Status: done.** 400 tests (237 unit + 163 integration), typecheck and lint clean,
production build passes.

> ⚠️ These are the SAC codes under the GST Scheme of Classification of Services
> (Notification 11/2017-CT(R), Annexure), stated to the best of my knowledge. **Not a CA's
> opinion.** One choice is a genuine judgement call and is flagged in the app rather than
> decided silently — see §3.

---

## 1. 🔴 The bug: a brand film billed as IT development

The demo invoiced **"Brand film — milestone 1"** under **998314 — Information technology
design and development services**. Every figure on it was right; the classification was not.

That is not cosmetic. **The SAC drives the HSN/SAC summary in GSTR-1**, so a film billed
under an IT code misstates the nature of the supply *in the return* — which is what the
department reads — not merely on the document.

It is also an easy mistake to make: an invoice line gets copied from the last one and the
description changes while the code does not.

## 2. The catalogue

| Code | Covers | |
|---|---|---|
| **999612** | Motion picture, videotape and TV programme **production** | brand film, ad film, TVC, corporate film |
| **999613** | Audiovisual **post-production** | edit, colour grade, VFX, motion graphics, animation |
| **999611** | Sound recording | voice-over, dubbing, mix, sound design |
| **999614** | Distribution of content | licensing finished work, as opposed to making it |
| **998361** | Advertising services | campaign creative and art direction — the fee, not the media buy |
| **998362** | Advertising space/time on commission | media buying where you earn commission |
| **998365** | Sale of internet advertising space | reselling digital inventory on own account |
| **998382** | Advertising photography | product and campaign stills |
| **998383** | Event photography and videography | launches, conferences |
| **998314** | IT design and development | building a website or application |
| **998313** | IT consulting and support | advisory, architecture, ongoing support |
| **998391** | Specialty design | graphic design, UI/UX, brand identity |
| **998513** | Contract staffing | a resource working under the client's direction |
| **998519** | Other employment & labour supply **n.e.c.** | residual bucket |

All of these are **18%**.

## 3. 🔴 The one real judgement call

**Staff augmentation** is the long-open question from `docs/03`, and it is not a lookup —
it turns on **who directs the work**:

- the **client** manages the person day to day → **998513**, contract staffing
- **Adpedia** owns the deliverable and happens to use its own people → **998314**, IT
  development

**998519 is the residual "n.e.c." bucket and is harder to defend than either.** Where it was
previously framed as "998314 vs 998519", the better comparison is **998314 vs 998513** —
998519 should be a last resort.

The system does not pick. Choosing either code raises a warning on the invoice form stating
the test, so the decision is made deliberately, once per contract, with the CA — not
silently by a default.

## 4. Validation, and where it is deliberately soft

`validateSac()` rejects what is unambiguously wrong:

- a missing code — it feeds GSTR-1
- a code that is not six digits, or not numeric
- 🔴 a **goods HSN** used where a service code belongs (`847130` is a real HSN for computers,
  and the wrong kind of code entirely) — services are chapter 99, so a SAC starts `99`

An unrecognised but **well-formed** code is only a **warning**. The catalogue covers what
Adpedia sells today; refusing a legitimate code the system has simply not heard of would be
the software overruling the person who actually did the work.

### The description cross-check

`sacLooksWrongForDescription()` catches the specific mistake above: a line whose wording
reads like film or video work carrying an IT, design or staffing code.

One detail that mattered: the pattern needed a trailing `s?`. `\b(film)\b` does not match
**"films"**, and `\b(motion graphic)\b` does not match **"motion graphics"** — which is how
the line is actually worded. Caught by a test, and plural forms are now in the fixtures.

## 5. Where it shows up

- **Invoice form** — issues appear under the live preview, **before the invoice is
  numbered**. A wrong SAC is cheap to change now and expensive once sent and reported.
- **Service catalogue** — ten items seeded with correct codes, so a SAC is picked from a
  list rather than typed from memory. Selecting a service fills the code in.

## 6. Still open

- 🔴 **Staff augmentation: 998314 or 998513** — the CA decides, per contract (§3).
- **Service and project CRUD screens** are still deferred; the catalogue is seeded and used
  by the invoice form, but cannot yet be edited in the app.
- Codes for work Adpedia does not currently sell are not listed, by design.
