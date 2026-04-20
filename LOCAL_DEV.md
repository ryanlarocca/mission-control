# Local Dev Runbook

How to spin up Mission Control locally for UI/API testing against the real Book of Business sheet.

## TL;DR

```bash
cd /Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control
# 1. Make sure GOOGLE_SERVICE_ACCOUNT_KEY is in .env.local (see below)
# 2. Kill any stale server
pkill -f "next dev"; pkill -f "next-server"
# 3. Start dev
PORT=3001 npm run dev
# 4. Open http://localhost:3001 — login password is MC_PASSWORD from .env.local
```

On VS Code Remote SSH: the Ports tab auto-forwards 3001, or add it manually (`Forward a Port`). The forwarded `localhost:3001` in your laptop browser tunnels to the Mac Mini.

## Why the default `.env.local` isn't enough

The committed `.env.local` is missing `GOOGLE_SERVICE_ACCOUNT_KEY` — without it `/api/crms/contacts` returns "Could not load contacts". The key is only stored in Vercel (production scope).

## Getting `GOOGLE_SERVICE_ACCOUNT_KEY` locally

Do **not** use `vercel env pull` — it strips the quotes inside the JSON and the result is unparseable (see DEPLOYMENT.md gotcha #3). Instead, fetch the decrypted value from the Vercel REST API directly:

```bash
cd /Users/ryanlarocca/.openclaw/workspace/PROJECTS/mission-control
node -e '
const fs=require("fs"), https=require("https");
const token=JSON.parse(fs.readFileSync("/Users/ryanlarocca/Library/Application Support/com.vercel.cli/auth.json","utf8")).token;
const { projectId, orgId }=JSON.parse(fs.readFileSync(".vercel/project.json","utf8"));
// First list envs to find the id, then fetch with decrypt=true
https.get({hostname:"api.vercel.com",path:`/v9/projects/${projectId}/env?teamId=${orgId}`,headers:{Authorization:`Bearer ${token}`}},r=>{
  let d="";r.on("data",c=>d+=c);r.on("end",()=>{
    const id=JSON.parse(d).envs.find(e=>e.key==="GOOGLE_SERVICE_ACCOUNT_KEY" && (e.target||[]).includes("production")).id;
    https.get({hostname:"api.vercel.com",path:`/v9/projects/${projectId}/env/${id}?teamId=${orgId}&decrypt=true`,headers:{Authorization:`Bearer ${token}`}},r2=>{
      let d2="";r2.on("data",c=>d2+=c);r2.on("end",()=>{
        fs.writeFileSync("/tmp/sa.json",JSON.parse(d2).value,{mode:0o600});
        console.log("wrote /tmp/sa.json");
      });
    });
  });
});
'
# Then append to .env.local (single-quoted so embedded " are preserved):
printf "\nGOOGLE_SERVICE_ACCOUNT_KEY='%s'\nSIDECAR_URL=http://localhost:5799\n" "$(cat /tmp/sa.json)" >> .env.local
rm -f /tmp/sa.json
```

After that, `.env.local` stays set up — you only need to do this once per machine.

## Smoke test the server is really up

```bash
curl -sS -o /dev/null -w "login=%{http_code}\n" http://localhost:3001/login          # expect 200
curl -sS -o /dev/null -w "contacts=%{http_code}\n" http://localhost:3001/api/crms/contacts  # expect 307 (redirect to /login — auth gate working)
```

If you get 500 instead of 200/307, check `/tmp/mc-dev.log` (or wherever you redirected the npm output).

## Common pitfalls

- **"localhost refused to connect" in your laptop browser** — you're on VS Code Remote SSH. The laptop `localhost` is your laptop, not the Mac. Forward port 3001 via the VS Code Ports tab.
- **"Could not load contacts"** — `GOOGLE_SERVICE_ACCOUNT_KEY` missing or malformed in `.env.local`. Follow the fetch-from-API flow above; don't use `vercel env pull`.
- **Old code is being served** — you're running against a cached `next-server` (production build) on the same port. Run `pkill -f next-server` before `npm run dev`.
- **Enrichment/send endpoints fail locally** — `SIDECAR_URL` points at the Cloudflare tunnel in production. For local, set `SIDECAR_URL=http://localhost:5799` (already in the template above) so `/api/crms/enrich-one` hits the local sidecar on the Mac Mini.

## Clean up when done

```bash
pkill -f "next dev"
# .env.local contains a service account key — do NOT commit or share
```

`.env.local` is in `.gitignore`, so the key stays local.
