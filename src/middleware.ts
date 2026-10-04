import { NextResponse, type NextRequest } from 'next/server'
import { ACCESS_COOKIE } from '@/server/context'

/**
 * Cheap gate only — it checks that a token is PRESENT, not that it is valid.
 * Real verification happens in getContext(), which also checks tokenVersion
 * against the database. Middleware runs on the edge and must not hit Prisma.
 */
export function middleware(req: NextRequest) {
  const hasToken = Boolean(req.cookies.get(ACCESS_COOKIE)?.value)
  const { pathname } = req.nextUrl

  // 🔴 docs/73 — the acceptance page is reached by somebody who has no account yet. A
  // redirect to /login turns an invitation into a dead end, and the person has no way in.
  const isPublic = pathname === '/login' || pathname.startsWith('/invite')

  if (!hasToken && !isPublic) {
    const url = req.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }
  if (hasToken && pathname === '/login') {
    const url = req.nextUrl.clone()
    url.pathname = '/dashboard'
    return NextResponse.redirect(url)
  }
  return NextResponse.next()
}

export const config = {
  // 🔴 sw.js and offline.html must stay reachable without a session. The service worker
  // is fetched by the browser, not by the page, and a redirect to /login makes
  // registration fail silently — taking the offline expense queue down with it.
  // 🔴 `/invite` is handled INSIDE the middleware rather than excluded here, so that a signed-in
  // visitor is still recognised and the page can say whose account it is about to create.
  // docs/30 §8 — the matcher is where a route silently disappears, so `tests/public-routes`
  // requests these rather than reading this line.
  matcher: ['/((?!api|_next/static|_next/image|brand|favicon.ico|manifest.webmanifest|sw.js|offline.html).*)'],
}
