import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ICONS } from '@/components/shell/icons'
import { NAV, MORE_TAB, mobileTabsFor } from '@/components/shell/nav'
import type { Role } from '@prisma/client'

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

/**
 * 🔴 docs/83 — a tab that leads nowhere.
 *
 * The sidebar is `hidden md:flex`, so on a phone the five-slot tab bar IS the navigation, and
 * its fifth slot has always pointed at `/more`. There was no `/more` page. It fell through to
 * the roadmap catch-all, which answered *"Arriving in phase 1 — what is missing is the
 * screen"* and offered two buttons back to the dashboard.
 *
 * Four screens out of sixty-five, on the device the business is actually run from. Nothing
 * failed: the bar rendered, the link worked, the page it reached returned 200. Which is why
 * this asks the only question that would have caught it — does the target EXIST.
 */
const APP = join(SRC, 'app', '(app)')
const pageExists = (href: string) =>
  existsSync(join(APP, href.replace(/^\//, ''), 'page.tsx'))

describe('🔴 every navigation target is a real page', () => {
  const ROLES: Role[] = ['OWNER', 'ACCOUNTANT', 'PROJECT_MANAGER', 'EMPLOYEE', 'AUDITOR']

  it('🔴 the tab bar\'s fifth slot leads to a page that exists', () => {
    expect(pageExists(MORE_TAB.href), `${MORE_TAB.href} has no page.tsx`).toBe(true)
  })

  it('every mobile tab, for every role', () => {
    const missing: string[] = []
    for (const role of ROLES) {
      for (const tab of mobileTabsFor(role).slice(0, 4)) {
        if (!pageExists(tab.href)) missing.push(`${role} → ${tab.href}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('every item in the rail, which is also every item on /more', () => {
    const missing = NAV.flatMap((g) => g.items).map((i) => i.href).filter((h) => !pageExists(h))
    expect(missing).toEqual([])
  })

  it('is not vacuous — it is checking real paths, and a made-up one fails', () => {
    expect(NAV.flatMap((g) => g.items).length).toBeGreaterThan(30)
    expect(pageExists('/not-a-screen')).toBe(false)
    expect(pageExists('/dashboard')).toBe(true)
  })

  /**
   * 🔴 `/more` must hide what the rail hides. It calls `navFor` with the same arguments the
   * sidebar is given — `navFor`'s `hasDrawings` DEFAULTS TO FALSE, so a page that called it
   * bare would quietly drop the drawings register on every phone, and show an unregistered
   * entity the GST screens that docs/82 §4 refuses.
   */
  it('🔴 /more filters the nav on the same two facts the sidebar does', () => {
    const src = read(join(APP, 'more', 'page.tsx'))
    expect(src).toMatch(/navFor\(/)
    expect(src).toMatch(/gstRegistered:/)
    expect(src).toMatch(/hasDrawings:/)
  })
})
