#!/usr/bin/env python3
"""Market-cycle tracker: the macro-context block an agent prints next to comps.

Spec: briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md §3.7 ("Comps context for
agents"). Context, never a substitute for pocket comps. At most 10 lines:

  1  label + zip + price + as-of
  2  scenario weights + where the scored object (SCC ZHVI max drawdown) stands in the partition
  3  county: ZHVI YoY, actives YoY, median days on site, price-cut share, list-to-sale
  4  the price tier (config geographies.tiers): actives, days on site, cut share, 90-day sold $/sf if present
  5  the zip: actives, days on site, cut share, 90-day sold $/sf if present, ZHVI YoY
  6  stale-comp drift: zip ZHVI change over the last 60 / 90 days (county index when no zip level series is stored)
  7  exit framing (only with --exit-month): each scenario's implied move by that month
  8  last checkpoint one-liner + next checkpoint date

Missing data prints "n/a (no reading yet)"; nothing is ever filled in.

Exit framing approximation: the county drawdown moves in a straight line from
today's print to the midpoint of each scenario's band by that scenario's
typical trough month, then stays flat; the tier is assumed to follow the county
path. Band midpoints: Bear = midpoint of -15% and the series' worst historical
drawdown (2007-11, -29.9% on the SFR series); Base = -11.5%; Bull = midpoint of -8% and the
deepest drawdown so far. Typical trough months come from the scenario markers
(Bull Q4 2026-Q1 2027 -> 2027-01, Base H1-mid 2027 -> 2027-05, Bear 2028 ->
2028-06) unless the config carries a scenario "trough_month".

Usage:
  python3 scripts/market-cycle/cycle-context.py --zip 95123 --price 1150000 [--exit-month 2027-04]
  python3 scripts/market-cycle/cycle-context.py --zip 95123 --price 1150000 --fixture path.json [--json]

Reads Supabase over PostgREST with the service key from .env.local (GET only,
same env loading as bootstrap-history.py). --fixture reads the same data shape
from a JSON file instead (see scripts/market-cycle/tests/fixtures/). The Vercel
route app/api/cycle/context/route.ts renders the identical block
(lib/cycleContext.ts; tests/market-cycle-context.unit.test.ts checks parity).
Stdlib only.
"""
import argparse, datetime as dt, glob, json, os, re, sys, urllib.parse, urllib.request
from decimal import Decimal, ROUND_HALF_UP

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ENV_PATHS = [os.path.join(ROOT, ".env.local"), "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local"]
NA = "n/a (no reading yet)"
LABEL = "MACRO CONTEXT (market-cycle tracker) — context, not comps"
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
DEFAULT_TROUGH = {"bull": "2027-01", "base": "2027-05", "bear": "2028-06"}
QUARTERLY_MONTHS = (2, 5, 8, 11)


# ---------------------------------------------------------------- config
def load_config():
    def ver(p):
        m = re.search(r"thesis\.v([\d.]+)\.json$", p)
        return tuple(int(x) for x in m.group(1).split(".")) if m else (0,)
    files = sorted(glob.glob(os.path.join(ROOT, "config", "market-cycle", "thesis.v*.json")), key=ver)
    with open(files[-1]) as f:
        return json.load(f)


# ---------------------------------------------------------------- formatting (mirrors lib/cycleContext.ts exactly)
def fnum(x, d=1):
    q = Decimal(1).scaleb(-d) if d > 0 else Decimal(1)
    s = str(Decimal(float(x)).quantize(q, rounding=ROUND_HALF_UP))
    if re.fullmatch(r"-0(\.0+)?", s):
        s = s[1:]
    return s


def fint(x):
    s = fnum(x, 0)
    neg = s.startswith("-")
    s = s.lstrip("-")
    s = re.sub(r"\B(?=(\d{3})+(?!\d))", ",", s)
    return ("-" if neg else "") + s


def fsigned(x, d=1):
    s = fnum(x, d)
    if not s.startswith("-") and float(s) != 0:
        s = "+" + s
    return s + "%"


def fmoney(v):
    if v >= 1e6:
        return "$" + fnum(v / 1e6, 2) + "M"
    if v >= 1e3:
        return "$" + fnum(v / 1e3, 0) + "k"
    return "$" + fint(v)


def date_label(iso):
    y, m, d = int(iso[:4]), int(iso[5:7]), int(iso[8:10])
    return "%s %d, %d" % (MONTHS[m - 1], d, y)


def month_label(ym):
    return "%s %d" % (MONTHS[int(ym[5:7]) - 1], int(ym[:4]))


# ---------------------------------------------------------------- series helpers
def month_index(ym):
    return int(ym[:4]) * 12 + int(ym[5:7]) - 1


def shift_month(ym, k):
    i = month_index(ym) + k
    return "%04d-%02d" % (i // 12, i % 12 + 1)


def series(data, dial):
    out = [(r[0], r[1]) for r in (data.get("readings") or {}).get(dial) or [] if r and r[1] is not None]
    return sorted(out, key=lambda r: r[0])


def latest(data, dial):
    s = series(data, dial)
    return s[-1] if s else None


def months_back(s, k):
    """Reading whose month is k months before the latest reading's month."""
    if not s:
        return None
    want = shift_month(s[-1][0][:7], -k)
    hit = [r for r in s if r[0][:7] == want]
    return hit[-1] if hit else None


def days_between(a, b):
    return (dt.date.fromisoformat(b) - dt.date.fromisoformat(a)).days


def near_days_back(s, days, tol):
    """Weekly series: the reading closest to `days` before the latest, within `tol` days."""
    if not s:
        return None
    best = None
    for r in s[:-1]:
        off = abs(days_between(r[0], s[-1][0]) - days)
        if off <= tol and (best is None or off < best[0]):
            best = (off, r)
    return best[1] if best else None


def pct_change(new, old):
    return (new / old - 1) * 100


# ---------------------------------------------------------------- pieces
def weights_part(data, cfg):
    wm = data.get("weight_move")
    cp = data.get("checkpoint")
    if wm and wm.get("to_weights"):
        w, src = wm["to_weights"], "weight log, " + date_label(wm["date"])
    elif cp and cp.get("weights_after"):
        w, src = cp["weights_after"], "checkpoint, " + date_label(cp["date"])
    else:
        w, src = {s["id"]: s["weight"] for s in cfg["scenarios"]}, "thesis v" + cfg["version"]
    names = {"bear": "Bear", "base": "Base", "bull": "Bull"}
    parts = ["%s %s" % (names[k], fnum(w.get(k), 0) if w.get(k) is not None else "n/a") for k in ("bear", "base", "bull")]
    return "Weights: " + " · ".join(parts) + " (" + src + ")"


def drawdown_state(data, cfg):
    """-> dict(today, deepest, month) in % vs the reference peak, or None."""
    ref = cfg["scored_object"]["reference_peak"]
    s = [r for r in series(data, "zhvi_scc") if r[0][:7] >= ref["month"]]
    if not s:
        return None
    dds = [pct_change(v, ref["value"]) for _, v in s]
    return {"today": dds[-1], "deepest": min(0.0, min(dds)), "month": s[-1][0][:7]}


def bands(cfg, deepest):
    b = {s["id"]: s["drawdown_bounds_pct"] for s in cfg["scenarios"]}
    floor = min(cfg["scored_object"]["historical_drawdowns_same_series"].values())
    return {
        "bear": (floor, b["bear"]["max"]),
        "base": (b["base"]["min"], b["base"]["max"]),
        "bull": (b["bull"]["min"], deepest),
    }


def partition_part(dd, cfg):
    if not dd:
        return "partition: " + NA
    b = {s["id"]: s["drawdown_bounds_pct"] for s in cfg["scenarios"]}
    bear_at, bull_floor = b["bear"]["max"], b["bull"]["min"]
    head = "SCC ZHVI %s vs %s peak (%s), deepest %s" % (
        fsigned(dd["today"]), month_label(cfg["scored_object"]["reference_peak"]["month"]), month_label(dd["month"]), fsigned(dd["deepest"]))
    if dd["deepest"] <= bear_at:
        where = "Bear band reached"
    elif dd["deepest"] <= bull_floor:
        where = "Base band reached, Bull ruled out (Bear at %s)" % fsigned(bear_at, 0)
    else:
        where = "inside the Bull band so far (Base at %s, Bear at %s)" % (fsigned(bull_floor, 0), fsigned(bear_at, 0))
    return head + " → " + where


def val(data, dial, fmt):
    r = latest(data, dial)
    return fmt(r[1]) if r else None


def pct_plain(x):
    return fnum(x, 1) + "%"


def days(x):
    return fint(x) + "d"


def ppsf(x):
    return "$" + fint(x) + "/sf"


def county_line(data):
    zy = val(data, "zhvi_scc_yoy", fsigned)
    if zy is None:
        s = series(data, "zhvi_scc")
        prev = months_back(s, 12)
        zy = fsigned(pct_change(s[-1][1], prev[1])) if prev else None
    act = None
    s = series(data, "mls_scc_active_sfr")
    prev = near_days_back(s, 364, 4)
    if prev:
        act = fsigned(pct_change(s[-1][1], prev[1]), 0)
    else:
        s = series(data, "realtor_active_scc")
        prev = months_back(s, 12)
        if prev:
            act = fsigned(pct_change(s[-1][1], prev[1]), 0) + " (Realtor.com)"
    dos = val(data, "mls_scc_median_dos", days)
    if dos is None:
        dos = val(data, "realtor_dom_scc", lambda x: days(x) + " (Realtor.com DOM)")
    cut = val(data, "mls_scc_price_cut_share", pct_plain)
    if cut is None:
        cut = val(data, "realtor_price_reduced_share_scc", lambda x: pct_plain(x) + " (Realtor.com)")
    lts = val(data, "mls_scc_list_to_sale", pct_plain)
    return "County (SCC): ZHVI YoY %s · actives YoY %s · days on site %s · price-cut share %s · list-to-sale %s" % tuple(
        x if x is not None else NA for x in (zy, act, dos, cut, lts))


def tier_for(cfg, price):
    for t in cfg["geographies"]["tiers"]:
        if (t["min"] is None or price >= t["min"]) and (t["max"] is None or price < t["max"]):
            return t
    return None


def local_parts(data, prefix):
    parts = [
        "actives " + (val(data, prefix + "_active_sfr", fint) or NA),
        "days on site " + (val(data, prefix + "_median_dos", days) or NA),
        "cut share " + (val(data, prefix + "_price_cut_share", pct_plain) or NA),
    ]
    sold = val(data, prefix + "_sold_ppsf_90d", ppsf)
    if sold:
        parts.append("sold 90d " + sold)
    return parts


def tier_line(data, cfg, price):
    t = tier_for(cfg, price)
    if not t:
        return "Tier: " + NA
    return "Tier %s (SCC): %s" % (t["label"], " · ".join(local_parts(data, "mls_scc_tier_" + t["id"])))


def zip_line(data, z):
    parts = local_parts(data, "mls_zip_" + z)
    parts.append("ZHVI YoY " + (val(data, "zhvi_zip_" + z, fsigned) or NA))
    return "Zip %s: %s" % (z, " · ".join(parts))


def drift_line(data, z):
    s, label = series(data, "zhvi_zip_%s_level" % z), "zip %s ZHVI" % z
    if not s:
        s, label = series(data, "zhvi_scc"), "county ZHVI, no zip level series yet"
    if not s:
        return "Stale-comp drift: " + NA
    p60, p90 = months_back(s, 2), months_back(s, 3)
    d60 = fsigned(pct_change(s[-1][1], p60[1])) if p60 else NA
    d90 = fsigned(pct_change(s[-1][1], p90[1])) if p90 else NA
    tail = " → a comp sold 90 days ago: index moved %s since" % d90 if p90 else ""
    return "Stale-comp drift (%s; latest print %s): 60d %s · 90d %s%s" % (label, month_label(s[-1][0][:7]), d60, d90, tail)


def exit_path(dd, cfg, exit_month):
    """-> list of (scenario id, move % vs today, ruled_out). Pure; see the module docstring."""
    out = []
    bb = bands(cfg, dd["deepest"])
    for sc in cfg["scenarios"]:
        sid = sc["id"]
        lo, hi = bb[sid]
        if sid != "bear" and dd["deepest"] <= lo:   # the max drawdown already went past this band
            out.append((sid, None, True))
            continue
        mid = (lo + hi) / 2
        trough = sc.get("trough_month") or DEFAULT_TROUGH[sid]
        span = month_index(trough) - month_index(dd["month"])
        gone = month_index(exit_month) - month_index(dd["month"])
        frac = 1.0 if span <= 0 else max(0.0, min(1.0, gone / span))
        dd_exit = dd["today"] + (mid - dd["today"]) * frac
        move = ((1 + dd_exit / 100) / (1 + dd["today"] / 100) - 1) * 100
        out.append((sid, move, False))
    return out


def exit_line(data, cfg, price, exit_month):
    dd = drawdown_state(data, cfg)
    head = "Exit %s" % month_label(exit_month)
    if not dd:
        return head + ": " + NA
    t = tier_for(cfg, price)
    names = {"bear": "Bear", "base": "Base", "bull": "Bull"}
    parts = []
    for sid, move, out in exit_path(dd, cfg, exit_month):
        parts.append("%s ruled out" % names[sid] if out else "%s %s (~%s)" % (names[sid], fsigned(move), fmoney(price * (1 + move / 100))))
    return "%s (%s ≈ county; straight line from today's %s to each band's midpoint by its typical trough, flat after): %s" % (
        head, t["label"] if t else "tier", fsigned(dd["today"]), " · ".join(parts))


def next_checkpoint(data, cfg, today):
    sch = cfg["checkpoint_schedule"]
    if today <= sch["shakedown"]:
        return sch["shakedown"], "shakedown"
    if today <= sch["first_formal"]:
        return sch["first_formal"], "first formal review"
    cal = data.get("calendar")
    if not cal:
        cal = [{"date": c["date"], "dial_id": c["dial_id"]} for c in cfg["calendar"]]
    cpi = sorted(c["date"] for c in cal if c.get("dial_id") == "cpi_yoy" and c.get("date") and re.match(r"\d{4}-\d{2}-\d{2}$", c["date"]))
    for d in cpi:
        x = dt.date.fromisoformat(d)
        monday = x + dt.timedelta(days=(7 - x.weekday()) % 7 or 7)
        if monday.isoformat() >= today:
            return monday.isoformat(), "quarterly" if monday.month in QUARTERLY_MONTHS else "monthly"
    return None, None


def one_liner(text, n=110):
    t = re.sub(r"\s+", " ", str(text or "")).strip()
    m = re.match(r"(.+?[.!?])(\s|$)", t)
    t = m.group(1) if m else t
    return t if len(t) <= n else t[: n - 1].rstrip() + "…"


def checkpoint_line(data, cfg, today):
    cp = data.get("checkpoint")
    if cp:
        last = "Last checkpoint %s (%s): %s" % (date_label(cp["date"]), cp.get("kind") or "?", one_liner(cp.get("argument")) or "no argument stored")
    else:
        last = "Last checkpoint: n/a (none yet)"
    d, kind = next_checkpoint(data, cfg, today)
    return last + " · Next: " + ("%s (%s)" % (date_label(d), kind) if d else "n/a (no CPI date on the calendar)")


def render(data, cfg, zip_code, price, exit_month=None, today=None):
    today = today or data.get("today") or dt.date.today().isoformat()
    dd = drawdown_state(data, cfg)
    lines = [
        "%s · zip %s · %s · as of %s" % (LABEL, zip_code, fmoney(price), date_label(today)),
        weights_part(data, cfg) + " | " + partition_part(dd, cfg),
        county_line(data),
        tier_line(data, cfg, price),
        zip_line(data, zip_code),
        drift_line(data, zip_code),
    ]
    if exit_month:
        lines.append(exit_line(data, cfg, price, exit_month))
    lines.append(checkpoint_line(data, cfg, today))
    assert len(lines) <= 10
    return lines


# ---------------------------------------------------------------- Supabase (GET only)
def load_env():
    for ep in ENV_PATHS:
        if os.path.exists(ep):
            return dict((k, v.strip("'\"")) for k, v in re.findall(r"^([A-Z0-9_]+)=(.*)$", open(ep).read(), re.M))
    return {}


def context_dials(cfg, zip_code, price):
    ids = ["zhvi_scc", "zhvi_scc_yoy", "realtor_active_scc", "realtor_dom_scc", "realtor_price_reduced_share_scc",
           "mls_scc_active_sfr", "mls_scc_median_dos", "mls_scc_price_cut_share", "mls_scc_list_to_sale",
           "zhvi_zip_" + zip_code, "zhvi_zip_%s_level" % zip_code]
    t = tier_for(cfg, price)
    for prefix in (["mls_scc_tier_" + t["id"]] if t else []) + ["mls_zip_" + zip_code]:
        ids += [prefix + m for m in ("_active_sfr", "_median_dos", "_price_cut_share", "_sold_ppsf_90d")]
    return ids


def fetch_data(cfg, zip_code, price, today):
    env = load_env()
    sb, key = env.get("LRG_SUPABASE_URL"), env.get("LRG_SUPABASE_SERVICE_KEY")
    if not sb or not key:
        sys.exit("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing from .env.local (or pass --fixture)")

    def get(path):
        req = urllib.request.Request(sb + "/rest/v1/" + path, headers={"apikey": key, "Authorization": "Bearer " + key})
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode() or "null")

    q = urllib.parse.quote
    readings = {}
    for d in context_dials(cfg, zip_code, price):
        rows = get("cycle_readings?select=as_of,value&dial_id=eq.%s&variant=eq.&as_of=lte.%s&order=as_of.desc&limit=60" % (q(d), today))
        if rows:
            readings[d] = [[r["as_of"], r["value"]] for r in reversed(rows)]
    wm = get("cycle_weight_moves?select=date,to_weights&order=date.desc,id.desc&limit=1")
    cp = get("cycle_checkpoints?select=date,kind,weights_after,argument&date=lte.%s&order=date.desc,created_at.desc&limit=1" % today)
    since = shift_month(today[:7], -1) + "-01"   # a CPI print earlier this month still decides this month's Monday
    cal = get("cycle_calendar?select=date,label,dial_id&date=gte.%s&order=date.asc&limit=100" % since)
    return {"today": today, "readings": readings, "weight_move": wm[0] if wm else None, "checkpoint": cp[0] if cp else None, "calendar": cal or []}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--zip", required=True)
    ap.add_argument("--price", required=True, type=float)
    ap.add_argument("--exit-month", help="YYYY-MM")
    ap.add_argument("--fixture", help="read this JSON instead of Supabase")
    ap.add_argument("--today", help="YYYY-MM-DD (default: the fixture's today, else the system date)")
    ap.add_argument("--json", action="store_true", help="print {lines, text} as JSON")
    a = ap.parse_args()
    if not re.fullmatch(r"\d{5}", a.zip):
        sys.exit("--zip must be 5 digits")
    if a.exit_month and not re.fullmatch(r"\d{4}-(0[1-9]|1[0-2])", a.exit_month):
        sys.exit("--exit-month must be YYYY-MM")
    if a.price <= 0:
        sys.exit("--price must be positive")
    cfg = load_config()
    if a.fixture:
        with open(a.fixture) as f:
            data = json.load(f)
        today = a.today or data.get("today") or dt.date.today().isoformat()
    else:
        today = a.today or dt.date.today().isoformat()
        data = fetch_data(cfg, a.zip, a.price, today)
    lines = render(data, cfg, a.zip, a.price, a.exit_month, today)
    if a.json:
        print(json.dumps({"lines": lines, "text": "\n".join(lines)}, ensure_ascii=False))
    else:
        print("\n".join(lines))


if __name__ == "__main__":
    main()
