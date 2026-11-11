import { NextRequest, NextResponse } from "next/server"
import { getLeadsClient, isOwnedNumber } from "@/lib/leads"
import { clearBestNumber, setBestNumber } from "@/lib/leadPhones"

// The lead card's "Add another number" (lib/leadPhones.ts). POST attaches a
// best number to the card — the Call button and texts go there from then on,
// and a call or text from it lands on the same card. DELETE takes it off.

export async function POST(request: NextRequest) {
  let body: { phone?: string; best?: string } = {}
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  if (!body.phone || !body.best) return NextResponse.json({ error: "phone and best are required" }, { status: 400 })
  if (isOwnedNumber(body.best)) return NextResponse.json({ error: "That's one of our own numbers." }, { status: 400 })
  const out = await setBestNumber(getLeadsClient(), { personPhone: body.phone, bestPhone: body.best, source: "ryan" })
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 400 })
  return NextResponse.json({ success: true, best: out.best })
}

export async function DELETE(request: NextRequest) {
  const phone = request.nextUrl.searchParams.get("phone")
  if (!phone) return NextResponse.json({ error: "phone is required" }, { status: 400 })
  const out = await clearBestNumber(getLeadsClient(), phone)
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: 500 })
  return NextResponse.json({ success: true })
}
