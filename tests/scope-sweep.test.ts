import { describe, it, expect } from 'vitest'
import { sweep, scopedModels } from './helpers/scope-sweep'

/**
 * 🔴 docs/95 — docs/82's sweep was a script nobody ran, and it read 106 queries with no company
 * filter. They are scoped now, and this is what keeps them so: a new query on a company-scoped
 * model that does not carry `companyId` in its own `where` fails the build.
 *
 * Each entry below is a query that is company-less ON PURPOSE. Adding to this list is a
 * decision that needs a reason written next to it, not a way to make a red test green.
 */
const BY_DESIGN: { file: string; model: string; why: string }[] = [
  { file: 'src/server/services/auth/invitation.ts', model: 'invitation',
    why: 'acceptance is by the secret token, by somebody with no account and so no company (docs/73)' },
  { file: 'src/app/(app)/layout.tsx', model: 'userCompany',
    why: 'counts THIS USER\'s memberships to decide whether to show the entity switcher — across companies by definition' },
  { file: 'src/server/services/company/switch.ts', model: 'userCompany',
    why: 'lists THIS USER\'s memberships for the switcher — the user belongs to several companies, which is the point (docs/82 §3)' },
  { file: 'src/server/services/banking/import.ts', model: 'bankTransaction',
    why: 'dedupeHash is unique and already includes the bank account id, which belongs to exactly one company' },
]

describe('🔴 every query on a company-scoped model names its company', () => {
  const offenders = sweep()

  it('knows which models are company-scoped — and that it is not vacuous', () => {
    expect(scopedModels().size).toBeGreaterThan(40)
    for (const m of ['invoice', 'vendorBill', 'journalEntry', 'customer', 'vendor']) expect(scopedModels().has(m)).toBe(true)
  })

  it('has nothing to say about the queries as they stand, beyond the ones on purpose', () => {
    const unexplained = offenders.filter((o) => !BY_DESIGN.some((a) => o.file === a.file && o.model === a.model))
    expect(unexplained.map((o) => `${o.file}:${o.line}  ${o.model}.${o.op}   ${o.text}`)).toEqual([])
  })

  it('every exception still exists — a stale entry would quietly excuse the next one', () => {
    for (const a of BY_DESIGN) {
      expect(offenders.some((o) => o.file === a.file && o.model === a.model), `${a.file} ${a.model}`).toBe(true)
    }
  })

  /** Neutering check, in the suite: the detector must actually see a leak when there is one. */
  it('is not vacuous — it flags a query that forgot the filter, and one whose filter sits in a nested where', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'sweep-'))
    writeFileSync(join(dir, 'a.ts'), [
      'await prisma.invoice.findUnique({ where: { id } })',
      'await prisma.invoice.findFirst({ where: { id }, include: { lines: { where: { companyId } } } })',
      'await prisma.invoice.findFirst({ where: { id, companyId: ctx.companyId } })',
      'const where = { companyId: ctx.companyId, id }\nawait prisma.invoice.findMany({ where })',
    ].join('\n'))
    const found = sweep(dir)
    expect(found.map((f) => f.line)).toEqual([1, 2])
  })
})
