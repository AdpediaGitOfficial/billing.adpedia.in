# 85 · The document that would not download

A deployed invoice answered `500` and the words *Could not render the invoice*, and that was
the entire diagnosis available to the person holding the phone.

This module is about the second half of that sentence more than the first. The failure is on
a box I cannot see; what I **can** fix is that the system had no way to say what was wrong
with it, and three places where it gave up on a document it could still have produced.

---

## 1. The archive was best effort going in and fatal coming out

`archiveIssuedDocument` has never thrown, on reasoning written into the file in docs/59:

> a company that cannot bill because a PDF renderer is unwell is a worse failure than one
> without a file on record

Serving took the opposite line, and nobody decided it. All four document routes did this:

```ts
const archived = await archivedDocument(ctx.companyId, 'Invoice', id)
if (archived) {
  const { bytes } = await readAttachment(ctx, archived.id)   // ← throws, and the route 500s
```

`readAttachment` ends at `readFile`. So an `Attachment` row pointing at bytes that are not
there — a storage directory left behind in a move, a `STORAGE_DIR` repointed, a database
restored without its blobs, a permission — came out of `/api/invoices/[id]/document` as a flat
500 **on a document the database could rebuild in a second**.

🔴 The archive is a record of what was issued, and losing it is a real loss, reported in the
log with the storage key so the file can be gone looking for. It is not a reason to withhold
the invoice. `archivedDocumentBytes` returns the bytes or nothing, the routes render when it
returns nothing, and `x-document-source` says plainly which of the two happened.

Proven by removing the blob under a sent invoice and asking for it again:

| | before | after |
|---|---|---|
| `GET /api/invoices/…/document` | `500 Could not render the invoice` | `200`, `x-document-source: rebuilt-now` |

---

## 2. A renderer that cannot run, and a box that could not say so

Every invoice, credit note, voucher, payslip and statement in this system is a Chromium
render. One missing browser takes out **all of them at once** — and from the screen that looks
exactly like one broken invoice.

Playwright says which of three things went wrong, in a sentence written for a developer at a
terminal. `rendererUnavailable` translates the three known shapes into one written for whoever
clicked *download*, and leaves everything else alone:

| what Playwright says | what the person reads |
|---|---|
| `Executable doesn't exist at …` | run `npx playwright install chromium` from the application directory, **as the user the application runs as** |
| `Host system is missing dependencies …` | run `npx playwright install-deps chromium`, as root |
| `Target page, context or browser has been closed` | it ran out of memory — one document at a time, or the server needs more |

The result is a `503`, not a `500`: the document is fine, the renderer is not.

🔴 **Only the known shapes.** Anything unrecognised stays generic and goes to the log, because
an unrecognised error is where table names and query fragments live — docs/80's rule, and it
is the reason this is a classifier and not a `catch`. The raw error is logged either way: it
carries the path Playwright searched, which is what actually settles a wrong-user install.

Verified against the real thing rather than a remembered string, by running a render with
`PLAYWRIGHT_BROWSERS_PATH` pointed at an empty directory.

### The health route

docs/90 listed **"no health route"** under *Known gaps on the box*, with the note that
monitoring was pointed at `/login` — which returns 200 for as long as Next is running, whatever
is happening underneath. The gap cost something real: the cause of the 500 was in a pm2 log,
which needs ssh, which is not what the person reporting it had.

| | |
|---|---|
| `GET /api/health` | public, no session. The database and nothing else — what a monitor should watch |
| `GET /api/health?deep=1` | signed in, **OWNER only**, and it *exercises* each subsystem |

```json
{"ok":true,
 "database":{"ok":true,"ms":6,"detail":"PostgreSQL 18.4"},
 "storage": {"ok":true,"ms":13,"detail":"local · STORAGE_DIR unset, using .storage in the checkout"},
 "renderer":{"ok":true,"ms":1144,"detail":"Chromium produced a 7 KB PDF"},
 "archive": {"issuedWithNoCopyOnFile":0,"numbers":[]}}
```

🔴 It **renders a real PDF and writes a real file**. A check that reports a renderer is
configured answers a question nobody asks; the failure happens at `chromium.launch()`, which
nothing short of launching can observe. Storage is written, read back, compared and removed,
because a check that only reads configuration passes on a box where the directory moved —
which is §1's failure exactly.

OWNER-only rather than merely signed in, because the deep check forks a browser, and an
endpoint that does that for anyone who asks is a way to take the box down.

`issuedWithNoCopyOnFile` is not a pass or a fail. An invoice issued before the archive existed
will be counted forever and nothing is wrong with it. It belongs here because **a renderer
that has been broken for a week shows up as a week of invoices with nothing on record**.

---

## 3. The screen threw the sentence away too

`ShareInvoice` — the button most likely to be pressed on a phone — did this:

```ts
if (!res.ok) throw new Error('Could not fetch the document')
```

The response body, which is where the server put its explanation, was dropped on the floor.
So the one screen most likely to be looked at was the one place the explanation could not
reach. It now shows what the server actually said, when that is a short plain-text sentence
and not somebody's HTML error page.

The same shape as docs/83 §5: a reason built carefully by one layer and discarded by the next.

---

## 4. One set of document headers

Five copies of the same header block lived in four routes, and they had already drifted:
`?download=1` was added to the invoice in docs/83 §6 **and to nothing else**, so a credit note,
a payslip, a voucher and a statement could be looked at and not saved. `pdfHeaders` is now the
only place that decides, and a sweep fails any document route that hand-rolls a
`content-disposition` again.

That sweep found a fifth document route I had not looked at — `reports/document`, which renders
statements and archives none of them. The archive rule is conditional because of it, and it now
honours `?download=1` like the rest.

🔴 The guard counts what it matched before it asserts anything. A sweep that finds nothing
passes, and a passing test that inspected zero files is worse than no test.

---

## 5. The timer that measured nothing

My own, caught by looking at the output instead of the green tick:

```ts
return { ok: true, ms: Date.now() - t, detail: await fn() }   // every check reported 0 ms
```

Object properties evaluate in source order, so `ms` was read before the work started. Every
check said `0`, which reads as *instant* rather than *never measured* — a wrong number is worse
than a missing one. The renderer check really takes about 1.1 seconds.

---

## 6. What I could not see

The failing box is not this repository: nothing here has ever been pushed, `origin/main` holds
one file, and the deployed code arrived some other way. So §1–§4 are the things that were
genuinely wrong **in the code**, and none of them can be confirmed as *the* cause of that
particular 500.

On the box itself, in order of likelihood:

1. **Chromium.** `npm ci` during a redeploy pulls the Playwright package without its browser.
   The archive at send time would have failed too — which is consistent with the invoice in
   the report having no copy on file.
2. **Memory.** Chromium is a child process, so nothing in the app's own memory shows it; a
   download that starts and then dies is this.
3. **The storage directory**, which §1 now survives.

`GET /api/health?deep=1`, signed in as the owner, distinguishes all three in one request — and
after a deploy it is worth looking at once, before an invoice needs to go out.

---

## 7. Still open

- The deployed box runs code that came from somewhere other than this repository, and there is
  no way to tell from here which revision. Nothing in §1–§5 reaches it until it is redeployed.
- The templates still fetch Poppins from Google at render time. docs/83 §5 made the wait
  deterministic; it did not remove the dependency, and a box with no egress still renders in a
  fallback face. Vendoring the font is ~350 KB and the decision has not been made.
- **`?download=1` now works on every document route and only two screens use it** — the
  invoice list and the invoice detail page. The others keep their preview defaults on purpose:
  `StatementPdfButton` says in its own comment that a statement is read rather than filed, and
  tapping a payslip on a phone should open it. The parameter is a second intention, available
  by asking; a sweep makes sure every route still reads it rather than hard-coding one answer.
- `issuedWithNoCopyOnFile` counts rows, not readable bytes. Catching §1's failure in the count
  would mean reading every archived blob on every health check, which is not worth it.
