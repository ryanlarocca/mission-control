# Adding a new email mailbox to the lead pipeline

When a new direct-mail campaign drops with a new email address (e.g. `ryansvk@lrghomes.com`), this is how to wire it up so leads sent to that mailbox flow into Mission Control.

## TL;DR

1. **Create the mailbox in Google Workspace Admin** (manual — there's no API for this without a heavier admin-SDK setup).
2. **Run the CLI:**
   ```bash
   cd /Users/ryanlarocca/Projects/PROJECTS/mission-control
   node scripts/add-email-mailbox.mjs ryansvk@lrghomes.com SVK-C --dry-run   # preview + DWD token proof, writes nothing
   node scripts/add-email-mailbox.mjs ryansvk@lrghomes.com SVK-C
   ```
3. **Deploy:**
   ```bash
   npx vercel deploy --prod
   ```
4. **Send a probe email** to the new mailbox from any external address. Confirm a row appears in the Supabase `leads` table within ~10 seconds with `source = SVK-C`.

That's it. The Mac mini renewal cron picks up the new mailbox on its next 09:00 run automatically — no plist edit, no script edit.

## What the CLI does

`scripts/add-email-mailbox.mjs <email> <campaign-label> [--dry-run]`:
1. Validates the email is on a Workspace-tenant domain: `@lrghomes.com`, `@lrghomesbuys.com` or `@lrghomesoffers.com` (`ALLOWED_DOMAINS` in the script). `--dry-run` stops after proving a DWD token mints for the mailbox — no config write, no watch.
2. Reads `config/email-campaigns.json`, adds the new entry, writes it back sorted.
3. Calls `gmail.users.watch` for the new mailbox against the existing Pub/Sub topic `lrg-gmail-leads`.
4. Prints next-step reminders.

It is idempotent — re-running with the same email is safe. The JSON entry is upserted and Gmail's watch is itself idempotent.

## Why the deploy is needed

The route at `app/api/leads/email/route.ts` imports `config/email-campaigns.json` at build time. Until you redeploy, the live route still has the old map and will reject notifications for the new mailbox with `[email] Notification for unmapped address: …`. The deploy is fast (~60–90s).

## Constraints / gotchas

- **Workspace-tenant domains only.** DWD on the lrghomes Workspace tenant is authorized for the `gmail.modify` scope. The grant is per *customer*, not per domain, so the secondary sending domains added 2026-09-01 (`lrghomesbuys.com`, `lrghomesoffers.com`) inherit it — verified 2026-09-03 with `node scripts/check-dwd-scopes.mjs` (tokens minted for all three mailboxes). A mailbox on any other domain won't auth and the CLI rejects it up-front. Adding a fourth domain = add it to `ALLOWED_DOMAINS` *after* the checker passes for a mailbox there.
- **Workspace mailbox must exist first.** The CLI calls `gmail.users.watch` against a real mailbox; if Google can't find the user, you get a `404 Not Found`. Create the mailbox in Admin before running the CLI.
- **`gmail.send` scope is NOT authorized** — only `gmail.modify` (re-confirmed 2026-09-03; `gmail.readonly` is also unauthorized). This is not a blocker: `messages.send` accepts `gmail.modify`, which is how the campaign engine and `/api/leads/email-reply` already send. Adding `gmail.send` would be least-privilege hygiene only. `node scripts/check-dwd-scopes.mjs` prints the exact Admin-console steps if Ryan ever wants to extend the grant.
- **Vercel CLI must be authenticated.** `vercel deploy --prod` runs against the existing project linked at `.vercel/project.json`. If you're running from a fresh checkout, run `npx vercel login` first.

## How the renewal stays current

- Gmail watches expire 7 days after registration.
- `~/Library/LaunchAgents/com.lrghomes.gmail-watch-renewal.plist` runs `node scripts/renew-gmail-watch.js` daily at 09:00 PT on the Mac mini.
- That script reads `config/email-campaigns.json` and re-registers the watch for *every* mailbox in the file, so adding a new one in step 2 above is enough — no plist change required.
- Logs: `/tmp/lrg-gmail-watch-renewal.log` and `/tmp/lrg-gmail-watch-renewal-err.log`.
- Manually trigger to test: `launchctl start com.lrghomes.gmail-watch-renewal`.

## Verifying it worked

After step 4 above, the lead should land in Supabase like this:

```
source        SVK-C            ← matches the campaign label you passed
source_type   direct_mail
caller_phone  <extracted phone if present>
name          <parsed From-header name>
email         <sender's email>
ai_notes      <Haiku one-sentence triage summary>
suggested_reply <Haiku draft reply in Ryan's voice>
status        new | hot | cold | junk  ← AI's read on intent
```

Telegram should also fire an alert to the configured chat. If both are silent for 60+ seconds, see the troubleshooting section.

## Troubleshooting

If nothing lands in Supabase after sending a probe email:

1. **Was the email actually delivered?** Check the inbox in Gmail web. If the email isn't there, the problem is upstream of this pipeline (sender's outbox, Workspace routing).

2. **Did Pub/Sub fire?** Pull recent logs:
   ```bash
   npx vercel logs -d https://mission-control-three-chi.vercel.app --no-follow --since=5m -n 30 -x | grep "leads/email"
   ```
   You should see `[email] Pub/Sub notification — <email> (<campaign>) historyId:<n>`. If absent, the watch isn't registered. Run `launchctl start com.lrghomes.gmail-watch-renewal` and check `/tmp/lrg-gmail-watch-renewal*.log` for errors.

3. **Did the route fail downstream?** Look for `[email] Inserted email lead …` (success) or any `[email] … failed` / `Background processing threw` entries in the same log query.

4. **Is the campaign mapped?** Look for `[email] Notification for unmapped address: <email>` — means you haven't redeployed since adding the mailbox. Run `npx vercel deploy --prod`.

5. **Is the mailbox really on a tenant domain?** The CLI enforces `ALLOWED_DOMAINS`, but if someone bypassed it, the route's middleware whitelist + the route itself will both quietly drop the request. `node scripts/check-dwd-scopes.mjs <mailbox>` tells you in one call whether Google recognises the user and which scopes mint.

## Related files

- `scripts/add-email-mailbox.mjs` — the CLI
- `scripts/check-dwd-scopes.mjs` — read-only DWD scope × mailbox verifier (run before trusting a new domain)
- `scripts/setup-gmail-watch.js` — one-time topic + subscription setup (already done; only re-run after disaster recovery)
- `scripts/renew-gmail-watch.js` — daily cron target
- `config/email-campaigns.json` — single source of truth for the mailbox→campaign map
- `app/api/leads/email/route.ts` — the webhook endpoint
- `infrastructure/launchd/com.lrghomes.gmail-watch-renewal.plist` — Mac mini cron source-of-truth
- Architectural overview: `PROJECTS/lead-pipeline/PROJECT_MEMO.md`
