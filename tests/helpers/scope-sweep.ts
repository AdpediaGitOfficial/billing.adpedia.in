import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * docs/82 §1, docs/95 — every query on a company-scoped model must carry the company filter.
 *
 * 🔴 With one company in the database this is undetectable: a query that forgot the filter
 * returns exactly the right answer and every test stays green. The day a second company exists,
 * the same query returns the other entity's rows and still nothing fails.
 *
 * Shared by `scripts/scope-sweep.mts` (a report) and `tests/scope-sweep.test.ts` (the gate).
 *
 * The first version of this accepted a call if `companyId` appeared ANYWHERE in its arguments —
 * including inside a nested `include.where` for a different model, which would have passed a
 * `findUnique({ where: { id }, include: { lines: { where: { companyId } } } })`. It now looks at
 * the call's own top-level `where`.
 */
export function scopedModels(schema = readFileSync('prisma/schema.prisma', 'utf8')): Set<string> {
  const scoped = new Set<string>()
  for (const block of schema.split(/^model /m).slice(1)) {
    const name = block.slice(0, block.indexOf(' ')).trim()
    const body = block.slice(0, block.indexOf('\n}'))
    if (/^\s*companyId\s/m.test(body)) scoped.add(name[0].toLowerCase() + name.slice(1))
  }
  return scoped
}

export const OPS = ['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'count', 'aggregate', 'groupBy', 'updateMany', 'deleteMany', 'update', 'upsert']
export const READS = ['findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow', 'count', 'aggregate', 'groupBy']

const files = (dir: string, out: string[] = []): string[] => {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, out)
    else if (/\.tsx?$/.test(p)) out.push(p)
  }
  return out
}

/** Index of the bracket that closes the one at `open`. */
function close(src: string, open: number): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') { if (--depth === 0) return i }
  }
  return src.length - 1
}

/** The text of the call's own top-level `where` value, or null when it has none. */
function topLevelWhere(args: string): { inline: string | null; ident: string | null } | null {
  // args = "( { ...options } )"; the options object is at depth 1, its keys at depth 2 from the paren
  let depth = 0
  for (let i = 0; i < args.length; i++) {
    const c = args[i]
    if (c === '(' || c === '{' || c === '[') depth++
    else if (c === ')' || c === '}' || c === ']') depth--
    else if (depth === 2 && /^where\b/.test(args.slice(i)) && !/\w/.test(args[i - 1] ?? ' ')) {
      const rest = args.slice(i + 5)
      const m = rest.match(/^\s*:\s*/)
      if (!m) return { inline: null, ident: 'where' }              // `{ where }` shorthand
      const v = rest.slice(m[0].length)
      if (v.startsWith('{')) return { inline: v.slice(0, close(v, 0) + 1), ident: null }
      const id = v.match(/^([A-Za-z_$][\w$]*)/)
      return { inline: null, ident: id ? id[1] : null }
    }
  }
  return null
}

/** `const where = { ... companyId ... }` earlier in the file — a filter built beforehand. */
function declaredWithCompany(src: string, id: string): boolean {
  const decl = new RegExp(`(?:const|let|var)\\s+${id}\\s*(?::[^=]+)?=\\s*`, 'g')
  for (const d of src.matchAll(decl)) {
    const from = d.index! + d[0].length
    const brace = src.indexOf('{', from)
    const text = brace >= 0 && brace < from + 3 ? src.slice(brace, close(src, brace) + 1) : src.slice(from, src.indexOf('\n', from))
    if (/companyId/.test(text)) return true
  }
  return false
}

export interface Offender { file: string; line: number; model: string; op: string; text: string }

export function sweep(root = 'src'): Offender[] {
  const scoped = scopedModels()
  const out: Offender[] = []
  for (const file of files(root)) {
    const src = readFileSync(file, 'utf8')
    for (const m of src.matchAll(/\b(?:prisma|tx)\.([a-zA-Z]+)\.([a-zA-Z]+)\(/g)) {
      const [, model, op] = m
      if (!scoped.has(model) || !OPS.includes(op)) continue
      const open = m.index! + m[0].length - 1
      const args = src.slice(open, close(src, open) + 1)
      const w = topLevelWhere(args)
      let ok = false
      if (w?.inline != null) {
        // `{ ...where, isRcm: true }` — the filter was built (with the company in it) beforehand
        ok = /companyId/.test(w.inline)
          || [...w.inline.matchAll(/\.\.\.([A-Za-z_$][\w$]*)/g)].some((s) => declaredWithCompany(src, s[1]))
      }
      else if (w?.ident) ok = declaredWithCompany(src, w.ident)
      // an `upsert` carries its filter in `create` as well; `where` still has to scope the lookup
      if (ok) continue
      const line = src.slice(0, m.index).split('\n').length
      out.push({ file: file.replace(/\\/g, '/'), line, model, op, text: src.split('\n')[line - 1].trim().slice(0, 140) })
    }
  }
  return out
}
