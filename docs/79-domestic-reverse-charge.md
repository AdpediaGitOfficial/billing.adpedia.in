# 79 · The domestic reverse charge, and what account 1240 is waiting for

**Status: done.** 1,028 tests (421 unit + 607 integration), typecheck and lint clean,
production build passes.

The last item on `docs/00 §7`, and the only one that could not be closed by building it:
*"Splitting account 1240 — only if a domestic s.9(3) reverse charge ever occurs, which has
never been confirmed."*

A gap that depends on a fact nobody has established is not a gap. It is a decision, and this
module makes it: **1240 stays one account**, with the trigger that would change that written
down, the invariant it rests on tested, and the one case where a domestic reverse charge could
pass through unnoticed given a voice.

---

## 1. What 1240 rests on

`docs/63 §1` justified reporting reverse-charge credit as a single figure on the grounds that
*"in this system every reverse charge is an import of services and therefore IGST"*. The same
argument lets account **1240 Input IGST — RCM** stay one account and the GSTR-3B **3.1(d)** line
stay one number.

That rests entirely on five lines:

```ts
export function deriveRcm(country: string, gstin: string | null | undefined) {
  const isForeignSupplier = country !== 'IN'
  return { isForeignSupplier, rcmApplicable: isForeignSupplier && !gstin }
}
```

🔴 **Nothing tested it.** `rcmApplicable` is derived, never typed in, and derived in one place —
and a change to that function, a manual override added for convenience, would quietly let a
Kerala supplier's bill post IGST. That is the wrong head of the wrong tax, and every statement
would still balance. `tests/reverse-charge.test.ts` now asserts both halves: what `deriveRcm`
returns, and that nothing in `vendor.ts` writes `rcmApplicable` from an input field.

## 2. 🔴 The risk is omission, not mis-posting

Because the wrong head is unwritable, a notified service bought from an Indian supplier does not
get mis-booked. It gets entered as an ordinary purchase with no tax on it, and the liability and
the credit are **both simply absent** — which is the quieter failure.

There is one place that surfaces: an Indian supplier with no GSTIN is `mode: 'NONE'`, so
`splitGst` returns zero whatever rate the line carries. Somebody types 18%, the total comes out
at the bare amount, and nothing says the rate was dropped rather than computed.

So the bill preview says it, and names the one case where tax is nonetheless due:

> *Thrissur Lorry Service has no GSTIN on file, so no GST arises on this bill and the rate on the
> lines has been ignored rather than applied. If this is one of the services notified under
> s.9(3) — goods transport, an advocate's fee, sponsorship, security — the tax is still payable,
> by Adpedia, under reverse charge at CGST + SGST. This system cannot account for that: ask the
> CA before approving it.*

🔴 **It fires on the rate, not on the result.** "No GST on this bill" is the normal state for
every unregistered vendor Adpedia uses, and a warning on all of them is how a warning gets
ignored — `docs/60 §3`. Warning only where somebody *expected* tax is the targeted version of
the same question, asked at the one moment it is answerable.

It changes no figure and blocks nothing. `docs/63 §3` already settled why: building a domestic
reverse-charge path on a guess would add a rate table, a head split and a self-invoice variant
that nobody has asked for, and the system would still not know when to apply them.

## 3. The decision, and the trigger

**Account 1240 stays one account.** It is now a deliberate non-goal rather than an open gap,
with the trigger named: *the first time a s.9(3) domestic reverse charge is confirmed.*

When that happens, what it takes is written down rather than discovered:

1. Three accounts — `1241`/`1242` Input CGST/SGST — RCM, and the matching `2141`/`2142` payable
   heads — created by **migration as well as seed**, because the seed only runs on a fresh
   install (`docs/65 §6`, `docs/71 §3`).
2. A reclassification entry moving whatever is already in 1240 that turns out to be domestic.
   🔴 **Derivable**, because every posting in 1240 carries its source bill, and every bill
   carries its vendor's country — which is why leaving it as one account costs nothing now.
3. `splitGst`-equivalent handling on the RCM side: the rate stops being the flat import 18% and
   becomes the notified rate for the service, which needs a table.
4. The GSTR-3B 3.1(d) line and `docs/63`'s hedge, which already derives itself from 1240's own
   entries and will start saying something the moment one of them is not an import.

## 4. Still open

- 🔴 **The question itself.** *Does any s.9(3) domestic reverse charge apply to Adpedia?* It is
  in `docs/00 §2` with the other unconfirmed facts, and it belongs to the CA. Nothing in the
  books suggests one has occurred; nothing in the books would show it if one had, which is why
  §2 exists.
- **A director's sitting fee** would be one — Schedule III puts an *employment* contract outside
  GST, and Shinelal is paid as salary under s.192, so it does not currently arise. It would the
  day a fee is paid for anything other than employment.
