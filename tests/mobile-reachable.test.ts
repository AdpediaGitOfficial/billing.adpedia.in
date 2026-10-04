import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ICONS } from '@/components/shell/icons'

const SRC = join(process.cwd(), 'src')

function files(dir: string, exts: string[], out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) files(p, exts, out)
    else if (exts.some((x) => e.endsWith(x))) out.push(p)
  }
  return out
}
const SOURCES = files(SRC, ['.ts', '.tsx'])
const rel = (p: string) => p.slice(process.cwd().length + 1)

/**
 * 🔴 Ask the question of the code, not of the prose.
 *
 * Every one of these guards failed on its own documentation the first time it ran: the
 * registry's comment quotes the namespace import it exists to forbid, and `icon.tsx` imports
 * a type from lucide beside a paragraph about why it must not import a value. A guard that
 * reports its own explanation is one somebody deletes.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1) => p1 + ' '.repeat(m.length - p1.length))
}
const read = (f: string) => code(readFileSync(f, 'utf8'))

/**
 * docs/68 §2 — the icon registry, and why only a static import can be dropped.
 *
 * `import * as Icons from 'lucide-react'` with a runtime string lookup shipped all 1,544
 * icons in a 518 kB chunk loaded by the app layout, so by every route — a bundler cannot
 * prove which member of a namespace a runtime string will reach, so it keeps them all.
 */
describe('🔴 lucide-react is imported in exactly one place', () => {
  const REGISTRY = join('src', 'components', 'shell', 'icons.ts')

  it('has no namespace import of it anywhere', () => {
    const offenders = SOURCES.filter((f) => /import \* as \w+ from ['"]lucide-react['"]/.test(read(f)))
    expect(offenders.map(rel)).toEqual([])
  })

  it('is imported for values only by the registry', () => {
    const offenders = SOURCES.filter((f) => {
      if (rel(f) === REGISTRY) return false
      // `import type { … } from 'lucide-react'` costs nothing and is allowed
      return read(f).split(/\n(?=import )/)
        .some((stmt) => /from ['"]lucide-react['"]/.test(stmt) && !/^import type /.test(stmt))
    })
    expect(offenders.map(rel)).toEqual([])
  })

  /**
   * 🔴 A registry that only grows is the next 518 kB. An icon nobody references is dead
   * weight on every route, and nothing else would ever notice it.
   */
  it('carries no icon the app does not use', () => {
    const body = SOURCES.filter((f) => rel(f) !== REGISTRY).map(read).join('\n')
    // a name passed as a string, or the fallback reached as `ICONS.Circle`
    const unused = Object.keys(ICONS).filter((n) => !new RegExp(`['"\`]${n}['"\`]|ICONS\\.${n}\\b`).test(body))
    expect(unused).toEqual([])
  })
})

/**
 * docs/68 §5 — a control in a column the mobile card drops is a control a phone cannot reach.
 *
 * The expenses table's reverse button and the receipts table's cancel button were both
 * `mobile: false`, and the receipt had no detail page to fall back to: on a phone there was
 * no route to either of them at all. `mobile: 'action'` is the slot; this is the guard.
 */
describe('🔴 no control is hidden on the mobile card', () => {
  const COLUMN = /\{ key: '([^']+)'([\s\S]*?)(?=\n {4}\{ key: '|\n {2}\])/g

  it('finds none', () => {
    const offenders: string[] = []
    for (const f of SOURCES) {
      const src = read(f)
      if (!src.includes('Column<')) continue
      for (const m of src.matchAll(COLUMN)) {
        const [, key, body] = m
        const control = /<ReverseButton|<Button|<form|onClick=|<AdjustAdvance|<ApproveButton/.test(body)
        if (control && /mobile: false/.test(body)) offenders.push(`${rel(f)} → column '${key}'`)
      }
    }
    expect(offenders).toEqual([])
  })
})
