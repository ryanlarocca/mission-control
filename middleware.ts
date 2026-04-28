import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

const SESSION_COOKIE = "mc_session"
// Only Twilio's webhook callbacks are public. Everything else under
// /api/leads (CRUD, recording-proxy) stays auth-gated.
const PUBLIC_PATHS = [
  "/login",
  "/api/auth",
  "/api/leads/voice",
  "/api/leads/sms",
]

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow login page and auth API through
  if (PUBLIC_PATHS.some(p => pathname.startsWith(p))) {
    return NextResponse.next()
  }

  // Check session cookie
  const session = request.cookies.get(SESSION_COOKIE)?.value
  const secret = process.env.MC_SESSION_SECRET

  if (!session || !secret || session.trim() !== secret.trim()) {
    const loginUrl = new URL("/login", request.url)
    loginUrl.searchParams.set("from", pathname)
    return NextResponse.redirect(loginUrl)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    // Protect all routes except static assets and public audio
    "/((?!_next/static|_next/image|favicon.ico|fonts|icons|voicemail-).*)",
  ],
}
