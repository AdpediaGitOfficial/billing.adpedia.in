# 13 · Screens, Navigation & Permissions

Mobile-first, per `02-recon-tds-mobile-pdf.md` Part C. Responsive PWA — one codebase,
two information architectures.

---

## 1. Roles

Five roles. Adpedia needs three today; the other two exist so they don't require a
migration later.

| Role | Who | Sees |
|---|---|---|
| **OWNER** | Shinelal | Everything, including payroll and approvals |
| **ACCOUNTANT** | accounts staff / CA | Everything financial except changing user roles |
| **PROJECT_MANAGER** | delivery lead | Their projects, project P&L, vendor bills; **no payroll** |
| **EMPLOYEE** | Akash, Deepak, Kiran | Own expenses, own payslips. Nothing else. |
| **AUDITOR** | external | **Read-only** across everything. No writes, ever. |

### 1.1 Permission matrix

`—` no access · `R` read · `W` create/edit · `A` approve/post

| Capability | OWNER | ACCOUNTANT | PROJECT_MGR | EMPLOYEE | AUDITOR |
|---|:--:|:--:|:--:|:--:|:--:|
| Dashboard | R | R | R (own projects) | — | R |
| Customers, projects | W | W | W (own) | — | R |
| Invoices — draft | W | W | W (own) | — | R |
| Invoices — **send** | A | A | — | — | — |
| Invoices — **cancel** | A | A | — | — | — |
| Receipts | W | W | — | — | R |
| Vendors, bills | W | W | W (own projects) | — | R |
| Bills — **approve** | A | A | — | — | — |
| Expenses — own | W | W | W | **W** | — |
| Expenses — **approve** | A | A | — | — | — |
| **Payroll** | W A | W | — | own payslip only | R |
| Bank import & matching | W | W | — | — | R |
| Bank match — **post** | A | A | — | — | — |
| Chart of accounts | W | W | — | — | R |
| Journal entries — manual | A | A | — | — | R |
| **Period lock / FY close** | A | — | — | — | — |
| GST & TDS returns | W | W | — | — | R |
| Reports | R | R | R (own projects) | — | R |
| Company profile, branding | W | — | — | — | R |
| Users & roles | W | — | — | — | — |

**Enforced server-side in the repository layer**, from the `role` and `companyId` in the
JWT. The UI hides what a role cannot do; the server refuses it regardless.

🔴 **AUDITOR is enforced by a global write-guard**, not by omitting buttons — any mutation
under an auditor token throws before it reaches a service.

---

## 2. Navigation

### 2.1 Desktop — sidebar

```
Dashboard
Sales        Customers · Projects · Quotations · Invoices · Receipts · Credit Notes · Receivables
Purchases    Vendors · Bills · Payments · Payables
Expenses     Expenses · Recurring · Categories
Payroll      Employees · Salary Structures · Monthly Run · Staff Allocation
Banking      Accounts · Import Statement · Reconcile · Rules
Tax          GST Dashboard · GSTR-1 · GSTR-3B · TDS Payable · TDS Receivable · Challans · 26AS
Accounting   Chart of Accounts · Journal · General Ledger · Trial Balance
Reports      P&L · Balance Sheet · Cash Flow · Project P&L · Client P&L · Ageing
Settings     Company · Branding · Series · Financial Years · LUTs · Users · Tax Rates
```

### 2.2 Mobile — bottom tabs, 5 slots

```
┌──────────────────────────────────┐
│                                  │
│           (content)              │
│                         ╭───╮    │
│                         │ + │    │
│                         ╰───╯    │
├─────┬─────┬─────┬─────┬──────────┤
│ 🏠  │ 📄  │ 💰  │ ✅  │ ☰       │
│Home │Sales│Money│Appr │More      │
└─────┴─────┴─────┴─────┴──────────┘
```

The `+` FAB is context-aware: on Sales → new invoice; on Money → record receipt;
anywhere → expense capture with the camera.

Accounting, Tax and Reports live under **More** — nobody does a trial balance on a phone.

### 2.3 Role-shaped mobile

| Role | Tabs |
|---|---|
| OWNER | Home · Sales · Money · **Approvals** · More |
| ACCOUNTANT | Home · Sales · Money · **Banking** · More |
| PROJECT_MANAGER | Home · **Projects** · Bills · More |
| EMPLOYEE | **Expenses** · Payslips · More — *that is the entire app for them* |

---

## 3. Screens

### 3.1 Dashboard — owner

```text
┌────────────────────────────────────┐
│ Good evening, Shinelal    🔔 3     │
│ FY 2026-27 · September             │
├────────────────────────────────────┤
│  REVENUE THIS MONTH                │
│  ₹2.54L              ▲ 18.4%       │
│  ▁▂▄▃▅▇█  last 7 months            │
├─────────────────┬──────────────────┤
│ RECEIVABLE      │ PAYABLE          │
│ ₹8.2L           │ ₹4.5L            │
│ 7 overdue  ⚠    │ due this week    │
├─────────────────┴──────────────────┤
│ PROJECT PROFIT (MTD)               │
│ ₹1.03L · 41.2% margin              │
├────────────────────────────────────┤
│ NEEDS YOU                          │
│ ⚠ 7 invoices overdue    ₹3.1L  →   │
│ ⚠ 47 bank lines to match       →   │
│ ⚠ TDS challan due 7 Oct ₹1.24L →   │
│ ⚠ GSTR-1 due in 4 days         →   │
│ 🔴 No LUT for FY 2026-27       →   │
│ ✓ 3 vendor bills to approve    →   │
└────────────────────────────────────┘
```

**Every tile drills down.** "Needs you" is the retention mechanic — an accounting app
that gets opened daily is one that says what is on fire.

Served by **one** aggregated endpoint (`GET /api/dashboard`), not 14 queries.

### 3.2 Invoice create — mobile, 4 steps

```
1  Client + Project     recent clients as chips; tax mode shown once client is picked
2  Line items           add-item sheet; SAC autofilled from ServiceItem
3  Tax + TDS            fully computed, read-only; TDS section is the only choice
4  Review + Send        live PDF preview, share targets
```

- Numeric keypad on every amount (`inputmode="decimal"`)
- **Tax mode is displayed, never chosen** — a banner reads *"Kerala → Kerala · CGST 9% + SGST 9%"*
- Autosave on every blur — never lose an invoice to an incoming call
- 🔴 **Send is blocked** when: mandatory Rule 46 fields missing · export invoice with no
  valid LUT for the FY · period locked

### 3.3 Bank reconciliation

**Desktop:** two panes, keyboard-first — `↓`/`Enter` accept, `S` split, `I` ignore,
`B` bulk-accept everything ≥90%. Accounts staff work through these in runs.

**Mobile:** one card at a time.

```text
┌────────────────────────────────┐
│ 12 Sep · Axis ····5413         │
│                                │
│   ₹91,800  CREDIT              │
│   NEFT/HDFCH…/CLICK AR BUSI…   │
│                                │
│ ┌────────────────────────────┐ │
│ │ 92%  ADP/26-27/0026        │ │
│ │ Click AR · ₹1,00,300       │ │
│ │ + TDS ₹8,500 u/s 194J      │ │
│ │ = exact match              │ │
│ └────────────────────────────┘ │
│                                │
│  [ Split ]  [ Skip ]  [ ✓ ]    │
└────────────────────────────────┘
        18 of 47 · ₹2.1L to go
```

Progress and "₹ remaining" are the motivator. Match reasons are always shown in words —
never a bare score.

### 3.4 Vendor bill entry — where the tax warnings fire

Inline, at the moment of entry, not in a month-end report:

```
⚠ Praveen C D — this bill takes FY 2026-27 total to ₹52,000.
  Annual 194J threshold crossed.
  TDS is now due on the FULL ₹52,000, not just this bill.
  Catch-up TDS this bill: ₹5,200          [ Apply ]  [ Override… ]

🔴 DigitalOcean is a foreign supplier. IGST ₹4,500 payable under reverse charge.
  A self-invoice will be generated.        [ Understood ]

⚠ No verified PAN for Maneesh Unnikuttan — s.206AA applies, TDS at 20% not 10%.
                                           [ Add PAN ]  [ Deduct at 20% ]
```

### 3.5 Expense capture — mobile, the most-used screen

Camera → OCR amount/date/GSTIN → category → project → done. Four taps.
`itcEligible` is set by category and needs a typed reason to override.
Works offline; queues and syncs.

### 3.6 Project P&L

```
Prime — Website Development            Click AR Business Pvt Ltd

Revenue        ₹8,00,000   ████████████████████
Staff cost     ₹2,40,000   ██████               ← from StaffAllocation
Freelancers    ₹1,80,000   ████▌
Vendors        ₹  80,000   ██
Cloud & other  ₹  40,000   █
─────────────────────────────────────────────────
Gross profit   ₹2,60,000               Margin 32.5%
```

Every number drills to the journal lines behind it.

---

## 4. Mobile behaviour

| | |
|---|---|
| Installable PWA | Home-screen icon, no app store |
| Offline | Expense + receipt capture queue and sync |
| Push | Payment received · approval pending · GST/TDS due · invoice overdue |
| Biometric | WebAuthn re-auth after 5 minutes idle |
| **Share** | Web Share API → **WhatsApp** with the invoice PDF |
| Numbers | `₹9,44,000` grouping; `₹25.4L` / `₹1.2Cr` in tiles, tap to expand |
| Tables | Become cards below 768px. **Never** a horizontally scrolling grid. |
| Actions | Swipe right = primary, left = secondary, always with Undo |

### Performance budget

FCP < 1.5s on 4G · interactive < 3s · skeletons not spinners · virtualised lists past 50
rows · route-level code splitting so an employee filing an expense never downloads the GL.

🔴 Measured by `scripts/perf.mts` — see `docs/68`, which also adds a **bytes** line this one
does not have, and records why windowing a server-rendered list does not move the clock.

---

## 5. Empty and error states

| State | Copy |
|---|---|
| No invoices yet | "No invoices yet. Your first will be **ADP/26-27/0026**." |
| Nothing to reconcile | "All 47 lines matched. Books agree with the bank to 30 Sep." |
| Export blocked, no LUT | "No valid LUT for FY 2026-27. File RFD-11, or raise this invoice with IGST." |
| Period locked | "September is locked — GSTR-3B was filed on 20 Oct. Post a reversal in October instead." |
| Threshold crossed | see §3.4 |

Error copy states **what to do**, not what went wrong. See `design:ux-copy` conventions.
