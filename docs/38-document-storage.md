# 38 · Document storage

**Status: done.** 455 tests (257 unit + 198 integration), typecheck and lint clean,
production build passes.

Five `…Url` fields existed in the schema and **nothing could write to them**. A receipt
photographed on a phone never left the phone — phase 9 queued the image and had nowhere to
put it, so if the handset was wiped, the evidence behind an input-credit claim went with it.

---

## 1. One interface, two drivers

`LocalStorageDriver` writes to `./.storage` and works with nothing to provision.
`S3StorageDriver` is **deliberately not implemented** (§6). Everything above the driver
stores an opaque key and never knows which is in use.

## 2. 🔴 The filename never touches the storage path

A filename is attacker-controlled: `../../../etc/passwd`, a leading slash, a NUL byte, a
4000-character path. Sanitising all of that correctly is a losing game, so the key is
**generated** and the original name kept only as a label:

```
<companyId>/<yyyymm>/<32 hex chars>.<ext>
```

The local driver then re-checks every resolved path against its root anyway — if a key ever
did come from somewhere else, that is what stops it writing outside the directory. Both are
tested, including a traversal attempt that ends up as a harmless label.

The label is also stripped of the **RTL override** (`U+202E`), which turns
`receipt<U+202E>gpj.exe` into something that displays as `receipt.exe` reversed — i.e. reads
as an image.

## 3. 🔴 The declared content-type is not believed

A client controls `Content-Type` completely. A file claiming `image/png` that is in fact
HTML would be stored as an image, and anything that ever served it inline would execute it
with the signed-in user's session.

So every upload is checked against the file's **magic bytes** — `%PDF-`, the PNG signature,
`ftyp` for HEIC — and a mismatch is refused by name:

> That file says it is image/png but its contents are not.

Verified over real HTTP, not only in tests: an HTML file labelled `image/png` is rejected,
and so is an SVG.

### Two formats are deliberately absent

- **SVG.** It is an image by every ordinary definition and it can contain `<script>`.
  Served from this origin that is stored XSS, from a file an employee uploaded as a receipt.
- **HTML.** The same, with less disguise.

HEIC *is* accepted, because that is what an iPhone produces by default and refusing it would
mean half the receipts simply fail.

## 4. 🔴 Serving is hostile by default

Nothing a user uploaded renders in this origin:

```
content-disposition: attachment; …     ← never inline
x-content-type-options: nosniff        ← the browser may not second-guess the type
content-security-policy: default-src 'none'; sandbox
cache-control: private, no-store
```

Reads are scoped to the caller's company **inside the same query that finds the row**.
Looking it up by id and comparing `companyId` afterwards is identical until somebody edits
one of those two lines; keeping it in the `where` makes a cross-company read impossible
rather than merely guarded against.

## 5. 🔴 Detaching keeps the evidence

There is no delete. A receipt is the proof behind an input-credit claim and a bill PDF
substantiates a deduction — destroying either could remove what is needed to sustain the
claim years later, when it is finally asked for. `detachAttachment` sets `detachedAt`: the
file disappears from the record and remains readable and stored.

This also matches the rest of the system, where a wrong invoice is cancelled and reversed
rather than erased, and where the database itself refuses a hard delete on financial tables.

## 6. The offline queue now finishes the job

Phase 9 queued the photo and stopped. The drain is now two-stage, and the ordering matters:

1. POST the expense → record **`expenseId` on the queue item**
2. POST the photo against that id

🔴 Recording the id first is what makes a failed upload safe. Without it, a retry would
re-post the expense — booking it twice and **claiming its input credit twice**, which is the
exact failure the `clientKey` was introduced to prevent. The test asserts the expense is
posted once across two drains.

A `4xx` on the photo stops the retrying: the file itself is unacceptable, the expense is
already safely booked, and nagging forever over an image would block a queue that has
nothing else wrong with it.

## 7. The S3 driver is not implemented

Adpedia has no object storage provisioned and no credentials. An untested S3 client that
merely looked finished would be discovered the first time a receipt failed to upload —
which is exactly when nobody is watching.

To complete it: `@aws-sdk/client-s3`, `PutObjectCommand` / `GetObjectCommand`, and
`STORAGE_S3_*` configuration. 🔴 **The bucket must not be public.** Downloads go through this
app so that the company check still applies; a public bucket would make every receipt
readable by anyone holding a URL.

## 8. Still open

- **PAN cards reuse all of this** (`docs/47`) — same magic-byte check, same never-inline
  serving, plus a company-scoped lookup of the party before an identity document is stored.
- **Attachments are not yet shown on the expense and bill screens** — upload and download
  work through the API, the UI does not list them.
- **Payslip and invoice PDFs** are not stored as attachments yet; both are generated on
  demand.
- **Virus scanning.** Files are checked for what they claim to be, not for what they contain.
  For a company this size the honest answer is that files are never executed and never served
  inline; a scanner is the right call once files are shared outside the company.
