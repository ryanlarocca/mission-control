#!/usr/bin/env python3
"""Market-cycle macro collector: daily pull of every history dial, new readings only.

Spec: briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md (3.2 monthly macro dials,
3.3 cadence: "Macro collector — daily pull; evaluated at checkpoints", and
"Scheduled-release notes — stored and surfaced in the monthly card").
Runs on the Mac mini at 06:30 (infrastructure/launchd/com.lrghomes.market-cycle-macro.plist).

For every dial with has_history and a fetch method other than manual/web/mlslistings:
fetch through sources.fetch_dial (the same code path as bootstrap-history.py),
apply the dial's transform, add the corridor variants (corridor.transform when it
differs from the dial transform, corridor.read_as = 10d_avg / 2d_close), and keep
only readings with as_of newer than the latest stored reading for that dial +
variant. C.A.R. and SCCAOR read only their newest few releases here (the archive
backfill is bootstrap-history.py's job).

Scheduled-release notes: when a dial on the data calendar (jobs, CPI, PCE,
Case-Shiller; FOMC via fed_funds_target_upper) gets a new print, one line
"X printed V vs prior P" goes to cycle_notes (kind 'release', surfaced_at null):
silent, surfaced by the monthly card. The matching cycle_calendar rows get fired_at.

Usage:
  python3 scripts/market-cycle/collect-macro.py               # dry run: no database; assumes nothing stored,
                                                              #   prints the latest 3 readings per dial
  python3 scripts/market-cycle/collect-macro.py --live        # read the latest stored as_of from Supabase; write nothing
  python3 scripts/market-cycle/collect-macro.py --write       # upsert new readings + notes (launchd)
  python3 scripts/market-cycle/collect-macro.py --only cpi_yoy,ust10y

--write needs both cycle_* migrations applied and the registry synced
(sync-registry.py --write); dials missing from cycle_dials are skipped and listed.
A FAILED source on a --write run posts one Telegram alert (silent failures must
alert); --no-alert suppresses it. Stdlib only.
"""
import argparse, datetime as dt, os, re, sys, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sources as S  # noqa: E402

SKIP_FETCH = ("manual", "web", "mlslistings")
SHOW_LATEST = 3
# Sources revise recent prints (EDD posts WARN notices days late, FRED/C.A.R.
# revise, a month in progress keeps growing): every run re-checks this many of
# the newest stored readings per dial and rewrites the ones whose value changed.
REVISE_WINDOW = {"daily": 10, "weekly": 4, "monthly": 3, "quarterly": 2}


def collectable(cfg, only=None):
    return [d for d in cfg["dials"] if d["has_history"] and d["fetch"] not in SKIP_FETCH and (not only or d["id"] in only)]


class Db:
    """The few PostgREST calls the collector needs."""

    def __init__(self, sb, key):
        self.sb, self.key = sb, key

    def req(self, method, path, body=None, prefer=None):
        return S.sb_req(self.sb, self.key, method, path, body, prefer)

    def probe(self):
        return S.sb_probe(self.sb, self.key, ["cycle_dials?select=id&limit=1", "cycle_readings?select=variant&limit=1",
                                              "cycle_notes?select=id&limit=1", "cycle_calendar?select=id&limit=1"])

    def dial_ids(self):
        return {r["id"] for r in self.req("GET", "cycle_dials?select=id") or []}

    def latest(self, dial_id, variant):
        got = self.recent(dial_id, variant, 1)
        return got[0][0] if got else None

    def recent(self, dial_id, variant, n):
        """The n newest stored readings, newest first: [(as_of, value)]."""
        got = self.req("GET", "cycle_readings?select=as_of,value&dial_id=eq.%s&variant=eq.%s&order=as_of.desc&limit=%d" % (
            S.q(dial_id), S.q(variant), n))
        return [(g["as_of"][:10], g["value"]) for g in got or []]

    def calendar(self):
        return [(r["date"], r["dial_id"]) for r in self.req("GET", "cycle_calendar?select=date,dial_id") or []]

    def upsert_readings(self, rows):
        for i in range(0, len(rows), 500):
            self.req("POST", "cycle_readings?on_conflict=dial_id,variant,as_of,source_url", rows[i:i + 500],
                     prefer="resolution=merge-duplicates,return=minimal")

    def insert_notes(self, notes):
        if not notes:
            return 0
        got = self.req("POST", "cycle_notes?on_conflict=dial_id,text", notes, prefer="resolution=ignore-duplicates,return=representation")
        return len(got or [])

    def mark_fired(self, cal_dial_id, today):
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        self.req("PATCH", "cycle_calendar?dial_id=eq.%s&date=lte.%s&fired_at=is.null" % (S.q(cal_dial_id), today), {"fired_at": now},
                 prefer="return=minimal")


def calendar_index(calendar):
    """[(date|None|'TBD', dial_id)] -> ({collected dial: [ISO dates]}, {collected dial: {calendar dial ids}})."""
    dates, cal_ids = {}, {}
    for date, dial in calendar:
        if not dial:
            continue
        did = S.CALENDAR_DIAL_ALIAS.get(dial, dial)
        cal_ids.setdefault(did, set()).add(dial)
        dates.setdefault(did, [])
        if date and re.match(r"\d{4}-\d{2}-\d{2}$", str(date)[:10]):
            dates[did].append(str(date)[:10])
    return dates, cal_ids


def run(cfg, db=None, only=None, fetch=None, today=None):
    """Collect every dial. db=None -> nothing stored (dry run). Returns per-dial results."""
    today = (today or S.TODAY).isoformat()
    fetch = fetch or S.fetch_dial
    calendar = db.calendar() if db else [(c["date"], c["dial_id"]) for c in cfg["calendar"]]
    cal_dates, cal_ids = calendar_index(calendar)
    known = db.dial_ids() if db else None
    results = []
    dials = collectable(cfg, only)
    for d in dials:
        r = {"dial": d, "status": "OK", "reason": None, "series": [], "note_row": None, "cal_ids": cal_ids.get(d["id"], set())}
        results.append(r)
        collect_one(r, d, cfg, db, fetch, known, cal_ids, cal_dates, today)
    again = [r for r in results if r["status"] == "FAILED"]
    if again:
        # a dropped connection can outlast one dial's retries: ask each failed source once more
        S.forget_failures()
        for r in again:
            r.update(status="OK", reason=None, series=[], note_row=None)
            collect_one(r, r["dial"], cfg, db, fetch, known, cal_ids, cal_dates, today)
    return results


def collect_one(r, d, cfg, db, fetch, known, cal_ids, cal_dates, today):
    """Fetch one dial into result r (status, series with new-only readings, release note)."""
    if known is not None and d["id"] not in known:
        r["status"], r["reason"] = "SKIPPED", "dial not in cycle_dials (run sync-registry.py --write)"
        return
    try:
        rows, url, note, extras = fetch(d, cfg)
        if not rows:
            raise S.SourceError("parsed 0 rows")
    except S.SourceError as e:
        r["status"], r["reason"] = "FAILED", str(e)
        return
    r.update(source_url=url, source_note=note, extras=extras)
    if "FAILED" in (note or ""):
        # some pages/files of a multi-page source failed (C.A.R. index, a SCCAOR PDF,
        # an EDD file): readings that did parse are kept; the failure is reported.
        r["status"], r["reason"] = "PARTIAL", note
    for variant, vrows in [("", rows)] + S.corridor_variants(d, rows):
        if isinstance(vrows, Exception):
            r["series"].append({"variant": variant, "error": str(vrows)})
            continue
        stored = db.recent(d["id"], variant, REVISE_WINDOW.get(d.get("cadence"), 3)) if db else []
        latest = stored[0][0] if stored else None
        r["series"].append({"variant": variant, "rows": vrows, "latest_stored": latest,
                            "new": [x for x in S.new_only(vrows, latest) if x[0][:10] >= S.STORE_SINCE],
                            "revised": S.revisions(vrows, stored)})
    if d["id"] in cal_ids:
        base = r["series"][0]
        txt = S.release_note(d, base["rows"], base["new"], cal_dates.get(d["id"], []), base["latest_stored"])
        if txt:
            r["note_row"] = {"date": today, "dial_id": d["id"], "text": txt, "kind": "release"}


def new_reading_rows(results):
    out = []
    for r in results:
        if r["status"] not in ("OK", "PARTIAL"):
            continue
        for s in r["series"]:
            if "new" in s:
                rev = [(d, new) for d, _old, new in s.get("revised", [])]
                out += S.reading_rows(r["dial"]["id"], s["variant"], s["new"] + rev, r["source_url"], r["source_note"], r["extras"])
    return out


def print_report(results, dry):
    fmt = S.fmt
    print("%-42s %-8s %6s  %-14s %s" % ("dial", "status", "new", "latest value", "as_of"))
    for r in results:
        did = r["dial"]["id"]
        if r["status"] not in ("OK", "PARTIAL"):
            print("%-42s %-8s %6s  %-14s %s" % (did, r["status"], "-", "-", "-"))
            continue
        for s in r["series"]:
            name = did if not s["variant"] else "  %s #%s" % (did, s["variant"])
            if "error" in s:
                print("%-42s %-8s %6s  %-14s %s" % (name[:42], "FAILED", "-", "-", "-"))
                continue
            ld, lv = s["rows"][-1] if s["rows"] else ("-", None)
            print("%-42s %-8s %6d  %-14s %s" % (name[:42], r["status"] if not s["variant"] else "OK", len(s["new"]), fmt(lv), ld[:10]))
    if dry:
        print("\nLATEST %d NEW READINGS PER DIAL (dry run: nothing assumed stored)" % SHOW_LATEST)
        for r in results:
            for s in r["series"] if r["status"] in ("OK", "PARTIAL") else []:
                if s.get("new"):
                    name = r["dial"]["id"] + ("#" + s["variant"] if s["variant"] else "")
                    print("  %-44s %s" % (name, "  ".join("%s=%s" % (d[:10], fmt(v)) for d, v in s["new"][-SHOW_LATEST:])))
    bad = [r for r in results if r["status"] in ("FAILED", "PARTIAL", "SKIPPED")] + \
          [dict(r, status="FAILED", reason="variant %s: %s" % (s["variant"], s["error"])) for r in results for s in r["series"] if "error" in s]
    print("\nFAILED / PARTIAL / SKIPPED SOURCES: %s" % ("none" if not bad else ""))
    for r in bad:
        print("  %-36s %s: %s" % (r["dial"]["id"], r["status"], r["reason"]))
    revised = [(r["dial"]["id"] + ("#" + s["variant"] if s["variant"] else ""), x) for r in results if r["status"] in ("OK", "PARTIAL")
               for s in r["series"] for x in s.get("revised", [])]
    print("\nREVISED STORED READINGS: %s" % ("none" if not revised else ""))
    for name, (d, old, new) in revised:
        print("  %-44s %s: %s -> %s" % (name, d, fmt(old), fmt(new)))
    notes = [r["note_row"] for r in results if r["note_row"]]
    print("\nSCHEDULED-RELEASE NOTES (%s): %s" % ("would be written to cycle_notes" if dry else "cycle_notes", "none" if not notes else ""))
    for n in notes:
        print("  [%s] %s" % (n["dial_id"], n["text"]))
    ok = sum(1 for r in results if r["status"] == "OK")
    print("\n%d dials: %d OK, %d PARTIAL, %d FAILED, %d SKIPPED; %d new readings (incl. variants), %d revised" % (
        len(results), ok, sum(1 for r in results if r["status"] == "PARTIAL"), sum(1 for r in results if r["status"] == "FAILED"),
        sum(1 for r in results if r["status"] == "SKIPPED"),
        sum(len(s.get("new", [])) for r in results for s in r["series"]), len(revised)))
    return bad, notes


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--write", action="store_true", help="upsert new readings + release notes into Supabase")
    ap.add_argument("--live", action="store_true", help="read the latest stored readings from Supabase; write nothing")
    ap.add_argument("--only", help="comma-separated dial ids")
    ap.add_argument("--no-alert", action="store_true", help="no Telegram alert on FAILED sources")
    a = ap.parse_args(argv)
    cfg = S.load_config()
    only = set(a.only.split(",")) if a.only else None
    env, db = S.load_env(), None
    mode = "WRITE" if a.write else ("LIVE READ (no writes)" if a.live else "DRY RUN (no database access)")
    if a.write or a.live:
        sb, key = env.get("LRG_SUPABASE_URL"), env.get("LRG_SUPABASE_SERVICE_KEY")
        if not sb or not key:
            sys.exit("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing from .env.local")
        db = Db(sb, key)
        missing = db.probe()
        if missing:
            print("REFUSING: these tables/columns are not reachable over PostgREST:\n  " + "\n  ".join(missing))
            print("Apply supabase/migrations/2026-11-01_market_cycle.sql + 2026-11-02_market_cycle_macro.sql, then sync-registry.py --write.")
            if a.write and not a.no_alert and sb.startswith("https://"):
                S.telegram_alert(env, "Market-cycle macro collector did not run: cycle_* tables unreachable (%s)." % "; ".join(missing)[:500])
            sys.exit(2)
    print("market-cycle macro collector %s — %s — %s" % (cfg["version"], S.TODAY.isoformat(), mode))
    results = run(cfg, db, only)
    bad, notes = print_report(results, dry=db is None)
    if a.write:
        rows = new_reading_rows(results)
        try:
            db.upsert_readings(rows)
            n_notes = db.insert_notes(notes)
            for r in results:
                if r["note_row"]:
                    for cid in r["cal_ids"]:
                        db.mark_fired(cid, S.TODAY.isoformat())
        except (urllib.error.URLError, OSError, ValueError) as e:
            msg = e.read().decode()[:300] if isinstance(e, urllib.error.HTTPError) else str(e)
            print("\nWRITE FAILED: %s" % msg)
            if not a.no_alert and db.sb.startswith("https://"):
                S.telegram_alert(env, "Market-cycle macro collector: Supabase write failed (%s)." % msg[:300])
            sys.exit(3)
        print("\nWROTE %d readings, %d new release notes" % (len(rows), n_notes))
        if bad and not a.no_alert and db.sb.startswith("https://"):
            S.telegram_alert(env, "Market-cycle macro collector: %d source(s) failed today — %s" % (
                len(bad), "; ".join("%s: %s" % (r["dial"]["id"], (r["reason"] or "")[:120]) for r in bad)))
    elif db is None:
        print("Dry run: nothing written. --write upserts the new readings and release notes.")


if __name__ == "__main__":
    main()
