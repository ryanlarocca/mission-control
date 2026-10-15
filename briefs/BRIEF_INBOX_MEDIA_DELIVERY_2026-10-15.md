# Brief — Inbox agent: listing photos from photographer deliveries (f8 first)

**Date:** 2026-10-15 · **Owner project:** `PROJECTS/inbox-agent/` · **Runs on:** Mac mini worker (`scripts/inbox-agent/index.mjs`, launchd every 5 min). Vercel is not involved.

## Why

Listing photos arrive by email as a link, not as attachments. Today's case: f8 Real
Estate Media (`order@f8re.com`) delivered **"f8 Media Delivery: 5764 Halleck Dr, San
Jose, CA 95123"** on 2026-10-15 (gmail id `1a1404b2c9ead5b0`). The stager (Kowi,
`info@stylemestaging.com`) placed the order; Ryan was only on the To line. The agent
saw the email, classified it `automated`, found the property **5764 Halleck Dr** and
even reported the Download Center URL in `classification.document_links` — then did
nothing, because `detectProvider` only knows DocuSign and photos are not on the
transaction whitelist. Ryan wants the photos in the property folder in Drive, without
duplicates, with no f8 account and no manual download.

Ryan's decisions (2026-10-15, verbatim intent):
- Photos go to **`Properties/<full address>/Photos/MLS`** (the Web/MLS set) and
  **`Properties/<full address>/Photos/Print`** (the Print set). Both sets, by default.
- Photographer filenames kept (`1-001_F8_5764 Halleck Dr.JPG` …).
- **Not** the MLS listing sheet PDF that the listing agent emails separately
  (Amanda Bakshi's "Halleck MLS" / `Halleck Listing.pdf`). That stays unfiled.
  Do not add any "marketing" subfolder under a property.
- Dedupe: never put the same photo in twice. Near-duplicates are *mentioned* on the
  card, never silently dropped.
- Property must match an **existing** full-address property folder; no folder → ❓
  card, never a silently created property folder.

## How f8 serves files (verified with curl on 2026-10-15 — no browser needed)

f8 runs on Aryeo. The Download Center is a server-rendered Laravel page:

1. `GET https://f8.f8re.com/listings/{listingId}/download-center?signature={sig}` →
   200 HTML. Sets cookies `XSRF-TOKEN` + `aryeo_session` (domain `.f8re.com`). The HTML
   contains `<input type="hidden" name="_token" value="…">` (Laravel CSRF, same value
   on every form) and, per image group, two forms whose `x-on:submit` call
   `fetchDownloadLinks($event, '<groupUrl>', 'https://foundry.aryeo.com/api/zip')`:
   - `https://f8.f8re.com/{listingId}/image-groups/{group}/download/print`
   - `https://f8.f8re.com/{listingId}/image-groups/{group}/download/web`
   Group was `unassigned` for Halleck; parse it from the page, do not hard-code it.
   The page also shows the count: `Images (36)` / `Web / MLS Quality Images (36)` /
   `Print Quality Images (36)`.
   The page answered 200 even with `?signature=` stripped, so expiry is unlikely —
   still handle a non-200 / login page / missing forms as a failure.
2. `POST <groupUrl>` with multipart form `_token=<token>`, the cookie jar from step 1,
   headers `Accept: application/json`, `X-Requested-With: XMLHttpRequest`,
   `Referer: <download-center url>` → 200 JSON:
   ```json
   { "zip_name": "5764-halleck-dr-san-jose-ca-95123.zip",
     "download_data": [
       { "download_type": "url",
         "name": "images-for-web-or-mls/1-001_F8_5764 Halleck Dr.JPG",
         "path": "https://cdn.aryeo.com/listings/5764-halleck-dr-san-jose-ca-95123-29967112/resized/large/large-01a13f27-25f0-70c7-afe3-f20f1c3a52fa.jpeg",
         "type": "image" }, … ] }
   ```
   Print set: `name` prefix `images-for-printing/`, `path` is the un-resized original
   (`…/listings/<slug>/<imageId>.jpeg`). The image UUID in `path` is the same for the
   web and print copy of one photo.
3. `GET <path>` — public CDN, no cookies: web ≈ 0.6 MB each, print ≈ 6.5 MB each
   (36 photos → ~21 MB + ~234 MB). Content-Type `image/jpeg`.
4. The site's own zip (`foundry.aryeo.com/api/zip`) is **not** needed — download the
   `path` URLs directly, name each file by the basename of `name`.

Real fixtures are checked in under `tests/fixtures/f8/`: the page HTML (`_token`
replaced by `FIXTURE_TOKEN`), both JSON responses, and the plain-text email. The cloud
session cannot reach f8; build against these and let the bridge session run live.

The email links are wrapped by Postmark click-tracking:
`https://track.pstmrk.it/3ts/<urlencoded target>/<junk>` — the real URL is the
URL-decoded path segment right after `/3ts/` up to the next `/` *after decoding stops
making sense*; simplest robust rule: take the segment after `/3ts/`, URL-decode it,
and if it starts with `f8.f8re.com/` prefix `https://`. The footer also carries the
**plain** `[Download Center](https://f8.f8re.com/listings/…/download-center?signature=…)`
link — prefer that when present. Branded / unbranded property-website links
(`https://f8.f8re.com/sites/<slug>/branded`, `/sites/<code>/unbranded`) come the same
way and go on the card.

## Constraints the cloud session must respect

- You cannot run the worker, hit f8, Gmail, Drive, Supabase or Telegram, or read
  `.env.local`. Write code + unit tests against the fixtures; the bridge session tests
  on the mini (`--dry-run --message=1a1404b2c9ead5b0`, then live).
- **No new dependencies.** Node 22 `fetch` + a tiny cookie jar you write (two cookies)
  is enough. No Playwright for this provider.
- No migration should be needed: `inbox_fetches.provider` and `inbox_files.source`
  are free text; `inbox_files` already has `sha256`, `size_bytes`, `final_folder`,
  `final_name`, `drive_file_id`, `source`, `fetch_id`. If you truly need a column, one
  migration under `supabase/migrations/` with `enable row level security`, read twice.
- `tsc --noEmit` and `npx vitest run` must pass. No `git add -A`; commit only the
  files you touched. Push the branch; **no PR, no merge**.
- Existing style: ESM `.mjs`, small named functions, Ryan-quoted comments explaining
  *why* where a rule comes from him. Keep `fileDocuments` and the DocuSign flow
  untouched except where this brief says otherwise.

## Design

### 1. Provider detection — `scripts/inbox-agent/fetch/providers.mjs`

- Add provider `"f8"` (keep the `Provider` typedef in sync). `detectProvider(url)`
  returns `"f8"` for `https://f8.f8re.com/listings/<id>/download-center…` (host
  `f8.f8re.com`, path `/listings/<uuid>/download-center`). Everything else on
  `f8re.com` (`/portal`, `/sites/...`, `www.f8re.com/...`) → `null`.
- Add `unwrapTrackingUrl(url)` for `track.pstmrk.it/3ts/…` (and pass-through for
  anything else); call it inside `extractUrls` *or* in `documentLinks` so a wrapped
  Download Center link is recognised and de-duplicated against the plain one (same
  listing → one job). Export it; test both shapes from the fixture email.
- Add `providerKind(provider)` → `"document" | "media"` (`f8` → `media`) and
  `providerLabel("f8")` → `"f8"`. Keep this file dependency-free (Vercel imports it).
- Add `propertyWebsiteLinks(text)` → `{ branded, unbranded }` for `f8.f8re.com/sites/…`
  links (unwrapped). Null when absent.

### 2. The f8 fetcher — `scripts/inbox-agent/fetch/f8.mjs`

`fetchF8({ url, jobId, log, fetchImpl = fetch })` →
`{ ok: true, sets: [{ set: "MLS"|"Print", files: [{ filename, mime, bytes, imageId }] }], counts: { page: 36, mls: 36, print: 36 }, listingId, steps }`
or `{ ok: false, error, needs: "expired" | "login" | null, steps }`.

- `parseDownloadCenter(html)` (pure, exported): `{ token, groups: [{ group, webUrl, printUrl }], imageCount }`.
  `imageCount` from `Images (N)`; `needs: "login"` when the page has a login form and
  no `_token`/groups; `needs: "expired"` on 403/410 or "expired"/"no longer available"
  text; otherwise a plain error.
- `parseDownloadJson(json, set)` (pure, exported): `[{ filename, url, imageId }]` —
  filename = basename of `name`, `imageId` = the UUID in `path`. Reject entries whose
  `download_type !== "url"` or whose `path` host is not `cdn.aryeo.com` / `*.aryeo.com`.
- Flow: GET page (store `set-cookie` values), parse, POST each group's web + print
  URL with the token, GET every `path` with concurrency 4, 30 s per request, 3 tries
  per image. Verify `mime` by magic bytes (`mimeFor` in `browser.mjs` already does
  this — import it; it does not launch a browser).
- Count check: if a set's file count ≠ `imageCount` or any image failed after retries,
  return `ok: false` with a precise error (`"Print set: 34 of 36 images downloaded"`).
  Partial sets are not filed — Ryan would rather get a card than a half folder.
- Memory: do not hold both sets at once. Return the sets lazily or write bytes to the
  job's on-disk store (`saveFetchedBytes`) as each image finishes and return paths;
  pick whichever keeps `index.mjs` simplest. 234 MB in RAM is acceptable on the mini if
  it keeps the code small — say which you chose.
- Hard cap 10 min per job (photos are bigger than PDFs); override `timeoutMs` in the
  dispatcher for `media` providers.

### 3. Dispatcher — `scripts/inbox-agent/fetch/index.mjs`

- `fetchDocuments` routes `provider === "f8"` to `fetchF8`, no ZIP expansion, no
  screenshots. Keep the DocuSign path byte-for-byte.
- `cli.mjs`: `node scripts/inbox-agent/fetch/cli.mjs --url "<download-center url>" --out /tmp/halleck-photos`
  must work for f8 (writes `MLS/` and `Print/` subdirs, prints counts). Keep the
  DocuSign flags.

### 4. Worker — `scripts/inbox-agent/index.mjs`

- **Routing.** In `handleMessage`, the `kind === "automated" … return` currently runs
  *before* `enqueueFetches`. Media deliveries must get through: before that return,
  if `documentLinks(msg, cls.document_links)` contains a `media` provider link, call
  `enqueueFetches` (and only that — no loops, no screens) and then return. Add
  `"media_delivery"` to `FETCH_KINDS` for when the classifier learns the kind (also add
  `media_delivery` to the classifier's kind list in `llm.mjs` with one line:
  "a photographer / media company delivering listing photos, video, floor plans or a
  property website — f8, Aryeo, HDPhotoHub, Tourbuzz, Spiro, Matterport"). Do not
  depend on the classifier getting it right; the provider match is the real gate.
- **Filing branch for media** — new `filePhotos(ctx, msg, cls, job, result)` used by
  `runFetchJob` when `providerKind(job.provider) === "media"`; it does **not** call
  `classify`, `fetchedDocs`, `fileDocuments`, `refineDocType` or `verifyProperty`.
  1. Property label: `cls.property.label` → fallback: the subject after the colon
     (`"f8 Media Delivery: 5764 Halleck Dr, San Jose, CA 95123"` → `5764 Halleck Dr`;
     strip city/state/zip with the existing `propertyKey` helpers). Resolve with
     `propertyFolderFor(ctx, label)` (full-address convention; the informal hand-made
     "Halleck" folder must not match — it doesn't, `propertyKey` needs the number).
     No folder → one ❓ card: "New property? I don't have a folder for X. Reply with
     the folder, or `skip`." using `postAskCard` on an `inbox_files` row for the first
     image, and park the job `status = 'needs_property'` (free text) so the Telegram
     reply path (`lib/inboxAgent.ts` `recordInboxReply`, existing ✏️ folder reply) can
     requeue it. Keep this minimal: the reply sets `inbox_fetches.status='queued'` +
     stores the chosen folder in `inbox_fetches.error = null` and a new free-text field
     is NOT needed — store it in the related `inbox_files.proposed_folder`; on requeue,
     `filePhotos` uses that folder when present. If this plumbing grows past ~40 lines,
     stop at the card + `needs_property` status and leave the requeue to the bridge
     session; say so in the report.
  2. Destination folders: `resolvePath(ctx.drive, ctx.rootId, "Properties/<pf.name>/Photos/MLS", { create: !DRY })`
     and `…/Photos/Print`. Creating `Photos/`, `MLS/`, `Print/` is fine (Ryan approved
     those names); creating a *property* folder is not.
  3. **Dedupe, three layers, in this order per file:**
     a. `sha256(bytes)` against `inbox_files.sha256` with status in the same set
        `recordAttachment` uses → skip as `duplicate` ("already filed as …").
     b. Same filename **and** same `size_bytes` already in the destination Drive folder
        (`listChildren` once per folder, cache it) → skip as `duplicate`, and record an
        `inbox_files` row with `status='duplicate'`, `drive_file_id` of the existing file.
     c. Same `imageId` (from the CDN path) already recorded in `inbox_files` for this
        property — store the id in `inbox_files.attachment_id` (free text, unused for
        fetched files) as `f8:<imageId>:<set>` — → skip as `duplicate` (re-delivery
        with a re-edit changes the bytes but not the id; treat as "re-edited, kept the
        existing copy" and **mention** it on the card rather than overwrite).
     Anything not caught above uploads via `uploadFile` with the photographer's
     filename; same name but different size → upload with `withTimeSuffix`-style
     suffix (`… (2).JPG`) and mention it as "looked like a duplicate but differed".
  4. `inbox_files` rows: one per uploaded image, `source = 'f8'`, `fetch_id = job.id`,
     `doc_type = 'photos'`, `status = 'filed'`, `final_folder`, `final_name`,
     `drive_file_id`, `drive_url`, `property_label/key`. Skips as above. Label the Gmail
     message `MC/Filed` like other filings (`addLabel`).
  5. **One card** (`tgSend`, HTML):
     ```
     📸 Photos filed — 5764 Halleck Dr
     MLS: 36 new · Print: 36 new   (or "36 new, 0 skipped as duplicates")
     ⚠️ 2 looked like existing photos (re-edited?) — kept the originals   (only when relevant)
     Open Photos/ (button → Drive folder URL of Photos/)
     🌐 Branded site · 🌐 Unbranded site  (URL buttons, only when present)
     ```
     plus `↩️ Undo` is **not** needed (undo of 72 files is a bigger feature; say so).
  6. `inbox_fetches` → `status='done'`, `files` summary (filename, size, sha256,
     inbox_file_id, set, imageId). Reuse `failAttempt` (5 min / 30 min backoff) for
     transient failures; the final ⚠️ card must carry the **email** link
     (`https://mail.google.com/mail/?authuser=ryan@lrghomes.com#all/<gmail_id>`) and the
     download-center link, and say what happened ("Print set: 34 of 36 downloaded").
     `needs: "expired"` / `"login"` → the existing cards (they already say "open the
     link"), no Send-New-Link logic for f8.
- **`--dry-run`:** no Drive, no DB, no Telegram; write the files to
  `/tmp/inbox-fetch/<job>/MLS|Print/` and log the would-be destinations + dedupe
  verdicts (dedupe layer (a) and (c) may read Supabase in dry-run; (b) may read Drive).
- `runFetches` picks up to 3 jobs per pass; a photo job can take minutes — make it
  1 media job per pass (check `providerKind` when selecting) so DocuSign jobs are not
  starved. Not a migration: filter in JS after the select.

### 5. Telegram side — `lib/inboxAgent.ts` (minimal)

- `fetch` on a card / `fetch <url>` already enqueue by `detectProvider`; nothing to
  add beyond the provider type. If you add the `needs_property` reply path (4.1), put
  it next to the existing `fetch` cases and keep it under ~40 lines. `HELP` unchanged.

### 6. Tests — `tests/inbox-media-fetch.unit.test.ts`

- `detectProvider` on the plain Download Center link → `"f8"`; on `/portal`,
  `/sites/…/branded`, `www.f8re.com/ambassadors`, the app-store links → `null`.
- `unwrapTrackingUrl` on the three Postmark links in `tests/fixtures/f8/delivery-email.txt`
  → the exact plain URLs; `documentLinks` on that email text → exactly one `f8` link.
- `propertyWebsiteLinks` → the branded + unbranded URLs.
- `parseDownloadCenter(fixture html)` → token `FIXTURE_TOKEN`, one group
  `unassigned` with both URLs, `imageCount` 36.
- `parseDownloadJson(web.json, "MLS")` → 36 entries, first filename
  `1-001_F8_5764 Halleck Dr.JPG`, imageId `01a13f27-25f0-70c7-afe3-f20f1c3a52fa`;
  print.json same ids, original paths.
- `fetchF8` with an injected `fetchImpl` that serves the fixtures and 36 tiny JPEG
  buffers (`FF D8 FF …`) → `ok`, counts 36/36/36; a 35-image set → `ok: false` with the
  "35 of 36" error; a 403 page → `needs: "expired"`.
- Dedupe decision function (`photoDedupeVerdict({ sha, filename, size, imageId }, { knownShas, folderFiles, knownImageIds })`) — make it pure and test all four outcomes
  (new / sha dup / name+size dup / imageId dup).
- Subject → property label fallback for the Halleck subject and for
  `"f8 Media Delivery: 2116 Quito Rd, Saratoga, CA 95070"`.

### 7. Hand-off notes for the bridge session (top of your final report)

- Files touched; whether a migration exists (it should not).
- Exact manual test: `node scripts/inbox-agent/fetch/cli.mjs --url "<Download Center url from gmail 1a1404b2c9ead5b0>" --out /tmp/halleck-photos`
  then `node scripts/inbox-agent/index.mjs --dry-run --message=1a1404b2c9ead5b0`, then
  `node scripts/inbox-agent/index.mjs --message=1a1404b2c9ead5b0` (live; the job queues
  and the next 5-min pass or a second `--message` run executes it — state which).
- Where the bytes live after a live run (`~/.lrg/inbox-fetch/<job>/`) and how to purge.
- Anything you could not verify without the mini.

## Out of scope (don't build)

Video / floor-plan / Matterport assets (f8 delivers those as separate groups — log
the group names you see so the next phase knows), other photographers' providers,
↩️ Undo for photo batches, an f8/Aryeo account or API key, filing the MLS listing
sheet PDF, any "Marketing" subfolder under a property, re-tiering listing-agent
emails (tracked separately in the inbox-agent memo).
