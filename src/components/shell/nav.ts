import type { Role } from '@prisma/client'
import { can, type Capability } from '@/server/auth/permissions'

export interface NavItem { label: string; href: string; cap: Capability; icon: string; badge?: number }
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
  ]},
  { label: 'Tax', items: [
    { label: 'GST', href: '/tax/gst', cap: 'tax', icon: 'Percent' },
    { label: 'TDS payable', href: '/tax/tds', cap: 'tax', icon: 'ScrollText' },
    { label: 'TDS receivable', href: '/tax/tds-receivable', cap: 'tax', icon: 'HandCoins' },
    { label: 'PAN register', href: '/tax/pan', cap: 'tax', icon: 'IdCard' },
    { label: 'The portal', href: '/tax/portal', cap: 'tax', icon: 'ShieldCheck' },
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
    { label: 'LUT register', href: '/settings/lut', cap: 'settings.company', icon: 'FileCheck' },
    { label: 'Users', href: '/settings/users', cap: 'settings.users', icon: 'UserCog' },
    { label: 'Reminders', href: '/settings/reminders', cap: 'settings.company', icon: 'BellRing' },
    { label: 'This device', href: '/settings/device', cap: 'dashboard', icon: 'Smartphone' },
    { label: 'E-invoicing', href: '/settings/e-invoice', cap: 'tax', icon: 'QrCode' },
  ]},
]

export function navFor(role: Role): NavGroup[] {
  return NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => can(role, i.cap, 'read')) }))
    .filter((g) => g.items.length > 0)
}

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
