# Cody Brief — Relationships Tab: Voice Generation Fix

**Date:** June 30, 2026
**Project:** Mission Control — Relationships Tab
**App:** `/Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control`
**Deploy:** `npm run build && kill $(lsof -ti :3001) && nohup node_modules/.bin/next start -p 3001 > /tmp/mc-next.log 2>&1 &`
**Branch:** `feature/voice-generation-fix` ← create this before starting

---

## The Problem

The Relationships tab generates outreach messages for Ryan to send to agents. The generated messages keep defaulting to boilerplate language Ryan hates — specifically **"I'm still actively buying fixers and value-add deals in the Bay Area"** — even though his actual texting style is much more casual. He's been manually editing every single message, which defeats the purpose.

**Ryan's actual style (these are real messages he sent):**
- `"Hey Rob, this is Ryan LaRocca — been a while since we last connected. I've been looking to buy some homes around the South Bay, wondering if you had seen anything worth looking at?"`
- `"Hey Penni, it's Ryan LaRocca — been a while since we last caught up. Are you still an agent? I am looking for a new project right now..."`
- `"Hey Albert! This is Ryan - hope you've been well. Im looking for a project now if you have anything..."`
- `"Carlton! Whats up man, how are you? I haven't heard from you in a minute"`
- `"Hey Michelle, this is Ryan LaRocca. I had saved your number from a while back. Are you still doing real estate? I have been looking for some homes to buy and was wondering if you've seen anything recently?"`

**What the AI keeps generating instead:**
- `"Hey Jessica, it's Ryan LaRocca — been a while since we last connected. I'm still actively buying fixers and value-add deals in the Bay Area. Have you come across anything interesting lately that might be worth looking at?"`

The difference: Ryan uses simpler, more personal language. "Looking for some homes to buy" not "actively buying fixers and value-add." "I'm looking for a new project" not the full Bay Area investor pitch. Familiar contacts get pure check-ins, no business push at all.

---

## Infrastructure

**App:** Next.js 14, running on port 3001
**Supabase (LRG Homes project):**
- URL: `https://vcebykfbaakdtpspkaek.supabase.co`
- service_role key: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZjZWJ5a2ZiYWFrZHRwc3BrYWVrIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzM4Njk4MCwiZXhwIjoyMDkyOTYyOTgwfQ.wy43QBkf-0HFANWFq_OiI-yalSlsWJBkAkZ2kxk2zIQ`
- Table: `relationship_touches` — logs every sent message. Key columns: `message` (what was actually sent after editing), `generated_message` (what the AI originally drafted), `was_edited` (bool), `modality`, `category_at_touch`, `replied_at`

**AI generation route:** `app/api/crms/generate/route.ts`
**Sidecar (touch history):** `/Users/ryanlarocca/.openclaw/workspace/PROJECTS/comprehensive-relationship-management/phase2/crms-sidecar.js` — runs on port 5799, reads from local `data/outreach_log.json`
**UI component:** `components/widgets/CRMSTab.tsx`

**Message flow:**
1. UI calls `POST /api/crms/generate` with `{ name, phone, notes, hasNotes, modality, category }`
2. Route fetches voice examples from `relationship_touches` in Supabase (real sent messages)
3. Route builds prompt with: static voice examples + DB voice examples + modality-specific instruction + contact notes
4. Calls OpenRouter (claude-sonnet-4-5) → returns generated message
5. UI displays in the composer for Ryan to review/edit before sending

---

## What's Already Been Tried (and didn't work)

1. **Static voice examples hardcoded** — Ryan's real messages added as `STATIC_VOICE` const in `generate/route.ts`, prepended to DB examples in `fetchVoiceExamples()`. Still not working.
2. **Prompt language updated** — Changed Agent_Reconnect and Agent_ColdReintro prompts to say "Do NOT write 'fixers and value-add' unless examples use it." Still generating it.
3. **Fallbacks updated** — Changed the no-notes fallback templates to Ryan's actual phrasing.
4. **Filter fix** — `[marked contacted manually]` placeholders now filtered out of voice training data.

The core issue is likely one or more of:
- The AI (claude-sonnet-4-5 via OpenRouter) is ignoring the "do not use" instruction
- The voice examples aren't being surfaced with enough weight in the prompt
- The system prompt / CONTEXT_FILTER_PREAMBLE is overriding the voice examples
- Caching issues (5-min in-memory `voiceCache` means code changes don't take effect until restart)

---

## Parts

### Part 1: Diagnose what the AI actually receives

Add a debug mode (env var `CRMS_DEBUG=1`) that logs the full prompt being sent to OpenRouter before each request. Run one test generation for "Jessica" (Agent, Reconnect, has notes) and inspect:
- Are the static voice examples actually in the prompt?
- What does the final assembled prompt look like?
- Is the `CONTEXT_FILTER_PREAMBLE` or `NEW_CONTACT_RULE` drowning out the voice block?

Log to `/tmp/crms-generate-debug.log`.

### Part 2: Fix the prompt architecture

The voice block currently prepends examples but then the modality prompt repeats conflicting instructions. Restructure so the voice examples are **the single source of truth for phrasing** — the modality prompt should only specify the scenario and relationship context, NOT tell the AI what words to use.

Recommended approach:
- Move voice examples to a system message (separate role) rather than prepending to user content
- Or: make the instruction in the prompt much more explicit — "Your ONLY job is to write in the voice of the examples above. The examples ARE the style guide. Do not deviate."
- Remove ALL specific phrasing mandates from the prompt templates (no "fixers, value-add", no "I'm still actively buying X")

### Part 3: Improve voice example selection

Currently `fetchVoiceExamples` queries `relationship_touches` in Supabase, filters to `sent` actions, and deduplicates. Issues:
- The 5-minute `voiceCache` persists across server restarts (it's in-memory, so actually it resets on restart — but confirm this isn't a NextJS module-level cache persisting across hot reloads)
- Expand example count: currently capped at `limit + 2` (7 max). Try 10.
- Add `was_edited` preference: messages Ryan edited are higher signal than ones he sent as-is. Prioritize `was_edited = true` rows.

### Part 4: Verify end-to-end with a real test

Before calling it done, generate 3 test messages:
1. Agent / Familiar (warm contact, has notes)
2. Agent / Reconnect (has notes)
3. Agent / ColdReintro (no notes — should use fallback)

All three should sound like the real Ryan examples above. None should contain "fixers and value-add deals" or "actively buying investment properties" as a set phrase.

---

## Build Order

1. Add debug logging (Part 1) → run one test → read the log → understand what's broken
2. Fix prompt architecture based on what you find (Part 2)
3. Improve voice example selection (Part 3)
4. Run end-to-end test (Part 4)
5. Remove debug logging before marking ready

---

## Checkpoint Protocol

After completing each Part, announce:

```
✅ CHECKPOINT: [Part Name] complete
Summary: [1-2 sentences]
Files touched: [list]
Blocked: [yes/no]
```

If blocked:
```
⏸ BLOCKED: [Issue]
Options: [A, B, C]
Waiting for input.
```

---

## Deploy Gate

Do NOT deploy to production. When ready:

```
🏁 READY FOR REVIEW
Changed files: [list]
What to test: [instructions]
Deploy command: npm run build && kill $(lsof -ti :3001) && nohup node_modules/.bin/next start -p 3001 > /tmp/mc-next.log 2>&1 &
```

---

## Files Cody May Touch

- `app/api/crms/generate/route.ts` — main target
- `app/api/crms/touches/route.ts` — if adjusting example fetching
- `components/widgets/CRMSTab.tsx` — only if there's a UI change needed
- `components/widgets/ContactDetailModal.tsx` — only if UI change needed

## DO NOT TOUCH

- Any leads pipeline files (`app/api/leads/`, `lib/leads.ts`)
- Supabase schema (no migrations)
- The sidecar (`crms-sidecar.js`) unless explicitly needed
- Any other tabs (Leads, Calendar, etc.)
- `.env` / secrets files
