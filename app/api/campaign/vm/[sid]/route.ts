import { NextRequest, NextResponse } from "next/server"

// Playable voicemail links (2026-07-30). Twilio recording media requires
// account auth (Ryan's alert links 401'd when tapped), so this streams the
// mp3 through Mission Control. Public path; the only input is a strictly
// validated RecordingSid — unguessable, same security model as Twilio's own
// public media URLs.

export const dynamic = "force-dynamic"

export async function GET(_req: NextRequest, ctx: { params: Promise<{ sid: string }> }) {
  const { sid } = await ctx.params
  const clean = sid.replace(/\.mp3$/i, "")
  if (!/^RE[0-9a-f]{32}$/.test(clean)) return new NextResponse("not found", { status: 404 })
  const accountSid = process.env.TWILIO_ACCOUNT_SID
  const token = process.env.TWILIO_AUTH_TOKEN
  if (!accountSid || !token) return new NextResponse("not configured", { status: 503 })

  const upstream = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Recordings/${clean}.mp3`,
    { headers: { Authorization: "Basic " + Buffer.from(`${accountSid}:${token}`).toString("base64") } }
  )
  if (!upstream.ok || !upstream.body) return new NextResponse("recording unavailable", { status: 404 })
  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": "audio/mpeg",
      "Cache-Control": "private, max-age=3600",
      "Content-Disposition": 'inline; filename="voicemail.mp3"',
    },
  })
}
