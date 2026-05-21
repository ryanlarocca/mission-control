import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { verifySessionToken } from "@/lib/session"

const SESSION_COOKIE = "mc_session"
// Only Twilio's webhook callbacks are public. Everything else under
// /api/leads (CRUD, recording-proxy) stays auth-gated.
const PUBLIC_PATHS = [
  "/login",
  "/api/auth",
  "/api/leads/voice",
  "/api/leads/sms",
  // Twilio fetches these for outbound call relay (initiated from /api/leads/call,
  // which itself stays auth-gated).
  "/api/leads/call/bridge",
  "/api/leads/call/recording",
  // Google Cloud Pub/Sub pushes Gmail-watch notifications here without
  // a session cookie. Auth on this path is enforced by Pub/Sub itself
  // (subscription origin) — see scripts/setup-gmail-watch.js.
  "/api/leads/email",
]

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow login page and webhook callbacks through. We match the path
  // exactly OR with a trailing-slash sub-path (e.g. /api/leads/voice plus
  // /api/leads/voice/recording). Plain `startsWith` would let
  // /api/leads/email-reply slip past as if it were /api/leads/email,
  // accidentally making an auth-required mail-sending endpoint public.
  const isPublic = PUBLIC_PATHS.some(p => pathname === p || pathname.startsWith(p + "/"))
  if (isPublic) {
    return NextResponse.next()
  }

  // Verify the signed session token. Pre-fix cookies (whose value was the
  // raw secret) and expired/forged tokens all fail here — see lib/session.ts.
  const session = request.cookies.get(SESSION_COOKIE)?.value
  const secret = process.env.MC_SESSION_SECRET
  const valid = await verifySessionToken(session, secret)

  if (!valid) {
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
