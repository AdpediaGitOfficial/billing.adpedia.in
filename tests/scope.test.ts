import { describe, it, expect } from 'vitest'
import { Scope } from '@/server/repositories/scoped'
import { Forbidden } from '@/server/errors'
import type { RequestContext } from '@/server/context'

const ctx = (role: RequestContext['role']): RequestContext => ({ userId: 'u1', companyId: 'c1', role })

describe('Scope — multi-company isolation', () => {
  it('refuses deletes outright', () => {
    expect(() => new Scope(ctx('OWNER')).delete()).toThrow(/never deleted/)
  })

  it('blocks auditors from any write path', () => {
    const s = new Scope(ctx('AUDITOR'))
    expect(() => s.assertCanWrite()).toThrow(Forbidden)
  })

  it('lets writers through', () => {
    for (const role of ['OWNER', 'ACCOUNTANT', 'PROJECT_MANAGER', 'EMPLOYEE'] as const) {
      expect(() => new Scope(ctx(role)).assertCanWrite()).not.toThrow()
    }
  })

  it('exposes companyId only from the context, never from a caller', () => {
    const s = new Scope(ctx('OWNER'))
    expect(s.companyId).toBe('c1')
    // there is no setter — the only way to change scope is a different token
    expect(Object.getOwnPropertyDescriptor(Scope.prototype, 'companyId')?.set).toBeUndefined()
  })
})
