# LRG e-sign — spec + runbook

Built 2026-10-17/18 on the Mac mini. A lightweight DocuSign for Ryan's
purchase agreements: send → seller signs on their phone → completed PDF with
a Certificate of Completion is emailed to everyone and filed in Drive.

- Code: `esign/` in this repo (plain Node ESM, no build step).
- Data: `~/Projects/PROJECTS/esign/data/` (SQLite + per-envelope PDFs; outside
  the repo, gitignored by the `**/data/` rule in `~/Projects/.gitignore`).
- Public: `https://sign.lrghomes.com` → named Cloudflare Tunnel `esign` →
  `127.0.0.1:5877`. No router ports opened; Cloudflare terminates HTTPS.
- Email: Gmail API as `ryan@lrghomes.com` through the Workspace service
  account (`GOOGLE_SERVICE_ACCOUNT_KEY`, same as Mission Control). Plain +
  HTML, logo hosted on the signing domain.
- Alerts: Marketing bot → Ryan (`CAMPAIGN_BOT_TOKEN` / `TELEGRAM_CHAT_ID`).

## Flow

1. Ryan creates a request at `/admin/new` — pick a PDF from Drive
   `Business Operations/Offers/<street>/` (or upload one), title, property,
   agreement date, note, signers (name, email, phone, Seller/Buyer, order).
   The offer bot's "📁 Saved to Drive" message carries a **✍️ Send for
   signature** button that opens this page pre-filled (seller + Ryan as buyer).
2. Signers in the lowest order tier get an email with a private link
   (`/s/<32-byte token>`, token stored hashed, expires `ESIGN_LINK_DAYS`=14).
   Same order number = sent together; the next tier is emailed when the
   previous one has all signed.
3. Link → consent screen (ESIGN/UETA disclosure, versioned in
   `lib/consent.mjs`; "I'd rather sign on paper" declines + alerts Ryan) →
   review (every page as a PNG, `pdftoppm` 110 dpi, plus a PDF link) → sign:
   type full legal name (must contain a space), optional draw-on-screen pad,
   "I have read…" box, green **I agree and sign**.
4. Every open / sign / decline / expired-link hit records IP (Cloudflare's
   `cf-connecting-ip`), approximate location (ip-api.com), User-Agent, and
   posts a Telegram notice.
5. When the last signer signs: `lib/pdf.mjs buildFinalPdf` fills the
   template's `seller_date` / `buyer_date` with each signer's signing date
   (PT), flattens the form, draws the signatures on the template's own lines
   (first Seller + first Buyer by order; coordinates in `TEMPLATE`), appends
   a **Signature Addendum** page for every other signer, saves `signed.pdf`,
   then appends the **Certificate of Completion** (envelope id, SHA-256 of the
   original and of `signed.pdf`, per-signer audit, event log) → `final.pdf`.
   Files are chmod 444 and the envelope row is `locked` — no route can
   change it afterwards.
6. `final.pdf` is uploaded next to the offer in Drive (or
   `Business Operations/E-Sign/<street>/` for uploads), emailed with the
   attachment to every signer + Ryan, and announced on Telegram. Delivery is
   idempotent: **Retry delivery** on the admin page redoes only what failed.
7. Signers can download their copy from the done page / completion email;
   `/verify/<envelope id>` shows status + fingerprints + download.

## Ops

| Job | Plist (in `esign/launchd/`, installed in `~/Library/LaunchAgents/`) | Log |
|---|---|---|
| server | `com.lrghomes.esign` — `node server.mjs`, KeepAlive | `~/Projects/logs/esign.log` |
| tunnel | `com.lrghomes.esign-tunnel` — `cloudflared --config ~/.cloudflared/esign.yml tunnel run`, KeepAlive | `~/Projects/logs/esign-tunnel.log` |
| backup | `com.lrghomes.esign-backup` — 2:40 AM daily `scripts/backup.mjs` | `~/Projects/logs/esign-backup.log` |

- Restart server: `launchctl kickstart -k gui/$(id -u)/com.lrghomes.esign`
  (after `git pull` on main; no build step).
- Backup = `VACUUM INTO` SQLite snapshot per day + every envelope's
  original/signed/final PDF and `record.json` (rows + events) uploaded once
  each (tracked in the `backups` table) to Drive
  `Business Operations/E-Sign Backups/`. Telegram alert only on failure.
- Secrets: `esign/.env.local` (gitignored) — `ESIGN_ADMIN_PASSWORD`,
  `ESIGN_API_SECRET`, `ESIGN_COOKIE_SECRET`, `ESIGN_BASE_URL`, `ESIGN_PORT`.
  Google + Telegram keys come from `mission-control/.env.local`.
- Dry runs: `ESIGN_DRY_MAIL=1 ESIGN_QUIET=1 ESIGN_DATA_DIR=/tmp/x ESIGN_PORT=5878
  node server.mjs` logs emails/notices instead of sending; signing links
  print in the log.
- JSON API: `POST /api/envelopes` with `Authorization: Bearer $ESIGN_API_SECRET`
  `{ title, property_address, agreement_date, message, drive_file_id |
  pdf_base64, signers:[{name,email,phone,role,order}] }` → `{ id, sent,
  admin_url }`.
- Sleep: the mini already runs `caffeinate` (sleep 0); nothing extra needed.

## Deliberately out of scope (tonight)

SMS one-time code (`sms_verified` column exists, always "Not requested"),
templates, bulk send, user accounts, reminders, text delivery of links
(use **Get link to text** on the admin page and text it by hand).

## Gotchas learned

- The template's light-blue boxes are drawn in the page content, not the
  form widgets — they stay on the signed copy by design.
- `fmtDatePT` treats `YYYY-MM-DD` as a calendar date (no timezone shift);
  only timestamps go through `America/Los_Angeles`.
- pdf-lib's `form.flatten()` keeps the fields' existing appearance streams;
  `updateFieldAppearances` only regenerates dirty fields.
- Git worktrees have no `.env.local`; `lib/env.mjs` falls back to the main
  checkout's file.
