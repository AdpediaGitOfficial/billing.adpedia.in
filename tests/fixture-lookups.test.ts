import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 docs/80 — a fixture lookup must identify the row it means.
 *
 * `prisma.expenseCategory.findFirstOrThrow({ where: { companyId } })` reads like "a category"
 * and means "whichever one Postgres finds convenient". Nine are seeded, and `TRAVEL` carries
 * `itcDefault: PARTIAL`, which makes `createExpense` demand a blocking reason and throw — so
 * three tests were green for as long as the physical order of the table happened to favour a
 * `FULL` category, and went red the moment enough rows were written to move it.
 *
 * That is `docs/78 §1`'s lesson about a paginated list, asked of a test: a query with no total
 * order returns whatever is convenient, and what is convenient changes.
 *
 * The rule is narrow on purpose — `where: { companyId }` and nothing else, which cannot pick a
 * row out of a set. A lookup by code, by label or by a unique flag says what it means.
 */
const DIR = join(process.cwd(), 'tests')
const AMBIGUOUS = /\.findFirst(OrThrow)?\(\{\s*where:\s*\{\s*compan(y)?Id:\s*[^,}]+\s*\}\s*\}\)/g

describe('🔴 every fixture lookup names the row it wants', () => {
  it('finds no findFirst that matches a whole company', () => {
    const offenders: string[] = []
    for (const f of readdirSync(DIR).filter((n) => n.endsWith('.ts'))) {
      const src = readFileSync(join(DIR, f), 'utf8')
      for (const m of src.matchAll(AMBIGUOUS)) {
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${f}:${line}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
