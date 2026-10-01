# 36 · Report exports

**Status: done.** 416 tests (253 unit + 163 integration), typecheck and lint clean,
production build passes.

Seven statements now download as CSV — the format a CA actually imports. The GST and TDS
screens already had export; the statements built in phase 8 did not.

| Report | `?report=` |
|---|---|
| Trial Balance | `trial-balance` |
| Profit & Loss | `pnl` |
| Balance Sheet | `balance-sheet` |
| Cash Flow | `cash-flow` |
| Receivables ageing | `ageing-ar` |
| Payables ageing | `ageing-ap` |
| Client P&L | `client-pnl` |

---

## 1. 🔴 CSV formula injection — and the trap in fixing it

A cell beginning `=`, `+`, `-`, `@`, tab or CR is **executed as a formula** when the file is
opened in Excel or Sheets. Every name in these exports is user-entered — a customer, a
vendor, an account, a journal narration — so a party named
`=HYPERLINK("http://evil","Invoice")` runs on the **accountant's machine**, when they open a
file we sent them. RFC 4180 quoting does not prevent it; only a leading apostrophe does,
which the spreadsheet strips on display.

**The existing GST and TDS exports had the same gap.** Both had their own local `csvCell`
with correct quoting and no injection guard, so the fix was made once in `src/lib/csv.ts`
and both were migrated onto it.

### 🔴 The trap: a negative number also starts with `-`

Prefixing every `-` would turn `-71000.00` into the text `'-71000.00` — and in a **financial**
export that is every loss, every credit balance and every cash outflow, arriving as text
that refuses to sum. The guard therefore skips anything that is a valid number:

```ts
const FORMULA_LEAD = /^[=+\-@\t\r]/
const NUMERIC = /^-?\d+(\.\d+)?$/
// neutralise only when it leads like a formula AND is not simply a number
```

`-- adjustment` is still neutralised; `-1232900.00` is not. Both are tested, and the whole
thing was verified end to end by giving a real customer a formula for a name and checking
the downloaded file: it arrives as `"'=HYPERLINK(""…`, and **zero cells begin with a bare
`=`**.

## 2. Two smaller things that break real files

- 🔴 **A UTF-8 BOM.** Without it, Excel on Windows reads the file as the system codepage and
  `Nuvé` becomes `NuvÃ©`, `₹` becomes mojibake. Every other reader ignores it.
- 🔴 **No Indian digit grouping.** `formatINR` produces `1,00,300.00`; in a CSV the commas
  split it across columns, and even quoted it imports as text that will not sum. Grouping is
  a display concern and has no business in an export. `csvMoney()` writes a plain decimal.

## 3. What travels with the file

Each export carries a header block — company, GSTIN, period, generated date — because a
sheet that has been emailed on and renamed is otherwise an unattributable list of numbers.

Two things deliberately travel too:

- **The self-check.** `# Balanced,yes` or `NO — out by …` on the trial balance and balance
  sheet, and `# Ties to cash accounts` on the cash flow. A CA opening the file should not
  have to re-add it to find out.
- **The `calculated, not posted` note** against current-year profit on the balance sheet.
  It is the reason the statement balances, and a CA seeing account 3200 with no journal
  behind it needs to know that before going to look for the entry.

Receivables ageing also states the TDS total it **excluded**, since that figure is a
receivable from the government rather than a client debt.

## 4. Download behaviour

The button is a plain `<a download>`, not a fetch. The browser's own download handling shows
progress, survives a navigation, and keeps the `Content-Disposition` filename — which
carries the report and the financial year, because a downloads folder full of `pnl.csv` is
useless.

## 5. Still open

- **PDF** versions of the statements. The renderer from docs/33 can do it; it needs a
  statement template, which is a design job rather than a wiring one.
- **Comparatives** (this year vs last) would be more use in the export than on screen.
- **Journal and account-ledger export** — the drill-through views have no download yet.
- Schedule III presentation grouping, if the CA wants statements in statutory format.
