# Brief — Migrate Relationships (BoB) from Google Sheet → Supabase

**Status:** Ready to execute. Scoped 2026-05-21.
**Owner:** new session — start a fresh Claude Code session in the
`mission-control` repo and point it at this file.
**Estimated size:** medium-large — one schema migration, a data backfill,
~10 API routes rewritten, one 1300-line component reworked. Best done as
its own focused branch (`feat/relationships-supabase`).

---

## 1. Why we're doing this

The **Relationships tab** ("Book of Business" / BoB) is the only part of
Mission Control still backed by a **Google Sheet** instead of Supabase.
Leads, drips, follow-ups, offers — everything else is in Postgres. The
sheet is a production database pretending to be a spreadsheet, and it
causes real bugs:

- **The partial-notes race (the bug that triggered this).** When you
  promote a lead to Relationships, `promote-to-relationship` copies a
  *snapshot* of the lead (name, phone, `ai_summary`) into the sheet. If
  the call transcript / AI summary hasn't finished processing yet (it
  runs async, minutes later), the sheet row freezes with partial notes.
  Nothing ever reconciles it. This is unavoidable while Relationships
  lives in a separate system — promotion has to *copy* data across a
  boundary instead of *referencing* it.
- **Contact identity is a row number.** Every contact's id is
  `bob-${rowIndex}` and every write targets `Sheet1!G${sheetRow}` etc.
  Insert or delete a sheet row and every id below it silently shifts.
- **No foreign keys, no joins, no transactions.** Can't link a
  relationship back to the lead it came from, the calls made to it, or
  the drip history.
- **Two systems, two mental models** for cadence, snooze, staleness.

Moving Relationships into a Supabase `relationships` table **dissolves
the partial-notes race entirely** (see §6), removes the row-number
fragility, and lets the Relationships tab share the same patterns as the
rest of the app.

> Note: this is **not** the same as Issues 2 & 3 shipped on 2026-05-21
> (commit `8c32500`). Those fixed the *lead-side* of promote (mark the
> whole cluster dead) and the manual-touch drip-cadence reset. Both are
> Supabase-side already and are **unaffected** by this migration. The
> only part of `promote-to-relationship` this brief changes is the
> "append a row to the BoB sheet" half.

---

## 2. Current architecture (what exists today)

### The BoB Google Sheet
- ID: `1sJyF3aLZxaGdA4l-i8G3Vy3yZliJjekdG6B9m3ydBIQ`
- Accessed via `lib/sheets.ts` → `getSheetsClient()` (service-account
  auth, `GOOGLE_SERVICE_ACCOUNT_KEY` env).
- **Tab `Sheet1`** — the contacts. Columns A–J:

  | Col | Field | Notes |
  |-----|-------|-------|
  | A | name | |
  | B | phone | stored as 10-digit, normalized on read |
  | C | — | unused |
  | D | — | unused |
  | E | category | `Agent`/`Vendor`/`Personal`/`PM`/`Investor`/`PrivateMoney`/`Seller`; legacy verbose labels normalized via `normalizeCategory()` |
  | F | — | unused |
  | G | LastContacted | human date string e.g. "May 21, 2026"; drives cadence |
  | H | tier | `A`/`B`/`C`/`D`/`E` — E = excluded from queue |
  | I | notes | optional `[enriched: YYYY-MM-DD]` prefix marks freshness |
  | J | snooze_until | ISO timestamp; contact hidden from queue until then |

- **Tab `Log`** — append-only touch audit trail. Columns A–K:
  timestamp, name, phone, sheetRow, modality, action, tier, category,
  message, generatedMessage (AI draft), wasEdited.

### Code that touches the sheet
- `lib/sheets.ts` — Sheets client + `SHEET_ID`.
- `lib/crms.ts` — `RelationshipCategory` enum, labels, picker order,
  `isValidCategory()`, `normalizeCategory()`. **Keep this file** — the
  enum is reused; only its "kept short for Sheet1" comments change.
- `components/widgets/CRMSTab.tsx` (~1311 lines) — the Relationships tab
  UI. Reads the queue, search, renders contact cards, send/log/snooze.
- `app/(dashboard)/relationships/page.tsx` — thin wrapper → `<CRMSTab />`.
- `app/api/crms/*` — 10 routes (see §4).
- `app/api/leads/[id]/promote-to-relationship/route.ts` — appends a
  Sheet1 row (the lead-side of this route is already correct; leave it).

### Cadence logic (currently duplicated in `contacts` + `all-contacts`)
- Cadence days by tier: `{ A: 30, B: 45, C: 60, D: 365 }`. Tier E never
  surfaces.
- A contact is **due** when `daysSince(LastContacted) >= cadenceDays`.
- Per-category **daily targets** (`contacts` route): Agent 10, Vendor 3,
  Personal 2, PrivateMoney 3, PM/Investor/Seller 0. The queue is a
  weighted round-robin (`interleave()`) capped at each target, with
  Agent backfilling any shortfall.
- Notes staleness: `[enriched: DATE]` older than 90 days → `notesStale`.
- Snooze: `snooze_until` in the future → hidden from the queue.

### External / non-obvious consumers — IMPORTANT
- **COI outreach scripts** (outside this repo, in the workspace outreach
  tooling) read the BoB sheet directly. They must be repointed or given
  a compatibility export — see §5, Phase 6.
- The **`Log` tab** is described in-code as feeding "future
  voice-learning analysis" — preserve this data; migrate it into
  `relationship_touches`.
- `app/api/crms/touches` proxies the **Mac-mini sidecar** for iMessage
  history. Note a *separate* in-flight effort is migrating messaging
  from the sidecar to Twilio — coordinate; `touches` should ideally read
  the new `relationship_touches` table instead of the sidecar.

---

## 3. Target schema

Run as a migration via the existing runner:
`node mission-control/scripts/run-migration.mjs <file.sql>`.

```sql
-- relationships — the Book of Business, one row per contact.
create table relationships (
  id                uuid primary key default gen_random_uuid(),
  name              text not null,
  phone             text,                       -- E.164 (+1XXXXXXXXXX)
  email             text,
  category          text not null
                      check (category in ('Agent','Vendor','Personal',
                        'PM','Investor','PrivateMoney','Seller')),
  tier              text not null default 'C'
                      check (tier in ('A','B','C','D','E')),
  notes             text,
  enriched_at       timestamptz,                -- replaces [enriched:] prefix
  last_contacted_at timestamptz,                -- replaces Sheet1 col G
  snooze_until      timestamptz,                -- replaces Sheet1 col J
  source_lead_id    uuid references leads(id),  -- the lead this came from
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index relationships_phone_idx on relationships (phone);
create index relationships_category_idx on relationships (category);
create index relationships_source_lead_idx on relationships (source_lead_id);

-- relationship_touches — replaces the BoB "Log" tab. One row per
-- logged outreach (sent / skipped / etc.).
create table relationship_touches (
  id                uuid primary key default gen_random_uuid(),
  relationship_id   uuid references relationships(id),
  occurred_at       timestamptz not null default now(),
  modality          text,            -- imessage / email / call
  action            text,            -- sent / skipped
  message           text,
  generated_message text,            -- original AI draft, for voice-learning
  was_edited        boolean,
  tier_at_touch     text,            -- snapshot
  category_at_touch text             -- snapshot
);
create index relationship_touches_rel_idx
  on relationship_touches (relationship_id, occurred_at desc);
```

Decisions baked in (override if Ryan disagrees):
- **Phone stored E.164** (`+1…`), not 10-digit — matches
  `leads.caller_phone` so relationships can be joined/looked-up against
  leads. Normalize on migration.
- **`enriched_at` as a real column** instead of an inline `[enriched:]`
  string prefix in notes. Staleness = `now() - enriched_at > 90 days`.
- **Tier E retained** as "excluded from queue" to preserve current
  behavior. (Could become a real `archived_at` later — out of scope.)
- **`source_lead_id` FK** is the key to dissolving Issue 1 — see §6.

---

## 4. API route migration map

All 10 `app/api/crms/*` routes lose their `getSheetsClient()` dependency
and become Supabase queries via `getLeadsClient()`. Keep the **response
shapes identical** so `CRMSTab.tsx` changes as little as possible.
`id` becomes the row UUID instead of `bob-${rowNumber}`; `sheetRow` is
dropped everywhere.

| Route | Today | After |
|-------|-------|-------|
| `contacts` | reads Sheet1, computes due queue + round-robin | `select * from relationships` where not snoozed, tier≠E; **keep** the JS cadence/interleave logic verbatim |
| `all-contacts` | reads Sheet1, all contacts | `select * from relationships order by name` |
| `category` | writes Sheet1 col E by `sheetRow` | `update relationships set category where id` |
| `tier` | writes Sheet1 col H | `update relationships set tier where id` |
| `notes` | writes Sheet1 col I | `update relationships set notes, enriched_at=now() where id` |
| `log` | appends Log tab; on `sent`→col G, on `skipped`→col J | `insert relationship_touches`; on `sent`→`last_contacted_at=now()`; on `skipped`→`snooze_until=now()+24h` |
| `enrich-one` | AI-enriches one contact's notes | same AI call → `update notes, enriched_at` |
| `generate` | AI-generates the outreach message (~438 lines) | unchanged logic; just load the contact from Supabase instead of the sheet — **lowest-risk route** |
| `send` | sends a message (sidecar) | unchanged send path; coordinate with the Twilio-SMS migration |
| `touches` | proxies sidecar for iMessage history | **prefer** reading `relationship_touches`; fall back to sidecar only if richer history is needed |

Extract the cadence constants + `interleave()` + parsing helpers into a
shared `lib/relationships.ts` (today they're copy-pasted across
`contacts` and `all-contacts`).

---

## 5. Phased plan

**Phase 1 — Schema.** Write + run the migration in §3. No code changes
yet.

**Phase 2 — Data migration.** One-off script (`scripts/`, delete after):
read BoB `Sheet1!A:J` and `Log!A:K`; for each Sheet1 row insert a
`relationships` row —
- `normalizeCategory(colE)`; phone → E.164; `tier` default `C`;
- parse col G → `last_contacted_at` (handle "never"/blank → null);
- parse col J → `snooze_until`;
- strip the `[enriched: DATE]` prefix from col I → `notes` +
  `enriched_at` (null if no prefix);
- `source_lead_id`: best-effort — match phone against `leads.caller_phone`,
  set if exactly one promoted/dead lead matches, else null.
Then migrate `Log` rows → `relationship_touches`, matching
`relationship_id` by normalized phone. Run it **idempotently** (clear the
tables or upsert) so it can be re-run. Print a reconciliation count.

**Phase 3 — API routes.** Rewrite all 10 routes (§4). Keep response
shapes byte-compatible. Add `lib/relationships.ts`. Remember
`force-dynamic` / `cache: "no-store"` for any data-reading route — see
the comments in `lib/leads.ts` `getLeadsClient()`.

**Phase 4 — `promote-to-relationship`.** Replace the
`sheets.spreadsheets.values.append(...)` block with a
`relationships` insert: name, phone (E.164), email, category, tier,
`notes` = the existing enriched string, `enriched_at = now()`,
**`source_lead_id = lead.id`**. The lead-side (cluster dead-mark +
`haltOutreachForCluster`) stays exactly as shipped in `8c32500`.

**Phase 5 — UI.** Update `CRMSTab.tsx` for UUID ids (drop every
`sheetRow` reference). If response shapes were kept identical, this is
mostly type tweaks. Verify search, queue, send, log, snooze, tier/
category edit, notes edit.

**Phase 6 — External consumers.** Repoint the COI outreach scripts off
the sheet. Options: (a) point them at a new read endpoint
`/api/relationships/export`, or (b) a scheduled one-way Supabase→Sheet
export kept alive during transition. **Ask Ryan which** — don't silently
break COI outreach.

**Phase 7 — Cutover & cleanup.** Hard cutover (single-user app):
deploy, smoke-test, keep the BoB sheet as a frozen read-only backup for
~30 days. Then delete `lib/sheets.ts`, `getSheetsClient`, the
`googleapis` dependency if nothing else uses it, and this brief.

---

## 6. How this dissolves Issue 1 (the partial-notes race)

Today: promote *snapshots* `ai_summary` into the sheet; the async call
analysis lands later; nothing reconciles it.

After migration, the `relationships` row carries `source_lead_id`. Two
clean options — recommend **B**:

- **A — read-through.** The Relationships UI shows the linked lead's
  current `ai_summary` live (join on `source_lead_id`). Always fresh,
  zero snapshot.
- **B — backfill hook.** In `applyAnalyzeCallResult` (lib/leads.ts) —
  where the call pipeline writes `ai_summary` onto the lead — also
  `update relationships set notes=…, enriched_at=now() where
  source_lead_id = <lead> or phone = <lead phone>`. Same database, one
  extra statement, no race. The Relationships row self-heals the moment
  the transcript lands.

Either way the bug is structurally gone: promotion no longer copies data
across a system boundary.

---

## 7. Risks & gotchas

- **COI outreach scripts** read the sheet — Phase 6 must land or they
  break silently. This is the highest-risk item.
- **Concurrent work:** a separate effort is migrating messaging
  (`/api/leads/send`, sidecar → Twilio). `crms/send` and `crms/touches`
  overlap — coordinate branches.
- **Supabase fetch caching:** App Router caches `fetch` GETs. Use
  `getLeadsClient()` (already sets `cache:"no-store"`) and
  `export const dynamic = "force-dynamic"` on read routes. See the long
  comment in `lib/leads.ts`.
- **Date parsing:** col G is a human string ("May 21, 2026"); some rows
  are blank or "never". Migration must handle all of it.
- **Phone collisions:** a relationship and a lead can share a phone;
  `source_lead_id` match should require exactly one lead match or be
  left null.
- **Don't lose the `Log` tab** — it's flagged in-code as future
  voice-learning training data.
- **`run-migration.mjs`** + Supabase PAT are in `.env.local` — see the
  memory note on the migration runner.

---

## 8. Acceptance criteria

- [ ] `relationships` + `relationship_touches` tables exist; every BoB
      Sheet1 row migrated (reconciliation count matches).
- [ ] Relationships tab: queue, search, send, log-sent, skip/snooze,
      tier + category + notes edits all work against Supabase.
- [ ] Cadence behavior unchanged — same contacts come due, same
      round-robin weighting, tier E still excluded, snooze still hides.
- [ ] Promote a lead → a `relationships` row appears with
      `source_lead_id` set; no Google Sheet write happens.
- [ ] Issue 1 verified: promote a lead whose call is still transcribing;
      when the transcript lands, the relationship's notes update on their
      own (Option B) or show live (Option A).
- [ ] COI outreach scripts still get their data (Phase 6).
- [ ] No remaining imports of `lib/sheets.ts` from the Relationships
      path; `tsc` + build clean.

## 9. Open decisions for Ryan

1. **COI scripts** — repoint to a Supabase endpoint, or keep a
   Supabase→Sheet export alive during transition?
2. **Issue 1 fix** — Option A (live read-through) or B (backfill hook)?
   Recommend B.
3. **Keep the BoB sheet** as a frozen backup for a while, or archive
   immediately after cutover?
