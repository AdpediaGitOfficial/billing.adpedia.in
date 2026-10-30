import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 🔴 A page the NAV cannot return you from needs its own way back.
 *
 * Sixteen pages had none. `/customers/[id]` is reached by clicking a row and, once there, the
 * only way out was the browser's own back button — which a PWA opened from the home screen
 * does not show, and which on a phone (where the rail is a row of tabs) left an edit screen as
 * a dead end. Nothing failed; the screens all worked. You simply could not leave them.
 *
 * A page that IS in the nav needs nothing: the rail is its navigation.
 */

const APP = join(process.cwd(), 'src', 'app', '(app)')
const NAV = join(process.cwd(), 'src', 'components', 'shell', 'nav.ts')

/**
 * Pages whose header — and therefore whose back link — is rendered by a shared component
 * rather than by the page itself. Listed rather than chased through imports, because a test
 * that resolves component graphs is a test that breaks for reasons of its own.
 */
const VIA_SHARED_COMPONENT: Record<string, string> = {
  '/vendors/new': 'vendors/vendor-form.tsx',
  '/vendors/[id]/edit': 'vendors/vendor-form.tsx',
}

function pages(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) pages(p, out)
    else if (e === 'page.tsx') out.push(p)
  }
  return out
}

const routeOf = (file: string) => {
  const rel = file.slice(APP.length + 1).replace(/[/\\]page\.tsx$/, '')
  return rel === 'page.tsx' ? '/' : '/' + rel.split(/[/\\]/).join('/')
}

const navHrefs = new Set([...readFileSync(NAV, 'utf8').matchAll(/href: '([^']+)'/g)].map((m) => m[1]))

describe('🔴 every page you can reach has a way back out', () => {
  it('no page below the nav is a dead end', () => {
    const stranded: string[] = []

    for (const file of pages(APP)) {
      const route = routeOf(file)
      if (route === '/' || navHrefs.has(route)) continue

      const shared = VIA_SHARED_COMPONENT[route]
      const src = readFileSync(shared ? join(APP, shared) : file, 'utf8')
      // either a header back link, or an explicit Back control of its own
      if (/back=\{\{|\bBack\b|ArrowLeft/.test(src)) continue

      stranded.push(route)
    }

    expect(stranded, 'reachable, and no way out of it except the browser\'s own button').toEqual([])
  })

  it('knows which routes the nav itself covers, so the rule is not vacuous', () => {
    // if this ever reads 0 the test above passes by accident rather than by correctness
    expect(navHrefs.size).toBeGreaterThan(20)
    expect(navHrefs.has('/dashboard')).toBe(true)
    expect(navHrefs.has('/customers')).toBe(true)
  })

  it('every shared-component exemption still renders a back link', () => {
    for (const [route, rel] of Object.entries(VIA_SHARED_COMPONENT)) {
      const src = readFileSync(join(APP, rel), 'utf8')
      expect(/back=\{\{/.test(src), `${rel} no longer carries the back link ${route} relies on`).toBe(true)
    }
  })
})
