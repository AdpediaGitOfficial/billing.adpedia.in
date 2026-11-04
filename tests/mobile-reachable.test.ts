import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { Decimal, formatINR } from '@/lib/money'
import { ICONS } from '@/components/shell/icons'
import { NAV, MORE_TAB, mobileTabsFor } from '@/components/shell/nav'
import { statChars } from '@/components/ui/kit'
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
 * 🔴 docs/83 §4 — the P&L's bottom line said the opposite of what it meant.
 *
 * `formatINR` returns `-₹9,55,000.00`. A hyphen is a line-break opportunity, so in a narrow
 * table cell at 375px the browser broke there: the minus alone on one line, `₹9,55,000.00`
 * under it. A net LOSS of nine lakh read as a profit of nine lakh, and the only thing saying
 * otherwise was a stray dash floating above the number.
 *
 * Nothing but CSS holds the sign to its digits, so this asserts the rule itself, and asserts
 * the break opportunity is still there to be suppressed.
 */
describe('🔴 a money figure never breaks across lines', () => {
  const CSS = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8')

  it('the .tabular rule every money figure carries declares nowrap', () => {
    const rule = CSS.split('\n').find((l) => l.startsWith('.tabular'))
    expect(rule, '.tabular rule not found in globals.css').toBeTruthy()
    expect(rule).toMatch(/white-space:\s*nowrap/)
  })

  it('is not vacuous — formatINR still emits a hyphen the browser may break at', () => {
    expect(formatINR(new Decimal(-955000))).toBe('-₹9,55,000.00')
  })

  /** the rule only reaches a figure that is inside an element carrying the class */
  it('every figure on the P&L is inside an element that carries it', () => {
    const pnl = read(join(APP, 'reports', 'pnl', 'page.tsx'))
    const bare: string[] = []
    for (const m of pnl.matchAll(/formatINR\(/g)) {
      const before = pnl.slice(Math.max(0, m.index - 220), m.index)
      if (!before.includes('tabular')) bare.push(pnl.slice(m.index, m.index + 40).split('\n')[0])
    }
    expect(bare).toEqual([])
    expect([...pnl.matchAll(/formatINR\(/g)].length).toBeGreaterThanOrEqual(3)
  })
})

/**
 * 🔴 docs/83 §4 — mobile Safari zooms the page in on a focused control under 16px.
 *
 * Every field in the app was 13.5px, and the viewport is `initialScale: 1` with no
 * `maximumScale` — deliberately, because disabling pinch-zoom is an accessibility failure.
 * So on the device docs/30 was written for, focusing any field threw the layout up a notch
 * and left the person to pinch back out, field after field. Nothing reports it: the form
 * works, it just fights. The `md:` override keeps the density the design was drawn at.
 */
describe('🔴 no form control is small enough to zoom the page', () => {
  /** an unprefixed `text-[Npx]` — a `md:` or `sm:` one only applies above the phone */
  const BASE_SIZE = /(?<![a-z]:)text-\[(\d+(?:\.\d+)?)px\]/

  it('the shared input class is 16px before the md breakpoint', () => {
    const kit = read(join(SRC, 'components', 'ui', 'kit.tsx'))
    const decl = kit.match(/export const inputClass =\s*`([^`]*)`/)
    expect(decl, 'inputClass not found').toBeTruthy()
    const size = decl![1].match(BASE_SIZE)
    expect(size, `inputClass sets no base font size: ${decl![1]}`).toBeTruthy()
    expect(Number(size![1])).toBeGreaterThanOrEqual(16)
  })

  it('and no hand-rolled field undercuts it', () => {
    const FIELD = /<(input|select|textarea)\b([\s\S]*?)\/?>/g
    const offenders: string[] = []
    for (const f of SOURCES) {
      if (!f.endsWith('.tsx')) continue
      const src = read(f)
      for (const m of src.matchAll(FIELD)) {
        const cls = m[2].match(/className="([^"]*)"/)?.[1]
        if (!cls) continue
        const size = cls.match(BASE_SIZE)
        if (size && Number(size[1]) < 16) offenders.push(`${rel(f)} → <${m[1]}> ${size[0]}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

/**
 * 🔴 docs/83 §4 — a button that is only text has only the text's hit box.
 *
 * `+ Add line` on the invoice form was 20px tall — a 13px label with no padding at all, and
 * the control pressed once per line item. `back`, `remove`, `It matches` and `Withdraw` were
 * 17px, and two of those change a record. Apple's minimum is 44px, Android's 48; none of
 * these reached half of it, and a mis-tap on `remove` is an undone GST filing.
 */
describe('🔴 a text-only button still has a thumb-sized hit box', () => {
  const BOX = /\b(p|px|py|pt|pb|h|min-h|size)-/

  /**
   * 🔴 The first version of this read `<button\b([\s\S]*?)>` and found nothing — because a
   * non-greedy match stops at the first `>`, which in almost every button here is the one in
   * `onClick={() => …}`. It never reached a single className. A guard that cannot see what it
   * is guarding passes forever, so the tag is scanned rather than matched.
   */
  function attrs(src: string, from: number): string {
    let depth = 0, quote = ''
    for (let i = from; i < src.length; i++) {
      const c = src[i]
      if (quote) { if (c === quote && src[i - 1] !== '\\') quote = '' ; continue }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue }
      if (c === '{') depth++
      else if (c === '}') depth--
      else if (c === '>' && depth === 0) return src.slice(from, i)
    }
    return ''
  }

  it('finds none without one', () => {
    const offenders: string[] = []
    for (const f of SOURCES) {
      if (!f.endsWith('.tsx')) continue
      const src = read(f)
      for (const m of src.matchAll(/<button\b/g)) {
        const tag = attrs(src, m.index + 7)
        const cls = tag.match(/className=(?:"([^"]*)"|\{`([^`]*)`\})/)
        const text = cls?.[1] ?? cls?.[2]
        if (!text || !/text-\[/.test(text)) continue   // not a text-only button
        if (BOX.test(text) || text.includes('tapTarget')) continue
        offenders.push(`${rel(f)} → <button className="${text.slice(0, 60)}">`)
      }
    }
    expect(offenders).toEqual([])
  })

  /**
   * 🔴 The shared one: `PageHeader`'s `back` link is the way out of every detail page in the
   * app — the whole point of the commit before docs/83 — and it was 19px tall on a phone.
   */
  it('and the back link every page is escaped by', () => {
    const kit = read(join(SRC, 'components', 'ui', 'kit.tsx'))
    const header = kit.slice(kit.indexOf('export function PageHeader'))
    const link = header.slice(header.indexOf('<Link href={back.href}'), header.indexOf('</Link>'))
    expect(link).toMatch(/tapTarget|min-h-\[(4[4-9]|[5-9]\d)px\]/)
  })

  it('is not vacuous — the scan reaches the className of a real button', () => {
    const form = read(join(APP, 'invoices', 'new', 'form.tsx'))
    const i = form.indexOf('<button')
    expect(i).toBeGreaterThan(0)
    expect(attrs(form, i + 7)).toMatch(/className=/)
  })

  it('is not vacuous — tapTarget exists, resets at md, and is actually used', () => {
    expect(tapMinClasses()).toMatch(/md:min-h-0/)
    const kit = read(join(SRC, 'components', 'ui', 'kit.tsx'))
    expect(kit).toMatch(/export const tapTarget = `inline-flex \$\{tapMin\}/)
    const users = SOURCES.filter((f) => f !== join(SRC, 'components', 'ui', 'kit.tsx')
      && read(f).includes('tapTarget'))
    expect(users.length).toBeGreaterThanOrEqual(6)
  })
})

/** The one declaration of the phone minimum, which everything that is pressed reads. */
function tapMinClasses(): string {
  const kit = read(join(SRC, 'components', 'ui', 'kit.tsx'))
  const decl = kit.match(/export const tapMin = '([^']*)'/)
  expect(decl, 'tapMin not found in the kit').toBeTruthy()
  return decl![1]
}

/**
 * 🔴 docs/83 §5 — and `Button` itself, which §4 looked at and left.
 *
 * 38px for `size="md"`, about 31px for `sm`. §4's reasoning was that 38 is close to 44 and
 * moving it moves every button in the app — which is true, and is also the argument for
 * moving it: `Cancel invoice`, `Reverse`, `Remove` and `Save` are all this one component, so
 * one line reaches all of them. The `Segmented` filter pills were ~25px on the same grounds.
 */
describe('🔴 every pressed control clears 44px on a phone', () => {
  const kitPath = join(SRC, 'components', 'ui', 'kit.tsx')

  it('the minimum is declared once, at 44px or more, and lifts at md', () => {
    const classes = tapMinClasses()
    const px = classes.match(/min-h-\[(\d+)px\]/)
    expect(px, `no min-h in tapMin: ${classes}`).toBeTruthy()
    expect(Number(px![1])).toBeGreaterThanOrEqual(44)
    expect(classes).toMatch(/md:min-h-0/)
  })

  it('Button reads it, for both sizes', () => {
    const kit = read(kitPath)
    const fn = kit.slice(kit.indexOf('export function Button'))
    const base = fn.slice(0, fn.indexOf('return ('))
    // one `base`, applied whatever the size — so `sm` cannot drift away from it
    expect(base, 'Button base does not read tapMin').toContain('${tapMin}')
    expect(base).toMatch(/const sizes = \{[^}]*sm:/)
  })

  it('and so does the segmented filter control', () => {
    const kit = read(kitPath)
    const fn = kit.slice(kit.indexOf('export function Segmented'), kit.indexOf('export function Button'))
    expect(fn).toContain('${tapMin}')
  })

  it('and the form controls, which were 42px', () => {
    const kit = read(kitPath)
    const decl = kit.match(/export const inputClass =\s*`([^`]*)`/)
    expect(decl, 'inputClass is no longer a template reading tapMin').toBeTruthy()
    expect(decl![1]).toContain('${tapMin}')
  })

  it('is not vacuous — nothing in the kit hard-codes a second copy of the number', () => {
    const kit = read(kitPath)
    const hard = new Set([...kit.matchAll(/min-h-\[(\d+)px\]/g)].map((m) => Number(m[1])))
    // only the one in tapMin; the tab bar's own 56px slot lives in bottom-tabs.tsx
    expect([...hard]).toEqual([44])
  })
})

/**
 * 🔴 docs/83 §5 — a row of stat cards became a screen of stat cards.
 *
 * Every one of them was `sm:grid-cols-N`, and `sm` is 640px, so at 375px all twenty-one rows
 * stacked one card per row. `/invoices` opened on four full-width cards — a whole screen of
 * summary — before the first invoice. Nothing was broken and nothing reported it; the page
 * simply answered a different question than the one you opened it to ask.
 */
describe('🔴 stat cards are two to a row on a phone', () => {
  const kitPath = join(SRC, 'components', 'ui', 'kit.tsx')

  it('the phone layout is declared once, and it is two columns', () => {
    const kit = read(kitPath)
    const decl = kit.match(/export const statGrid =\s*'([^']*)'/)
    expect(decl, 'statGrid not found in the kit').toBeTruthy()
    expect(decl![1]).toMatch(/\bgrid-cols-2\b/)
    // and no `sm:`/`lg:` columns here — those belong to the page, not to the shared base
    expect(decl![1]).not.toMatch(/\b(sm|md|lg):grid-cols-/)
  })

  it('and every row of them uses it', () => {
    const offenders: string[] = []
    for (const f of SOURCES) {
      if (!f.endsWith('.tsx') || f === kitPath) continue
      const lines = read(f).split('\n')
      lines.forEach((ln, i) => {
        if (!/\bgrid-cols-/.test(ln)) return
        const wrapsStats = lines.slice(i + 1, i + 7).some((l) => l.includes('<StatCard'))
        if (wrapsStats && !ln.includes('statGrid')) offenders.push(`${rel(f)}:${i + 1}  ${ln.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('is not vacuous — it finds the rows it is guarding', () => {
    const users = SOURCES.filter((f) => f.endsWith('.tsx') && f !== kitPath
      && read(f).includes('statGrid'))
    // 21 pages carry a stat row; if this scan ever stops seeing them it has stopped guarding
    expect(users.length).toBeGreaterThanOrEqual(20)
    for (const f of users) expect(read(f), rel(f)).toContain("from '@/components/ui/kit'")
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

/**
 * 🔴 docs/83 §5 — what two-up did to a long figure.
 *
 * Making the stat row 2-up gave each card 134px of room, and `.tabular` is `white-space:
 * nowrap` (§4, so a minus sign cannot be orphaned). A value that can neither wrap nor shrink
 * simply leaves: `/invoices` printed the next invoice number running out through the right
 * edge of its card and off the screen. The sizes below were measured against Poppins in the
 * page, not estimated.
 */
describe('🔴 a stat value fits the card it is in', () => {
  /** inner width of a card below `sm`, measured in the page: (vw - 32 gutter - 12 gap)/2 - 32 */
  const room = (vw: number) => vw / 2 - 54

  it('the value never asks for more room than the card has, at 320px or 375px', () => {
    const values = ['4', '₹8,21,000', '31/ADP/26-27', '₹12,34,56,789.00', 'A'.repeat(16)]
    for (const vw of [320, 375]) {
      for (const v of values) {
        // what `.stat-value` computes: min(24px, room / chars) — then the drawn width
        const px = Math.min(24, room(vw) / statChars(v))
        const width = px * statChars(v)
        expect(width, `"${v}" wants ${Math.round(width)}px in ${Math.round(room(vw))}px at ${vw}`)
          .toBeLessThanOrEqual(room(vw) + 0.5)
      }
    }
  })

  it('and a short one still gets the full 24px', () => {
    for (const v of ['4', '₹5,000', '₹8,21,000']) {
      expect(Math.min(24, room(375) / statChars(v)), v).toBe(24)
    }
  })

  it('is not vacuous — the rule exists, applies only below sm, and StatCard sets the variable', () => {
    const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8')
    expect(css).toMatch(/\.stat-value\s*\{[^}]*font-size:\s*24px/)
    const mq = css.slice(css.indexOf('@media (max-width: 639.98px)'))
    expect(mq).toMatch(/\.stat-value\s*\{[^}]*var\(--stat-chars/)

    const kit = read(join(SRC, 'components', 'ui', 'kit.tsx'))
    const card = kit.slice(kit.indexOf('export function StatCard'), kit.indexOf('export function HeroStat'))
    expect(card).toContain('stat-value')
    expect(card).toContain("'--stat-chars': statChars(value)")
    // 🔴 and nothing hard-codes the size beside it, which is what made the spill possible
    expect(card).not.toMatch(/className="[^"]*text-\[24px\]/)
  })
})

/**
 * 🔴 docs/83 §5 — a page's own actions, off the right-hand edge of the phone.
 *
 * Every action row was `flex gap-2` with no wrap. A flex item whose content cannot wrap has a
 * min-content width of the whole row, so it cannot shrink either: on the invoice at 375px the
 * six buttons ran to 634px in a 343px column, and `Amend` — the only way to correct a sent
 * invoice — sat furthest outside the viewport, behind a horizontal scroll nothing announced.
 */
describe('🔴 a row of actions wraps rather than leaving the screen', () => {
  it('no row of buttons is a non-wrapping flex row', () => {
    const offenders: string[] = []
    for (const f of SOURCES) {
      if (!f.endsWith('.tsx')) continue
      const lines = read(f).split('\n')
      lines.forEach((ln, i) => {
        if (!/className="flex gap-\d/.test(ln)) return
        const holdsButtons = lines.slice(i + 1, i + 5).some((l) => /<Button|<button/.test(l))
        if (holdsButtons) offenders.push(`${rel(f)}:${i + 1}  ${ln.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })

  it('and PageHeader\u2019s own action slot wraps', () => {
    const kit = read(join(SRC, 'components', 'ui', 'kit.tsx'))
    const header = kit.slice(kit.indexOf('export function PageHeader'))
    const slot = header.match(/\{action && <div className="([^"]*)"/)
    expect(slot, 'the action slot is no longer a div with a className').toBeTruthy()
    expect(slot![1]).toContain('flex-wrap')
  })

  it('is not vacuous — the sweep finds the rows it is guarding', () => {
    const wrapped = SOURCES.filter((f) => f.endsWith('.tsx') && read(f).includes('flex flex-wrap gap-2'))
    expect(wrapped.length).toBeGreaterThanOrEqual(10)
  })

  /** 🔴 and a label that wraps turns one 44px control into a four-line tower. */
  it('a button label does not wrap', () => {
    const kit = read(join(SRC, 'components', 'ui', 'kit.tsx'))
    const fn = kit.slice(kit.indexOf('export function Button'))
    expect(fn.slice(0, fn.indexOf('return ('))).toContain('whitespace-nowrap')
  })
})
