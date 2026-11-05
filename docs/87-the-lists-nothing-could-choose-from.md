# 87 · The lists nothing could choose from

A client is set up with a country, a state and a currency. All three were hard-coded as
`<option>` tags in whichever form happened to need them, so the set of clients this system
could represent was the set somebody had typed out by hand.

China was not on it. Nor Malaysia, Thailand, Australia or New Zealand.

Neither was Rajasthan.

---

## 1. Three lists, and what each one cost

| | what existed | what it meant |
|---|---|---|
| **Country** | five options, in three forms — and six in the fourth, already drifted apart | a client in a country nobody had listed could not be created at all |
| **State** | seven in two forms, twelve in two others, out of thirty-six | a client in Rajasthan could not be saved; the GSTR-1 amendment screen could not correct a place of supply to a state it did not list |
| **Currency** | a column, a rule, and no writer | every export invoice was USD, for ever |

The country lists had **already drifted**: `vendors/vendor-form.tsx` offered Ireland and
`customers/new/page.tsx` did not, for no reason anybody decided. That is what a list looks
like just before it is wrong.

🔴 **The state table already existed, complete and correct**, in
`server/services/tax/tax-mode.ts` — all thirty-eight codes, including the two GSTR-1
reporting buckets. Four client components could not import from `server`, so each wrote out
its own partial slice. The knowledge was in the repository; it was not in the place that
needed it. The same sentence was true of docs/86, about a different thing.

---

## 2. The currency was worse than missing

`Customer.currency` has carried this comment since the schema was laid down:

> 🔴 The billing currency is AGREED with the client, never inferred from their country.

It is a good rule. `invoiceCurrency(taxMode, customer.currency)` applies it properly: INR for
anything domestic whatever is stored, the customer's own currency for an export. docs/33 even
records the bug where the preview and the create path disagreed about it.

**Nothing ever wrote the field.** `createCustomer` and `updateCustomer` do not mention it, and
it is not in `CustomerInput`. Every customer therefore held the schema default, `USD`, and
every export invoice was raised in dollars — a client who agreed on rupees, dirhams or pounds
could not be represented. A rule stated three times over a value nothing could set.

That is docs/49's defect class, applied to a column rather than to a service.

### The documents that followed it

Both invoice renderers, and the invoice screen, decide the amount in words like this:

```ts
amountInWords(total, cur === 'INR' ? 'Indian Rupees' : 'US Dollars')
```

So the moment a currency other than those two becomes reachable — which is the point of this
module — an invoice for AED 44,000 reads **"US Dollars Forty Four Thousand Only"** on the face
of the document, under rule 46. Fixed here rather than left for the first dirham invoice to
find, because the fix is the same table.

---

## 3. One statement of each

- `lib/countries.ts` — ISO 3166-1 alpha-2, **all 249**. Not a shortlist: a shortlist is a
  list that is wrong again in six months, which is the whole finding above. The code is what
  the e-invoice payload sends as `ExpDtls.CntCode`, so the codes are the standard ones.
- `lib/indian-states.ts` — the GST table, moved out of `server` so forms can reach it and
  re-exported from `tax-mode.ts`, which is where the rest of the codebase has always asked.
  `STATE_OPTIONS` drops 96 and 97: they are GSTR-1 buckets, not places a client is registered.
- `lib/currencies.ts` — ISO 4217 for the currencies a service exporter realistically bills in,
  each with the plural a rule 46 amount-in-words line needs. An unlisted code falls back to
  the bare code rather than being refused.
- `components/ui/geo.tsx` — `CountrySelect`, `StateSelect`, `CurrencySelect`. The only place
  allowed to turn any of the three into `<option>` tags.

`CurrencySelect` appears **only where the currency is honoured** — on an overseas client.
Offering it on a domestic client would be a lie, because `invoiceCurrency` forces INR.

---

## 4. Which code, and which name

Codes are stored; names are rendered. Three places had it the other way round:

- `customers/page.tsx` and `vendors/page.tsx` showed the bare `AE` in the party list. Five
  countries are guessable. Two hundred and forty-nine are not.
- `customers/actions.ts` wrote the **code** into the billing address for an overseas client
  and the full word "India" for a domestic one — and that address prints on the invoice. A
  Shanghai client's invoice ended its address with `CN`.
- `render.ts` printed `billTo.country` verbatim as the place of supply on an export invoice:
  **"Place of supply: US"**, where a domestic invoice says "Kerala (32)". The country code is
  the snapshot; rendering it as its name is exactly what `placeOfSupplyLabel` already does
  with the state code, so this is the symmetry being restored, not a document being rewritten.

---

## 5. The SWIFT code nothing could set

`templates/invoice/tax-invoice.html` has carried a SWIFT row since docs/03, bound to
`bank.swift`, and `render.ts` has substituted it: `bank?.swift ?? '—'`.

`CompanyBankAccount.swift` is nullable, and no form, service or seed ever wrote it.

So every invoice printed **—** in the row an overseas client reads to find out where to send
the money. The field, the binding, the renderer and the fallback all worked perfectly; the
value was never there. Found while making the currency selectable, because the two defects
are the same client on the same document.

Now editable on Settings → Company, beside the account it belongs to, with `assertCan` in the
service rather than on the screen — a server action is a POST endpoint with a generated name,
so the check has to sit below the boundary (docs/86 §4). Validated as eight characters or
eleven, which are the two legal lengths, and seeded with Axis Chalakudy's own `AXISINBB046`.

---

## 6. The company's two currencies, which are not the same currency

`Company.currencyDefault` is the **books** currency. An Indian entity keeps its ledger, its
GST and its TDS in rupees; that is not a preference and the setup screen does not offer it.

`Company.billingCurrencyDefault` is new, and is what a **new overseas client** is billed in
unless that client says otherwise — the "mostly USD" that company setup now asks for. The
books stay in rupees either way. Two fields, because they are two different facts, and the
doc comment on each says which.

---

## 7. The guard

`tests/party-lists.test.ts` sweeps `src` and fails the build on:

- a hand-written country option — `<option value="IN">` and friends
- a hand-written state tuple — `['32', 'Kerala']`, the shape all four copies had
- the amount-in-words ternary — `=== 'INR' ? 'Indian Rupees'`

Exempting the three tables and `geo.tsx`, the one component allowed to render them. The sweep
asserts it can see over 200 source files and at least five callers of the selects first,
because a clean sweep that cannot find anything is not a clean sweep.

Both rules were verified by neutering: the country rule named `geo.tsx` before it was
exempted, and the state rule named `vendor-form.tsx` when a two-entry `STATES` was put back.

---

## 8. What is still open

- **The FX posting, still.** A USD invoice books its face value into a rupee control account
  and `Invoice.fxRate` is read nowhere. This module makes *more* currencies reachable, which
  makes that gap wider, not narrower: CNY 12,500 now lands in 1100 as ₹12,500. docs/84 §5 and
  docs/86 §6 both name it; it needs a rate source and the CA's policy, not another table.
- **`currencyDefault` is dead.** Nothing reads the books currency; it is written as `'INR'` in
  two places and that is all. Left alone and documented rather than removed, because the day
  the books are not in rupees is the day it matters.
- **Bank accounts are otherwise still read-only.** Only the SWIFT is editable, because only
  the SWIFT was missing from a document. A full bank-account screen is its own module.
- **A customer's currency can change under issued invoices.** Each invoice snapshots its own
  currency at issue, so nothing behind it moves — the edit form warns, as it does for a
  changed state code, and that is the whole of the protection.
