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

# Non-goals

- No changes to how DocuSign/eSign completions already work (`resolveSignatureLoops`, `envelopeMatches`) beyond routing them through the same `completionEvent` shape if that simplifies.
- No new Telegram alerts. Loops stay silent (`loop_alerts` off) and surface in the brief.
- No UI (Next.js app) changes.

# Definition of done

- `npm test` green with new files `tests/inbox-loops.unit.test.ts` (Parts A–F) and additions to `tests/inbox-vendor-filing.unit.test.ts` or a new `tests/inbox-drive-dedupe.unit.test.ts` (Part G). `npx tsc --noEmit` passes.
- A dry run of the digest against the fixtures above would list exactly: Waiting on you (1) — Sign: 5764 Halleck Dr San Jose - Disclosures; Waiting on them (1) — Amanda Bakshi / South Bay Termite; no Unanswered; no filing proposals.
- `briefs/BRIEF_INBOX_LOOP_HYGIENE_2026-10-17.md` committed with the updated status line.

# HANDOFF (write this section at the end of the brief file when you finish)

List: the migration file to apply; the exact `git` merge steps (fast-forward `inbox-loop-hygiene` into `main`, then `git -C /Users/ryanlarocca/Projects/PROJECTS/mission-control pull --ff-only`); the live checks for the operator (run the worker once with `--dry-run` on the Halleck, Quito, Juan and FreshBooks gmail ids above and confirm the log lines "loop resolved by completion" / "duplicate (drive)"); anything you could not cover with tests and why.
