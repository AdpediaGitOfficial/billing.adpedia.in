/**
 * docs/82 §1 — every query on a company-scoped model must carry the company filter.
 *
 * 🔴 With one company in the database this is undetectable: every row belongs to it, so a
 * query that forgot the filter returns exactly the right answer and every test stays green.
 * The day a second company exists, the same query returns the other entity's rows and still
 * nothing fails. This is the sweep that has to run before that day, not after.
 *
 * The scoped-model list is read from the SCHEMA, not hand-maintained: `scoped.ts` kept its
 * own list of 29 and the schema has since grown to 65, which is most of why nobody used it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const schema = readFileSync('prisma/schema.prisma', 'utf8')

/** Models carrying a companyId column — the ones a query can leak across. */
const scoped = new Set<string>()
for (const block of schema.split(/^model /m).slice(1)) {
  const name = block.slice(0, block.indexOf(' ')).trim()
  const body = block.slice(0, block.indexOf('\n}'))
  if (/^\s*companyId\s/m.test(body)) scoped.add(name[0].toLowerCase() + name.slice(1))
}

const OPS = ['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany', 'update', 'upsert', 'create', 'createMany']

const files = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

/** The call's argument text, by balancing parentheses from the opening one. */
function args(src: string, open: number): string {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++
    else if (src[i] === ')' && --depth === 0) return src.slice(open + 1, i)
  }
  return src.slice(open + 1)
}

/**
 * 🔴 The filter is often not written inside the call.
 *
 *   const where = { companyId: ctx.companyId }
 *   await prisma.invoice.findMany({ where, ... })
 *
 * A sweep that reads only the call text calls that a leak, and a sweep that cries wolf is
 * worse than none — the first version of docs/81's guard made exactly this mistake in the
 * other direction. So an identifier used as `where` (or spread into it) is resolved to its
 * declaration in the same file before anything is reported.
 */
function resolves(src: string, a: string): boolean {
  const idents = new Set<string>()
  if (/\bwhere\s*[,}]/.test(a)) idents.add('where')          // { where } shorthand
  for (const m of a.matchAll(/where:\s*([A-Za-z_$][\w$]*)/g)) idents.add(m[1])
  for (const m of a.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)) idents.add(m[1])

  for (const id of idents) {
    const decl = new RegExp(`(?:const|let|var)\\s+${id}\\s*(?::[^=]+)?=\\s*`, 'g')
    for (const d of src.matchAll(decl)) {
      const from = d.index! + d[0].length
      // the initialiser, to the end of its object literal or statement
      const brace = src.indexOf('{', from)
      let text: string
      if (brace >= 0 && brace < from + 3) {
        let depth = 0, end = brace
        for (let i = brace; i < src.length; i++) {
          if (src[i] === '{') depth++
          else if (src[i] === '}' && --depth === 0) { end = i; break }
        }
        text = src.slice(brace, end + 1)
      } else {
        text = src.slice(from, src.indexOf('\n', from))
      }
      if (/companyId/.test(text)) return true
    }
  }
  return false
}

const offenders: { file: string; line: number; model: string; op: string }[] = []
for (const file of files('src')) {
  const src = readFileSync(file, 'utf8')
  // services query through `prisma.` and, inside transactions, `tx.`
  for (const m of src.matchAll(/\b(?:prisma|tx)\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)) {
    const [, model, op] = m
    if (!scoped.has(model) || !OPS.includes(op)) continue
    const a = args(src, m.index! + m[0].length - 1)
    if (/companyId/.test(a) || resolves(src, a)) continue
    offenders.push({ file, line: src.slice(0, m.index).split('\n').length, model, op })
  }
}

console.log(`scoped models in the schema: ${scoped.size}`)
console.log(`queries with no company filter: ${offenders.length}\n`)
const byOp = new Map<string, number>()
for (const o of offenders) byOp.set(o.op, (byOp.get(o.op) ?? 0) + 1)
console.log('by operation:')
for (const [op, n] of [...byOp.entries()].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(3)}  ${op}`)

const READS = ['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']
console.log('\n🔴 READS with no company filter — the ones that can return another entity\'s rows:')
for (const o of offenders.filter((o) => READS.includes(o.op))) console.log(`  ${o.file}:${o.line}  ${o.model}.${o.op}`)
