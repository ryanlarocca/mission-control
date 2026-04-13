import { NextResponse } from "next/server"

const SESSION_COOKIE = "mc_session"
const THIRTY_DAYS = 60 * 60 * 24 * 30

export async function POST(request: Request) {
  const { password } = await request.json()

  const expected = process.env.MC_PASSWORD
  const secret = process.env.MC_SESSION_SECRET

  if (!expected || !secret) {
    return NextResponse.json({ error: "Server not configured" }, { status: 500 })
  }

  if (password !== expected) {
    // Small delay to slow brute force
    await new Promise(r => setTimeout(r, 500))
    return NextResponse.json({ error: "Incorrect password" }, { status: 401 })
  }

  const response = NextResponse.json({ ok: true })
  response.cookies.set(SESSION_COOKIE, secret, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    maxAge: THIRTY_DAYS,
    path: "/",
  })
  return response
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true })
  response.cookies.delete(SESSION_COOKIE)
  return response
}
