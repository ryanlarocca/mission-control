Status: built + reviewed 2026-10-17 — awaiting migration + merge to main

You are building a self-contained change to the Inbox Agent (the ryan@lrghomes.com Gmail watcher) in this Next.js repo. Work on a new branch `inbox-loop-hygiene` off `main`, commit in small conventional commits, and push the branch with `git push -u origin inbox-loop-hygiene`. Do NOT open a PR, do NOT touch `main`, never `git add -A`. You have no access to the production Supabase, Gmail, Drive or Telegram: everything you ship must be covered by vitest unit tests with fixtures (`npm test` = `vitest run`) and `npx tsc --noEmit` must pass. The migration and live checks will be run by the operator on the Mac mini afterwards, from your HANDOFF section.

First, save this entire brief verbatim as `briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md` (replace the status line at the top with `Status: built + reviewed 2026-10-17 — awaiting migration + merge to main`) and commit it. Then read, in this order, before writing code: `briefs/BRIEF_INBOX_AGENT_2026-09-24.md`, `briefs/BRIEF_INBOX_VENDOR_FILING_TAPINSPECT_2026-10-16.md`, `scripts/inbox-agent/{loops,env,llm,filing,drive,gmail,vendors,index}.mjs`, `scripts/inbox-agent/fetch/{providers,index}.mjs`, `tests/inbox-tapinspect.unit.test.ts`, `tests/inbox-vendor-filing.unit.test.ts`, `supabase/migrations/2026-09-24_inbox_agent.sql`. Match the existing style: pure helpers in small modules that both the worker and tests import (`loops.mjs` is the home for everything in Parts A–F), config in `inbox_settings` via `getSetting/setSetting`, Telegram conventions already in `index.mjs` (`ix:` namespace). Keep `index.mjs` changes to thin call sites.

# Background (diagnosed with Ryan 2026-10-17)

The morning brief (`maybeDigest` in `index.mjs`) listed 7 items under "Waiting on you", 3 under "Unanswered" and 3 filing proposals. Ryan: only ONE was really his (sign the Halleck disclosures); one more is waiting on the other party (Amanda has to get South Bay Termite to release the report); everything else had already been handled, and the mailbox + the agent's own filings contained the evidence. Every miss below is a real sequence from 2026-10-12 → 10-16 — model your fixtures on them (gmail ids given so the operator can replay).

1. **Loops created after Ryan had already replied.** A vendor-filing replay on 10-16 at 23:50 UTC re-processed two older emails and minted loops for them: HomeSentry "Inspection results for 5764 Halleck Dr" (msg `1a14056ab449524c`, received 10-15 16:13; Ryan replied "Paid" on that thread 10-16 20:40 — sent msg `1a146719cfe7f101`) and Juan Muniz "RE: NOO Absentee Q4" (msg `1a14686438fae4d0`, received 10-16 21:02; Ryan replied 10-16 22:12 — sent msg `1a146c635191327f`). `resolveLoops` only closes a loop when a sent message is NEWER THAN `loop.created_at`, so a reply that predates the (late) loop row never counts.
2. **Replies on a different thread don't count.** Juan's "RE: Soft quote absentee list" (thread `1a0f98d70a4c7d1b`, last inbound 10-13 19:24) stayed "Unanswered" although Ryan wrote to juan@letterprinting.net three times on the newer "NOO Absentee Q4" thread (`1a136cb10adfd480`) on 10-14/15/16. Both the digest's loose-end check and `resolveLoops` key on `thread_id` only.
3. **Vendor completion events close nothing.** HomeSentry (`inspections@tapinspect.com`) sent "Thank you for your payment" (`1a14674c084ab8c7`, body: "We have received your payment for the inspection of 5764 Halleck Dr, San Jose, CA 95123") and "Inspection results for 5764 Halleck Dr … have been updated" (`1a146754b76d30a8`), and the agent itself FILED the report (`Properties/5764 Halleck Dr/Inspections/… (HomeSentry).pdf`). Yet "Please sign agreement" (`1a1317578e6f00b5`, 10-12, Halleck share uuid `d50c5c43-83cb-4f15-aac0-8e0cdf25de18` in the body) stayed Unanswered and the results loop stayed open. Today only DocuSign/eSign "Completed" emails close loops (`resolveSignatureLoops`).
4. **One ask, three loops.** For 2116 Quito Rd, HomeSentry's booking email (`1a145be09c1aae90`, "Inspection of 2116 Quito Rd, San Jose, CA 95130"), HomeSentry's "Please sign agreement" (`1a145be12eff4a08`, share uuid `78a00aee-dcfc-4ed0-9d2d-8d78319142e4`) and Amanda Bakshi's forward of the booking (`1a145bee1ca7d82e`, "Fwd: Inspection of 2116 Quito Rd…", from amanda@bakshirealestate.com) arrived within 10 seconds and each opened its own loop. `upsertLoop` dedupes by `thread_id` only (plus envelope subject for signatures).
5. **FreshBooks.** "Kowi Chandra commented on invoice 080223UP ($2,985.00)" (`1a135f9e00ed5f51`, 10-13 15:55, from mail@fb02.freshbooks.com) was classified `human` / `needs_reply`. Six hours later "Kowi Chandra commented on invoice 080223UP ($0.00)" (`1a13712751de3137`, body "Thank you for your payment") arrived. The first stayed Unanswered. Replies to FreshBooks notification addresses go nowhere, and the zero balance IS the resolution.
6. **No "waiting on them" bucket.** Amanda's "Fwd: Termite Inspection Report | 5764 Halleck Dr" (`1a1455ab4b1bc7ef`) became "Pay $300 … so South Bay Termite can release the report" under Waiting on you. Ryan: the ball is in Amanda's court. The classifier has no field for who holds the next action.
7. **Filing proposals for files already in Drive.** Dominic Wooten's re-scrubbed lists (`1a13633c418fce81` 10-13 and `1a13b13d4d5f6497` 10-14, three CSVs `ALL Santa Cruz Co / ALL SC Co / ALL SM Co NOO SFR 11+ yr.csv`, 2,452,735 / 13,641,311 / 4,401,051 bytes) sat as pending proposals for 3–4 days. The identical bytes had been uploaded by hand on 10-14 into `Marketing/2026/NOO October2026/Raw…` as `v2 2026-10-14 - <name>.csv` (Drive ids `1CB99tecfNMh4lxzALcl8arU42bX6vat0`, `1hknhStNli99VC2Yrw8YcgdL9rvbewwDF`, `1_SSfKvya7H7sGBK0byUhVPuEg8RKC5dc`). Dedupe (`recordAttachment` in `index.mjs`, ~line 510) only checks `inbox_files.sha256`, i.e. files the agent itself filed. Drive is never consulted.

The operator has already hand-closed the 10-16/10-17 rows (5 loops → `resolved_by_reply`/`done`, 3 CSV rows → `duplicate`, 3 threads → `agent.unanswered_dismissed`). Your job is to make the agent do that itself.

# Part A — resolve against the email's date, not the loop's row date

- Migration `supabase/migrations/2026-10-17_inbox_loops_message_at.sql`: `alter table inbox_loops add column if not exists message_at timestamptz;` with a COMMENT ("internalDate of the email that opened/refreshed the loop; resolution compares sent mail against this, not created_at"). Backfill: `update inbox_loops l set message_at = m.internal_date from inbox_messages m where m.gmail_id = l.gmail_id and l.message_at is null;`. RLS is already on for this table; don't touch it.
- `upsertLoop`: write `message_at: msg.internalDate` on insert AND on the refresh-update path.
- `resolveLoops`: a sent message on the thread counts when `sent > (loop.message_at || loop.created_at)`. Pure helper `replyResolves(loop, sentAt)` in `loops.mjs`, tested with the Halleck and Juan timings above (reply 20:40 vs loop row 23:50 → resolves; reply before the email → does not).
- Widen the sent-mail lookup in `resolveLoops` from 4 days to 8 so it matches the digest's window (`sentThreadsSince(ctx.gmail, 8)`); one shared constant.

# Part B — a reply to the same person counts, on any thread

- Extend `gmail.mjs sentThreadsSince` (or add `sentSince`) to also return a map `recipientEmail (lowercase) → latest sent internalDate`, from the To/Cc headers (use `format: "metadata", metadataHeaders: ["To","Cc"]`; parse addresses with a small pure helper, tested — display names, angle brackets, multiple recipients).
- Pure helper `answeredBy(item, { byThread, byRecipient })` in `loops.mjs`: an item (loop or loose-end message) is answered if Ryan sent on its thread after `message_at`, OR sent anything to its counterparty email after `message_at`. Counterparty email for a loop = `counterparty_email`; for a loose-end = the message sender. For FORWARDS (Part D) the counterparty is the forwarder, which is correct (Amanda's forward is answered when Ryan writes Amanda).
- Use it in both `resolveLoops` (status `resolved_by_reply`) and the digest's loose-end loop. Fixture: Juan's "Soft quote" thread + the three sends to juan@ on the other thread → not a loose end.

# Part C — vendor completion events close loops and loose ends

Generalize the 2026-10-12 lesson in `loops.mjs` ("a completion is an event that CLOSES a loop; it never opens one") beyond DocuSign:

- `completionEvent(msg, cls)` → `null | { kind, vendor, property, invoice, shareId }`:
  - HomeSentry/tapinspect (sender `@tapinspect.com`): subject `/^thank you for your payment/i` → `kind: "paid"`, property = address parsed from the body ("payment for the inspection of <address>." — reuse `addressIn` / the address parsing in `fetch/index.mjs`); subject `/inspection results for (.+) have been updated/i` → `kind: "updated"`, property from the subject. A tapinspect share uuid in the body, if any, goes in `shareId`.
  - FreshBooks (sender `@freshbooks.com`): subject `/commented on invoice (\S+) \(\$0\.00\)/i` or body `/thank you for your payment/i` → `kind: "paid"`, `invoice`.
  - A FILED inspection report is also a completion: when the fetch/filing path marks an `inbox_files` row `filed` with `doc_type: "inspection"` and a `property_label`, emit `{ kind: "report_filed", vendor: "tapinspect", property }`. Hook at the single place the tapinspect fetch outcome is written (`runFetchJob` → filed outcomes in `index.mjs` ~line 1425–1445).
  - These events are NEVER loop-eligible: add their kinds/subjects to the `loopEligible`/completion gate so a payment receipt can't open a loop (today "Thank you for your payment" would be classified and could become one).
- `completionCloses(event, loop)` → boolean. A loop closes when: same vendor family (loop `counterparty_email` domain, OR the loop subject/ask contains the property address, OR the loop's `gmail_id` message body contains the same share uuid — pass the loop's message text in via a lookup you define) AND the property matches (`propertyKey` from `filing.mjs` on the loop's subject/ask vs the event's property), OR invoice number matches. For tapinspect events, close every open/snoozed/acknowledged loop for that property whose counterparty is tapinspect OR whose subject matches `/inspection/i` and the address — this covers Amanda's forward of the booking too. Status `resolved_by_event`, `tgClearButtons` if a card exists.
- Loose ends: the same event dismisses matching Unanswered threads. Reuse the existing `agent.unanswered_dismissed` map (thread_id → ISO) so the digest filter needs no new logic; write the thread ids of every `inbox_messages` row from the same vendor domain in the previous 10 days that matches the property (via `classification.property.label`, address in subject, or share uuid in `inbox_fetches.url` for that thread) or the invoice number.
- Tests on the real sequences: Halleck ("Please sign agreement" 10-12 + results loop + payment receipt + updated email + filed report → everything closed); Quito (nothing closes until a Quito receipt arrives); FreshBooks (080223UP $2,985 → $0.00 closes it; a different invoice number does not).

# Part D — one ask, one loop

- `loopKey(msg, cls)` in `loops.mjs`: `${vendorFamily}|${propertyKey}|${askKind}` where `vendorFamily` = the sender domain, OR for a forward (`/^fwd?:/i` subject) the domain of the original sender found in the quoted header (`From: … <x@y>`), falling back to the forwarder; `propertyKey` from the address in subject/body/`cls.property.label`; `askKind` = `signature | payment | agreement | other` derived from the ask text (`/sign/`, `/pay|payment|invoice/`, `/agreement/`).
- `upsertLoop`: before inserting, look for an open/snoozed loop created in the last 48 h with the same `loopKey` (store `loop_key text` in the migration from Part A; index it). If found, refresh it (newest `gmail_id`, keep earliest `created_at`, keep `due_on` if the new one is null, priority high wins) instead of inserting. Keep the existing thread_id and signature-envelope matches as the first two checks.
- Test: the three Quito emails in arrival order → one loop, counterparty HomeSentry, due 2026-10-20; Amanda's forward refreshes it, never a second row. A genuinely different property on the same day (Halleck vs Quito) → two loops.

# Part E — notification relays are never "human emails with no reply"

- In the digest's loose-end filter the sender regex (`/noreply|no-reply|notification|docusign|authentisign/i`) gains `freshbooks\.com|tapinspect\.com|pandadoc|quickbooks|intuit\.com|bill\.com|invoicing|statements?@`. Make it a shared exported constant `RELAY_SENDER_RE` in `loops.mjs` with a test, and use it in both places that filter senders.
- FreshBooks comment emails still may open a loop (the ask is real: "pay invoice …"); Part C closes it on payment. They just never appear under Unanswered.

# Part F — "Waiting on them"

- Classifier (`llm.mjs` classify schema): add `"owed_by": "ryan" | "them" | null` — who holds the next action after this email. Terse prompt note: "them" when the sender/forwarder still has to do something before Ryan can act (get a report released, send a form, confirm a date); "ryan" when Ryan can act now. Default null → treated as ryan.
- Migration (same file as Part A): `alter table inbox_loops add column if not exists owed_by text;` (check `owed_by in ('ryan','them')`).
- `upsertLoop` stores it. Digest and the `open` command render loops with `owed_by = 'them'` under a separate `<b>Waiting on them (n)</b>` block after "Waiting on you" (same line format, prefixed by the counterparty). They are excluded from the "Waiting on you" count. Reply-based resolution (Parts A–C) applies to both buckets.
- Telegram: replying `theirs` / `mine` to a loop card flips `owed_by` (follow the existing `ix:ld`/`ix:lz` reply conventions in `lib/inboxAgent.ts` — keep it minimal: parse the two words in the existing reply handler for loop refs).

# Part G — filing proposals check Drive first

- `drive.mjs listChildren`: add `md5Checksum, size` to `fields`. Add `walkFolder(drive, folderId, { maxDepth = 4 })` returning every non-folder descendant with `{ id, name, size, md5Checksum, webViewLink, path }` (reuse `folderTree` patterns; cap at ~2,000 files; skip Google-native mime types which have no md5).
- `recordAttachment` (`index.mjs` ~line 510): after the sha256 lookup misses, and only for attachments that would otherwise become `pending`/`interview`/`waiting`/`approved`, compute md5 of the bytes and compare against `walkFolder` of (a) the proposed destination's root folder for Marketing docs (the `Marketing` extra root → `2026/<campaign folder>` subtree), (b) the property's folder for property docs (`propertyFolders` already resolves it), matching `size` first then `md5Checksum`. On a hit: status `duplicate`, `final_folder`/`final_name`/`drive_file_id`/`drive_url` from the existing file, `resolved_at` now, no Telegram card — it shows up in the brief's "Skipped as duplicates" line. Log `duplicate (drive): <name> = <existing path>`.
- Pure helper `driveDuplicateOf({ size, md5 }, files)` in `filing.mjs`, tested with the three Dominic CSVs vs a fixture tree that contains the `v2 2026-10-14 - …` names (hit) and a same-size-different-md5 decoy (miss).
- Cache the walk per run in `ctx` (one listing per root per pass).

# Part H — Ask once when the mailbox can't know

*(Addendum from the operator, Ryan 2026-10-17, relayed by a second Claude session after Parts A–G were built.)*

Ryan: "It may be hard for the system to deduce that I signed the HomeSentry inspection. When in doubt it can ask me, but some of these from this morning were ridiculous." Two rules fall out:

1. Evidence beats asking. Anything Parts A–C can settle from sent mail, vendor receipts, or the agent's own filed rows must NEVER be shown or asked about. That is the existing scope; this is just the priority order.

2. Portal-only asks get ONE question, not a daily re-list. Some asks can only be completed outside email (sign/pay in the tapinspect portal, a vendor's e-sign page, a FreshBooks pay link). Detect them as `resolution: "portal"` in loops.mjs (pure helper `resolutionKind(msg, cls)`: tapinspect `/please sign|agreement|invoice/i`, FreshBooks/invoice pay links, any `cls.ask` matching `/sign|pay/` whose body carries a non-DocuSign action link; DocuSign requests stay as they are since Completed emails close them). For a portal loop with no completion event by the first brief after it opens (or by `due_on` minus 1 day if sooner), the brief lists it ONCE under a sub-heading `<i>Can't tell from email — did you handle these?</i>` with the existing per-loop card (✓ Done / 👀 Got it / ⏰ Snooze 2d; reuse the ix:ld / ix:la / ix:lz callbacks). Then set a new status `asked` (free-text column, no migration needed) with `snooze_until = null`. An `asked` loop is NOT re-listed in later briefs and NOT counted in "Waiting on you"; it still closes automatically on a completion event or a reply (Parts A–C), and reopens only if the vendor sends a reminder on the same loop_key (upsertLoop refresh path: `asked` → `open`). Include `asked` in every status list Parts A–D touch (resolve/complete/dedupe) and in the `open` Telegram command as a separate "Asked you about:" line. Tests: Quito sequence with no receipt → listed once, becomes `asked`, absent from the next digest; a Quito "Thank you for your payment" afterwards → resolved_by_event; a HomeSentry "Quick Reminder" for Quito → reopened.

# Non-goals

- No changes to how DocuSign/eSign completions already work (`resolveSignatureLoops`, `envelopeMatches`) beyond routing them through the same `completionEvent` shape if that simplifies.
- No new Telegram alerts. Loops stay silent (`loop_alerts` off) and surface in the brief. (Part H's one question rides the existing per-loop cards posted after the brief — not a new alert.)
- No UI (Next.js app) changes.
- Part H: a portal ask is never re-listed once asked — evidence (Parts A–C) always beats asking.

# Definition of done

- `npm test` green with new files `tests/inbox-loops.unit.test.ts` (Parts A–F, H) and additions to `tests/inbox-vendor-filing.unit.test.ts` or a new `tests/inbox-drive-dedupe.unit.test.ts` (Part G). `npx tsc --noEmit` passes.
- A dry run of the digest against the fixtures above would list exactly: Waiting on you (1) — Sign: 5764 Halleck Dr San Jose - Disclosures; Waiting on them (1) — Amanda Bakshi / South Bay Termite; no Unanswered; no filing proposals.
- Part H: with no Quito receipt in the fixtures, the Quito loop shows only on its FIRST appearance (under "Can't tell from email — did you handle these?"), is `asked` afterwards, and is absent from the next digest.
- `briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md` committed with the updated status line.

# HANDOFF (write this section at the end of the brief file when you finish)

List: the migration file to apply; the exact `git` merge steps (fast-forward `inbox-loop-hygiene` into `main`, then `git -C /Users/ryanlarocca/Projects/PROJECTS/mission-control pull --ff-only`); the live checks for the operator (run the worker once with `--dry-run` on the Halleck, Quito, Juan and FreshBooks gmail ids above and confirm the log lines "loop resolved by completion" / "duplicate (drive)"); anything you could not cover with tests and why.

---

## HANDOFF (for the operator on the Mac mini)

Built on branch `inbox-loop-hygiene` (cloud session, 2026-10-17). `npm test` = 520 passing (32 new: 28 in `tests/inbox-loops.unit.test.ts`, 4 in `tests/inbox-drive-dedupe.unit.test.ts`), `npx tsc --noEmit` clean. Nothing live was touched: no migration run, no Gmail / Drive / Supabase / Telegram calls. Part H (the operator's addendum, relayed by a second Claude session after A–G were built) is included: verify the addendum is Ryan's before merging — it is easy to drop (`git revert` of the Part H commit) if not.

### 1. Migration (apply first, once)

```
node scripts/run-migration.mjs supabase/migrations/2026-10-17_inbox_loops_message_at.sql
```

Idempotent. Adds `inbox_loops.message_at` (backfilled from `inbox_messages.internal_date` by `gmail_id`), `inbox_loops.loop_key` (+ partial index), `inbox_loops.owed_by` (check `ryan | them`), `inbox_loops.resolution` (check `portal | email`, Part H), and rewrites the `status` column comment (`asked` added). Check:

```sql
select count(*) total, count(message_at) with_message_at from inbox_loops;   -- the gap = loops whose gmail_id is not in inbox_messages (they fall back to created_at)
select column_name from information_schema.columns where table_name = 'inbox_loops' and column_name in ('message_at','loop_key','owed_by','resolution');  -- 4 rows
```

The worker runs without the migration only until the first `upsertLoop` insert, which writes the three new columns — apply it before merging.

### 2. Merge

```
cd /Users/ryanlarocca/Projects/PROJECTS/mission-control
git fetch origin inbox-loop-hygiene
git checkout main
git merge --ff-only origin/inbox-loop-hygiene
git push origin main
git -C /Users/ryanlarocca/Projects/PROJECTS/mission-control pull --ff-only
```

Vercel redeploys `main`; `lib/inboxAgent.ts` now imports `scripts/inbox-agent/loops.mjs` (which imports `env.mjs` — plain ESM, `@supabase/supabase-js` is already a dependency). Confirm the deploy is green, then in Telegram type `open`: a "Waiting on them" block appears once any loop has `owed_by = 'them'`.

### 3. Dry runs (no DB writes, no Drive upload, no Telegram; Drive is READ for the dedupe walk; a tapinspect link still fetches inline into `/tmp/inbox-fetch/`)

| Gmail id | What | Command | Expected log lines |
|---|---|---|---|
| `1a14674c084ab8c7` | Halleck "Thank you for your payment" | `node scripts/inbox-agent/index.mjs --dry-run --message=1a14674c084ab8c7` | `completion event: tapinspect paid · 5764 Halleck Dr`; then one `loop resolved by completion (tapinspect paid · 5764 Halleck Dr): <id> (…)` per still-open Halleck HomeSentry loop and `unanswered dismissed by completion (tapinspect paid): <thread> (…)` per matching tapinspect thread not already in `agent.unanswered_dismissed`. Since the 10-16/10-17 rows were hand-closed/dismissed, both lists may be empty — the `completion event:` line is the proof the email is recognised. If the classifier says needs_reply, also `no loop: tapinspect paid is a completion event`. |
| `1a146754b76d30a8` | Halleck "results … have been updated" | `node scripts/inbox-agent/index.mjs --dry-run --message=1a146754b76d30a8` | `completion event: tapinspect updated · 5764 Halleck Dr · share d50c5c43…` (the share uuid from the body). The inline dry fetch then runs as before; when it would file the report you also get `loop resolved by completion (tapinspect report_filed · 5764 Halleck Dr): …` for any open Halleck loop. |
| `1a1317578e6f00b5` | Halleck "Please sign agreement" | `node scripts/inbox-agent/index.mjs --dry-run --message=1a1317578e6f00b5` | `loop: <ask> (normal · ryan · tapinspect.com|5764halleck|signature)` — the loop_key with the property taken from the classifier (the subject has no address). Not a completion. |
| `1a145be09c1aae90` → `1a145be12eff4a08` → `1a145bee1ca7d82e` | Quito booking, agreement, Amanda's forward | three `--dry-run --message=…` runs in that order | each logs `loop: … (… · tapinspect.com|2116quito|signature)` — the SAME key for all three (Amanda's forward keys to tapinspect.com via the quoted `From:` header). A dry run inserts nothing, so "would refresh <id> (same key)" appears only if a live open Quito loop exists. To see the dedupe live, replay the three live (next section) and check `select count(*) from inbox_loops where loop_key = 'tapinspect.com|2116quito|signature' and status in ('open','snoozed');` → 1. |
| `1a1455ab4b1bc7ef` | Amanda's termite forward | `node scripts/inbox-agent/index.mjs --dry-run --message=1a1455ab4b1bc7ef` | `loop: Pay $300 … (normal · them · southbaytermite@yahoo.com|5764halleck|payment)` if Haiku sets `owed_by: "them"` (prompt note: the forwarder still has to do something). If it says `ryan`, reply `theirs` on the loop card once live. The key's vendor family is South Bay Termite, so Halleck HomeSentry events never touch it. |
| `1a14686438fae4d0` | Juan "RE: NOO Absentee Q4" (ITI invoice 243496) | `node scripts/inbox-agent/index.mjs --dry-run --message=1a14686438fae4d0` | the vendor filing lines as before, then `loop: … (… · letterprinting.net||payment)`. Live, the same pass's `resolveLoops` closes it: `loop resolved by reply (same thread): <id>` — Ryan's 22:12 reply is newer than the email's 21:02 `message_at`, however late the row was minted. |
| `1a13712751de3137` | FreshBooks "… 080223UP ($0.00)" | `node scripts/inbox-agent/index.mjs --dry-run --message=1a13712751de3137` | `completion event: freshbooks paid · invoice 080223UP`; `unanswered dismissed by completion (freshbooks paid): <thread of 1a135f9e00ed5f51>` unless that thread is already in `agent.unanswered_dismissed`; `no loop: freshbooks paid is a completion event`. `1a135f9e00ed5f51` itself still logs `loop: Pay … (… · fb02.freshbooks.com|5764halleck|payment)` and never appears under Unanswered (relay sender). |
| `1a13633c418fce81`, `1a13b13d4d5f6497` | Dominic's re-scrubbed CSVs | `node scripts/inbox-agent/index.mjs --dry-run --message=1a13b13d4d5f6497` | three `duplicate (drive): ALL … NOO SFR 11+ yr.csv = Marketing/2026/NOO October2026/Raw…/v2 2026-10-14 - ALL … NOO SFR 11+ yr.csv` lines, then the usual `duplicate: <name> (matches <drive id>)` from the pipeline, no proposal card. Requires `inbox_settings.drive.extra_roots.marketing` (set by `findExtraRoots` on every pass) so `Marketing/2026` resolves; if the walk finds nothing you get the old pending proposal instead — check `node scripts/inbox-agent/index.mjs --drive-check` shows `Marketing/` in the tree. |
| digest | the brief as it would print | `node scripts/inbox-agent/index.mjs --dry-run --no-poll --no-events --digest-now` | the `---- TELEGRAM (dry run) ----` block: `Waiting on you (n)`, then `<i>Can't tell from email — did you handle these?</i>` for open portal asks not yet asked (Part H; a dry run does not mark them `asked`), then `Waiting on them (n)` when any open loop has `owed_by = 'them'`, `Unanswered` only for human threads that pass `isLooseEnd` (no relays, replies to the same person count). Against today's live rows (hand-closed) expect Waiting on you = the Halleck disclosures envelope, nothing Unanswered. |
| Part H live | the one question, then silence | after the Quito live replay below, let the 7:30 brief run (or `--digest-now` live) | the Quito loop appears once under the ask heading with a ❔ card (✓ Done / 👀 Got it / ⏰ Snooze 2d), log `loop asked once (portal): <id>`, row status `asked`. The next brief does not list it; `open` in Telegram shows it under "Asked you about". A later HomeSentry reminder for Quito logs `loop reopened (same key)`. |

### 4. Live replays (in this order, after the migration + merge)

```
node scripts/inbox-agent/index.mjs --message=1a145be09c1aae90      # Quito booking → 1 loop (key tapinspect.com|2116quito|signature)
node scripts/inbox-agent/index.mjs --message=1a145be12eff4a08      # agreement → "loop refreshed (same key)", still 1 row
node scripts/inbox-agent/index.mjs --message=1a145bee1ca7d82e      # Amanda's forward → refreshed again, counterparty stays HomeSentry, due 2026-10-20
node scripts/inbox-agent/index.mjs --message=1a13712751de3137      # FreshBooks $0.00 → dismisses the 080223UP thread (no loop)
node scripts/inbox-agent/index.mjs --message=1a13b13d4d5f6497      # Dominic → 3 inbox_files rows status duplicate with drive_file_id = the v2 copies
```
Note the Quito loop does NOT close on Ryan's "Paid" to inspections@tapinspect.com (10-16 20:40, about Halleck): a property-keyed loop only closes on a reply on its own thread, a completion for its property, or Part H (operator tightening 2026-10-17, see §5). Expect it under "Can't tell from email — did you handle these?" at the next brief, once.

### 5. Judgement calls and what is not covered by tests

- **Same-person replies do NOT close across properties (operator tightening, 2026-10-17).** As built, `answeredBy` counted any send to the counterparty after the email, so one "Paid" to HomeSentry about Halleck also closed the Quito ask. The operator tightened it before merging: a loop whose `loop_key` carries a property only closes on a reply on its own thread (or a completion / Part H). Property-less loops (Juan's `letterprinting.net||payment`) and Unanswered threads keep the same-person rule. `resolveLoops` now selects `loop_key` for this.
- **Completion matching is narrower than the brief's literal "subject matches /inspection/i and the address".** Applied literally, the Halleck HomeSentry receipt would have closed Amanda's "Fwd: Termite Inspection Report | 5764 Halleck Dr" (South Bay Termite) and a DocuSign "Please Sign: 2116 Quito Rd - Inspection Contingency Removal". `completionMatch` therefore (a) treats the vendor family of a forward as the quoted `From:` domain (`loop_key`), (b) excludes termite / WDO / pest / contingency asks and e-sign relay senders from the inspection rule. Tests cover all three.
- **`loop_key` dedupe needs a property.** `letterprinting.net||payment` (Juan, no property) never merges with another property-less Juan ask; the key is still stored for completion matching.
- **Loose-end dismissal reads no Gmail bodies.** It uses the row's subject, `classification.property.label` / `ask`, the invoice number and `inbox_fetches.url` share uuids on the thread (last 30 days). Loop closing does read the loop email's body from Gmail, but only for an event that carries a share uuid and only when the cheaper signals did not decide (cached per pass).
- **Sent-mail cost.** `sentSince` reads up to 300 sent messages over 8 days with `format: "metadata"` once per pass (`ctx.sent`); before, resolveLoops read 4 days and the digest another 8 on digest days. Header shapes (`To`/`Cc` with display names) are covered by `parseAddressList` tests, not against live Gmail.
- **Drive walk cost.** One `walkFolder` of `Marketing/<year>` (depth 4, ≤ 2,000 files) per pass when a marketing list arrives, and one of the property folder (depth 3) when a whitelisted property document arrives; both cached on `ctx`. A walk failure is logged and the sha-only behaviour continues.
- **Classifier `owed_by`.** Prompt-only; default null → `ryan`. Not testable here. `theirs` / `mine` on the card is the manual override and a later email never undoes it unless the classifier says `ryan`/`them` explicitly.
- **"Both places that filter senders."** The worker had one sender filter (the digest's loose-end loop); `RELAY_SENDER_RE` is used there via `isLooseEnd`. The poll-time `AUTOMATED_RE` is a different gate (drops the whole email) and was left alone.
- **DocuSign completions** still go through `resolveSignatureLoops` / `envelopeMatches` unchanged (non-goal).
- **Part H timing.** "By the first brief after it opens, or `due_on` − 1 day if sooner": loops are silent outside the brief (non-goal: no new alerts), so the question is only ever raised at a brief — `shouldAskPortal` is true for every open portal ask at brief time, and the `due_on` clause only matters for a loop that opens after today's brief and is due tomorrow (it is then asked at tomorrow's brief, same as without the clause). `resolution` is a new column in the same migration (the addendum said "no migration needed" for the `asked` STATUS, which is free text; the resolution kind needs somewhere to live). An `asked` loop is matched by `loop_key` at any age, not just 48 h, so a vendor reminder weeks later reopens it rather than opening a second row.
- **Vercel bundle.** `lib/inboxAgent.ts` → `loops.mjs` → `env.mjs` (reads `.env.local` if present, defines `sb()` lazily). Verify the first production deploy after the merge builds; if the bundler objects to `env.mjs`'s `import.meta.url`, inline `splitLoops` / `owedByFromReply` in the TS file.
