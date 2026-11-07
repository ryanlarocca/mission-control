#!/usr/bin/env python3
"""Market-cycle registry sync: config/market-cycle/thesis.v1.2.json -> Supabase.

Upserts
  cycle_dials            every dial; config key `fetch` -> column fetch_method
  cycle_claims           new claims inserted whole; existing claims get the
                         config-owned fields only (text, category, scenario_tag,
                         prob_initial, resolves_on, falsifier, data_source, version).
                         prob_current / status / resolution / Brier scores are
                         DB-owned (moved at checkpoints) and never overwritten.
  cycle_thesis_versions  one row for the config's version (config = the full JSON)
  cycle_calendar         one row per config calendar entry, matched by label

Corridor merge rule (config vote_rules.corridor_note): the config's authored
corridor keys are authoritative; bootstrap-computed stats live under
corridor.computed and are kept as they are in the DB, never overwriting an
authored key (sources.merge_corridor).

Usage:
  python3 scripts/market-cycle/sync-registry.py           # dry run: counts only, no database access
  python3 scripts/market-cycle/sync-registry.py --live    # + diff summary against the DB (read-only)
  python3 scripts/market-cycle/sync-registry.py --write   # apply (needs the cycle_* migrations)
Stdlib only.
"""
import argparse, datetime as dt, json, os, sys, urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sources as S  # noqa: E402

CLAIM_PATCH_COLS = [c for c in S.CLAIM_CONFIG_COLS if c != "id"]
DIAL_CMP_COLS = list(S.DIAL_COLS) + ["fetch_method", "notes", "corridor"]


def canon(v):
    return json.dumps(v, sort_keys=True, default=str)


def plan(cfg, db=None):
    """-> dict of planned rows + diff (when db rows given). db = {table: rows} or None."""
    p = {"version": S.version_row(cfg)}
    have_dials = {r["id"]: r for r in (db or {}).get("cycle_dials", [])}
    p["dials"] = [S.dial_row(d, None, (have_dials.get(d["id"]) or {}).get("corridor")) for d in cfg["dials"]]
    p["claims"] = [S.claim_row(c, cfg["version"]) for c in cfg["claims"]]
    p["calendar"] = [S.calendar_row(c) for c in cfg["calendar"]]
    if db is None:
        return p

    diff = {}
    changed = []
    for r in p["dials"]:
        h = have_dials.get(r["id"])
        if h is None:
            continue
        cols = [c for c in DIAL_CMP_COLS if canon(r.get(c)) != canon(h.get(c))]
        if cols:
            changed.append((r["id"], cols))
    ids = {r["id"] for r in p["dials"]}
    diff["dials"] = {"new": [r["id"] for r in p["dials"] if r["id"] not in have_dials], "changed": changed,
                     "unchanged": len(ids & set(have_dials)) - len(changed), "db_only": sorted(set(have_dials) - ids)}

    have_claims = {r["id"]: r for r in db.get("cycle_claims", [])}
    changed = []
    for r in p["claims"]:
        h = have_claims.get(r["id"])
        if h is None:
            continue
        cols = [c for c in CLAIM_PATCH_COLS if canon(_norm(c, r.get(c))) != canon(_norm(c, h.get(c)))]
        if cols:
            changed.append((r["id"], cols))
    diff["claims"] = {"new": [r["id"] for r in p["claims"] if r["id"] not in have_claims], "changed": changed,
                      "unchanged": len({r["id"] for r in p["claims"]} & set(have_claims)) - len(changed),
                      "db_only": sorted(set(have_claims) - {r["id"] for r in p["claims"]})}

    have_v = {r["version"]: r for r in db.get("cycle_thesis_versions", [])}
    hv = have_v.get(p["version"]["version"])
    diff["version"] = "new" if hv is None else ("changed" if canon(hv.get("config")) != canon(p["version"]["config"]) or str(hv.get("date"))[:10] != p["version"]["date"] else "unchanged")

    have_cal = {}
    for r in db.get("cycle_calendar", []):
        have_cal.setdefault(r["label"], r)
    changed = []
    for r in p["calendar"]:
        h = have_cal.get(r["label"])
        if h is None:
            continue
        cols = [c for c in ("date", "dial_id", "tentative") if canon(_norm(c, r.get(c))) != canon(_norm(c, h.get(c)))]
        if cols:
            changed.append((r["label"], cols, h["id"]))
    labels = {r["label"] for r in p["calendar"]}
    diff["calendar"] = {"new": [r["label"] for r in p["calendar"] if r["label"] not in have_cal], "changed": changed,
                        "unchanged": len(labels & set(have_cal)) - len(changed), "db_only": sorted(set(have_cal) - labels)}
    p["diff"] = diff
    return p


def _norm(col, v):
    if v is None:
        return None
    if col in ("date", "resolves_on"):
        return str(v)[:10]
    if col == "prob_initial":
        return float(v)
    return v


def read_db(sb, key):
    out = {}
    for t, sel in (("cycle_dials", "*"), ("cycle_claims", "*"), ("cycle_thesis_versions", "version,date,config"), ("cycle_calendar", "id,date,label,dial_id,tentative")):
        out[t] = S.sb_req(sb, key, "GET", "%s?select=%s" % (t, sel)) or []
    return out


def apply(sb, key, p):
    d = p["diff"]
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    S.sb_req(sb, key, "POST", "cycle_thesis_versions?on_conflict=version", [p["version"]], prefer="resolution=merge-duplicates,return=minimal")
    S.sb_req(sb, key, "POST", "cycle_dials?on_conflict=id", [dict(r, updated_at=now) for r in p["dials"]], prefer="resolution=merge-duplicates,return=minimal")
    new_c = [r for r in p["claims"] if r["id"] in set(d["claims"]["new"])]
    if new_c:
        S.sb_req(sb, key, "POST", "cycle_claims", new_c, prefer="return=minimal")
    by_id = {r["id"]: r for r in p["claims"]}
    for cid, cols in d["claims"]["changed"]:
        S.sb_req(sb, key, "PATCH", "cycle_claims?id=eq.%s" % S.q(cid), dict({c: by_id[cid][c] for c in CLAIM_PATCH_COLS}, updated_at=now), prefer="return=minimal")
    new_cal = [r for r in p["calendar"] if r["label"] in set(d["calendar"]["new"])]
    if new_cal:
        S.sb_req(sb, key, "POST", "cycle_calendar", new_cal, prefer="return=minimal")
    by_label = {r["label"]: r for r in p["calendar"]}
    for label, cols, rid in d["calendar"]["changed"]:
        r = by_label[label]
        S.sb_req(sb, key, "PATCH", "cycle_calendar?id=eq.%s" % rid, {"date": r["date"], "dial_id": r["dial_id"], "tentative": r["tentative"]}, prefer="return=minimal")


def print_plan(p):
    print("would upsert: %d dials, %d claims, %d thesis version (v%s), %d calendar rows" % (
        len(p["dials"]), len(p["claims"]), 1, p["version"]["version"], len(p["calendar"])))
    fm = {}
    for r in p["dials"]:
        fm[r["fetch_method"]] = fm.get(r["fetch_method"], 0) + 1
    print("  dials by fetch_method: " + ", ".join("%s %d" % kv for kv in sorted(fm.items())))
    print("  dials with an authored corridor: %d; claims by scenario: %s" % (
        sum(1 for r in p["dials"] if r["corridor"]),
        ", ".join("%s %d" % (s, sum(1 for c in p["claims"] if c["scenario_tag"] == s)) for s in ("bear", "base", "bull"))))
    if "diff" not in p:
        return
    d = p["diff"]
    print("DIFF against the database")
    for t in ("dials", "claims", "calendar"):
        x = d[t]
        print("  %-9s new %d, changed %d, unchanged %d, in DB only %d" % (t, len(x["new"]), len(x["changed"]), x["unchanged"], len(x["db_only"])))
        for item in x["changed"][:15]:
            print("      ~ %s: %s" % (item[0], ", ".join(item[1])))
        if x["new"]:
            print("      + " + ", ".join(map(str, x["new"][:20])) + (" ..." if len(x["new"]) > 20 else ""))
        if x["db_only"]:
            print("      ? in DB, not in config (left alone): " + ", ".join(map(str, x["db_only"][:20])))
    print("  thesis v%s: %s" % (p["version"]["version"], d["version"]))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--live", action="store_true", help="read the DB and print a diff summary (no writes)")
    ap.add_argument("--write", action="store_true", help="apply the upserts")
    a = ap.parse_args(argv)
    cfg = S.load_config()
    mode = "WRITE" if a.write else ("LIVE READ (no writes)" if a.live else "DRY RUN (no database access)")
    print("market-cycle registry sync — thesis v%s (%s) — %s" % (cfg["version"], cfg["date"], mode))
    db = None
    if a.live or a.write:
        env = S.load_env()
        sb, key = env.get("LRG_SUPABASE_URL"), env.get("LRG_SUPABASE_SERVICE_KEY")
        if not sb or not key:
            sys.exit("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing from .env.local")
        try:
            db = read_db(sb, key)
        except (urllib.error.URLError, OSError, ValueError) as e:
            msg = e.read().decode()[:200] if isinstance(e, urllib.error.HTTPError) else str(e)
            if a.write:
                sys.exit("REFUSING --write: cannot read the cycle_* tables (%s). Apply the market-cycle migrations first." % msg)
            print("could not read the database (%s); counts only" % msg)
    p = plan(cfg, db)
    print_plan(p)
    if a.write:
        apply(sb, key, p)
        print("APPLIED")
    elif db is None:
        print("Dry run: nothing written.")


if __name__ == "__main__":
    main()
