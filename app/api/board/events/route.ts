import { NextResponse } from "next/server"
import { getLeadsClient } from "@/lib/leads"
import { EVENT_TYPES, isDateKey, validatePayload, type BoardEventType } from "@/lib/board"
import { deleteEvent, fetchActivePeriod, insertEvent, setEventRelationship } from "@/lib/boardDb"

// Board rep-event CRUD. Every tap on the Today view lands here.
//
//   POST   { event_type, occurred_on, payload?, relationship_id? }   log a rep
//   DELETE { id }                                                     undo
//   PATCH  { id, relationship_id }   link/unlink a contact touch to a
//                                    relationships row (null unlinks)
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const body = await request.json()

    const eventType = body.event_type as BoardEventType
    if (!EVENT_TYPES.includes(eventType)) {
      return NextResponse.json({ error: "invalid event_type" }, { status: 400 })
    }
    const occurredOn = body.occurred_on
    if (!isDateKey(occurredOn)) {
      return NextResponse.json({ error: "occurred_on=YYYY-MM-DD is required" }, { status: 400 })
    }
    const validated = validatePayload(eventType, body.payload)
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 })
    }
    const relationshipId =
      body.relationship_id === undefined || body.relationship_id === null
        ? null
        : String(body.relationship_id)
    if (relationshipId !== null && eventType !== "contact_touch") {
      return NextResponse.json({ error: "relationship_id only applies to contact_touch" }, { status: 400 })
    }

    const supabase = getLeadsClient()
    const period = await fetchActivePeriod(supabase, occurredOn)
    if (!period) {
      return NextResponse.json({ error: "no goal period exists" }, { status: 400 })
    }

    const event = await insertEvent(supabase, {
      period_id: period.id,
      event_type: eventType,
      occurred_on: occurredOn,
      payload: validated.payload,
      relationship_id: relationshipId,
    })
    return NextResponse.json({ success: true, event })
  } catch (err) {
    console.error("board events POST error:", err)
    return NextResponse.json({ error: "log failed" }, { status: 500 })
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json()
    const id = String(body.id ?? "")
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })

    const deleted = await deleteEvent(getLeadsClient(), id)
    if (!deleted) return NextResponse.json({ error: "event not found" }, { status: 404 })
    return NextResponse.json({ success: true })
  } catch (err) {
    console.error("board events DELETE error:", err)
    return NextResponse.json({ error: "undo failed" }, { status: 500 })
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json()
    const id = String(body.id ?? "")
    if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 })
    if (body.relationship_id === undefined) {
      return NextResponse.json({ error: "relationship_id is required (null to unlink)" }, { status: 400 })
    }
    const relationshipId = body.relationship_id === null ? null : String(body.relationship_id)

    const event = await setEventRelationship(getLeadsClient(), id, relationshipId)
    if (!event) return NextResponse.json({ error: "event not found" }, { status: 404 })
    return NextResponse.json({ success: true, event })
  } catch (err) {
    console.error("board events PATCH error:", err)
    return NextResponse.json({ error: "link failed" }, { status: 500 })
  }
}
