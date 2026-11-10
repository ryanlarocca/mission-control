#!/usr/bin/env python3
"""Market-cycle tracker, Phase 0: history bootstrap + corridor numbers.

Spec: briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md (Part 3.4, Part 4 Phase 0).
Registry: config/market-cycle/thesis.v1.2.json (every dial with has_history=true
is fetched here). Fetchers, parsers and transforms live in sources.py and are
shared with collect-macro.py (the daily collector), so a dial reads the same way
in both. Here the monthly-release sources (C.A.R., SCCAOR) read their full public
archive (backfill).

For each dial: fetch the full free history, apply the dial's transform, and
print one line: dial id, source, OK / FAILED(reason), rows, first, last,
latest value. Then compute the corridors:
  (a) seasonal_1sd dials: per-calendar-month mean and sd over the prior 5 years
  (b) CCC OAS (BAMLH0A3HYC): 2010-01-01..2025-12-31 maximum
  (c) Realtor.com price-reduced share (PRIREDCOU / ACTLISCOU): 2016-2025 maximum
  (d) EDD WARN: 2025 monthly average of Santa Clara County affected workers
  (e) ZHVI SCC all homes: drawdown from the fixed reference peak; tier YoY
  (f) other corridor dials: 2021-2025 distribution + latest
A source that cannot be fetched is reported FAILED with the reason. Nothing is
ever filled in: no placeholder numbers.

Corridor merge rule (config vote_rules.corridor_note): the numbers computed here
are written under corridor.computed; the config's authored corridor keys are
authoritative and are never overwritten (sources.merge_corridor).

Usage:
  python3 scripts/market-cycle/bootstrap-history.py            # dry run (prints only; no DB)
  python3 scripts/market-cycle/bootstrap-history.py --write    # upsert into the cycle_* tables
  python3 scripts/market-cycle/bootstrap-history.py --only ccc_oas,brent

--write needs supabase/migrations/2026-11-01_market_cycle.sql and
2026-11-02_market_cycle_macro.sql applied first; it probes the cycle_* tables
over PostgREST and refuses to run if one is missing.
Stdlib only. PDF sources (EDD fiscal-year WARN reports, SCCAOR monthly stats)
are read with the system `pdftotext` (poppler) when present; otherwise FAILED.
"""
import argparse, datetime as dt, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sources as S  # noqa: E402

TODAY = S.TODAY
SEASONAL_YEARS = list(range(TODAY.year - 5, TODAY.year))          # prior 5 full calendar years
STORE_SINCE = S.STORE_SINCE                                        # readings written with --write
TABLES = ["cycle_thesis_versions", "cycle_claims", "cycle_dials", "cycle_readings", "cycle_checkpoints",
          "cycle_weight_moves", "cycle_owned_properties", "cycle_calendar"]
fmt = S.fmt


def why(results, k):
    return ("FAILED: %s" % results[k]["reason"]) if k in results else "not run (filtered by --only)"


def compute_corridors(results, cfg):
    dials = {d["id"]: d for d in cfg["dials"]}
    cor, lines = {}, []
    ok = {k: r for k, r in results.items() if r["status"] == "OK"}

    lines.append("(a) seasonal_1sd: per-calendar-month mean +/- 1 sd over %d-%d; latest print vs its month" % (SEASONAL_YEARS[0], SEASONAL_YEARS[-1]))
    for did, r in ok.items():
        d = dials[did]
        if d["band_rule"] != "seasonal_1sd":
            continue
        s = S.seasonal(r["rows"], SEASONAL_YEARS)
        ld, lv = r["rows"][-1]
        m = s.get(ld[5:7])
        z = None
        if m and m["sd"]:
            z = round((lv - m["mean"]) / m["sd"], 2)
        cor[did] = {"rule": "seasonal_1sd", "years": [SEASONAL_YEARS[0], SEASONAL_YEARS[-1]], "by_month": s, "computed_on": TODAY.isoformat()}
        band = ("%s +/- %s" % (fmt(m["mean"]), fmt(m["sd"]))) if m else "no band (month absent in window)"
        lines.append("    %-34s latest %s = %-10s band[%s] %-26s z=%s%s" % (did, ld, fmt(lv), ld[5:7], band, fmt(z),
                     "  OUTSIDE" if z is not None and abs(z) > 1 else ""))

    # (b) CCC OAS
    lines.append("(b) CCC OAS (BAMLH0A3HYC) 2010-01-01..2025-12-31 maximum")
    if "ccc_oas" in ok:
        rows = ok["ccc_oas"]["rows"]
        win = [(d, v) for d, v in rows if "2010-01-01" <= d <= "2025-12-31"]
        first = rows[0][0]
        md, mv = max(win, key=lambda x: x[1]) if win else (None, None)
        complete = first <= "2010-01-04"
        cor["ccc_oas"] = {"rule": "corridor", "bear_above_2010_2025_max": mv if complete else None,
                          "history_available_from": first, "complete": complete,
                          "partial_window_max": {"date": md, "value": mv, "window": [first, "2025-12-31"]} if not complete else None,
                          "latest_10d_avg": S.avg_last(rows), "latest": rows[-1], "computed_on": TODAY.isoformat()}
        if complete:
            lines.append("    2010-2025 max = %s on %s; latest %s = %s; 10-day avg %s" % (mv, md, rows[-1][0], rows[-1][1], S.avg_last(rows)))
        else:
            lines.append("    FAILED (incomplete history): FRED serves BAMLH0A3HYC only from %s (ICE licence: ~3 years)." % first)
            lines.append("    The 2010-2025 maximum CANNOT be computed from FRED. Max inside the available %s..2025-12-31 window = %s on %s (NOT the threshold)." % (first, mv, md))
            lines.append("    latest %s = %s; 10-day avg %s" % (rows[-1][0], rows[-1][1], S.avg_last(rows)))
    else:
        lines.append("    " + why(results, "ccc_oas"))

    # (c) price-reduced share
    lines.append("(c) Realtor.com SCC price-reduced share (PRIREDCOU6085 / ACTLISCOU6085) 2016-2025 maximum")
    k = "realtor_price_reduced_share_scc"
    if k in ok:
        rows = ok[k]["rows"]
        win = [(d, v) for d, v in rows if "2016-01-01" <= d <= "2025-12-31"]
        md, mv = max(win, key=lambda x: x[1])
        cor[k] = {"rule": "corridor", "bear_above": mv, "max_month": md[:7], "window": [win[0][0][:7], win[-1][0][:7]],
                  "latest": rows[-1], "computed_on": TODAY.isoformat()}
        lines.append("    max = %.2f%% in %s (window %s..%s); latest %s = %.2f%%" % (mv, md[:7], win[0][0][:7], win[-1][0][:7], rows[-1][0][:7], rows[-1][1]))
    else:
        lines.append("    " + why(results, k))

    # (d) WARN
    lines.append("(d) EDD WARN, Santa Clara County affected workers: 2025 monthly average (by notice date)")
    k = "scc_warn_workers"
    if k in ok:
        rows = ok[k]["rows"]
        m25 = {d[:7]: v for d, v in rows if d.startswith("2025-")}
        if len(m25) == 12:
            avg = sum(m25.values()) / 12
            cor[k] = {"rule": "corridor", "baseline_2025_monthly_avg": round(avg, 1), "tripwire_month_above": round(2 * avg, 1),
                      "monthly_2025": m25, "month_assigned_by": "notice date", "computed_on": TODAY.isoformat()}
            lines.append("    2025 total %d, monthly avg %.1f -> tripwire (2x) %.1f" % (sum(m25.values()), avg, 2 * avg))
            lines.append("    2025 by month: " + " ".join("%s:%d" % (m[5:], v) for m, v in sorted(m25.items())))
            m26 = {d[:7]: v for d, v in rows if d.startswith("2026-")}
            lines.append("    2026 by month: " + " ".join("%s:%d" % (m[5:], v) for m, v in sorted(m26.items())))
        else:
            lines.append("    FAILED: only %d of 12 months of 2025 covered (%s)" % (len(m25), ok[k]["note"]))
    else:
        lines.append("    " + why(results, k))

    # (e) ZHVI: drawdown from the fixed reference peak (scored_object.reference_peak)
    ref = cfg["scored_object"]["reference_peak"]
    lines.append("(e) ZHVI Santa Clara County (all homes, SA): drawdown from the reference peak %s = $%s; tier YoY" % (ref["month"], format(ref["value"], ",")))
    if "zhvi_scc" in ok:
        rows = ok["zhvi_scc"]["rows"]
        dd = S.drawdown_from_fixed(rows, ref["value"], since=ref["month"] + "-01")
        ath_d, ath_v = max(rows, key=lambda x: x[1])
        ld, lv = rows[-1]
        cur = (lv / ref["value"] - 1) * 100
        md, maxdd = min(dd, key=lambda x: x[1]) if dd else (None, None)
        c = {"rule": "corridor", "reference_peak": ref, "series_all_time_high": {"month": ath_d[:7], "value": round(ath_v)},
             "latest": {"month": ld[:7], "value": round(lv)}, "current_drawdown_pct": round(cur, 2),
             "max_drawdown_pct": round(maxdd, 2) if maxdd is not None else None, "max_drawdown_month": md[:7] if md else None,
             "scenario_bounds_pct": {"bull_above": -8, "bear_at_or_below": -15}, "computed_on": TODAY.isoformat()}
        cor["zhvi_scc"] = c; cor["zhvi_scc_drawdown"] = c
        lines.append("    series all-time high %s = $%s%s; latest %s = $%s; current drawdown %.2f%% (deepest so far %.2f%% in %s) -> partition today: %s" % (
            ath_d[:7], format(round(ath_v), ","), "" if ath_d[:7] == ref["month"] else " (NOT the configured reference month: review at the shakedown)",
            ld[:7], format(round(lv), ","), cur, maxdd, md[:7] if md else "-",
            "bear" if maxdd <= -15 else ("base" if maxdd <= -8 else "bull (shallower than -8%)")))
    else:
        lines.append("    " + why(results, "zhvi_scc"))
    for k in ("zhvi_scc_yoy", "zhvi_scc_top_yoy", "zhvi_scc_bottom_yoy"):
        if k in ok:
            ld, lv = ok[k]["rows"][-1]
            lines.append("    %-20s latest %s YoY = %+.2f%%" % (k, ld[:7], lv))
        else:
            lines.append("    %-20s %s" % (k, why(results, k)))

    # other corridor dials: descriptive history for the shakedown (no thresholds invented)
    lines.append("(f) other corridor dials: 2021-2025 distribution + latest (authored thresholds stay in the config)")
    for did, r in ok.items():
        d = dials[did]
        if d["band_rule"] != "corridor" or did in cor:
            continue
        rows = r["rows"]
        c = {"rule": "corridor", "stats_2021_2025": S.stats(rows),
             "latest": rows[-1], "latest_10d_avg": S.avg_last(rows) if d["cadence"] == "daily" else None, "computed_on": TODAY.isoformat()}
        extra = ""
        if did == "sp500":
            refc = dict(rows).get("2026-10-06")
            if refc:
                c["oct6_2026_high"] = refc
                c["drawdown_from_oct6_pct"] = round((rows[-1][1] / refc - 1) * 100, 2)
                after = [v for dd_, v in rows if dd_ > "2026-10-06"]
                c["closed_above_oct6_since"] = any(v > refc for v in after)
                extra = " | Oct 6 high %s, drawdown %+.2f%%, closed above since: %s" % (refc, c["drawdown_from_oct6_pct"], c["closed_above_oct6_since"])
        if did == "basket_index":
            yr = [(dd_, v) for dd_, v in rows if dd_ >= (dt.date.fromisoformat(rows[-1][0]) - dt.timedelta(days=365)).isoformat()]
            hd, hv = max(yr, key=lambda x: x[1])
            c["high_52w"] = {"date": hd, "value": hv}
            c["drawdown_from_52w_high_pct"] = round((rows[-1][1] / hv - 1) * 100, 2)
            c["base_date"] = rows[0][0]
            extra = " | 52w high %s on %s, drawdown %+.2f%% (C30 line -30%%)" % (fmt(hv), hd, c["drawdown_from_52w_high_pct"])
        if did == "mortgage_spread":
            extra = " | C11 line 180 bp; brief norm ~170 bp"
        if did == "scc_months_supply":
            raw = (r["extras"].get(rows[-1][0]) or {}).get("raw") or {}
            if "sfr_only_months" in raw:
                c["latest_sfr_only_months"] = raw["sfr_only_months"]
                extra = " | SFR-only (SCCAOR inventory / SFR sales) %s; C19 line 3.0" % raw["sfr_only_months"]
        cor[did] = c
        s = c["stats_2021_2025"]
        lines.append("    %-34s latest %s = %-9s%s 2021-25 min/med/max %s/%s/%s%s" % (
            did, rows[-1][0], fmt(rows[-1][1]), (" 10d avg %s" % fmt(c["latest_10d_avg"])) if c["latest_10d_avg"] is not None else "",
            fmt(s["min"]) if s else "-", fmt(s["median"]) if s else "-", fmt(s["max"]) if s else "-", extra))
    return cor, lines


# ---------------------------------------------------------------- Supabase (--write only)
def reading_rows(did, r, store_since=STORE_SINCE):
    """Base series + corridor variants -> cycle_readings rows (as_of >= store_since)."""
    out = []
    for variant, rows in [("", r["rows"])] + [(v, rr) for v, rr in r.get("variants", []) if not isinstance(rr, Exception)]:
        out += S.reading_rows(did, variant, rows, r["source_url"], r["note"], r["extras"], since=store_since)
    return out


def write_all(cfg, results, corridors):
    env = S.load_env()
    sb, key = env.get("LRG_SUPABASE_URL"), env.get("LRG_SUPABASE_SERVICE_KEY")
    if not sb or not key:
        sys.exit("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing from .env.local")
    missing = S.sb_probe(sb, key, [t + "?select=*&limit=1" for t in TABLES] + ["cycle_readings?select=variant&limit=1"])
    if missing:
        print("\nREFUSING --write: these tables/columns are not reachable over PostgREST:\n  " + "\n  ".join(missing))
        print("Apply supabase/migrations/2026-11-01_market_cycle.sql and 2026-11-02_market_cycle_macro.sql first (owner's tap), then re-run with --write.")
        sys.exit(2)

    S.sb_req(sb, key, "POST", "cycle_thesis_versions?on_conflict=version", [S.version_row(cfg)],
             prefer="resolution=ignore-duplicates,return=minimal")
    claims = [S.claim_row(c, cfg["version"]) for c in cfg["claims"]]
    S.sb_req(sb, key, "POST", "cycle_claims?on_conflict=id", claims, prefer="resolution=ignore-duplicates,return=minimal")
    existing = {r["id"]: r.get("corridor") for r in S.sb_req(sb, key, "GET", "cycle_dials?select=id,corridor") or []}
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    dial_rows = [dict(S.dial_row(d, corridors.get(d["id"]), existing.get(d["id"])), updated_at=now) for d in cfg["dials"]]
    S.sb_req(sb, key, "POST", "cycle_dials?on_conflict=id", dial_rows, prefer="resolution=merge-duplicates,return=minimal")
    print("  upserted %d dials (authored corridor + corridor.computed), %d claims (insert-only), thesis v%s (insert-only)" % (len(dial_rows), len(claims), cfg["version"]))

    n = 0
    for did, r in results.items():
        if r["status"] != "OK":
            continue
        rows = reading_rows(did, r)
        for i in range(0, len(rows), 500):
            S.sb_req(sb, key, "POST", "cycle_readings?on_conflict=dial_id,variant,as_of,source_url", rows[i:i + 500], prefer="resolution=merge-duplicates,return=minimal")
        n += len(rows)
    print("  upserted %d readings incl. corridor variants (as_of >= %s)" % (n, STORE_SINCE))

    have = S.sb_req(sb, key, "GET", "cycle_owned_properties?select=address,zip,flag&retired_at=is.null") or []
    seed = [{"address": "5764 Halleck Dr, San Jose, CA 95123", "zip": "95123", "flag": "for_sale", "bought_on": "2026-10-01", "listed_on": "2026-10-14", "source": "bootstrap"},
            {"address": "2116 Quito Rd, San Jose, CA 95130", "zip": "95130", "flag": "for_sale", "bought_on": "2026-10-08", "listed_on": "2026-10-22", "source": "bootstrap"},
            {"address": None, "zip": "95118", "flag": "home", "bought_on": None, "listed_on": None, "source": "bootstrap"}]
    new = [s for s in seed if not any(h["zip"] == s["zip"] and h["flag"] == s["flag"] for h in have)]
    if new:
        S.sb_req(sb, key, "POST", "cycle_owned_properties", new, prefer="return=minimal")
    print("  owned properties: %d seeded, %d already present" % (len(new), len(seed) - len(new)))

    have = {h["label"] for h in S.sb_req(sb, key, "GET", "cycle_calendar?select=label") or []}
    cal = [S.calendar_row(c) for c in cfg["calendar"] if c["name"] not in have]
    if cal:
        S.sb_req(sb, key, "POST", "cycle_calendar", cal, prefer="return=minimal")
    print("  calendar: %d inserted" % len(cal))

    if not S.sb_req(sb, key, "GET", "cycle_weight_moves?select=id&bootstrap_exception=is.true&limit=1"):
        m = cfg["weight_moves"][0]
        S.sb_req(sb, key, "POST", "cycle_weight_moves", [{"date": m["date"], "from_weights": m["from"], "to_weights": m["to"], "readings_cited": {"bootstrap": m["readings_cited"]},
                 "argument": m["reason"], "opposite_case": m["opposite_case"], "reverses_if": m["reverses_if"], "bootstrap_exception": True}], prefer="return=minimal")
        print("  weight move #0 inserted")


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--write", action="store_true", help="upsert readings/corridors/registry into Supabase (default: dry run)")
    ap.add_argument("--only", help="comma-separated dial ids")
    a = ap.parse_args()
    cfg = S.load_config()
    only = set(a.only.split(",")) if a.only else None
    dials = [d for d in cfg["dials"] if d["has_history"] and (not only or d["id"] in only)]
    print("market-cycle bootstrap %s — %s — %d dials with history — %s" % (cfg["version"], TODAY.isoformat(), len(dials), "WRITE" if a.write else "DRY RUN (no database access)"))
    print("%-34s %-30s %-8s %6s  %-10s  %-10s  %s" % ("dial", "source", "status", "rows", "first", "last", "latest"))
    results = {}

    def fetch_one(d):
        src = d["source"].get("series_id") or d["fetch"]
        try:
            rows, url, note, extras = S.fetch_dial(d, cfg, backfill=True)
            if not rows:
                raise S.SourceError("parsed 0 rows")
            results[d["id"]] = {"status": "OK", "rows": rows, "source_url": url, "note": note, "extras": extras,
                                "variants": S.corridor_variants(d, rows)}
            print("%-34s %-30s %-8s %6d  %-10s  %-10s  %s" % (d["id"], src[:30], "OK", len(rows), rows[0][0], rows[-1][0], fmt(rows[-1][1])))
            if d["fetch"] in ("edd_warn_xlsx", "tiingo", "car_html", "sccaor_html") or "reference peak" in note:
                print("    note: " + note)
            for v, vr in results[d["id"]]["variants"]:
                if isinstance(vr, Exception):
                    print("    variant %s FAILED (%s)" % (v, vr))
        except S.SourceError as e:
            results[d["id"]] = {"status": "FAILED", "reason": str(e)}
            print("%-34s %-30s FAILED(%s)" % (d["id"], src[:30], e))
        sys.stdout.flush()

    for d in dials:
        fetch_one(d)
    again = [d for d in dials if results[d["id"]]["status"] == "FAILED"]
    if again:
        # a dropped connection can outlast one dial's retries: ask each failed source once more
        S.forget_failures()
        print("\nSECOND PASS over %d FAILED dial(s)" % len(again))
        for d in again:
            fetch_one(d)
    nok = sum(1 for r in results.values() if r["status"] == "OK")
    print("\n%d OK, %d FAILED" % (nok, len(results) - nok))
    partial = sorted(k for k, r in results.items() if r["status"] == "OK" and "FAILED" in (r["note"] or ""))
    if partial:
        print("OK but with some pages/files FAILED (see each note; those months are missing, never filled): " + ", ".join(partial))
    corridors, lines = compute_corridors(results, cfg)
    print("\nCORRIDORS (written under corridor.computed; authored config keys win)")
    print("\n".join(lines))
    if a.write:
        print("\nWRITING")
        write_all(cfg, results, corridors)
    else:
        print("\nDry run: nothing written. --write upserts readings (+ variants), corridor.computed, registry and the owned-property seed.")


if __name__ == "__main__":
    main()
