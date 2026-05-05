# Cody Brief — Phase 7.4 Follow-Up: Email Timeline Bug + Email Reply Button

**Date:** 2026-05-05
**Project:** Mission Control — Lead Pipeline
**App:** `PROJECTS/mission-control/`
**Deploy:** `cd PROJECTS/mission-control && vercel --prod`
**Branch:** `feature/phase7.4-email-ux-fixes` ← create this branch before starting

---

## Context for Cody

The Leads tab in Mission Control captures inbound email leads from two mailboxes:
- `ryansvg@lrghomes.com` → Campaign MFM-A
- `ryansvj@lrghomes.com` → Campaign MFM-B

When Ryan expands a lead card, the timeline shows a chronological merge of:
1. Authoritative rows from Supabase (inserted by `/api/leads/email/route.ts`)
2. Synthetic rows fetched on card-expand from `/api/leads/sync-email` (which reads the full Gmail thread via the sidecar)

**There are two issues to fix.**

---

## Bug 1 — Inbound Email Renders as Outbound ("You") in Timeline

### What's broken

In `components/widgets/LeadsTab.tsx`, the `isOutbound()` helper reads:
```ts
function isOutbound(l: Lead): boolean {
  return !l.twilio_number
}
```

For Twilio leads, `twilio_number IS NULL` is the outbound marker (iMessage sends from the sidecar). But the email route (`app/api/leads/email/route.ts`) inserts email leads with `twilio_number: null` too — because there is no Twilio number involved. This causes ALL email lead rows to be treated as outbound ("You"), regardless of who actually sent the email.

The authoritative Supabase row for an inbound email from a lead appears as a right-aligned "You" bubble instead of a left-aligned inbound message bubble.

### Root cause confirmed

`app/api/leads/email/route.ts` — both `handleAppsScript` and `processSingleMessage` insert with `twilio_number: null`. The `isOutbound` convention was designed for iMessage sidecar sends only, but email leads collide with it.

### Fix

**Option chosen: use `twilio_number` as a direction field for email rows too.**

For inbound email inserts (lead emailed Ryan), set `twilio_number = "email:<mailbox>"` instead of `null`. Example: `"email:ryansvj@lrghomes.com"`.

This is NOT a null so `isOutbound()` returns `false` — inbound. It encodes the receiving mailbox for future use (e.g. knowing which mailbox to reply from).

For outbound email rows (Ryan replying — Part 2 below), keep `twilio_number = null` to match the existing outbound convention.

**Changes needed:**

1. **`app/api/leads/email/route.ts`** — in both `handleAppsScript` and `processSingleMessage`, change the insert:
   ```ts
   // Before:
   twilio_number: null,

   // After:
   twilio_number: `email:${emailAddress}`,  // emailAddress = the receiving mailbox, lowercase
   ```
   `emailAddress` is already in scope in both functions (it's the mailbox that received the email — `ryansvg@lrghomes.com` or `ryansvj@lrghomes.com`).

2. **`components/widgets/LeadsTab.tsx`** — the `syntheticFromGmail` function also builds Lead rows. Verify line:
   ```ts
   twilio_number: m.is_from_ryan ? null : "gmail",
   ```
   This is already correct (non-null for inbound Gmail synthetics). No change needed here.

3. **`lib/leads.ts`** — check if `isOutbound` or any outbound-detection logic is duplicated here. If it is, apply the same fix.

4. **No schema migration needed** — `twilio_number` is already a `TEXT` column. We're just putting a non-null string where null was before.

**Verify:** After the fix, when Ryan sends himself a test email to `ryansvj@lrghomes.com`, the lead row should render as a left-aligned inbound bubble in the timeline with the lead's name/email as the label — NOT "You".

---

## Part 2 — Email Reply Button

### What to build

When Ryan expands an email lead card, add an **"📧 Email Reply"** button next to (or below) the existing iMessage "Send" button. The email reply is specific to the inbound email lead's sender address and sends via the correct receiving mailbox (the one that got the inbound lead).

### Backend — new route: `POST /api/leads/email-reply`

Auth-gated (requires `mc_session` cookie — do NOT add to `PUBLIC_PATHS`).

**Request body:**
```ts
{
  leadId: string       // Supabase lead row ID — used to look up email + mailbox
  message: string      // Reply body text
}
```

**What the route does:**
1. Fetch the lead row from Supabase by `leadId` — get `email` (sender address), `twilio_number` (contains the receiving mailbox as `"email:ryansvg@lrghomes.com"`), `gmail_thread_id` (for threading the reply).
2. Derive the reply-from mailbox: strip the `"email:"` prefix from `twilio_number`. If `twilio_number` doesn't start with `"email:"`, return 400.
3. Validate: `email` must be non-null, `message` must be non-empty.
4. Send via Gmail API using the service account + DWD (same auth pattern as `getGmailClient()` in `app/api/leads/email/route.ts`):
   - Compose a `message/rfc822` MIME email with `To: <lead email>`, `From: <mailbox>`, `Subject: Re: <original subject if available>`, and `In-Reply-To: <gmail_thread_id>` / `References: <gmail_thread_id>` headers for proper threading.
   - Call `gmail.users.messages.send` with `threadId: gmail_thread_id` to thread the reply.
5. Insert an outbound lead row into Supabase:
   ```ts
   {
     lead_type: "email",
     source_type: <same as original lead's source_type>,
     source: <same as original lead's source>,
     twilio_number: null,     // outbound convention
     caller_phone: <original lead's caller_phone>,
     name: null,
     email: <lead's email>,
     message: message,
     status: "contacted",
     gmail_thread_id: gmail_thread_id,  // links to same thread
   }
   ```
6. Return `{ ok: true, leadId: <new row id> }`.

**Auth pattern** — copy `getGmailClient(userEmail)` from `app/api/leads/email/route.ts` into `lib/leads.ts` (or keep it local in the new route — your call, but don't duplicate the JWT logic manually; extract it). The DWD scope needed is `gmail.modify` (already authorized on the lrghomes.com tenant).

**Gmail send MIME construction** — use Node's built-in string construction (no nodemailer needed). Raw RFC 2822 format, base64url-encoded:
```ts
function buildRawEmail({
  to, from, subject, body, threadId, inReplyTo
}: { to: string; from: string; subject: string; body: string; threadId?: string | null; inReplyTo?: string | null }): string {
  const lines = [
    `To: ${to}`,
    `From: ${from}`,
    `Subject: ${subject}`,
  ]
  if (inReplyTo) {
    lines.push(`In-Reply-To: ${inReplyTo}`)
    lines.push(`References: ${inReplyTo}`)
  }
  lines.push(`Content-Type: text/plain; charset=utf-8`)
  lines.push(`MIME-Version: 1.0`)
  lines.push(``)
  lines.push(body)
  return Buffer.from(lines.join('\r\n')).toString('base64url')
}
```

For the subject line: fetch it from the `message` column of the lead row (the authoritative Supabase row has `message = "<subject>\n\n<body>"`). Parse out the first line as the subject.

**If `gmail_thread_id` is null** — still send, just don't set `threadId` in the Gmail API call and omit `In-Reply-To`. This is a graceful fallback.

### Frontend — UI changes in `components/widgets/LeadsTab.tsx`

Only show the email reply UI when `group.mostRecentEvent.lead_type === "email"` (already tracked as `isEmailLead` at line 682). Phone leads should not show this button.

**Approach:** Replace the single composer section in the expanded card with two branches:

**Branch A — iMessage leads** (existing behavior, no change):
- Textarea + Send button (calls `sendOutbound` → `/api/leads/send`)
- Gated on `group.contactPhone`

**Branch B — email leads** (`isEmailLead === true`):
- Show the "📧 Email Reply" button (or a textarea + Send via Email button)
- If `group.suggestedReply` exists, pre-fill the textarea with it and label it "💡 Suggested Reply"
- Send calls a new `sendEmailReply(group)` function (see below)
- Below the email reply section, if `group.contactPhone` also exists, also show the iMessage composer (some email leads have a phone — they should be able to do both)

**New state** (add alongside `draftMessage`, `sendingFor`, etc.):
```ts
const [emailDraft, setEmailDraft] = useState<Record<string, string>>({})
const [sendingEmailFor, setSendingEmailFor] = useState<string | null>(null)
const [emailSendSuccess, setEmailSendSuccess] = useState<string | null>(null)
const [emailSendError, setEmailSendError] = useState<string | null>(null)
```

**New function:**
```ts
async function sendEmailReply(group: LeadGroup) {
  const text = (emailDraft[group.phone] ?? group.suggestedReply ?? "").trim()
  if (!text) return
  // Find the most recent inbound email lead row to get the leadId
  const emailLead = group.events.find(e => e.lead_type === "email" && !isOutbound(e))
  if (!emailLead) return
  setSendingEmailFor(group.phone)
  setEmailSendError(null)
  try {
    const res = await fetch("/api/leads/email-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leadId: emailLead.id, message: text }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`)
    setEmailDraft(prev => ({ ...prev, [group.phone]: "" }))
    setEmailSendSuccess(group.phone)
    setTimeout(() => setEmailSendSuccess(null), 2500)
    void fetchLeads(true)
  } catch (e) {
    setEmailSendError(e instanceof Error ? e.message : String(e))
  } finally {
    setSendingEmailFor(null)
  }
}
```

**Pass down to the `LeadCard` component** (via the existing `p: LeadCardCallbacks` prop pattern):
- `emailDraft: string` (= `emailDraft[group.phone] ?? group.suggestedReply ?? ""`)
- `onEditEmailDraft: (v: string) => void`
- `onSendEmail: () => void`
- `sendingEmail: boolean`
- `emailSendSuccess: boolean`
- `emailSendError: string | null`

**In `LeadCard`** — the composer section becomes:

```tsx
{isEmailLead ? (
  <div>
    <div className="text-xs text-zinc-500 mb-1.5">
      {group.suggestedReply ? "💡 Suggested Reply" : "Email Reply"}
    </div>
    <textarea
      value={p.emailDraft}
      onChange={e => p.onEditEmailDraft(e.target.value)}
      placeholder="Write an email reply…"
      rows={3}
      className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 resize-none"
      style={{ fontSize: 16 }}
      disabled={p.sendingEmail}
    />
    <div className="mt-2 flex items-center justify-between gap-2">
      <div className="text-xs text-zinc-500 flex-1 min-w-0 truncate">
        {p.emailSendError && <span className="text-red-300">{p.emailSendError}</span>}
        {p.emailSendSuccess && (
          <span className="text-emerald-400 inline-flex items-center gap-1">
            <Check className="w-3 h-3" /> Email sent
          </span>
        )}
      </div>
      <button
        onClick={p.onSendEmail}
        disabled={p.sendingEmail || !p.emailDraft.trim()}
        className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded bg-blue-600 hover:bg-blue-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium transition-colors"
      >
        {p.sendingEmail ? <Loader2 className="w-4 h-4 animate-spin" /> : <Mail className="w-4 h-4" />}
        Send Email
      </button>
    </div>
    {/* If the lead also has a phone, show iMessage option below */}
    {group.contactPhone && (
      <div className="mt-3 pt-3 border-t border-zinc-800">
        <div className="text-xs text-zinc-500 mb-1.5">Or send iMessage</div>
        <textarea
          value={p.draftMessage}
          onChange={e => p.onEditMessage(e.target.value)}
          placeholder="Send a message…"
          rows={2}
          className="w-full bg-zinc-900 border border-zinc-800 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-zinc-700 resize-none"
          style={{ fontSize: 16 }}
          disabled={p.sending}
        />
        <div className="mt-2 flex justify-end">
          <button
            onClick={p.onSend}
            disabled={p.sending || !p.draftMessage.trim()}
            className="inline-flex items-center gap-1.5 px-4 py-2 min-h-[44px] rounded bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-800 disabled:text-zinc-600 text-white text-sm font-medium transition-colors"
          >
            {p.sending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            iMessage
          </button>
        </div>
      </div>
    )}
  </div>
) : (
  // Original iMessage-only composer (unchanged)
  <div>
    <div className="text-xs text-zinc-500 mb-1.5">Send a message</div>
    <textarea ... />
    ...
  </div>
)}
```

Make sure to import `Mail` from `lucide-react` at the top of the file.

---

## Build Order

1. **Bug fix first** — fix `twilio_number` in `app/api/leads/email/route.ts` (both insert paths). Test locally by inspecting what gets inserted.
2. **`lib/leads.ts`** — check for any duplicate `isOutbound` logic; update if present.
3. **`app/api/leads/email-reply/route.ts`** — new route. Build and test with a curl.
4. **`middleware.ts`** — confirm `/api/leads/email-reply` is NOT in PUBLIC_PATHS (it should stay auth-gated — no changes needed, just verify).
5. **`components/widgets/LeadsTab.tsx`** — UI changes. Test the full flow.
6. **`tsc --noEmit` must pass** before shipping.

---

## Checkpoint Protocol

**IMPORTANT:** After completing each major step, announce it clearly:

```
✅ CHECKPOINT: [Step Name] complete
Summary: [1-2 sentences of what was done]
Files touched: [list]
Blocked: [yes/no — if yes, what you need]
```

If you hit a blocker or need a decision, announce:
```
⏸ BLOCKED: [Issue description]
Options: [A, B, C if applicable]
Waiting for input.
```

**Do NOT proceed past a blocker without input.**

---

## Deploy Gate

**Do NOT deploy to production.** When all code is written and `tsc --noEmit` passes:
```
🏁 READY FOR REVIEW
Changed files: [list]
What to test: [list]
Deploy command: cd PROJECTS/mission-control && vercel --prod
```

Wait for explicit "deploy" instruction from Ryan or Thadius.

---

## Infrastructure

- **App:** `PROJECTS/mission-control/` (Next.js, Vercel)
- **Prod URL:** `https://mission-control-three-chi.vercel.app`
- **Supabase (LRG):** `https://vcebykfbaakdtpspkaek.supabase.co` — service role key in `.env.local` as `LRG_SUPABASE_SERVICE_KEY`
- **Gmail auth:** `GOOGLE_SERVICE_ACCOUNT_KEY` env var (JSON service account credentials). Auth pattern in `app/api/leads/email/route.ts` — `getGmailClient(userEmail)` using `google.auth.JWT` with DWD `subject`. Scope: `https://www.googleapis.com/auth/gmail.modify`.
- **DWD authorized scopes on lrghomes.com Workspace:** `gmail.modify` only. `gmail.readonly` will 401.
- **Mailboxes:** `ryansvg@lrghomes.com` (MFM-A), `ryansvj@lrghomes.com` (MFM-B)
- **Supabase `leads` table columns** (relevant): `id`, `lead_type`, `source`, `source_type`, `twilio_number`, `caller_phone`, `email`, `name`, `message`, `ai_notes`, `suggested_reply`, `status`, `gmail_thread_id`, `created_at`

---

## Files Modified (allow-list)

- `app/api/leads/email/route.ts`
- `app/api/leads/email-reply/route.ts` ← NEW
- `components/widgets/LeadsTab.tsx`
- `lib/leads.ts` (only if isOutbound logic is duplicated there)
- `middleware.ts` (read-only check — do not add `/api/leads/email-reply` to PUBLIC_PATHS)

Anything not listed: ask first.

---

## DO NOT TOUCH

- Any other API routes
- Twilio webhook routes
- Supabase schema (no migrations needed for this brief)
- crms-sidecar.js
- Anything in `phase2/`
- Any launchd plists
- `config/email-campaigns.json`
