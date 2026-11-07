#!/bin/sh
# Market-cycle job chains for launchd (brief v2 §6, P1.4/P1.6). One entry point
# so the order is fixed: collect → tripwires → review check. The review never
# runs on half-collected data (on Nov 7, 2026 the 07:30 review ran while the
# 06:30 collector was still retrying FRED until 10:09), and tripwires are
# evaluated every day, not only on Mondays.
#
#   run.sh daily    06:30 PT  collect-macro, tripwires, review --check
#   run.sh weekly   Mon 06:00 collect-weekly, tripwires
#
# Every step runs even if an earlier one failed (the review's own data-ready
# check decides whether it is due); the exit code is the first failure.
# Logs: ~/Library/Logs/lrg-market-cycle-<chain>.log (set in the plist; /tmp is
# emptied nightly by macOS).
cd "$(dirname "$0")/../.." || exit 1
PY=/opt/homebrew/bin/python3
NPX=/opt/homebrew/bin/npx
rc=0

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
  *)
    echo "usage: run.sh daily|weekly" >&2
    exit 2
    ;;
esac
echo "=== $(date '+%Y-%m-%d %H:%M:%S %Z') done (exit $rc)"
exit $rc
