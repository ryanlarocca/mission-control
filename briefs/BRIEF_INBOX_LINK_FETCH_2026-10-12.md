# Brief — Inbox agent: pull documents from behind links (DocuSign first)

**Date:** 2026-10-12 · **Owner project:** `PROJECTS/inbox-agent/` · **Runs on:** Mac mini worker (`scripts/inbox-agent/index.mjs`, launchd every 5 min) + Vercel webhook (`lib/inboxAgent.ts`).

## Why

Ryan (2026-10-12): the DocuSign link is "an ongoing friction point". Agents send
disclosures as a DocuSign "Please Sign" envelope, and the "Completed" email often
arrives **without** the PDF attached (sender has attach-PDF off). Today the agent
only files what arrives as an attachment; for links it posts "grab it from the
DocuSign link" and Ryan does it by hand. Concrete case: Ryan Nickell's
**"Please Sign: 93 Ridgeview Ave - Disclosures"**. The Completed email
(gmail id `1a1135bbe462b5b1`, 2026-10-06, from `dse_na4@docusign.net`) had zero
attachments and one `https://na4.docusign.net/Signing/EmailStart.aspx?a=…&etti=…&r=…`
link. Ryan went in, downloaded the disclosures and filed them himself.

Goal: the agent opens the link in a headless browser on the Mac mini, downloads
every document behind it, and feeds the PDFs through the **existing** filing
pipeline (classify → verify property from the PDF → whitelist → property
subfolder → confirmation card). Nothing downstream changes.

Ryan accepted two side effects: the envelope shows as **Viewed** to the sender,
and the agent ticks DocuSign's "I agree to use electronic records and
signatures" consent (needed to see the documents). The agent must **never** sign,
adopt a signature, finish, decline, or submit anything.

## Constraints the cloud session must respect

- You cannot run the worker, the browser, migrations, or anything needing
  `.env.local`. Write the code + unit tests; Ryan's bridge session tests on the
  mini against the Ridgeview email and applies the migration.
- Playwright `^1.62.1` is already a dependency. On the mini the browser is
  **Google Chrome** (`/Applications/Google Chrome.app`), launched with
  `channel: "chrome"` (see `scripts/skip-trace-fps.mjs:285` for the existing
  pattern). There is no `ms-playwright` download cache — do not rely on bundled
  Chromium.
- Only add a dependency if you must. For ZIP extraction prefer `fflate`
  (tiny, pure JS) — add it to `package.json` dependencies and tell the bridge
  session to `npm install` on the mini.
- Every new table/column ships in one migration under `supabase/migrations/`
  with `enable row level security` (house rule). Read your SQL twice — the
  bridge session has caught a missing comma from a cloud session before.
- `tsc --noEmit` and `vitest run` must pass. No `git add -A`; commit only the
  files you touched. Push the branch; **no PR, no merge**.
- Keep the existing code style: ESM `.mjs`, small named functions, Ryan-quoted
  comments explaining *why* where a rule comes from him.

## Design

### 1. Fetch module — `scripts/inbox-agent/fetch/`

```
fetch/index.mjs     detectProvider(url|email) → 'docusign' | null ; fetchDocuments(job) dispatcher
fetch/browser.mjs   launch/close a persistent Chrome context; screenshots; download capture
fetch/docusign.mjs  the DocuSign flow
fetch/cli.mjs       manual test: node scripts/inbox-agent/fetch/cli.mjs --url "<link>" [--code 1234] [--headed] [--out /tmp/dir]
```

`fetchDocuments({ url, provider, accessCode, jobId, log })` returns
`{ ok: true, files: [{ filename, mime, bytes }], screenshots: [paths] }` or
`{ ok: false, error, needs: 'access_code' | 'login' | 'expired' | null, screenshots }`.

**browser.mjs**

- `chromium.launchPersistentContext(profileDir, { channel: "chrome", headless: !headed, acceptDownloads: true, viewport: {1280,900}, timeout })`.
- `profileDir` = `process.env.INBOX_BROWSER_PROFILE || ~/.lrg/browser-profiles/inbox-agent` (outside the repo; create it). The point of a persistent
  profile: once Ryan logs into DocuSign there (later, `--headed --login`), the
  consent screens stop and any envelope sent to ryan@ opens. v1 works **without**
  a login — recipient links open on their own.
- Screenshot after every step to `/tmp/inbox-fetch/<jobId>-<n>-<step>.png`
  (keep the last 50 jobs; prune older dirs). On failure the card links the last
  screenshot path in the log line (Ryan can `open` it on the mini).
- Hard caps: 90 s per job, 3 attempts per job with backoff (5 min, 30 min, then
  give up and card).
- **Click allowlist.** The only buttons/links the flow may click are those
  whose visible text or data-qa matches: continue, review documents/review
  document, other actions, print & download / download, combined / separate
  pdf(s), close, finish later, got it, ok. Anything matching
  `/sign|adopt|finish(?! later)|submit|decline|agree and sign|complete/i` is
  refused and logged. Put the allowlist in one exported constant with a unit
  test.

**docusign.mjs** — two entry shapes, same flow:

1. `…/Signing/EmailStart.aspx?a=…&etti=…&r=…` (request *and* completed emails) → redirects into `…/Signing/?ti=…` (sometimes a "Review Documents" button first).
2. Possible gates, in order: "I agree to use electronic records and signatures"
   checkbox + CONTINUE (tick it); access-code form (`needs: 'access_code'` if
   no code given, else type it and continue); ID verification / phone auth /
   "sign in to view" → `needs: 'login'`; "This envelope has expired / voided /
   has been completed and can no longer be accessed" → `needs: 'expired'`.
3. Download. For completed envelopes the toolbar has a download icon; for
   in-progress ones it's under OTHER ACTIONS → Print & Download. Prefer
   **Separate PDFs** (a ZIP, one PDF per document, keeps DocuSign's document
   names which match what the agent files under for disclosures); fall back to
   **Combined PDF**. Capture with `page.waitForEvent('download')`, read bytes,
   unzip with `fflate` when the download is a ZIP. Name files from the ZIP
   entries, or from `download.suggestedFilename()`.
4. Then **Finish Later** / close. Never anything else.
5. Selectors drift: locate by role/text first (`getByRole('button', { name: /download/i })`), data-qa second, with a short list of fallbacks per step
   and a screenshot before giving up. Log each step (`[fetch] docusign: consent → download(separate) → 4 files`).

### 2. Queue — migration `supabase/migrations/2026-10-12_inbox_fetches.sql`

```sql
create table if not exists inbox_fetches (
  id            uuid primary key default gen_random_uuid(),
  gmail_id      text references inbox_messages (gmail_id) on delete cascade,
  thread_id     text,
  url           text not null,
  url_sha256    text not null,
  provider      text not null,              -- 'docusign' | 'unknown'
  kind          text,                       -- the inbox_messages.kind that queued it, or 'manual'
  status        text not null default 'queued',  -- queued | running | done | failed | needs_code | needs_login | expired | duplicate
  access_code   text,
  attempts      int not null default 0,
  next_try_at   timestamptz,
  error         text,
  files         jsonb not null default '[]'::jsonb,   -- [{filename, mime, size, sha256, inbox_file_id}]
  screenshot    text,
  tg_message_id bigint,
  created_at    timestamptz not null default now(),
  started_at    timestamptz,
  resolved_at   timestamptz
);
create unique index if not exists inbox_fetches_url_once on inbox_fetches (url_sha256);
alter table inbox_fetches enable row level security;
alter table inbox_files add column if not exists source text not null default 'attachment';   -- 'attachment' | 'docusign' | 'manual'
alter table inbox_files add column if not exists fetch_id uuid references inbox_fetches (id) on delete set null;
```

`inbox_files.gmail_id` is NOT NULL with an FK — fetched files always hang off
the message that carried the link. For `fetch <url>` typed by Ryan with no
email, insert a synthetic `inbox_messages` row first (`gmail_id = 'manual:' + Date.now()`,
`kind = 'manual'`, `subject = 'fetch ' + hostname`) and reference it.

### 3. Worker wiring — `scripts/inbox-agent/index.mjs`

- **Link extraction:** `documentLinks(msg)` pulls `https?://` URLs from `msg.text`
  and matches providers (`detectProvider`). Start with DocuSign only
  (`*.docusign.net/Signing/EmailStart.aspx`, `*.docusign.net/Signing/`,
  `app.docusign.com/…`). Ignore `protect.docusign.net`, `support.docusign.com`,
  unsubscribe/footer links.
- **Enqueue** in `handleMessage` when `kind ∈ {docusign_request, docusign_completed, esign_completed}` **or** the classifier reports a document link (add
  `"document_links": [url, …]` to the classifier JSON in `llm.mjs` — "a link
  where the documents live: DocuSign/Authentisign envelope, Zix, Disclosures.io,
  Glide, Dotloop, ShareFile, Dropbox/Drive share of transaction documents";
  only enqueue the ones `detectProvider` knows). One row per distinct URL
  (`url_sha256` unique → `duplicate` instead of a second run). Replace the
  current "🖊 DocuSign completed … grab it from the DocuSign link" notice with the
  enqueue (the notice becomes the *failure* card).
- **`runFetches(ctx)`** — new step in `main()` right after `pollInbox` and before
  `resolveLoops`: take up to 3 rows with `status='queued' and (next_try_at is null or next_try_at <= now())`, mark `running`, call `fetchDocuments`, then:
  - **ok** → hand the files to the filing pipeline (next bullet), store `files`, `status='done'`, post the card.
  - **needs_code / needs_login / expired** → set that status, post the card.
  - **error** → `attempts++`, `next_try_at` = backoff, after 3 → `failed` + card.
  - Any thrown error → Telegram alert (Ryan's rule: no silent failures on things he initiated).
- **Filing refactor.** The per-attachment loop body in `handleMessage` (from
  `relevantAttachments` through `postFiledConfirmation`) becomes
  `fileDocuments(ctx, msg, cls, docs, { source })` where
  `docs = [{ filename, mime, size, attachmentId?, bytes? }]`.
  `recordAttachment` takes `att.bytes` when present instead of calling
  `getAttachmentBytes`, and writes `source` + `fetch_id`. `relevantAttachments`'s
  filters (logos, size caps, `cls.attachments[].relevant`) still apply to the
  attachment path; fetched docs skip the "classifier said irrelevant" check but
  still go through `refineDocType` → `filingDecision` → `verifyProperty`. Both
  paths must produce identical `inbox_files` rows apart from `source`.
  `--dry-run --message=<id>` must still work and must also dry-run the fetch
  (log the steps, download to `/tmp`, no DB writes, no Drive upload).
- **Cards** (`tgSend` needs **URL buttons**: extend `telegram.mjs` so a row
  button may be `{ text, url }` → `{ text, url }` in `inline_keyboard`, or
  `{ text, data }` as today):
  - success: header `📥 Pulled 4 documents from DocuSign — “93 Ridgeview Ave - Disclosures”` then the normal filed-confirmation lines; buttons `[🖊 Open in DocuSign (url)]` on request envelopes, none on completed.
  - needs_code: `🔐 DocuSign wants an access code for “…”. Reply to this card with  code: 1234  and I'll pull the documents.` + `[Open in DocuSign (url)]`. Store `tg_message_id` so the reply routes.
  - needs_login / expired / failed: `⚠️ Couldn't pull the documents from DocuSign (<reason>) — open the link.` + `[Open (url)] [🔁 Retry → ix:fr:<uuid>]`.
- **Loop bug (fix in the same branch).** The Ridgeview card Ryan still sees on
  2026-10-12 comes from loop `25a67d93-3038-48e2-8809-15460b16a190`, created
  **by the Completed email** (`kind=docusign_completed`, classifier set
  `needs_reply=true`), so the agent nags him to sign something he already
  signed. Rule: `docusign_completed` / `esign_completed` never reach
  `upsertLoop`, and `resolveSignatureLoops` also closes loops whose
  `normalizeEnvelope(subject)` matches after stripping a leading
  `completed:`. Add a one-off `scripts/inbox-agent/oneoff/oneoff-2026-10-12-close-completed-loops.mjs`
  that marks open `category='signature'` loops whose subject starts with
  `Completed:` as `resolved_by_event` (dry-run default, `--apply`).

### 4. Telegram side — `lib/inboxAgent.ts`

- `findInboxByTgMessage` also checks `inbox_fetches.tg_message_id` → `{ kind: 'fetch', id, status, gmail_id, thread_id }` (add to `InboxRef`).
- `recordInboxReply` case `fetch`: `code: 1234` / `access code 1234` / a bare 4–10 digit string → store `access_code`, `status='queued'`, `attempts=0`, reply "🔁 Got the code — pulling the documents on the next pass (≤5 min)". `retry` → requeue.
- Reply **`fetch`** on *any* card that has a `gmail_id` (loop, file, batch, screen, draft) → enqueue every document link found in that message (the webhook can read the message via `fetchInboxMessage`; reuse `detectProvider` — export it from a tiny shared module that both the `.mjs` worker and the `.ts` webhook can import, e.g. `scripts/inbox-agent/fetch/providers.mjs` with a `.d.ts` or a duplicated pure TS copy under `lib/inboxFetchProviders.ts` with one shared test fixture; pick the simplest thing that typechecks). Reply "📥 Queued — pulling the documents on the next pass."
- Command **`fetch <url>`** → synthetic message row + enqueue. Command **`fetch`** alone → list the last 10 fetches with status.
- Callback `ix:fr:<uuid>` → requeue (attempts=0). Add `fetch` lines to `HELP`.
- Nothing in `lib/` ever launches a browser — Vercel only writes queue rows.

### 5. Tests (vitest, `scripts/inbox-agent/fetch/*.test.mjs` or under `tests/`)

- `detectProvider` on the real link shapes above (+ footer links that must be ignored).
- Click allowlist: every refused pattern, every allowed label.
- ZIP → files (build a tiny zip in the test with `fflate`).
- `documentLinks(msg)` on a fixture modelled on the Ridgeview Completed email.
- Loop fix: a `docusign_completed` message creates no loop; `resolveSignatureLoops` matches `Completed: Please Sign: X` against `Please Sign: X`.

### 6. Hand-off notes for the bridge session (write these at the top of your final report)

- Files touched, the migration path, whether `npm install` is needed.
- Exact manual test: `node scripts/inbox-agent/fetch/cli.mjs --url "<EmailStart link from gmail 1a1135bbe462b5b1>" --out /tmp/ridgeview` then `node scripts/inbox-agent/index.mjs --dry-run --message=1a1135bbe462b5b1`.
- Anything you could not verify without the mini.

## Out of scope (later phases, don't build)

Disclosures.io / Glide (email one-time-code login using the agent's inbox access), Zix portal, Authentisign, SMS codes via the chat.db sidecar, a `--login` headed helper for the persistent profile.

---

## Phase 1b (2026-10-12, after the first live run) — expired email links

**What the mini found:** DocuSign email links **expire** (the 10/06 Ridgeview
Completed link was dead six days later). The expired page
(`/tmp/inbox-fetch/cli-…/02-expired.png`) shows "This link from your email has
expired" with two buttons: **SEND NEW LINK** ("Docusign will send a fresh link
to your email address") and **LOG IN**. The fresh link lands in ryan@ — the
mailbox the agent reads — so the agent can get itself a working link.

Build, same files as Phase 1:

1. `docusign.mjs`: when the `expired` gate shows a **Send New Link** button,
   click it (add `/^send new link$/i` to `CLICK_ALLOW`; it sends an email, nothing
   else), screenshot, and return `{ ok: false, needs: "new_link" }`. If the
   expired page has no such button, keep `needs: "expired"`.
2. Worker: `needs: "new_link"` → `inbox_fetches.status = 'awaiting_new_link'`,
   `error = 'asked DocuSign for a fresh link'`, **no Telegram card**. The fresh
   email is a normal DocuSign message: it is classified, its link is a new
   `url_sha256`, it is enqueued and fetched like any other. When that later job
   for the **same thread_id or normalized envelope subject** reaches `done`,
   mark the `awaiting_new_link` job `resolved_by_new_link` (free-text status,
   no migration). A job still `awaiting_new_link` after **2 hours** gets the
   usual ⚠️ card (one, then `failed`). Never click Send New Link twice for the
   same envelope within 24 h (the `awaiting_new_link` row is the guard).
3. The ⚠️ expired/failed card: drop the "Open" URL button when the link is the
   expired one (it is useless) — keep only 🔁 Retry, and say "ask the sender to
   resend, or log the agent into DocuSign".
4. **`--login` helper** (`fetch/cli.mjs --login --headed`): opens
   `https://account.docusign.com` in the persistent profile and waits (up to
   10 min) for the URL to leave the login flow, then exits. Ryan runs it once
   on the mini over screen share; after that `app.docusign.com` links and
   expired-link recovery via LOG IN both work. Document in the file header.
5. Tests: allowlist accepts "Send New Link"; a fixture of the expired page text
   → `gateFromText` = `expired`; the awaiting → resolved transition.

The live worker already runs Phase 1 on the mini (`main` 087806a, migration
applied 2026-10-12). Keep the diff minimal and leave `fileDocuments` alone.
