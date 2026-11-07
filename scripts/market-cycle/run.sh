#!/bin/sh
# Market-cycle job chains for launchd (brief v2 §6, P1.4/P1.6). One entry point
# so the order is fixed: collect → tripwires → review check. The review never
# runs on half-collected data (on Nov 7, 2026 the 07:30 review ran while the
# 06:30 collector was still retrying FRED until 10:09), and tripwires are
# evaluated every day, not only on Mondays.
#
#   run.sh daily    06:30 PT  collect-macro, tripwires, review --check
#   run.sh weekly   Mon 06:00 collect-weekly, tripwires
#   run.sh retry    hourly    only when a site outage left dials pending:
#                             collect-macro --retry-pending, tripwires, review --check
#                             (silent; exits at once when nothing is pending)
#
# Every step runs even if an earlier one failed (the review's own data-ready
# check decides whether it is due); the exit code is the first failure.
# Logs: ~/Library/Logs/lrg-market-cycle-<chain>.log (set in the plist; /tmp is
# emptied nightly by macOS).
cd "$(dirname "$0")/../.." || exit 1
PY=/opt/homebrew/bin/python3
NPX=/opt/homebrew/bin/npx
STATE="${MC_STATE_DIR:-$HOME/Library/Application Support/lrg-market-cycle}"
LOCK="$STATE/run.lock"
rc=0

if [ "$1" = retry ]; then
  [ -s "$STATE/macro-pending.json" ] || exit 0       # nothing pending: no work, no log noise
  [ -d "$LOCK" ] && exit 0                            # the daily/weekly chain is running
fi
mkdir -p "$STATE"
# One chain at a time. daily/weekly wait for each other (on Mondays the 06:00 weekly
# can still be running at 06:30, and Monday is review day); retry never waits.
# A lock older than 6 h is a crashed run and is cleared.
waited=0
until mkdir "$LOCK" 2>/dev/null; do
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +360 2>/dev/null)" ]; then rmdir "$LOCK"; continue; fi
  if [ "$1" = retry ] || [ $waited -ge 7200 ]; then
    echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') another market-cycle chain is running; skipped $1"; exit 0
  fi
  sleep 30; waited=$((waited + 30))
done
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

step() {
  echo ""
  echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') $*"
  "$@"
  s=$?
  [ $s -ne 0 ] && echo "=== exit $s: $*" && [ $rc -eq 0 ] && rc=$s
  return 0
}

case "$1" in
  daily)
    step "$PY" scripts/market-cycle/collect-macro.py --write
    step "$PY" scripts/market-cycle/tripwires.py --live --write --post
    step "$NPX" tsx scripts/market-cycle/review.ts --check --write --send
    ;;
  weekly)
    step "$PY" scripts/market-cycle/collect-weekly.py --write --alert-on-failure
    step "$PY" scripts/market-cycle/tripwires.py --live --write --post
    ;;
  retry)
    step "$PY" scripts/market-cycle/collect-macro.py --write --retry-pending
    step "$PY" scripts/market-cycle/tripwires.py --live --write --post
    step "$NPX" tsx scripts/market-cycle/review.ts --check --write --send
    ;;
  *)
    echo "usage: run.sh daily|weekly|retry" >&2
    exit 2
    ;;
esac
echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') done (exit $rc)"
exit $rc
