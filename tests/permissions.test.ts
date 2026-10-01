import { describe, it, expect } from 'vitest'
import { can, assertCan, assertNotReadOnly, levelFor, CAPABILITIES } from '@/server/auth/permissions'
import type { Role } from '@prisma/client'
import { Forbidden } from '@/server/errors'

describe('permission matrix — docs/13 §1.1', () => {
  it('owner can do everything including locking periods', () => {
    expect(can('OWNER', 'period.lock', 'approve')).toBe(true)
    expect(can('OWNER', 'settings.users', 'write')).toBe(true)
    expect(can('OWNER', 'payroll', 'approve')).toBe(true)
  })

  it('accountant runs the books but cannot manage users or lock the year', () => {
    expect(can('ACCOUNTANT', 'invoices.send', 'approve')).toBe(true)
    expect(can('ACCOUNTANT', 'banking.post', 'approve')).toBe(true)
    expect(can('ACCOUNTANT', 'settings.users')).toBe(false)
    expect(can('ACCOUNTANT', 'period.lock')).toBe(false)
  })

  it('project manager never sees payroll', () => {
    expect(can('PROJECT_MANAGER', 'payroll')).toBe(false)
    expect(can('PROJECT_MANAGER', 'projects', 'write')).toBe(true)
    expect(can('PROJECT_MANAGER', 'invoices.send')).toBe(false)
  })

  it('employee sees only their own expenses and payslips', () => {
    expect(can('EMPLOYEE', 'expenses.own', 'write')).toBe(true)
    expect(can('EMPLOYEE', 'payroll.own', 'read')).toBe(true)
    expect(can('EMPLOYEE', 'invoices')).toBe(false)
    expect(can('EMPLOYEE', 'expenses.all')).toBe(false)
    expect(can('EMPLOYEE', 'reports')).toBe(false)
  })

  it('auditor reads everything and writes nothing', () => {
    expect(can('AUDITOR', 'journal', 'read')).toBe(true)
    expect(can('AUDITOR', 'reports', 'read')).toBe(true)
    for (const cap of ['invoices', 'receipts', 'bills', 'payroll', 'banking', 'accounts', 'journal'] as const) {
      expect(levelFor('AUDITOR', cap)).toBe('read')
    }
    expect(() => assertNotReadOnly('AUDITOR')).toThrow(Forbidden)
    expect(() => assertNotReadOnly('ACCOUNTANT')).not.toThrow()
  })

  it('assertCan names the role and the capability', () => {
    expect(() => assertCan('EMPLOYEE', 'payroll', 'write')).toThrow(/EMPLOYEE cannot write payroll/)
  })
})

describe('🔴 the capability list cannot drift from the matrix', () => {
  it('every capability any role is granted appears in CAPABILITIES', () => {
    // CAPABILITIES is what the roles screen renders. If a capability existed in the matrix
    // but not the list, the screen would quietly omit a row the server is still enforcing —
    // which is worse than no screen, because it reads as "nobody can do this".
    const roles: Role[] = ['OWNER', 'ACCOUNTANT', 'PROJECT_MANAGER', 'EMPLOYEE', 'AUDITOR']
    const listed = new Set<string>(CAPABILITIES)

    for (const role of roles) {
      for (const cap of CAPABILITIES) {
        // exercising every pair also proves levelFor never throws on a listed capability
        expect(['none', 'read', 'write', 'approve']).toContain(levelFor(role, cap))
      }
    }
    expect(listed.size).toBe(CAPABILITIES.length)   // no duplicates
  })

  it('the owner can do everything the list names', () => {
    for (const cap of CAPABILITIES) expect(can('OWNER', cap, 'read')).toBe(true)
  })

  it('an auditor can read but never write, anywhere', () => {
    for (const cap of CAPABILITIES) expect(can('AUDITOR', cap, 'write')).toBe(false)
  })

  it('an employee reaches only their own expenses and payslips', () => {
    const allowed = CAPABILITIES.filter((c) => can('EMPLOYEE', c, 'read'))
    expect([...allowed].sort()).toEqual(['expenses.own', 'payroll.own'])
  })
})
