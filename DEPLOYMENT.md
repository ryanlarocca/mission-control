# Mission Control Deployment Runbook

Full rebuild-from-scratch instructions for the CRMS stack on Vercel + Cloudflare tunnel + Mac Mini sidecar.

## Architecture

```
Phone → Vercel (UI + Next.js API)
          ├── /api/crms/contacts    → Google Sheets API (direct)
          ├── /api/crms/log         → Google Sheets API (direct)
          ├── /api/crms/generate    → OpenRouter API (direct)
          ├── /api/crms/send        → SIDECAR_URL/send     (Cloudflare tunnel → Mac Mini:5799)
          └── /api/crms/enrich-one  → SIDECAR_URL/enrich-one (Cloudflare tunnel → Mac Mini:5799)
```

## Required Vercel env vars (Production scope)

| Var | Purpose |
| --- | --- |
| `GOOGLE_SERVICE_ACCOUNT_KEY` | JSON key for the service account with Editor access to the BoB sheet |
| `SIDECAR_URL` | Current `*.trycloudflare.com` tunnel URL (updates on every Mac reboot — see below) |
| `OPENROUTER_API_KEY` | For `/api/crms/generate` |
| `MC_PASSWORD` | Login password |
| `MC_SESSION_SECRET` | Session cookie secret |

## Sheet requirements (BoB)

- **Sheet1** has columns: A Name, B Phone, E Category, G LastContacted, H Tier, I Notes, J SnoozeUntil
- **Log** tab must exist (blank, no headers needed — API appends rows there)
- Service account email must have Editor access

## Google service account

1. `console.cloud.google.com` → project → enable Google Sheets API
2. Create service account → Keys → Add Key → JSON → download
3. Share the BoB sheet with the service account email (Editor)
4. In Vercel: add `GOOGLE_SERVICE_ACCOUNT_KEY` = **the full JSON file contents**, scope: Production

## Mac Mini sidecar

- Runs on `localhost:5799` via LaunchAgent `com.openclaw.crms.sidecar.plist`
- Has Full Disk Access (needed for `chat.db`)
- CORS allows: `localhost:3000`, `localhost:3001`, `mission-control-three-chi.vercel.app`

## Cloudflare tunnel (exposes sidecar to Vercel)

- LaunchAgent: `~/Library/LaunchAgents/com.openclaw.crms.cloudflare-tunnel.plist`
- Runs `cloudflared tunnel --url http://localhost:5799`
- Log: `~/.openclaw/workspace/logs/cloudflare-tunnel-sidecar.log`
- URL changes on every Mac reboot (Cloudflare quick tunnels are ephemeral)

## Auto-updating SIDECAR_URL on reboot

- Script: `~/.openclaw/workspace/scripts/update-sidecar-url.sh`
- LaunchAgent: `~/Library/LaunchAgents/com.openclaw.crms.update-sidecar-url.plist`
- Runs once at boot, 30s after cloudflared starts
- Scrapes the new tunnel URL from the log, updates Vercel env, triggers redeploy

## Gotchas — read before deploying

### 1. Next.js caches data-fetching routes by default

Any API route that reads from Google Sheets MUST export `dynamic = "force-dynamic"`, or Vercel bakes the first response into the build and never refreshes it.

```typescript
export const dynamic = "force-dynamic"
export const revalidate = 0
```

Currently applied to `/api/crms/contacts`. If you add new routes that read live sheet data, include these exports.

### 2. LaunchAgents run with a bare environment

`PATH` doesn't include Homebrew, so `vercel` / `node` / `cloudflared` fail with "command not found". Every LaunchAgent that runs shell commands MUST include:

```xml
<key>EnvironmentVariables</key>
<dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>HOME</key>
    <string>/Users/ryanlarocca</string>
</dict>
```

### 3. `vercel env pull` corrupts JSON values

Vercel strips quotes when pulling env vars locally, so `GOOGLE_SERVICE_ACCOUNT_KEY` becomes invalid JSON. The stored value on Vercel is still correct — this only affects local debugging. If you need the credentials locally, read the JSON file directly, don't use `vercel env pull`.

### 4. Adding env vars requires a redeploy

`vercel env add` does NOT apply to existing deployments. After adding any env var, run `vercel --prod` to pick it up. The auto-update LaunchAgent handles this for `SIDECAR_URL` on boot.

### 5. Sheet column J = snooze date

"Skip" actions write an ISO date to column J. `/api/crms/contacts` filters out any contact whose column J is in the future. Manually clearing a cell un-snoozes that contact.

## Deploy from scratch (first time)

```bash
# 1. Install deps
cd PROJECTS/mission-control && npm install

# 2. Set all Vercel env vars (see table above)
cat /path/to/service-account.json | vercel env add GOOGLE_SERVICE_ACCOUNT_KEY production
# ... etc for others

# 3. Load LaunchAgents on Mac Mini
launchctl load ~/Library/LaunchAgents/com.openclaw.crms.sidecar.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.crms.cloudflare-tunnel.plist
launchctl load ~/Library/LaunchAgents/com.openclaw.crms.update-sidecar-url.plist

# 4. First-time SIDECAR_URL set (LaunchAgent will handle this automatically on next boot)
tail -5 ~/.openclaw/workspace/logs/cloudflare-tunnel-sidecar.log   # grab *.trycloudflare.com URL
echo "https://<url>" | vercel env add SIDECAR_URL production

# 5. Deploy
vercel --prod
```

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Could not load contacts" on mobile | `GOOGLE_SERVICE_ACCOUNT_KEY` not set in Production scope | `vercel env ls production` to verify, re-add if missing, `vercel --prod` |
| Contacts API returns stale data after sheet edit | Route not `force-dynamic` | Add the exports, redeploy |
| Send/enrich returns `sidecar unavailable` | Tunnel down or `SIDECAR_URL` stale | Check `tail -5 ~/.openclaw/workspace/logs/cloudflare-tunnel-sidecar.log`, re-run `update-sidecar-url.sh` |
| LaunchAgent silently fails | Missing PATH in plist | Add `EnvironmentVariables` block (see gotcha #2) |
| Service account can't read sheet | Sheet not shared with service account email | Share with `<service-account>@<project>.iam.gserviceaccount.com` as Editor |
