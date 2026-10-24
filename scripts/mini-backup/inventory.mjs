// Generates SYSTEMS_INVENTORY.md from the live machine. Names of secrets, never values.
import fs from "node:fs"
import path from "node:path"
import { execSync } from "node:child_process"
import { HOME, MC_ROOT, PROJECTS_ROOT, loadEnvFile } from "./lib.mjs"

const run = (cmd) => { try { return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60_000 }).trim() } catch { return "" } }
const SAFE_VALUE = (k) => /_(NUMBER|PHONE|NUMBERS)$/.test(k) || /^(LRG_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_URL|SIDECAR_URL|TELEGRAM_CHAT_ID|MC_BASE_URL|NEXT_PUBLIC_[A-Z_]*URL|ESIGN_DRIVE_ROOT_ID|ESIGN_DATA_DIR|PILE_GMAIL_IMAP_USER|GOG_ACCOUNT)$/.test(k)

function plistSummary(file) {
  const label = run(`/usr/libexec/PlistBuddy -c 'Print :Label' '${file}'`)
  const prog = run(`/usr/libexec/PlistBuddy -c 'Print :ProgramArguments' '${file}'`).split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("Array") && s !== "}").join(" ")
  const interval = run(`/usr/libexec/PlistBuddy -c 'Print :StartInterval' '${file}'`)
  const cal = run(`/usr/libexec/PlistBuddy -c 'Print :StartCalendarInterval' '${file}'`).replace(/\s+/g, " ").replace(/Dict \{|\}/g, "").trim()
  const keep = run(`/usr/libexec/PlistBuddy -c 'Print :KeepAlive' '${file}'`)
  const runAtLoad = run(`/usr/libexec/PlistBuddy -c 'Print :RunAtLoad' '${file}'`)
  const state = run(`launchctl list 2>/dev/null | grep -F '${label}'`).split(/\s+/)
  const sched = interval ? `every ${interval}s` : cal ? `calendar ${cal}` : keep === "true" ? "keepalive" : runAtLoad === "true" ? "at login" : "manual"
  return { label, prog, sched, pid: state[0] && state[0] !== "-" ? state[0] : "", lastExit: state[1] ?? "" }
}

export function buildInventory() {
  const now = new Date()
  const L = []
  const h = (t) => L.push("", `## ${t}`, "")
  L.push(`# Mac mini — systems inventory`, "", `Generated ${now.toISOString()} by scripts/mini-backup/inventory.mjs. Regenerated nightly. Secret NAMES only, never values.`)

  h("Machine")
  L.push(`- Host: ${run("hostname")} · ${run("sw_vers -productName")} ${run("sw_vers -productVersion")} · user ${run("whoami")} · LAN IP ${run("ipconfig getifaddr en0") || run("ipconfig getifaddr en1")}`)
  L.push(`- Uptime: ${run("uptime")}`)
  L.push(`- FileVault: ${run("fdesetup status")} · auto-login user: ${run("defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser")}`)
  L.push(`- Versions: node ${run("node -v")} (${run("which node")}) · npm ${run("npm -v")} · git ${run("git --version")} · claude ${run("claude --version")} · gog ${run("gog --version | head -1")} · cloudflared ${run("cloudflared --version | head -1")} · vercel ${run("vercel --version")}`)
  L.push(`- Homebrew: ${run("brew --version | head -1")} · formulae: ${run("brew list --formula | tr '\\n' ' '")}`)
  L.push(`- Homebrew casks: ${run("brew list --cask | tr '\\n' ' '")}`)
  L.push(`- Global npm: ${run("npm ls -g --depth=0 2>/dev/null | tail -n +2 | tr '\\n' ' '")}`)
  L.push(`- Disk: ${run("df -h / | tail -1")}`)

  h("Scheduled jobs (launchd, user agents)")
  L.push("| Label | Schedule | PID | Last exit | Program |", "|---|---|---|---|---|")
  const agents = fs.readdirSync(path.join(HOME, "Library/LaunchAgents")).filter((f) => /lrghomes|openclaw|physiq|claude/i.test(f) && f.endsWith(".plist")).sort()
  for (const f of agents) { const p = plistSummary(path.join(HOME, "Library/LaunchAgents", f)); L.push(`| ${p.label || f} | ${p.sched} | ${p.pid || "—"} | ${p.lastExit || "—"} | \`${p.prog}\` |`) }
  const disabled = fs.readdirSync(path.join(HOME, "Library/LaunchAgents")).filter((f) => /disabled/i.test(f))
  if (disabled.length) L.push("", `Disabled plists kept on disk: ${disabled.join(", ")}`)

  h("Network: listening ports + tunnels")
  L.push(`- Listening: ${run("netstat -an -p tcp | grep LISTEN | awk '{print $4}' | sort -u | tr '\\n' ' '")}`)
  const cfProcs = run("pgrep -lf cloudflared | sed 's/^[0-9]* //' | tr '\\n' ';'") || "none"
  L.push(`- cloudflared processes: ${cfProcs}`)
  for (const f of fs.existsSync(path.join(HOME, ".cloudflared")) ? fs.readdirSync(path.join(HOME, ".cloudflared")) : []) {
    if (f.endsWith(".yml")) L.push(`- ~/.cloudflared/${f}: ${run(`grep -E 'hostname|service' '${path.join(HOME, ".cloudflared", f)}' | tr -s ' ' | tr '\\n' ' '`)}`)
    else L.push(`- ~/.cloudflared/${f}`)
  }
  const named = run("cloudflared tunnel list 2>/dev/null | tail -n +2 | awk '{print $2}' | tr '\\n' ' '") || "n/a"
  L.push(`- Named tunnels: ${named}`)

  h("Repos")
  for (const [name, dir] of [["~/Projects (memos, sidecar, esign, scripts — NO remote)", PROJECTS_ROOT], ["mission-control", MC_ROOT], ["lrghomes-landing", path.join(PROJECTS_ROOT, "PROJECTS/lrghomes-landing")]]) {
    if (!fs.existsSync(path.join(dir, ".git"))) continue
    L.push(`- **${name}** — \`${dir}\` · remote: ${run(`git -C '${dir}' remote get-url origin`) || "none"} · branch ${run(`git -C '${dir}' rev-parse --abbrev-ref HEAD`)} @ ${run(`git -C '${dir}' rev-parse --short HEAD`)} (${run(`git -C '${dir}' log -1 --format=%ci`)}) · uncommitted: ${run(`git -C '${dir}' status --short | wc -l | tr -d ' '`)}`)
  }
  L.push(`- mission-control worktrees (agent scratch, not needed for restore): ${run(`git -C '${MC_ROOT}' worktree list | tail -n +2 | wc -l | tr -d ' '`)}`)

  h("Secrets (names only) — the files themselves are in secrets/ in this backup")
  for (const [label, file] of [["mission-control/.env.local", path.join(MC_ROOT, ".env.local")], ["esign/.env.local", path.join(MC_ROOT, "esign/.env.local")]]) {
    const e = loadEnvFile(file)
    L.push(`- **${label}** (${Object.keys(e).length} vars): ${Object.keys(e).sort().map((k) => SAFE_VALUE(k) ? `${k}=${e[k]}` : k).join(", ")}`)
  }
  try {
    const cred = JSON.parse(loadEnvFile(path.join(MC_ROOT, ".env.local")).GOOGLE_SERVICE_ACCOUNT_KEY || "{}")
    L.push(`- Google service account: ${cred.client_email} · GCP project ${cred.project_id} · DWD client id ${cred.client_id} · key id ${String(cred.private_key_id || "").slice(0, 8)}…`)
  } catch {}
  L.push(`- Scopes referenced in code: ${run(`grep -rhoE 'googleapis\\.com/auth/[a-z.]+' '${MC_ROOT}/lib' '${MC_ROOT}/scripts' '${MC_ROOT}/esign/lib' 2>/dev/null | sort -u | sed 's#.*/auth/##' | tr '\\n' ' '`)}`)
  L.push(`- gog accounts (OAuth, tokens live in macOS Keychain — re-auth on a new machine): ${run("gog auth list 2>/dev/null | tr '\\n' ';'")}`)
  L.push(`- gog config: ~/Library/Application Support/gogcli/config.json`)
  L.push(`- Vercel: ${run("vercel whoami 2>/dev/null")} · project ${run(`cat '${MC_ROOT}/.vercel/project.json' 2>/dev/null`)}`)

  h("Sidecar (CRMS, port 5799) endpoints")
  L.push(run(`grep -oE "req\\.url === '/[a-zA-Z/_-]+'" '${PROJECTS_ROOT}/PROJECTS/comprehensive-relationship-management/phase2/crms-sidecar.js' | cut -d"'" -f2 | sort -u | tr '\\n' ' '`))

  h("Claude Code (agent) state")
  const projDir = path.join(HOME, ".claude/projects")
  for (const d of fs.existsSync(projDir) ? fs.readdirSync(projDir) : []) {
    const m = path.join(projDir, d, "memory")
    if (fs.existsSync(m)) L.push(`- memory: ~/.claude/projects/${d}/memory — ${fs.readdirSync(m).filter((f) => f.endsWith(".md")).length} files`)
  }
  L.push(`- skills: ${run(`ls '${HOME}/.claude/skills' 2>/dev/null | tr '\\n' ' '`)}`)
  L.push(`- settings: ~/.claude/settings.json, ~/.claude/settings.local.json`)

  h("Data files (one-copy items included in this backup)")
  for (const f of ["PROJECTS/comprehensive-relationship-management/data/iphone_sms.db", "PROJECTS/comprehensive-relationship-management/data/unified_messages.db", "PROJECTS/esign/data/esign.sqlite"]) {
    const p = path.join(PROJECTS_ROOT, f); if (fs.existsSync(p)) L.push(`- ${f} — ${(fs.statSync(p).size / 1e6).toFixed(1)} MB`)
  }
  L.push(`- ~/Library/Messages/chat.db (live texts, NOT backed up — lives on the iPhone/iCloud; needs Full Disk Access to read)`)
  L.push(`- ~/Library/Application Support/CallHistoryDB, AddressBook (synced from iPhone, NOT backed up)`)

  h("Cloud services (survive the mini)")
  L.push("- Vercel: mission-control-three-chi.vercel.app (prod from `main`) · Supabase (prod DB) · Twilio (lines + recordings) · Telegram bots · Google Workspace (lrghomes.com mail, Drive via DWD) · Cloudflare (DNS for 3 zones + tunnels) · GitHub (mission-control, lrghomes-landing)")
  return L.join("\n") + "\n"
}

if (process.argv[1] && process.argv[1].endsWith("inventory.mjs")) process.stdout.write(buildInventory())
