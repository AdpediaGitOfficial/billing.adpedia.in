# 80 · The bug hunt — errors that vanished, and the caller docs/72 never added

**Status: done.** Typecheck and lint clean, production build passes, **1,032 tests**
(425 unit + 607 integration) at the time of writing.

Not a feature. Four findings, each of a class this project has already been bitten by once,
which is the only reason it thought to look.

---

## 1. How these were found

`docs/49 §1` said the survey that finds a service with tests and no caller **should be a
script and not a memory**, and for thirty-one modules it stayed a memory. The script is now
`scripts/unreachable.mts`. The rest came from asking the same question of a part of the
codebase the surveys had never covered: the API routes that return a **file** rather than
JSON, which are the only handlers that do not go through `handler()`.

## 2. 🔴 Nine routes that said something and wrote nothing

Every file-serving route had hand-rolled its error handling, and all nine dropped the
logging:

```ts
return new Response(e instanceof AppError ? e.message : 'Could not render the invoice', { status })
```

A tidy sentence for the user and **nothing written down anywhere**. In production that makes
every unexpected failure in a PDF or a CSV export undiagnosable: you learn that something
broke and not one thing more. The careful version already existed ten lines above them in
`_lib/handler.ts` — the file routes had quietly diverged from it.

`fileError(e, route, fallback)` restores it:

🔴 **The message the user sees stays generic on purpose.** A Prisma error carries table
names, column names and fragments of the query, and this response goes to a browser. The
tidy message was never the problem; losing the cause was. So the cause is logged with the
route that produced it, and the sentence is unchanged.

`tests/api-failures.test.ts` asserts both halves — that the cause reaches `console.error`
with its route, and that the body handed to the browser still says nothing about it.

## 3. 🔴 The caller docs/72 wrote the service for and then did not add

`cancelAdvanceTaxPayment` had tests and no caller.

`docs/72`'s own argument was that a modelled-but-unserviced field is the same gap as a
service nothing calls — and it closed the first by opening the second. The service landed
with its tests, the button did not, and an advance-tax challan entered from the wrong
counterfoil could not be corrected from the screen that displays it. Nine modules of green
tests said otherwise.

## 4. 🔴 A default that wasn't, and a 500 that explained nothing

`/api/tax/tds/export` read the financial year as `url.searchParams.get('fy') ?? ''`.

`??` only falls back on `null` or `undefined`; the empty string is neither. So an absent
`fy` handed `''` to `findFirstOrThrow`, which threw a **Prisma** NotFound rather than an
`AppError`, and the route answered `500 Could not build the return` — and, per §2, wrote
nothing anywhere. Every sibling export defaults the year; this one looked like it did.

The page always passes `fy`, so only a typed or truncated URL ever reached it. What the bug
cost was not the failure but the silence around it, which is why it is in the same module as
`fileError`.

## 5. 🔴 A fixture lookup that passed by luck

```ts
prisma.expenseCategory.findFirstOrThrow({ where: { companyId } })
```

Reads as "a category". Means "whichever one Postgres finds convenient". Nine are seeded, and
`TRAVEL` carries `itcDefault: PARTIAL`, which makes `createExpense` demand a blocking reason
and throw — so three integration tests were green only for as long as the physical order of
the table happened to favour a `FULL` category, and would go red the moment enough rows were
written to move it. A stale id then reads as a 404 regression somewhere unrelated.

That is `docs/78 §1`'s lesson about a paginated list, asked of a test: **a query with no total
order returns whatever is convenient, and what is convenient changes.**

`tests/fixture-lookups.test.ts` greps for the pattern and is narrow on purpose — a `where`
of `{ companyId }` and nothing else, which by construction cannot identify a row. A lookup
by code, by label or by a unique flag says what it means and is left alone.

## 6. What was deleted

`postInvoiceReversal` — dead since cancellation started going through the corrections
service. It had been a mirror of `postInvoice` that nothing had called for some time, and an
unused posting rule is worse than an unused function: it is a second definition of how an
invoice reverses, sitting beside the real one.

## 7. The survey, and what it still says

`scripts/unreachable.mts` lists exported service functions that nothing outside their own
file calls. Four have shipped that way — `cancelReceipt` and friends (`docs/49`),
`validateInvoiceNumber` (`docs/64`), `listRefundVouchers` and `listCreditNotes` (`docs/69`),
and `cancelAdvanceTaxPayment` above.

🔴 **It currently still reports one**, and this module did not fix it:

```
  unarchivedInvoices             server/services/storage/document-archive.ts    tests:2
```

`docs/59` wrote the report that names every sent invoice with **no archived copy of what the
client received**, with tests, and nothing in the app calls it. The consequence showed up on
a deployed box within a month: an invoice whose archive failed at send time announces itself
one invoice at a time, on its own page, and nothing anywhere lists them. Left open
deliberately rather than quietly — it belongs with whatever next touches the document
archive.

## 8. The lesson, stated plainly

Three of the four were in code that **no test could have caught**, because the tests asserted
what the code returns and these bugs were about what it *fails* to say. A route that answers
500 with a sentence is indistinguishable, to a test, from a route that answers 500 with a
sentence and a log line. The only way to find them was to read the error paths and ask what
would be known at 3am.
