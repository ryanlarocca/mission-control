#!/usr/bin/env python3
"""Market-cycle tracker: big-tripwire engine (thresholds only, no judgment).

Spec: briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md §3.4 (Tripwires), §3.5 (the
3-line card). Rules: config/market-cycle/thesis.v1.1.json → tripwires.big; every
threshold comes from the dial's `corridor` (or, for the SCC actives rule, from the
rule text) — nothing numeric is hard-coded here.

  threshold tripwires
    ccc_oas_record            ccc_oas >= corridor.tripwire_at_or_above on a two-day close (corridor.read_as = 2d_close)
    scc_actives_yoy           mls_scc_active_sfr YoY above +40% or below 0% for two consecutive weekly readings.
                              YoY uses our own reading ~52 weeks earlier when it exists; until then the Realtor.com
                              monthly series (realtor_active_scc) for the same month a year earlier, scaled by a fixed
                              calibration k = our count / Realtor's count (median over months both have; before any
                              overlap, our earliest reading / the latest Realtor print before it). Approximate by design.
    scc_price_reduced_record  realtor_price_reduced_share_scc >= corridor.bear_at_or_above for two consecutive readings
                              (the dial is monthly; "two consecutive weeks" in the rule = two consecutive readings)
    scc_warn_spike            scc_warn_workers >= corridor.bear_at_or_above in a month (one reading)
  event tripwires (no automatic source — recorded by hand as a manual reading)
    ant_ipo_fail (ant_ipo) · hormuz (hormuz_status) · fed_intermeeting (fomc_decision)
    fire when the dial has a reading with value 1 and source_url starting 'manual:tripwire'
  claim_early                 not automatic: resolved at the checkpoint review (reported as MANUAL)

Persistence fires once per episode: the alarm is raised on the reading that completes
the required run of consecutive crossings, not again while it persists, and a
(tripwire_id, fired_on) already in cycle_tripwire_events is never re-posted.

Recording an event tripwire (e.g. Anthropic pulls its IPO):
  python3 scripts/market-cycle/tripwires.py --record ant_ipo --date 2026-11-20 --note "ANT IPO postponed — <news url>"            # prints the row
  python3 scripts/market-cycle/tripwires.py --record ant_ipo --date 2026-11-20 --note "ANT IPO postponed — <news url>" --write    # inserts it
  (equivalent SQL: insert into cycle_readings (dial_id, as_of, value, source_url, raw)
   values ('ant_ipo', '2026-11-20', 1, 'manual:tripwire', 'ANT IPO postponed — <news url>');)
The next tripwires.py --live run fires it.

Usage:
  python3 scripts/market-cycle/tripwires.py --fixture scripts/market-cycle/tests/fixtures/tripwires.json
  python3 scripts/market-cycle/tripwires.py --live                       # read readings, print evaluation + cards
  python3 scripts/market-cycle/tripwires.py --live --write --post        # launchd: insert events, post the 3-line card
Stdlib only.
"""
import argparse
import datetime as dt
import html
import json
import os
import re
import statistics
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CONFIG = os.path.join(ROOT, "config", "market-cycle", "thesis.v1.1.json")
ENV_PATHS = [os.path.join(ROOT, ".env.local"), "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local"]
MANUAL_SRC = "manual:tripwire"
EVENT_LOOKBACK_DAYS = 45            # an older manual event reading is history, not news
CONSECUTIVE_GAP_DAYS = {"daily": 5, "weekly": 10, "monthly": 45}   # max gap for two readings to count as consecutive
EVENT_TRIPWIRES = {"ant_ipo_fail", "hormuz", "fed_intermeeting"}


# ---------------------------------------------------------------- helpers
def d(s):
    return dt.date.fromisoformat(str(s)[:10])


def nice_date(s):
    x = d(s)
    return "%s %d, %d" % (x.strftime("%b"), x.day, x.year)            # always with the year


def fmt_num(v, units=""):
    if v is None:
        return "—"
    s = ("{:,.0f}".format(v) if abs(v) >= 100 else "{:,.2f}".format(v).rstrip("0").rstrip("."))
    return s + (" " + units if units else "")


def series(readings, dial_id, exclude_manual=True):
    rows = [r for r in readings if r["dial_id"] == dial_id and r.get("value") is not None
            and not (exclude_manual and str(r.get("source_url") or "").startswith(MANUAL_SRC))]
    best = {}
    for r in sorted(rows, key=lambda r: (str(r["as_of"])[:10], str(r.get("source_url") or ""))):
        best[str(r["as_of"])[:10]] = float(r["value"])                 # one value per date
    return sorted(best.items())


def onset(points, cond, k, max_gap):
    """points: [(date, value)] ascending. Returns the index i where `cond` first holds for k consecutive
    readings ending at i (each gap <= max_gap days) while it did not already hold for k readings ending
    at i-1 — i.e. once per episode. Returns the LAST such onset (most recent episode) or None."""
    found = None
    run = 0
    for i, (day, v) in enumerate(points):
        contiguous = i > 0 and (d(day) - d(points[i - 1][0])).days <= max_gap
        if cond(v):
            run = run + 1 if (run and contiguous) else 1
        else:
            run = 0
        if run == k:
            found = i
    return found


def card(what, reading_text, day):
    """The tripwire card: exactly three lines (§3.5)."""
    return "\n".join([
        "🚨 <b>Tripwire:</b> %s" % html.escape(what),
        "%s (%s)" % (html.escape(reading_text), nice_date(day)),
        "Out-of-cycle review within 24h",
    ])


# ---------------------------------------------------------------- evaluators
def ev_threshold(tw, dial, readings, k, key_label, today):
    cor = dial.get("corridor") or {}
    key = next((x for x in ("tripwire_at_or_above", "bear_at_or_above") if x in cor), None) if key_label is None else key_label
    if key is None or key not in cor:
        return {"status": "NO_THRESHOLD", "detail": "dial %s has no %s in its corridor" % (dial["id"], key_label or "threshold")}
    thr = float(cor[key])
    pts = series(readings, dial["id"])
    if not pts:
        return {"status": "NO_DATA", "detail": "no readings for %s" % dial["id"]}
    gap = CONSECUTIVE_GAP_DAYS.get(dial["cadence"], 45)
    i = onset(pts, lambda v: v >= thr, k, gap)
    latest = pts[-1]
    base = "latest %s = %s on %s; threshold >= %s (%s), %d consecutive" % (dial["id"], fmt_num(latest[1]), latest[0], fmt_num(thr), key, k)
    if i is None:
        return {"status": "QUIET", "detail": base}
    day, v = pts[i]
    what = "%s at or above %s%s" % (dial["name"], fmt_num(thr, dial.get("units") or ""), " for %d consecutive readings" % k if k > 1 else "")
    return {"status": "FIRED", "fired_on": day, "reading": v, "detail": base + "; crossing completed on %s" % day,
            "card": card(what, "Reading: %s" % fmt_num(v, dial.get("units") or ""), day)}


def scc_yoy_points(readings, today):
    """[(date, yoy_pct, basis)] for every mls_scc_active_sfr reading where a YoY can be formed."""
    own = series(readings, "mls_scc_active_sfr")
    realtor = {k[:7]: v for k, v in series(readings, "realtor_active_scc")}
    if not own:
        return [], "no mls_scc_active_sfr readings"
    overlaps = [v / realtor[day[:7]] for day, v in own if day[:7] in realtor and realtor[day[:7]]]
    kcal, kdesc = None, None
    if overlaps:
        kcal = statistics.median(overlaps)
        kdesc = "k = median over %d overlapping month(s) = %.3f" % (len(overlaps), kcal)
    else:
        first_day, first_v = own[0]
        prior = [(m, v) for m, v in sorted(realtor.items()) if m <= first_day[:7]]
        if prior:
            kcal = first_v / prior[-1][1]
            kdesc = "k = our first reading %s (%s) / Realtor %s (%s) = %.3f (no overlapping month yet)" % (fmt_num(first_v), first_day, prior[-1][0], fmt_num(prior[-1][1]), kcal)
    out = []
    for day, v in own:
        x = d(day)
        mine = [ov for od, ov in own if 357 <= (x - d(od)).days <= 371]
        if mine:
            out.append((day, 100.0 * (v / mine[-1] - 1), "own reading 52 weeks earlier"))
            continue
        ya = "%04d-%02d" % (x.year - 1, x.month)
        if kcal and ya in realtor and realtor[ya]:
            out.append((day, 100.0 * ((v / kcal) / realtor[ya] - 1), "Realtor.com %s x calibration" % ya))
    return out, kdesc


def ev_scc_actives(tw, dial, readings, today):
    m = re.search(r"above \+(\d+(?:\.\d+)?)% YoY or below (-?\d+(?:\.\d+)?)% YoY", tw["rule"])
    if not m:
        return {"status": "NO_THRESHOLD", "detail": "could not read the +x% / y% thresholds from the rule text"}
    hi, lo = float(m.group(1)), float(m.group(2))
    k = 2 if "two consecutive" in tw["rule"] else 1
    pts, kdesc = scc_yoy_points(readings, today)
    if not pts:
        return {"status": "NO_DATA", "detail": "no YoY could be formed (%s)" % (kdesc or "no Realtor.com year-ago month / calibration")}
    gap = CONSECUTIVE_GAP_DAYS["weekly"]
    yo = [(day, y) for day, y, _ in pts]
    latest = pts[-1]
    base = "latest YoY %+.1f%% on %s (%s; %s); fire above +%g%% or below %g%%, %d consecutive weeks" % (latest[1], latest[0], latest[2], kdesc, hi, lo, k)
    hits = [(onset(yo, lambda v: v > hi, k, gap), "above +%g%%" % hi), (onset(yo, lambda v: v < lo, k, gap), "below %g%%" % lo)]
    hits = [(i, side) for i, side in hits if i is not None]
    if not hits:
        return {"status": "QUIET", "detail": base}
    i, side = max(hits)
    day, y = yo[i]
    v = dict(series(readings, "mls_scc_active_sfr"))[day]
    what = "SCC active SFR count %s YoY for %d consecutive weeks" % (side, k)
    return {"status": "FIRED", "fired_on": day, "reading": round(y, 2), "detail": base + "; crossing completed on %s" % day,
            "card": card(what, "Reading: %s actives, %+.1f%% YoY" % (fmt_num(v), y), day)}


def ev_event(tw, dial, readings, today):
    rows = [r for r in readings if r["dial_id"] == dial["id"] and str(r.get("source_url") or "").startswith(MANUAL_SRC)
            and r.get("value") is not None and float(r["value"]) == 1.0 and (today - d(r["as_of"])).days <= EVENT_LOOKBACK_DAYS]
    if not rows:
        return {"status": "QUIET", "detail": "no manual event reading (value 1, source_url '%s') for %s in the last %d days" % (MANUAL_SRC, dial["id"], EVENT_LOOKBACK_DAYS)}
    r = sorted(rows, key=lambda r: str(r["as_of"]))[-1]
    note = str(r.get("raw") or "").strip() or tw["rule"]
    day = str(r["as_of"])[:10]
    return {"status": "FIRED", "fired_on": day, "reading": 1, "detail": "manual reading on %s: %s" % (day, note[:200]),
            "card": card(tw["rule"], note[:300], day)}


def evaluate(cfg, readings, events, today):
    dials = {x["id"]: x for x in cfg["dials"]}
    done = {(e["tripwire_id"], str(e["fired_on"])[:10]) for e in events}
    out = []
    for tw in cfg["tripwires"]["big"]:
        dial = dials.get(tw["dial_id"]) if tw["dial_id"] else None
        if tw["id"] == "claim_early" or dial is None:
            res = {"status": "MANUAL", "detail": "no automatic source: claims are resolved at the checkpoint review"}
        elif tw["id"] in EVENT_TRIPWIRES:
            res = ev_event(tw, dial, readings, today)
        elif tw["id"] == "scc_actives_yoy":
            res = ev_scc_actives(tw, dial, readings, today)
        elif tw["id"] == "ccc_oas_record":
            k = 2 if (dial.get("corridor") or {}).get("read_as") == "2d_close" else 1
            res = ev_threshold(tw, dial, readings, k, "tripwire_at_or_above", today)
        else:
            k = 2 if "two consecutive" in tw["rule"] else 1
            res = ev_threshold(tw, dial, readings, k, "bear_at_or_above", today)
        res.update({"tripwire_id": tw["id"], "dial_id": tw["dial_id"], "rule": tw["rule"]})
        if res["status"] == "FIRED" and (tw["id"], res["fired_on"]) in done:
            res["status"] = "ALREADY_FIRED"
        out.append(res)
    return out


# ---------------------------------------------------------------- IO
def load_env():
    env = {}
    for ep in ENV_PATHS:
        if os.path.exists(ep):
            env = dict((k, v.strip("'\"")) for k, v in re.findall(r"^([A-Z0-9_]+)=(.*)$", open(ep).read(), re.M))
            break
    env.update({k: v for k, v in os.environ.items() if re.match(r"^[A-Z0-9_]+$", k)})
    return env


def sb_req(sb, key, method, path, body=None, prefer=None):
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    req = urllib.request.Request(sb + "/rest/v1/" + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        t = r.read().decode()
        return json.loads(t) if t else None


def sb_get_all(sb, key, path, page=1000):
    out, off = [], 0
    while True:
        rows = sb_req(sb, key, "GET", "%s&limit=%d&offset=%d" % (path, page, off))
        out += rows
        if len(rows) < page:
            return out
        off += page


def live_inputs(cfg, env, today):
    sb, key = env.get("LRG_SUPABASE_URL"), env.get("LRG_SUPABASE_SERVICE_KEY")
    if not sb or not key:
        sys.exit("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing")
    ids = sorted({t["dial_id"] for t in cfg["tripwires"]["big"] if t["dial_id"]} | {"realtor_active_scc"})
    since = (today - dt.timedelta(days=430)).isoformat()
    readings = sb_get_all(sb, key, "cycle_readings?select=dial_id,as_of,value,source_url,raw&dial_id=in.(%s)&as_of=gte.%s&order=as_of.asc,id.asc"
                          % (",".join(ids), since))
    events = sb_get_all(sb, key, "cycle_tripwire_events?select=tripwire_id,fired_on&order=id.asc")
    return readings, events, sb, key


def post_card(env, text):
    token = env.get("CAMPAIGN_BOT_TOKEN") or env.get("TELEGRAM_BOT_TOKEN")    # Marketing bot first, as lib/campaignAlerts.ts
    chat = env.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return False, "CAMPAIGN_BOT_TOKEN/TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing"

    def send(body):
        req = urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % token, data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode())
    try:
        send({"chat_id": chat, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True})
        return True, "sent"
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:200]
        try:                                              # formatting rejection → plain text; degraded > lost
            send({"chat_id": chat, "text": re.sub(r"<[^>]+>", "", html.unescape(text))})
            return True, "sent as plain text (HTML rejected: %s)" % detail
        except Exception as e2:
            return False, "HTTP %d %s; plain retry: %s" % (e.code, detail, e2)
    except Exception as e:
        return False, "%s: %s" % (type(e).__name__, e)


def record_manual(cfg, a, env):
    dials = {x["id"] for x in cfg["dials"]}
    if a.record not in dials:
        sys.exit("unknown dial id %s" % a.record)
    if not a.note:
        sys.exit("--note is required (what happened + a source link)")
    row = {"dial_id": a.record, "as_of": a.date or dt.date.today().isoformat(), "value": 1, "source_url": MANUAL_SRC, "raw": a.note}
    print(json.dumps(row, ensure_ascii=False))
    if a.write:
        sb, key = env.get("LRG_SUPABASE_URL"), env.get("LRG_SUPABASE_SERVICE_KEY")
        sb_req(sb, key, "POST", "cycle_readings?on_conflict=dial_id,as_of,source_url", [row], prefer="resolution=merge-duplicates,return=minimal")
        print("inserted")
    else:
        print("dry run: add --write to insert")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    src = ap.add_mutually_exclusive_group()
    src.add_argument("--fixture", help="JSON {today?, readings: [...], events?: [...]}")
    src.add_argument("--live", action="store_true", help="read cycle_readings / cycle_tripwire_events")
    src.add_argument("--record", metavar="DIAL_ID", help="record a manual event reading (value 1, source_url manual:tripwire)")
    ap.add_argument("--date"); ap.add_argument("--note")
    ap.add_argument("--today", help="evaluation date (default today, or the fixture's)")
    ap.add_argument("--write", action="store_true", help="insert fired events into cycle_tripwire_events (live only)")
    ap.add_argument("--post", action="store_true", help="post each new card via the Marketing bot")
    a = ap.parse_args()
    cfg = json.load(open(CONFIG))
    env = load_env()
    if a.record:
        return record_manual(cfg, a, env)
    if not a.fixture and not a.live:
        ap.error("one of --fixture / --live / --record is required")
    sb = key = None
    if a.fixture:
        fx = json.load(open(a.fixture))
        today = d(a.today or fx.get("today") or dt.date.today().isoformat())
        readings, events = fx["readings"], fx.get("events", [])
        if a.write:
            sys.exit("--write is only meaningful with --live")
    else:
        today = d(a.today) if a.today else dt.date.today()
        readings, events, sb, key = live_inputs(cfg, env, today)
    print("market-cycle tripwires — %s — %s — %d readings, %d past events" % (today.isoformat(), "fixture " + a.fixture if a.fixture else "live", len(readings), len(events)))
    results = evaluate(cfg, readings, events, today)
    for r in results:
        print("\n%-25s %-14s %s" % (r["tripwire_id"], r["status"], r["detail"]))
        if r["status"] == "FIRED":
            print("  ┌ card")
            for line in r["card"].split("\n"):
                print("  │ " + line)
            ev_id = None
            if a.write:
                row = {"tripwire_id": r["tripwire_id"], "dial_id": r["dial_id"], "fired_on": r["fired_on"], "reading": r["reading"],
                       "detail": r["card"] + "\n---\n" + r["detail"], "review_requested": True}
                got = sb_req(sb, key, "POST", "cycle_tripwire_events?on_conflict=tripwire_id,fired_on", [row], prefer="resolution=ignore-duplicates,return=representation")
                ev_id = got[0]["id"] if got else None
                print("  event row %s" % ("inserted id=%s" % ev_id if ev_id else "already present (not re-posted)"))
                if not ev_id:
                    continue
            if a.post:
                ok, why = post_card(env, r["card"])
                print("  telegram: %s" % why)
                if ok and ev_id:
                    sb_req(sb, key, "PATCH", "cycle_tripwire_events?id=eq.%s" % ev_id, {"posted_at": dt.datetime.now(dt.timezone.utc).isoformat()}, prefer="return=minimal")
            else:
                print("  (not posted: add --post)")
    fired = [r for r in results if r["status"] == "FIRED"]
    print("\n%d fired, %d already fired, %d quiet, %d no data, %d manual" % (
        len(fired), sum(r["status"] == "ALREADY_FIRED" for r in results), sum(r["status"] == "QUIET" for r in results),
        sum(r["status"] in ("NO_DATA", "NO_THRESHOLD") for r in results), sum(r["status"] == "MANUAL" for r in results)))


if __name__ == "__main__":
    main()
