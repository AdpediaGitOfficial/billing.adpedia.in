import { describe, it, expect } from 'vitest'
import { middleware, config } from '@/middleware'
import { NextRequest } from 'next/server'
import { ACCESS_COOKIE } from '@/server/context'

/**
 * 🔴 docs/30 §8, finally guarded — and docs/73, which added a route that depends on it.
 *
 * The auth matcher excluded `api`, `_next`, `brand` and the manifest, but not `/sw.js` or
 * `/offline.html`. The browser fetches the service worker itself, outside any page, so it was
 * being redirected to /login: registration failed silently and took the entire offline expense
 * queue with it. It was caught by requesting the routes rather than by reading the config, and
 * then nothing was left behind to catch it again.
 *
 * Two halves have to hold, and they fail differently:
 *
 *   1. the matcher decides whether the middleware RUNS at all — a path excluded here is
 *      invisible to every rule below it;
 *   2. the middleware decides whether to redirect.
 *
 * ⚠️ The matcher is evaluated here as a plain `RegExp`. Next compiles it with path-to-regexp,
 * which is not identical — but for the negative-lookahead shape this one uses the two agree,
 * and what is being asked is whether a path was forgotten.
 */

const matches = (pathname: string) => new RegExp(`^${config.matcher[0]}$`).test(pathname)

const request = (pathname: string, signedIn = false) => {
  const req = new NextRequest(new URL(`http://localhost${pathname}`))
  if (signedIn) req.cookies.set(ACCESS_COOKIE, 'a-token')
  return req
}
const redirectsToLogin = (pathname: string, signedIn = false) => {
  const res = middleware(request(pathname, signedIn))
  return res.headers.get('location')?.endsWith('/login') ?? false
}

describe('🔴 what the auth matcher must not swallow', () => {
  it('leaves the service worker and its offline page alone', () => {
    // 🔴 fetched by the BROWSER, outside any page — a redirect kills registration in silence
    expect(matches('/sw.js')).toBe(false)
    expect(matches('/offline.html')).toBe(false)
    expect(matches('/manifest.webmanifest')).toBe(false)
  })

  it('leaves the API and static assets alone', () => {
    expect(matches('/api/auth/login')).toBe(false)
    expect(matches('/_next/static/chunks/main.js')).toBe(false)
    expect(matches('/brand/logo.svg')).toBe(false)
  })

  it('still covers the pages it is there to protect', () => {
    expect(matches('/dashboard')).toBe(true)
    expect(matches('/invoices/abc123')).toBe(true)
    expect(matches('/settings/users')).toBe(true)
  })
})

describe('🔴 what may be reached without a session', () => {
  it('sends an unauthenticated visitor to the login page', () => {
    expect(redirectsToLogin('/dashboard')).toBe(true)
    expect(redirectsToLogin('/settings/users')).toBe(true)
    expect(redirectsToLogin('/tax/gst')).toBe(true)
  })

  /**
   * 🔴 docs/73 — the person accepting an invitation has no account yet. A redirect to /login
   * turns the invitation into a dead end with no way in, and the only sign of it is somebody
   * saying the link does not work.
   */
  it('lets an invitation through', () => {
    expect(matches('/invite/sometoken')).toBe(true)        // the middleware does run…
    expect(redirectsToLogin('/invite/sometoken')).toBe(false)  // …and lets it pass
  })

  it('and the login page itself', () => {
    expect(redirectsToLogin('/login')).toBe(false)
  })

  it('sends a signed-in visitor away from the login page, but not away from an invitation', () => {
    expect(middleware(request('/login', true)).headers.get('location')).toMatch(/\/dashboard$/)
    expect(middleware(request('/invite/sometoken', true)).headers.get('location')).toBeNull()
  })
})
