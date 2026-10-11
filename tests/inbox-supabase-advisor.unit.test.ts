import { describe, expect, it } from "vitest"
import { advisorSummary, isSupabaseSecurityAlert, otherErrors, rlsTargets } from "../scripts/inbox-agent/supabase-advisor.mjs"

const alert = { from: { email: "noreply@supabase.com", name: "Supabase" }, subject: "Action required: security vulnerabilities detected in your projects" }

describe("isSupabaseSecurityAlert", () => {
  it("matches the weekly advisor email", () => {
    expect(isSupabaseSecurityAlert(alert)).toBe(true)
    expect(isSupabaseSecurityAlert({ ...alert, subject: "Re: Action required: security vulnerabilities detected" })).toBe(true)
  })
  it("ignores other Supabase mail and look-alike subjects from elsewhere", () => {
    expect(isSupabaseSecurityAlert({ ...alert, subject: "Your Supabase invoice is ready" })).toBe(false)
    expect(isSupabaseSecurityAlert({ ...alert, subject: "Your project has been paused" })).toBe(false)
    expect(isSupabaseSecurityAlert({ from: { email: "workspace-noreply@google.com" }, subject: "[Notice] Possible unresolved security risks in your Admin Console" })).toBe(false)
    expect(isSupabaseSecurityAlert({ from: { email: "someone@supabase.com.evil.io" }, subject: alert.subject })).toBe(false)
    expect(isSupabaseSecurityAlert(null)).toBe(false)
  })
})

describe("advisor lint parsing", () => {
  const lints = [
    { name: "rls_disabled_in_public", level: "ERROR", metadata: { schema: "public", name: "mail_records", type: "table" } },
    { name: "rls_disabled_in_public", level: "ERROR", metadata: { schema: "public", name: "reply_drafts", type: "table" } },
    { name: "rls_enabled_no_policy", level: "INFO", metadata: { schema: "public", name: "leads", type: "table" } },
    { name: "function_search_path_mutable", level: "WARN", metadata: { schema: "public", name: "set_updated_at", type: "function" } },
    { name: "auth_users_exposed", level: "ERROR", metadata: { schema: "public", name: "people_view", type: "view" } },
  ]
  it("picks only RLS-off public tables as fix targets", () => {
    expect(rlsTargets(lints)).toEqual([
      { schema: "public", table: "mail_records" },
      { schema: "public", table: "reply_drafts" },
    ])
  })
  it("reports other ERROR lints for Ryan, not INFO/WARN", () => {
    expect(otherErrors(lints)).toEqual(["auth_users_exposed · public.people_view"])
  })
})

describe("advisorSummary", () => {
  it("names fixed tables and says nothing is owed when clean", () => {
    const s = advisorSummary({ fixed: ["public.mail_records", "public.reply_drafts"], remaining: [], stillFlagged: [], errors: [] })
    expect(s).toContain("2 tables")
    expect(s).toContain("• mail_records")
    expect(s).toContain("Nothing for you to do")
  })
  it("surfaces what it could not fix", () => {
    const s = advisorSummary({ fixed: [], remaining: ["auth_users_exposed · public.people_view"], stillFlagged: ["public.x"], errors: [] })
    expect(s).toContain("nothing to fix")
    expect(s).toContain("Still flagged")
    expect(s).toContain("auth_users_exposed")
    expect(s).not.toContain("Nothing for you to do")
  })
})
