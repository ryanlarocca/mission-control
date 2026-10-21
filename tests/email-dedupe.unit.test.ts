import { describe, it, expect } from "vitest"
import type { SupabaseClient } from "@supabase/supabase-js"
import { appsScriptMessageId, insertEmailLead, isUniqueViolation, UNIQUE_VIOLATION } from "@/lib/emailDedupe"

// BRIEF_TRIAGE_SONNET_DEDUPE_MATCHLINK_2026-10-21 §3. Two Gmail notifications
// for one message raced through the read-then-insert check and produced two
// identical lead rows. The partial unique index on leads.gmail_message_id
// rejects the second insert (23505); insertEmailLead reports it as
// `duplicate` instead of an error. Offline: a fake supabase client that
// enforces the index in memory, same style as tests/email-alias.unit.test.ts.

function fakeLeadsTable() {
  const rows: Record<string, unknown>[] = []
  const ids = new Set<string>()
  const sb = {
    from(table: string) {
      if (table !== "leads") throw new Error(`unexpected table ${table}`)
      return {
        insert(row: Record<string, unknown>) {
          const key = row.gmail_message_id as string | null | undefined
          const chain = {
            select: () => chain,
            single: async () => {
              if (key && ids.has(key)) {
                return { data: null, error: { code: UNIQUE_VIOLATION, message: `duplicate key value violates unique constraint "leads_gmail_message_id_uniq"` } }
              }
              if (key) ids.add(key)
              const id = `lead-${rows.length + 1}`
              rows.push({ id, ...row })
              return { data: { id }, error: null }
            },
          }
          return chain
        },
      }
    },
  }
  return { sb: sb as unknown as SupabaseClient, rows }
}

describe("email dedupe — atomic insert on gmail_message_id", () => {
  it("inserting the same Gmail message id twice leaves one row; the second is reported as duplicate", async () => {
    const { sb, rows } = fakeLeadsTable()
    const row = { lead_type: "email", email: "seller@example.com", message: "Re: your letter", gmail_message_id: "18f3a1b2c3d4e5f6" }
    const first = await insertEmailLead(sb, row)
    const second = await insertEmailLead(sb, { ...row })
    expect(first).toEqual({ id: "lead-1", duplicate: false, error: null })
    expect(second).toEqual({ id: null, duplicate: true, error: null })
    expect(rows).toHaveLength(1)
  })

  it("rows without an id are never treated as duplicates of each other (index is partial)", async () => {
    const { sb, rows } = fakeLeadsTable()
    await insertEmailLead(sb, { lead_type: "email", gmail_message_id: null })
    await insertEmailLead(sb, { lead_type: "email", gmail_message_id: null })
    expect(rows).toHaveLength(2)
  })

  it("passes other errors through untouched", async () => {
    const sb = {
      from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: { code: "42703", message: "column does not exist" } }) }) }) }),
    } as unknown as SupabaseClient
    const r = await insertEmailLead(sb, { gmail_message_id: "x" })
    expect(r.duplicate).toBe(false)
    expect(r.error?.code).toBe("42703")
  })

  it("Apps Script key: stable for the same mail, differs when sender / subject / body differ", () => {
    const a = appsScriptMessageId("Seller@Example.com", "Re: letter", "I got your letter about 4032 Ross Park Ct.")
    const b = appsScriptMessageId("seller@example.com ", "Re: letter", "I got your letter about 4032 Ross Park Ct.")
    expect(a).toBe(b)
    expect(a).toMatch(/^as:[0-9a-f]{40}$/)
    expect(appsScriptMessageId("other@example.com", "Re: letter", "I got your letter about 4032 Ross Park Ct.")).not.toBe(a)
    expect(appsScriptMessageId("seller@example.com", "Re: letter 2", "I got your letter about 4032 Ross Park Ct.")).not.toBe(a)
    expect(appsScriptMessageId("seller@example.com", "Re: letter", "Different body.")).not.toBe(a)
    // Only the first 200 chars of the body count — same as the fuzzy check.
    const long = "x".repeat(200)
    expect(appsScriptMessageId("s@e.com", "s", long + "tail A")).toBe(appsScriptMessageId("s@e.com", "s", long + "tail B"))
  })

  it("isUniqueViolation keys on the Postgres code only", () => {
    expect(isUniqueViolation({ code: "23505", message: "dup" })).toBe(true)
    expect(isUniqueViolation({ code: "23503" })).toBe(false)
    expect(isUniqueViolation(null)).toBe(false)
    expect(isUniqueViolation("23505")).toBe(false)
  })
})
