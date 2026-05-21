import { NextResponse } from "next/server"
import { issueSessionToken, safeEqual, SESSION_MAX_AGE_S } from "@/lib/session"

const SESSION_COOKIE = "mc_session"

export async function POST(request: Request) {
  let password: unknown
  try {
    ;({ password } = await request.json())
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 })
  }

  const expected = process.env.MC_PASSWORD
  const secret = process.env.MC_SESSION_SECRET

  if (!expected || !secret) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 })
  }

  if (typeof password !== "string" || !safeEqual(password, expected)) {
    // Small delay to slow brute force
    await new Promise((r) => setTimeout(r, 500))
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 })
  }

  // Issue a signed, expiring token — the cookie is no longer the raw
  // secret itself (see lib/session.ts).
  const token = await issueSessionToken(secret)

  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: SESSION_MAX_AGE_S,
    path: "/",
  })
  return response
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete(SESSION_COOKIE)
  return response
}
