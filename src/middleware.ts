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

  if (!hasToken && pathname !== '/login') {
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
  matcher: ['/((?!api|_next/static|_next/image|brand|favicon.ico|manifest.webmanifest|sw.js|offline.html).*)'],
}
