import type { Role } from '@prisma/client'
import { can, type Capability } from '@/server/auth/permissions'
import type { IconName } from '@/components/shell/icons'

export interface NavItem {
  label: string; href: string; cap: Capability; icon: IconName; badge?: number
  /** docs/82 §5 — meaningless for an entity that is not registered for GST */
  gstOnly?: true
  /** docs/82 §4 — a company has no drawings: a director is paid, or lent to, not helped out */
  drawingsOnly?: true
}
export interface NavGroup { label: string; items: NavItem[] }

/** docs/13 §2.1. Filtered by role — the server also refuses whatever the UI hides. */
export const NAV: NavGroup[] = [
  { label: '', items: [
    { label: 'Dashboard', href: '/dashboard', cap: 'dashboard', icon: 'LayoutDashboard' },
    // docs/61 — cross-cutting: PAN, certificates, 26AS credits and unpaid invoices all end
    // in somebody outside this company being asked for something
    { label: 'Chases', href: '/chases', cap: 'tax', icon: 'MessageSquare' },
  ]},
  { label: 'Sales', items: [
    { label: 'Customers', href: '/customers', cap: 'customers', icon: 'Users' },
    { label: 'Projects', href: '/projects', cap: 'projects', icon: 'FolderKanban' },
    { label: 'Invoices', href: '/invoices', cap: 'invoices', icon: 'FileText' },
    // docs/69 — the notes have always been reachable from their invoice and nowhere else
    { label: 'Credit & debit notes', href: '/notes', cap: 'invoices', icon: 'FileStack' },
    { label: 'Receipts', href: '/receipts', cap: 'receipts', icon: 'Receipt' },
  ]},
  { label: 'Purchases', items: [
    { label: 'Vendors', href: '/vendors', cap: 'vendors', icon: 'Store' },
    { label: 'Bills', href: '/bills', cap: 'bills', icon: 'FileInput' },
    { label: 'Expenses', href: '/expenses', cap: 'expenses.own', icon: 'CreditCard' },
    { label: 'Capture', href: '/expenses/capture', cap: 'expenses.own', icon: 'Camera' },
  ]},
  { label: 'Payroll', items: [
    { label: 'Employees', href: '/payroll/employees', cap: 'payroll', icon: 'IdCard' },
    { label: 'Monthly Run', href: '/payroll/runs', cap: 'payroll', icon: 'CalendarClock' },
  ]},
  { label: 'Banking', items: [
    { label: 'Reconcile', href: '/banking/reconcile', cap: 'banking', icon: 'Landmark' },
    { label: 'Import', href: '/banking/import', cap: 'banking', icon: 'Upload' },
    // docs/82 §4 — the owner's own money, in and out. Equity, never the P&L
    { label: 'Drawings', href: '/drawings', cap: 'journal', drawingsOnly: true, icon: 'Banknote' },
  ]},
  { label: 'Tax', items: [
    { label: 'GST', href: '/tax/gst', cap: 'tax', gstOnly: true, icon: 'Percent' },
    { label: 'TDS payable', href: '/tax/tds', cap: 'tax', icon: 'ScrollText' },
    { label: 'TDS receivable', href: '/tax/tds-receivable', cap: 'tax', icon: 'HandCoins' },
    { label: 'PAN register', href: '/tax/pan', cap: 'tax', icon: 'IdCard' },
    { label: 'The portal', href: '/tax/portal', cap: 'tax', icon: 'ShieldCheck' },
    // docs/71 — s.211 instalments, and the estimate they are a percentage of
    { label: 'Advance tax', href: '/tax/advance', cap: 'tax', icon: 'Scale' },
    { label: 'Calendar', href: '/tax/calendar', cap: 'tax', icon: 'CalendarClock' },
  ]},
  { label: 'Accounting', items: [
    { label: 'Chart of Accounts', href: '/accounting/accounts', cap: 'accounts', icon: 'ListTree' },
    { label: 'Journal', href: '/accounting/journal', cap: 'journal', icon: 'BookOpen' },
    { label: 'Trial Balance', href: '/accounting/trial-balance', cap: 'reports', icon: 'Scale' },
    { label: 'Close the books', href: '/accounting/close', cap: 'period.lock', icon: 'Lock' },
  ]},
  { label: 'Reports', items: [
    { label: 'All reports', href: '/reports', cap: 'reports', icon: 'LayoutGrid' },
    { label: 'Profit & Loss', href: '/reports/pnl', cap: 'reports', icon: 'TrendingUp' },
    { label: 'Balance Sheet', href: '/reports/balance-sheet', cap: 'reports', icon: 'Scale' },
    { label: 'Cash Flow', href: '/reports/cash-flow', cap: 'reports', icon: 'Wallet' },
    { label: 'Ageing', href: '/reports/ageing', cap: 'reports', icon: 'HandCoins' },
    { label: 'Client P&L', href: '/reports/client-pnl', cap: 'reports', icon: 'Users' },
    { label: 'Project P&L', href: '/reports/project-pnl', cap: 'reports', icon: 'ChartPie' },
  ]},
  { label: 'Settings', items: [
    { label: 'Company', href: '/settings/company', cap: 'settings.company', icon: 'Building2' },
    // docs/82 — more than one entity under one login, and the way between them
    { label: 'Companies', href: '/settings/companies', cap: 'dashboard', icon: 'Building2' },
    { label: 'Services', href: '/settings/services', cap: 'invoices', icon: 'Package' },
    { label: 'LUT register', href: '/settings/lut', cap: 'settings.company', gstOnly: true, icon: 'FileCheck' },
    { label: 'Document series', href: '/settings/series', cap: 'invoices', icon: 'Hash' },
    { label: 'Users', href: '/settings/users', cap: 'settings.users', icon: 'UserCog' },
    { label: 'Reminders', href: '/settings/reminders', cap: 'settings.company', icon: 'BellRing' },
    { label: 'This device', href: '/settings/device', cap: 'dashboard', icon: 'Smartphone' },
    { label: 'E-invoicing', href: '/settings/e-invoice', cap: 'tax', gstOnly: true, icon: 'QrCode' },
  ]},
]

export function navFor(
  role: Role,
  opts: { gstRegistered?: boolean; hasDrawings?: boolean } = {},
): NavGroup[] {
  // 🔴 docs/82 §5 — GSTR-1, QRMP, the LUT register and e-invoicing are all things a REGISTERED
  // person does. Offered to an unregistered entity they are screens that cannot mean anything,
  // and the LUT one invites zero-rating an export that is not zero-rated.
  const gstRegistered = opts.gstRegistered ?? true
  // 🔴 docs/82 §4 — and the mirror of it: drawings belong to an entity whose owner and
  // business are the same person. On a company's rail it would invite recording a director's
  // withdrawal as something that needs no salary, no TDS and no repayment.
  const hasDrawings = opts.hasDrawings ?? false
  return NAV
    .map((g) => ({
      ...g,
      items: g.items.filter((i) => can(role, i.cap, 'read')
        && (gstRegistered || !i.gstOnly)
        && (hasDrawings || !i.drawingsOnly)),
    }))
    .filter((g) => g.items.length > 0)
}

/**
 * 🔴 docs/83 — the tab bar's fifth slot, and the only route a phone has to the rest of the app.
 *
 * It was a literal inside `BottomTabs`, pointing at a page that did not exist: `/more` fell
 * through to the roadmap catch-all, which said the screen was "arriving in phase 1". Named
 * here so the guard in `tests/mobile-reachable` can check the target the way the bar does.
 */
export const MORE_TAB: NavItem = { label: 'More', href: '/more', cap: 'dashboard', icon: 'Menu' }

/** docs/13 §2.3 — mobile tabs are role-shaped; nobody does a trial balance on a phone. */
export function mobileTabsFor(role: Role): NavItem[] {
  const home: NavItem = { label: 'Home', href: '/dashboard', cap: 'dashboard', icon: 'Home' }
  switch (role) {
    case 'OWNER':
      return [home,
        { label: 'Sales', href: '/invoices', cap: 'invoices', icon: 'FileText' },
        { label: 'Money', href: '/receipts', cap: 'receipts', icon: 'Wallet' },
        { label: 'Approvals', href: '/approvals', cap: 'bills.approve', icon: 'CheckCircle2' }]
    case 'ACCOUNTANT':
      return [home,
        { label: 'Sales', href: '/invoices', cap: 'invoices', icon: 'FileText' },
        { label: 'Money', href: '/receipts', cap: 'receipts', icon: 'Wallet' },
        { label: 'Banking', href: '/banking/reconcile', cap: 'banking', icon: 'Landmark' }]
    case 'PROJECT_MANAGER':
      return [home,
        { label: 'Projects', href: '/projects', cap: 'projects', icon: 'FolderKanban' },
        { label: 'Bills', href: '/bills', cap: 'bills', icon: 'FileInput' }]
    case 'EMPLOYEE':
      return [
        { label: 'Expenses', href: '/expenses', cap: 'expenses.own', icon: 'CreditCard' },
    { label: 'Capture', href: '/expenses/capture', cap: 'expenses.own', icon: 'Camera' },
        { label: 'Payslips', href: '/payroll/me', cap: 'payroll.own', icon: 'IdCard' }]
    case 'AUDITOR':
      return [home,
        { label: 'Journal', href: '/accounting/journal', cap: 'journal', icon: 'BookOpen' },
        { label: 'Reports', href: '/reports/pnl', cap: 'reports', icon: 'TrendingUp' }]
  }
}
