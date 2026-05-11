#!/usr/bin/env bash
# mac-mini-reset.sh — reload every project-owned LaunchAgent on the Mac
# mini after a reboot or power blip, then run a health check on each
# service and print a one-line-per-service summary.
#
# Idempotent: safe to run anytime. `launchctl unload` on a plist that
# isn't currently loaded errors with "Could not find specified service"
# — we swallow that so a partial state still reloads cleanly.
#
# Scope: matches `com.lrghomes.*.plist` and `com.openclaw.crms.*.plist`
# in ~/Library/LaunchAgents/. Anything outside those prefixes (chatdb
# oneshot, nightly-bug-sweep, etc.) is intentionally left alone.
#
# Usage:
#   bash scripts/mac-mini-reset.sh
#
# Exit code:
#   0 — every service health check returned OK
#   1 — at least one service is unhealthy (see the table for which)

set -u

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PREFIXES=( "com.lrghomes." "com.openclaw.crms." )

# ANSI colors — disabled when stdout isn't a TTY so logs/cron output
# stay clean. Bash on macOS supports `[[ -t 1 ]]`.
if [[ -t 1 ]]; then
  C_OK="\033[32m"; C_FAIL="\033[31m"; C_DIM="\033[2m"; C_RESET="\033[0m"
else
  C_OK=""; C_FAIL=""; C_DIM=""; C_RESET=""
fi

# Health-check timestamp threshold for log-based checks (24 hours).
GMAIL_WATCH_LOG="/tmp/lrg-gmail-watch-renewal.log"
GMAIL_WATCH_MAX_AGE_SEC=$((26 * 3600))

# Buckets for the final summary table. Parallel arrays — Bash 3 (macOS
# default) doesn't support associative arrays portably enough.
SERVICE_NAMES=()
SERVICE_STATUS=()  # OK / FAIL
SERVICE_DETAILS=()

# is_project_plist <path>
#   Returns 0 if the plist's basename matches any of PREFIXES.
is_project_plist() {
  local base
  base="$(basename "$1")"
  for prefix in "${PREFIXES[@]}"; do
    if [[ "$base" == "$prefix"* && "$base" == *.plist ]]; then
      return 0
    fi
  done
  return 1
}

# label_from_plist <path>
#   Strip the directory and `.plist` extension. The plist's <Label>
#   field is conventionally the basename minus extension across this
#   project, but defensively read the file too if `defaults` is around.
label_from_plist() {
  local base
  base="$(basename "$1" .plist)"
  echo "$base"
}

# reload_plist <path>
#   `launchctl unload` then `launchctl load`. The unload may error if
#   the service was never loaded — swallow that one specific case.
reload_plist() {
  local path="$1"
  launchctl unload "$path" 2>/dev/null || true
  launchctl load "$path"
}

# record <name> <status> <detail>
record() {
  SERVICE_NAMES+=( "$1" )
  SERVICE_STATUS+=( "$2" )
  SERVICE_DETAILS+=( "$3" )
}

# health_curl <name> <url>
#   curl with a short timeout, expect HTTP 200.
health_curl() {
  local name="$1" url="$2"
  if curl -sf --max-time 4 "$url" >/dev/null 2>&1; then
    record "$name" "OK" "$url responded"
  else
    record "$name" "FAIL" "$url did not respond (HTTP non-2xx or timeout)"
  fi
}

# health_launchctl_pid <name> <label>
#   Pass if the label is loaded AND PID is non-dash (meaning it's
#   currently running). LaunchAgents with StartInterval may legitimately
#   be idle between firings — for those we instead look at last-exit.
health_launchctl_pid() {
  local name="$1" label="$2"
  local line pid status
  line="$(launchctl list 2>/dev/null | awk -v L="$label" '$3 == L { print $1 " " $2 }')"
  if [[ -z "$line" ]]; then
    record "$name" "FAIL" "label $label not loaded"
    return
  fi
  pid="${line% *}"
  status="${line#* }"
  if [[ "$pid" == "-" ]]; then
    record "$name" "FAIL" "label $label loaded but no PID"
  else
    record "$name" "OK" "pid $pid (last exit $status)"
  fi
}

# health_launchctl_loaded <name> <label> — passes if the label is loaded,
# regardless of whether it's currently between fires. For interval/cron
# style jobs (drip-engine, gmail-watch-renewal, merge, lastcontacted-sync).
health_launchctl_loaded() {
  local name="$1" label="$2"
  local line status
  line="$(launchctl list 2>/dev/null | awk -v L="$label" '$3 == L { print $1 " " $2 }')"
  if [[ -z "$line" ]]; then
    record "$name" "FAIL" "label $label not loaded"
    return
  fi
  status="${line#* }"
  # Treat any last-exit other than 0/- as a problem — but stay tolerant
  # of a first run that hasn't fired yet (status="-").
  case "$status" in
    0|-) record "$name" "OK" "loaded (last exit $status)" ;;
    *)   record "$name" "FAIL" "loaded but last exit=$status" ;;
  esac
}

# health_log_mtime <name> <path> <max_age_sec>
#   Pass when the log file exists and was modified within max_age_sec.
health_log_mtime() {
  local name="$1" path="$2" max_age="$3"
  if [[ ! -f "$path" ]]; then
    record "$name" "FAIL" "log file missing: $path"
    return
  fi
  local mtime now age
  mtime="$(stat -f %m "$path" 2>/dev/null || echo 0)"
  now="$(date +%s)"
  age=$(( now - mtime ))
  if (( age <= max_age )); then
    record "$name" "OK" "log updated ${age}s ago ($(date -r "$mtime" +%H:%M))"
  else
    record "$name" "FAIL" "log stale (${age}s old; >${max_age}s)"
  fi
}

# --- Phase 1: reload every project-owned plist ---

echo "→ Reloading project LaunchAgents in $LAUNCH_AGENTS_DIR"
reloaded=0
for plist in "$LAUNCH_AGENTS_DIR"/*.plist; do
  [[ -e "$plist" ]] || continue
  is_project_plist "$plist" || continue
  label="$(label_from_plist "$plist")"
  printf "  %b•%b %s\n" "$C_DIM" "$C_RESET" "$label"
  if reload_plist "$plist"; then
    reloaded=$(( reloaded + 1 ))
  else
    printf "    %b! launchctl load failed for %s%b\n" "$C_FAIL" "$label" "$C_RESET"
  fi
done
echo "  reloaded $reloaded plist(s)"
echo

# Give services a moment to come up before health-checking.
sleep 2

# --- Phase 2: health checks ---

# Keep-alive HTTP services.
health_curl              "sidecar"            "http://localhost:5799/health"
health_curl              "mission-control"    "http://localhost:3001"

# Long-running daemons we just need to confirm are alive.
health_launchctl_pid     "cloudflare-tunnel"  "com.openclaw.crms.cloudflare-tunnel"
health_launchctl_pid     "ngrok"              "com.lrghomes.ngrok"
health_launchctl_pid     "lead-webhook"       "com.lrghomes.lead-webhook"

# Interval / cron-style jobs.
health_launchctl_loaded  "drip-engine"        "com.lrghomes.drip-engine"
health_launchctl_loaded  "gmail-watch-renewal" "com.lrghomes.gmail-watch-renewal"
health_launchctl_loaded  "crms-merge"         "com.openclaw.crms.merge"
health_launchctl_loaded  "lastcontacted-sync" "com.openclaw.crms.lastcontacted-sync"

# Side effect: confirm Gmail watch is renewing daily.
health_log_mtime         "gmail-watch-log"    "$GMAIL_WATCH_LOG" "$GMAIL_WATCH_MAX_AGE_SEC"

# --- Phase 3: summary table ---

echo
echo "Service health summary"
printf "%-22s %-6s %s\n" "SERVICE" "STATE" "DETAIL"
printf "%-22s %-6s %s\n" "----------------------" "------" "------"
any_fail=0
for i in "${!SERVICE_NAMES[@]}"; do
  name="${SERVICE_NAMES[$i]}"
  status="${SERVICE_STATUS[$i]}"
  detail="${SERVICE_DETAILS[$i]}"
  if [[ "$status" == "OK" ]]; then
    printf "%-22s ${C_OK}[%-4s]${C_RESET} %s\n" "$name" "OK" "$detail"
  else
    any_fail=1
    printf "%-22s ${C_FAIL}[%-4s]${C_RESET} %s\n" "$name" "FAIL" "$detail"
  fi
done

echo
if (( any_fail == 0 )); then
  echo -e "${C_OK}All services healthy.${C_RESET}"
  exit 0
else
  echo -e "${C_FAIL}One or more services failed health check — see table above.${C_RESET}"
  exit 1
fi
