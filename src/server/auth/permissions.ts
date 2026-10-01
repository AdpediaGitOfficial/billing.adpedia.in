import type { Role } from '@prisma/client'
import { Forbidden } from '@/server/errors'

/** docs/13 §1.1. `read` < `write` < `approve`. */
export type Level = 'none' | 'read' | 'write' | 'approve'

/**
 * Every capability, as a runtime list.
 *
 * The type is DERIVED from this array rather than declared beside it, so a capability can
 * never exist in one and not the other — which is how a permissions page ends up quietly
 * omitting a row that the server is still enforcing.
 */
export const CAPABILITIES = [
  'dashboard', 'customers', 'projects',
  'invoices', 'invoices.send', 'invoices.cancel',
  'receipts', 'vendors', 'bills', 'bills.approve',
  'expenses.own', 'expenses.all', 'expenses.approve',
  'payroll', 'payroll.own',
  'banking', 'banking.post',
  'accounts', 'journal', 'period.lock',
  'tax', 'reports',
  'settings.company', 'settings.users',
] as const

export type Capability = (typeof CAPABILITIES)[number]

// Absence of a capability means 'none' — there is no N constant by design.
const R: Level = 'read', W: Level = 'write', A: Level = 'approve'

const MATRIX: Record<Role, Partial<Record<Capability, Level>>> = {
  OWNER: {
    dashboard: R, customers: W, projects: W, invoices: W, 'invoices.send': A, 'invoices.cancel': A,
    receipts: W, vendors: W, bills: W, 'bills.approve': A,
    'expenses.own': W, 'expenses.all': W, 'expenses.approve': A,
    payroll: A, 'payroll.own': R, banking: W, 'banking.post': A,
    accounts: W, journal: A, 'period.lock': A, tax: W, reports: R,
    'settings.company': W, 'settings.users': W,
  },
  ACCOUNTANT: {
    dashboard: R, customers: W, projects: W, invoices: W, 'invoices.send': A, 'invoices.cancel': A,
    receipts: W, vendors: W, bills: W, 'bills.approve': A,
    'expenses.own': W, 'expenses.all': W, 'expenses.approve': A,
    payroll: W, 'payroll.own': R, banking: W, 'banking.post': A,
    accounts: W, journal: A, tax: W, reports: R,
  },
  PROJECT_MANAGER: {
    dashboard: R, customers: W, projects: W, invoices: W,
    vendors: W, bills: W, 'expenses.own': W, reports: R,
  },
  EMPLOYEE: {
    'expenses.own': W, 'payroll.own': R,
  },
  AUDITOR: {
    dashboard: R, customers: R, projects: R, invoices: R, receipts: R, vendors: R, bills: R,
    'expenses.all': R, payroll: R, banking: R, accounts: R, journal: R, tax: R, reports: R,
    'settings.company': R,
  },
}

const ORDER: Level[] = ['none', 'read', 'write', 'approve']

export function levelFor(role: Role, cap: Capability): Level {
  return MATRIX[role]?.[cap] ?? 'none'
}

export function can(role: Role, cap: Capability, need: Level = 'read'): boolean {
  return ORDER.indexOf(levelFor(role, cap)) >= ORDER.indexOf(need)
}

export function assertCan(role: Role, cap: Capability, need: Level = 'read'): void {
  if (!can(role, cap, need)) throw new Forbidden(`${role} cannot ${need} ${cap}`)
}

/**
 * 🔴 AUDITOR is read-only by construction, not by hiding buttons.
 * Every mutating path calls this before touching a service.
 */
export function assertNotReadOnly(role: Role): void {
  if (role === 'AUDITOR') throw new Forbidden('Auditor access is read-only')
}
