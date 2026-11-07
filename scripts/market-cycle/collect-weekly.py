#!/usr/bin/env python3
"""Market-cycle tracker, Phase 1: the Monday weekly collector (no LLM).

Spec: briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md §3.2 (weekly dials),
Part 4 Phase 1. Registry: config/market-cycle/thesis.v1.1.json (mls_* dials,
the mls_zip_{zip}_{metric} template, scc_nod_count).

What it does, per run:
  1. MLSListings (plain HTTP, scripts/market-cycle/mlsl.py): Buy (Active /
     Active Under Contract / Contingent / Pending) and Recently Sold for every
     city of Santa Clara County and of the panels (San Mateo County, San
     Francisco split houses vs condos/townhouses, Santa Cruz County, Fremont).
     Per geography (SFR unless the panel is condos): active count, pending
     ratio, new listings last 7 days, median days on site of actives,
     withdrawn/relist share, list-to-sale on the week's solds, price-cut share;
     SCC also by price tier.
  2. A per-listing snapshot of every Buy card (all types) for this week. The
     price-cut share = actives whose price is below the first price we
     recorded (and, separately, below last week's). On the first run there is
     no earlier snapshot, so the share is 0 by construction (printed as such).
     List-to-sale also needs the snapshot: Sold cards carry only the sale price,
     so "last list price" = the listing's price in our latest earlier snapshot.
  3. Owned-property zips (cycle_owned_properties; dry run = the bootstrap seed):
     actives, median days on site, cut share, 90-day sold $/sf (SFR), and a
     rough home value = sqft x that median when the home row has sqft.
  4. NODs for Santa Clara County: Properant's county page (stock under NOD +
     monthly filings table) and PropertyShark's county page. One honest
     request each; a number with its source URL or FAILED with the reason.
  5. Listed properties (for_sale rows): the Pile (texts via the mini sidecar,
     personal Gmail via IMAP) for the last 7 days of messages naming the bare
     street. Count + snippets stored raw; never interpreted here.

Usage:
  python3 scripts/market-cycle/collect-weekly.py                  # dry run: prints, writes nothing
  python3 scripts/market-cycle/collect-weekly.py --prior-snapshots /tmp/market-cycle-snapshot-2026-10-26.json
  python3 scripts/market-cycle/collect-weekly.py --write          # upsert readings + snapshots
  python3 scripts/market-cycle/collect-weekly.py --only scc --skip-nod --skip-pile

Dry run never touches the database: it saves this week's snapshot to
/tmp/market-cycle-snapshot-<week>.json so a later dry run can pass it back with
--prior-snapshots. --write needs supabase/migrations/2026-11-01_market_cycle.sql
and 2026-11-02_market_cycle_listings.sql applied; readings whose dial id is not
yet in cycle_dials (FK) are skipped and listed so the registry can be extended.
Stdlib only.
"""
import argparse
import datetime as dt
import html
import imaplib
import email
import email.header
import email.utils
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import mlsl  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(HERE))
CONFIG = os.path.join(ROOT, "config", "market-cycle", "thesis.v1.1.json")
ENV_PATHS = [os.path.join(ROOT, ".env.local"), "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local"]
UA = "mission-control-market-cycle/1.0 (+stdlib urllib)"
MLS_URL = "https://www.mlslistings.com/Search"           # stable source_url for MLS readings (upsert key)
SIDECAR = "http://localhost:5799"

# ---------------------------------------------------------------- geographies
# MLS card city names. SCC = the spec's 16 cities + San Martin (unincorporated
# SCC community with its own MLS city name; leaving it out undercounts the county).
SCC_CITIES = ["San Jose", "Santa Clara", "Sunnyvale", "Mountain View", "Palo Alto", "Los Altos", "Los Altos Hills",
              "Cupertino", "Saratoga", "Los Gatos", "Monte Sereno", "Campbell", "Milpitas", "Morgan Hill", "Gilroy",
              "Stanford", "San Martin"]
SAN_MATEO_CITIES = ["Atherton", "Belmont", "Brisbane", "Burlingame", "Colma", "Daly City", "East Palo Alto", "Foster City",
                    "Half Moon Bay", "Hillsborough", "Menlo Park", "Millbrae", "Pacifica", "Portola Valley", "Redwood City",
                    "San Bruno", "San Carlos", "San Mateo", "South San Francisco", "Woodside", "El Granada", "Montara",
                    "Moss Beach", "La Honda", "Pescadero", "San Gregorio", "Loma Mar"]
SANTA_CRUZ_CITIES = ["Santa Cruz", "Watsonville", "Scotts Valley", "Capitola", "Aptos", "Soquel", "Ben Lomond",
                     "Boulder Creek", "Felton", "Freedom", "La Selva Beach", "Brookdale", "Corralitos", "Davenport",
                     "Mount Hermon", "Bonny Doon"]
# Fetch groups (one set of city searches each) → geographies computed from them.
GROUPS = {
    # SCC condo/TH is its own display-only panel (Ryan 2026-11-01: never blend condos into SFR numbers).
    "scc": {"cities": SCC_CITIES, "geos": [("scc", "sfr", "mls_scc"), ("scc_condos", "condo", "mls_panel_scc_condos")]},
    "san_mateo": {"cities": SAN_MATEO_CITIES, "geos": [("san_mateo", "sfr", "mls_panel_san_mateo")]},
    "sf": {"cities": ["San Francisco"], "geos": [("sf_houses", "sfr", "mls_panel_sf_houses"), ("sf_condos", "condo", "mls_panel_sf_condos")]},
    "santa_cruz": {"cities": SANTA_CRUZ_CITIES, "geos": [("santa_cruz", "sfr", "mls_panel_santa_cruz")]},
    "fremont": {"cities": ["Fremont"], "geos": [("fremont", "sfr", "mls_panel_fremont")]},
}
# Owned-property seed: the same three rows bootstrap-history.py --write seeds.
OWNED_SEED = [
    {"address": "5764 Halleck Dr, San Jose, CA 95123", "zip": "95123", "flag": "for_sale", "sqft": None},
    {"address": "2116 Quito Rd, San Jose, CA 95130", "zip": "95130", "flag": "for_sale", "sqft": None},
    {"address": None, "zip": "95118", "flag": "home", "sqft": None},
]
UNDER_CONTRACT = ("Active Under Contract", "Pending", "Contingent")
SOLD_WINDOW_DAYS = 7          # "the week's solds"
WITHDRAW_SOLD_LOOKBACK = 45   # sold cards fetched at least this far back to tell "sold" from "withdrawn"


# ---------------------------------------------------------------- pure metrics (unit-tested)
def is_sfr(t):
    return bool(t) and t.strip().lower() == "single family residence"


def is_condo(t):
    return bool(t) and t.strip().lower() in ("condominium", "townhouse")


def kind_filter(kind):
    return is_sfr if kind == "sfr" else is_condo


def tier_of(price, tiers):
    """tiers = config geographies.tiers ([{id, min, max}]); min inclusive, max exclusive."""
    if price is None:
        return None
    for t in tiers:
        if (t["min"] is None or price >= t["min"]) and (t["max"] is None or price < t["max"]):
            return t["id"]
    return None


def median(xs):
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def pending_ratio(cards):
    """(Pending + Active Under Contract + Contingent) / Active over Buy cards. None if no actives."""
    act = sum(1 for c in cards if c["status"] == "Active")
    uc = sum(1 for c in cards if c["status"] in UNDER_CONTRACT)
    return (round(uc / act, 4) if act else None), act, uc


def new_listings(cards, days=7):
    """Buy cards (any status) with days_on_site <= days."""
    return sum(1 for c in cards if c.get("days_on_site") is not None and c["days_on_site"] <= days)


def price_cut_share(actives, first_seen, last_week):
    """actives: current Active cards. first_seen: mls -> first recorded price. last_week: mls -> last
    week's price. Returns dict with share_first / share_wow (in %, of all actives) and counts.
    A listing with no earlier record counts as not cut (first run => 0 by construction)."""
    n = len(actives)
    cut_first = sum(1 for c in actives if c["mls"] in first_seen and c["price"] is not None and first_seen[c["mls"]] is not None and c["price"] < first_seen[c["mls"]])
    cut_wow = sum(1 for c in actives if c["mls"] in last_week and c["price"] is not None and last_week[c["mls"]] is not None and c["price"] < last_week[c["mls"]])
    with_hist = sum(1 for c in actives if c["mls"] in first_seen)
    return {"share_first": round(100.0 * cut_first / n, 2) if n else None, "share_wow": round(100.0 * cut_wow / n, 2) if n else None,
            "cut_first": cut_first, "cut_wow": cut_wow, "with_history": with_hist, "n": n}


def list_to_sale(solds, last_list):
    """solds: Sold cards in the window. last_list: mls -> our last recorded list price.
    Median of sold_price / last list price, in % of list; pairs need both prices."""
    ratios = [100.0 * c["sold_price"] / last_list[c["mls"]] for c in solds
              if c.get("sold_price") and last_list.get(c["mls"])]
    return (round(statistics.median(ratios), 2) if ratios else None), len(ratios)


def norm_addr(a):
    if not a:
        return None
    a = re.sub(r"[.,#]", " ", a.lower())
    a = re.sub(r"\b(unit|apt|ste)\b", " ", a)
    return " ".join(a.split()) or None


def withdrawn_relist(actives, buy_mls, sold_mls, prior_rows):
    """prior_rows: last week's snapshot rows ({mls, status, address, ...}) for the same geography/kind.
    withdrawn = last week's actives that are in neither this week's Buy cards nor any Sold card.
    relisted  = this week's actives at an address last week carried under a different MLS #.
    Share = (withdrawn + relisted) / last week's actives, in %."""
    prior_act = [r for r in prior_rows if r.get("status") == "Active"]
    if not prior_act:
        return None, {"withdrawn": 0, "relisted": 0, "prior_actives": 0}
    withdrawn = sum(1 for r in prior_act if r["mls"] not in buy_mls and r["mls"] not in sold_mls)
    prior_by_addr = {}
    for r in prior_rows:
        k = norm_addr(r.get("address"))
        if k:
            prior_by_addr.setdefault(k, set()).add(r["mls"])
    relisted = 0
    for c in actives:
        k = norm_addr(c.get("address"))
        if k and k in prior_by_addr and c["mls"] not in prior_by_addr[k]:
            relisted += 1
    share = round(100.0 * (withdrawn + relisted) / len(prior_act), 2)
    return share, {"withdrawn": withdrawn, "relisted": relisted, "prior_actives": len(prior_act)}


def sold_ppsf(solds):
    v = [c["sold_price"] / c["sqft"] for c in solds if c.get("sold_price") and c.get("sqft")]
    return (round(statistics.median(v), 0) if v else None), len(v)


def week_of(d):
    return d - dt.timedelta(days=d.weekday())


def street_key(address):
    """'5764 Halleck Dr, San Jose, CA 95123' -> 'Halleck' (bare street rule)."""
    if not address:
        return None
    s = address.split(",")[0]
    s = re.sub(r"^\s*\d+[A-Za-z]?\s+", "", s)
    s = re.sub(r"\b(st|street|ave|avenue|dr|drive|rd|road|blvd|ct|court|ln|lane|pl|way|cir|ter|pkwy)\.?$", "", s.strip(), flags=re.I)
    return s.strip() or None


# ---------------------------------------------------------------- env / Supabase
def load_env():
    env = {}
    for ep in ENV_PATHS:
        if os.path.exists(ep):
            env = dict((k, v.strip("'\"")) for k, v in re.findall(r"^([A-Z0-9_]+)=(.*)$", open(ep).read(), re.M))
            break
    env.update({k: v for k, v in os.environ.items() if re.match(r"^[A-Z0-9_]+$", k)})
    return env


def sb_req(sb, key, method, path, body=None, prefer=None, headers=None):
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    h.update(headers or {})
    req = urllib.request.Request(sb + "/rest/v1/" + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        t = r.read().decode()
        return json.loads(t) if t else None


def sb_get_all(sb, key, path, page=1000):
    """PostgREST caps responses at 1000 rows: page with offset."""
    out, off = [], 0
    while True:
        sep = "&" if "?" in path else "?"
        rows = sb_req(sb, key, "GET", "%s%slimit=%d&offset=%d" % (path, sep, page, off))
        out += rows
        if len(rows) < page:
            return out
        off += page


# ---------------------------------------------------------------- MLS fetch
def fetch_group(gid, cities, full_sold_cities, sold_cutoff, log, owned_zips=()):
    """Buy + Recently Sold for every city in the group; cards kept only when the card's city is the
    searched city (City search can leak neighbours). Buy first for all cities, then Sold: sold paging
    stops early past sold_cutoff except for cities in full_sold_cities or whose Buy cards carry an
    owned zip (owned zips need 90 days of solds)."""
    t0 = time.time()
    buy, sold, notes = {}, {}, []
    for city in cities:
        want = city.lower()
        try:
            r = mlsl.search_full("Buy", "City", city)
            kept = [c for c in r["cards"] if (c["city"] or "").lower() == want]
            for c in kept:
                buy.setdefault(c["mls"], c)
            if r["unparsed"]:
                notes.append("%s buy: %d unparsed cards" % (city, len(r["unparsed"])))
            log("  %-20s buy  site=%-5s parsed=%-5d kept=%-5d pages=%d" % (city, r["count"], len(r["cards"]), len(kept), r["pages"]))
        except Exception as e:
            notes.append("%s buy FAILED: %s: %s" % (city, type(e).__name__, e))
            log("  %-20s buy  FAILED %s" % (city, e))
        time.sleep(mlsl.PAGE_SLEEP)
    full_sold_cities = set(full_sold_cities) | {c["city"] for c in buy.values() if c["zip"] in owned_zips}
    for city in cities:
        want = city.lower()
        try:
            stop = None
            if city not in full_sold_cities:
                stop = lambda page: bool(page) and min(c["sold_date"] or "9999" for c in page) < sold_cutoff
            r = mlsl.search_full("recentlySold", "City", city, stop=stop)
            kept = [c for c in r["cards"] if (c["city"] or "").lower() == want]
            for c in kept:
                sold.setdefault(c["mls"], c)
            log("  %-20s sold site=%-5s parsed=%-5d kept=%-5d pages=%d%s" % (city, r["count"], len(r["cards"]), len(kept), r["pages"], "" if stop is None else " (stopped at cutoff)"))
        except Exception as e:
            notes.append("%s sold FAILED: %s: %s" % (city, type(e).__name__, e))
            log("  %-20s sold FAILED %s" % (city, e))
        time.sleep(mlsl.PAGE_SLEEP)
    return {"buy": list(buy.values()), "sold": list(sold.values()), "notes": notes, "secs": time.time() - t0}


# ---------------------------------------------------------------- prior snapshots
def prior_from_file(path):
    rows = json.load(open(path))
    rows = rows["rows"] if isinstance(rows, dict) else rows
    return rows


def prior_from_db(sb, key, week, current_mls):
    """Last week's rows (the latest snapshot week before `week`) + earliest first_seen for current listings."""
    w = sb_req(sb, key, "GET", "cycle_listing_snapshots?select=week&week=lt.%s&order=week.desc&limit=1" % week)
    if not w:
        return [], {}
    prev = w[0]["week"]
    rows = sb_get_all(sb, key, "cycle_listing_snapshots?select=mls,geography,zip,price,status,days_on_site,type,week,first_seen_price,address&week=eq.%s&order=mls" % prev)
    have = {r["mls"] for r in rows}
    missing = [m for m in current_mls if m not in have]
    first = {}
    for i in range(0, len(missing), 150):
        chunk = missing[i:i + 150]
        q = "cycle_listing_snapshots?select=mls,first_seen_price,week&week=lt.%s&mls=in.(%s)&order=week.asc" % (week, ",".join(urllib.parse.quote(m) for m in chunk))
        for r in sb_get_all(sb, key, q):
            first.setdefault(r["mls"], r["first_seen_price"])
    return rows, first


# ---------------------------------------------------------------- NOD
def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "ignore")


def page_text(body):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<script.*?</script>|<style.*?</style>|<[^>]+>", " ", body, flags=re.S)))


MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


def parse_properant_county(text):
    """Properant county page → {'stock': n under NOD, 'as_of': 'Month D, YYYY' or None, 'monthly': [(YYYY-MM, nod, sale)]}."""
    out = {"stock": None, "as_of": None, "monthly": []}
    m = re.search(r"([\d,]+) under a notice of default", text)
    if m:
        out["stock"] = int(m.group(1).replace(",", ""))
    m = re.search(r"As of ((?:%s) \d{1,2}, \d{4})" % "|".join(MONTHS), text)
    if m:
        out["as_of"] = m.group(1)
    i = text.find("Month Notices Of Default Sale Notices")
    if i >= 0:
        seg = text[i: i + 1500]
        for mm in re.finditer(r"(%s) (\d{4}) (\d+) (\d+)" % "|".join(MONTHS), seg):
            out["monthly"].append(("%s-%02d" % (mm.group(2), MONTHS.index(mm.group(1)) + 1), int(mm.group(3)), int(mm.group(4))))
    return out


def parse_properant_state(text, county="Santa Clara County"):
    m = re.search(re.escape(county) + r" \( ([\d,]+) \)", text)
    return int(m.group(1).replace(",", "")) if m else None


def month_end(ym):
    y, m = map(int, ym.split("-"))
    nxt = dt.date(y + (m == 12), m % 12 + 1, 1)
    return (nxt - dt.timedelta(days=1)).isoformat()


def collect_nod(as_of, log):
    readings = []
    county_url = "https://properant.com/california/foreclosures/santa-clara"
    state_url = "https://properant.com/california/notice-of-default-list"
    ps_url = "https://www.propertyshark.com/mason/CA/Santa-Clara-County/Notices-of-Default"
    got = None
    try:
        p = parse_properant_county(page_text(http_get(county_url)))
        if p["stock"] is None:
            raise ValueError("no 'N under a notice of default' figure on the page (layout changed?)")
        got = p
        readings.append(R("scc_nod_count", as_of, p["stock"], 1, county_url, "SCC", "nod_stock",
                          {"status": "OK", "measure": "properties currently under a recorded notice of default (stock, cancellations/cures removed)",
                           "site_as_of": p["as_of"], "source": "Properant county page"}))
        for ym, nod, sale in p["monthly"]:
            readings.append(R("scc_nod_filings_monthly", month_end(ym), nod, 1, county_url, "SCC", "nod_filings_month",
                              {"status": "OK", "month": ym, "notices_of_default": nod, "sale_notices": sale,
                               "measure": "NODs recorded in the month (counted when recorded, cured or not)"}))
        log("  Properant county: %s under NOD (site as of %s); %d monthly rows" % (p["stock"], p["as_of"], len(p["monthly"])))
    except Exception as e:
        log("  Properant county FAILED: %s: %s" % (type(e).__name__, e))
        try:
            n = parse_properant_state(page_text(http_get(state_url)))
            if n is None:
                raise ValueError("Santa Clara County not found on the statewide list page")
            readings.append(R("scc_nod_count", as_of, n, 1, state_url, "SCC", "nod_stock",
                              {"status": "OK", "measure": "NODs on record (statewide list page, county row)", "county_page_error": str(e)}))
            got = {"stock": n}
        except Exception as e2:
            readings.append(R("scc_nod_count", as_of, None, 0, county_url, "SCC", "nod_stock",
                              {"status": "FAILED", "reason": "county page: %s; statewide page: %s: %s" % (e, type(e2).__name__, e2)}))
    if got is not None:
        # PropertyShark sits behind a Cloudflare challenge most weeks; asking it when Properant
        # already answered would post a failure alert every Monday. Backup only.
        return readings
    time.sleep(1)
    try:
        t = page_text(http_get(ps_url))
        m = re.search(r"([\d,]+) (?:available )?pre-?foreclosures", t, re.I)
        if not m:
            raise ValueError("no pre-foreclosure count on the page")
        readings.append(R("scc_nod_count", as_of, int(m.group(1).replace(",", "")), 1, ps_url, "SCC", "nod_stock",
                          {"status": "OK", "measure": "PropertyShark pre-foreclosures listed (their selection, ~2.5 years)"}))
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "ignore")[:3000]
        why = "HTTP %d%s" % (e.code, " (Cloudflare 'Just a moment' bot challenge)" if "Just a moment" in body else "")
        readings.append(R("scc_nod_count", as_of, None, 0, ps_url, "SCC", "nod_stock", {"status": "FAILED", "reason": why}))
        log("  PropertyShark FAILED: " + why)
    except Exception as e:
        readings.append(R("scc_nod_count", as_of, None, 0, ps_url, "SCC", "nod_stock", {"status": "FAILED", "reason": "%s: %s" % (type(e).__name__, e)}))
        log("  PropertyShark FAILED: %s" % e)
    return readings


# ---------------------------------------------------------------- Pile
def pile_texts(street, since, env):
    h = {"Accept": "application/json"}
    if env.get("SIDECAR_SECRET"):
        h["X-Sidecar-Secret"] = env["SIDECAR_SECRET"]
    u = SIDECAR + "/pile/texts?" + urllib.parse.urlencode({"q": street, "since": since, "limit": 200})
    with urllib.request.urlopen(urllib.request.Request(u, headers=h), timeout=20) as r:
        rows = json.loads(r.read().decode())
    seen, out = set(), []
    for x in rows:                                     # a person with two numbers in one group returns it twice
        k = (x.get("at"), (x.get("group") or {}).get("chat") if isinstance(x.get("group"), dict) else None, x.get("text"))
        if k in seen:
            continue
        seen.add(k)
        out.append({"at": x.get("at"), "channel": "text", "who": "me" if x.get("from_me") else (x.get("name") or x.get("number")),
                    "group": (x.get("group") or {}).get("label") if isinstance(x.get("group"), dict) else None,
                    "text": re.sub(r"\s+", " ", str(x.get("text") or ""))[:300]})
    return out


def _dec(s):
    try:
        return str(email.header.make_header(email.header.decode_header(s or "")))
    except Exception:
        return s or ""


def pile_email(street, env, days=7, limit=20):
    user, pw = env.get("PILE_GMAIL_IMAP_USER"), env.get("PILE_GMAIL_IMAP_PASSWORD")
    if not user or not pw:
        raise RuntimeError("PILE_GMAIL_IMAP_USER / PILE_GMAIL_IMAP_PASSWORD missing")
    M = imaplib.IMAP4_SSL("imap.gmail.com", 993, timeout=30)
    try:
        M.login(user, pw)
        M.select('"[Gmail]/All Mail"', readonly=True)
        typ, data = M.uid("SEARCH", "X-GM-RAW", '"\\"%s\\" newer_than:%dd"' % (street.replace('"', ""), days))
        uids = (data[0] or b"").split()[-limit:]
        out = []
        for u in reversed(uids):
            typ, msg = M.uid("FETCH", u, "(BODY.PEEK[]<0.6000>)")
            raw = next((p[1] for p in msg if isinstance(p, tuple)), b"")
            m = email.message_from_bytes(raw)
            body = ""
            for part in (m.walk() if m.is_multipart() else [m]):
                if part.get_content_type() in ("text/plain", "text/html"):
                    try:
                        body = part.get_payload(decode=True).decode(part.get_content_charset() or "utf-8", "ignore")
                    except Exception:
                        body = str(part.get_payload())
                    break
            d = email.utils.parsedate_to_datetime(m.get("Date")) if m.get("Date") else None
            out.append({"at": d.astimezone(dt.timezone.utc).isoformat() if d else None, "channel": "email",
                        "who": _dec(m.get("From")), "subject": _dec(m.get("Subject")),
                        "text": re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", body))[:300]})
        return out
    finally:
        try:
            M.logout()
        except Exception:
            pass


def collect_pile(owned, as_of, today, env, log):
    readings = []
    since = (today - dt.timedelta(days=7)).isoformat()
    for o in owned:
        if o["flag"] != "for_sale":
            continue
        street = street_key(o.get("address"))
        if not street:
            log("  for_sale row without a street (%s): skipped" % o)
            continue
        did = "listed_%s_pile_mentions_7d" % re.sub(r"[^a-z0-9]+", "_", street.lower()).strip("_")
        items, errors = [], []
        try:
            items += pile_texts(street, since, env)
        except Exception as e:
            errors.append("texts (sidecar %s): %s: %s" % (SIDECAR, type(e).__name__, e))
        try:
            items += pile_email(street, env)
        except Exception as e:
            errors.append("email (IMAP): %s: %s" % (type(e).__name__, e))
        items.sort(key=lambda x: x.get("at") or "", reverse=True)
        if len(errors) == 2:
            readings.append(R(did, as_of, None, 0, "pile:" + street, "listed:" + street, "pile_mentions_7d",
                              {"status": "FAILED", "reason": "; ".join(errors), "address": o["address"]}))
            log("  %s: FAILED %s" % (street, "; ".join(errors)))
            continue
        readings.append(R(did, as_of, len(items), len(items), "pile:" + street, "listed:" + street, "pile_mentions_7d",
                          {"status": "OK" if not errors else "PARTIAL", "errors": errors, "address": o["address"], "since": since,
                           "texts": sum(1 for i in items if i["channel"] == "text"), "emails": sum(1 for i in items if i["channel"] == "email"),
                           "snippets": items}))
        log("  %s: %d mentions since %s (%d texts, %d emails)%s" % (street, len(items), since, sum(1 for i in items if i["channel"] == "text"),
                                                                    sum(1 for i in items if i["channel"] == "email"), (" — " + "; ".join(errors)) if errors else ""))
    return readings


# ---------------------------------------------------------------- readings
def R(dial_id, as_of, value, n, source_url, geography, metric, raw):
    return {"dial_id": dial_id, "as_of": as_of, "value": value, "n": n, "source_url": source_url,
            "geography": geography, "metric": metric, "raw": raw, "secs": None}


def geo_readings(prefix, label, cards_buy, cards_sold, kind, as_of, today, first_seen, last_week, prior_rows, all_buy_mls, all_sold_mls, secs, tiers=None):
    f = kind_filter(kind)
    buy = [c for c in cards_buy if f(c["type"])]
    act = [c for c in buy if c["status"] == "Active"]
    cutoff = (today - dt.timedelta(days=SOLD_WINDOW_DAYS)).isoformat()
    week_solds = [c for c in cards_sold if f(c["type"]) and (c["sold_date"] or "") > cutoff]
    out = []

    def add(metric, value, n, raw):
        r = R("%s_%s" % (prefix, metric), as_of, value, n, MLS_URL, label, metric, raw)
        r["secs"] = secs
        out.append(r)
    add("active_sfr", len(act), len(act), {"status": "OK", "kind": kind, "statuses": "Active"})
    pr, a, uc = pending_ratio(buy)
    add("pending_ratio", pr, a + uc, {"status": "OK", "active": a, "under_contract": uc})
    add("new_listings_7d", new_listings(buy), len(buy), {"status": "OK", "rule": "Buy cards (any status) with days_on_site <= 7"})
    add("median_dos", median([c["days_on_site"] for c in act]), len(act), {"status": "OK"})
    pc = price_cut_share(act, first_seen, last_week)
    first_run = pc["with_history"] == 0
    # No earlier snapshot = no measurement. Store null (NO_HISTORY), never a 0 the review could read as "nobody is cutting".
    add("price_cut_share", None if first_run else pc["share_first"], pc["n"], {"status": "NO_HISTORY" if first_run else "OK", **pc,
        "note": "first run: no earlier snapshot to compare against" if first_run else "share of actives below their first recorded price"})
    pr_geo = [r for r in prior_rows if f(r.get("type"))]
    ws, wd = withdrawn_relist(act, all_buy_mls, all_sold_mls, pr_geo)
    add("withdrawn_share", ws, wd["prior_actives"], {"status": "OK" if ws is not None else "NO_HISTORY", **wd,
        "note": None if ws is not None else "needs last week's snapshot"})
    last_list = {**{r["mls"]: r["price"] for r in prior_rows}}
    lts, n = list_to_sale(week_solds, last_list)
    add("list_to_sale", lts, n, {"status": "OK" if lts is not None else "NO_HISTORY", "solds_in_window": len(week_solds),
        "window": "sold_date > %s" % cutoff, "newest_sold_date": max([c["sold_date"] for c in cards_sold if c["sold_date"]], default=None),
        "note": None if lts is not None else "Sold cards carry only the sale price; the last list price comes from our earlier snapshots, none yet"})
    if tiers:
        for t in tiers:
            ta = [c for c in act if tier_of(c["price"], tiers) == t["id"]]
            r = R("%s_tier_%s_active_sfr" % (prefix, t["id"]), as_of, len(ta), len(ta), MLS_URL, label + " " + t["label"], "active_sfr", {"status": "OK", "tier": t})
            r["secs"] = secs
            out.append(r)
            tpc = price_cut_share(ta, first_seen, last_week)
            r = R("%s_tier_%s_price_cut_share" % (prefix, t["id"]), as_of, None if tpc["with_history"] == 0 else tpc["share_first"], tpc["n"], MLS_URL, label + " " + t["label"], "price_cut_share",
                  {"status": "NO_HISTORY" if tpc["with_history"] == 0 else "OK", **tpc, "note": "first run: no earlier snapshot" if tpc["with_history"] == 0 else None})
            r["secs"] = secs
            out.append(r)
    return out


def zip_readings(z, all_buy, all_sold, as_of, today, first_seen, last_week, homes):
    buy = [c for c in all_buy if c["zip"] == z and is_sfr(c["type"])]
    act = [c for c in buy if c["status"] == "Active"]
    cutoff90 = (today - dt.timedelta(days=90)).isoformat()
    solds = [c for c in all_sold if c["zip"] == z and is_sfr(c["type"]) and (c["sold_date"] or "") > cutoff90]
    out = []
    pfx = "mls_zip_%s_" % z
    if not buy and not solds:
        return [R(pfx + "active_sfr", as_of, None, 0, MLS_URL, "zip " + z, "active_sfr",
                  {"status": "FAILED", "reason": "zip %s not seen on any card from the fetched cities" % z})]
    out.append(R(pfx + "active_sfr", as_of, len(act), len(act), MLS_URL, "zip " + z, "active_sfr", {"status": "OK"}))
    out.append(R(pfx + "median_dos", as_of, median([c["days_on_site"] for c in act]), len(act), MLS_URL, "zip " + z, "median_dos", {"status": "OK"}))
    pc = price_cut_share(act, first_seen, last_week)
    out.append(R(pfx + "price_cut_share", as_of, None if pc["with_history"] == 0 else pc["share_first"], pc["n"], MLS_URL, "zip " + z, "price_cut_share",
                 {"status": "NO_HISTORY" if pc["with_history"] == 0 else "OK", **pc, "note": "first run: no earlier snapshot" if pc["with_history"] == 0 else None}))
    ppsf, n = sold_ppsf(solds)
    dates = [c["sold_date"] for c in solds]
    out.append(R(pfx + "sold_ppsf_90d", as_of, ppsf, n, MLS_URL, "zip " + z, "sold_ppsf_90d",
                 {"status": "OK", "window": "%s..%s" % (min(dates, default=None), max(dates, default=None)), "solds": len(solds)}))
    for h in homes:
        if h["zip"] != z:
            continue
        if not h.get("sqft"):
            out.append(R(pfx + "home_value_est", as_of, None, 0, MLS_URL, "zip " + z, "home_value_est",
                         {"status": "SKIPPED", "reason": "home row has no sqft (cycle_owned_properties.sqft is null)"}))
        elif ppsf:
            out.append(R(pfx + "home_value_est", as_of, round(h["sqft"] * ppsf, -3), n, MLS_URL, "zip " + z, "home_value_est",
                         {"status": "OK", "sqft": h["sqft"], "sold_ppsf_90d": ppsf, "rule": "sqft x 90-day SFR sold $/sf median (rough)"}))
        else:
            out.append(R(pfx + "home_value_est", as_of, None, 0, MLS_URL, "zip " + z, "home_value_est",
                         {"status": "SKIPPED", "reason": "no SFR solds with sq ft in the zip in 90 days"}))
    return out


# ---------------------------------------------------------------- output
def fmt(v):
    if v is None:
        return "—"
    if isinstance(v, float) and not v.is_integer():
        return "%.2f" % v
    return "{:,}".format(int(v))


def print_table(readings):
    print("\n%-26s %-26s %12s %6s %7s  %s" % ("geography", "metric", "value", "n", "secs", "dial_id / note"))
    for r in readings:
        raw = r["raw"] if isinstance(r["raw"], dict) else {}
        st = raw.get("status", "OK")
        note = r["dial_id"]
        if st not in ("OK",):
            note += "  [%s%s]" % (st, (": " + str(raw.get("reason") or raw.get("note") or "")[:90]) if (raw.get("reason") or raw.get("note")) else "")
        elif raw.get("note"):
            note += "  (%s)" % raw["note"]
        print("%-26s %-26s %12s %6s %7s  %s" % (r["geography"][:26], r["metric"][:26], fmt(r["value"]), r["n"] if r["n"] is not None else "",
                                              ("%.0f" % r["secs"]) if r.get("secs") else "", note))


def snapshot_rows(group_cards, week, first_seen):
    rows = []
    for gid, cards in group_cards.items():
        for c in cards:
            rows.append({"mls": c["mls"], "geography": gid, "zip": c["zip"], "price": c["price"], "status": c["status"],
                         "days_on_site": c["days_on_site"], "type": c["type"], "week": week, "address": c["address"],
                         "first_seen_price": first_seen.get(c["mls"], c["price"])})
    return rows


def post_alert(env, text):
    token = env.get("CAMPAIGN_BOT_TOKEN") or env.get("TELEGRAM_BOT_TOKEN")
    chat = env.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        print("alert not posted: CAMPAIGN_BOT_TOKEN/TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID missing")
        return
    req = urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % token, data=json.dumps({"chat_id": chat, "text": text}).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        urllib.request.urlopen(req, timeout=20).read()
    except Exception as e:
        print("alert post failed: %s" % e)


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--write", action="store_true", help="upsert readings + snapshots (default: dry run, no database access)")
    ap.add_argument("--as-of", help="reading / snapshot date (default: the Monday of this week = the launchd run date)")
    ap.add_argument("--only", help="comma-separated fetch groups: " + ",".join(GROUPS))
    ap.add_argument("--prior-snapshots", help="dry run: JSON file of an earlier week's snapshot rows")
    ap.add_argument("--skip-nod", action="store_true")
    ap.add_argument("--skip-pile", action="store_true")
    ap.add_argument("--alert-on-failure", action="store_true", help="post one Telegram line if the SCC fetch or the write fails")
    a = ap.parse_args()
    t_start = time.time()
    cfg = json.load(open(CONFIG))
    tiers = cfg["geographies"]["tiers"]
    today = dt.date.today()
    week = dt.date.fromisoformat(a.as_of) if a.as_of else week_of(today)   # a re-run later in the week overwrites, never adds a "week"
    as_of = week.isoformat()
    env = load_env()
    groups = [g for g in GROUPS if not a.only or g in a.only.split(",")]
    print("market-cycle weekly collector — run %s — week %s — %s" % (today.isoformat(), as_of, "WRITE" if a.write else "DRY RUN (no database access)"))

    sb = key = None
    if a.write:
        sb, key = env.get("LRG_SUPABASE_URL"), env.get("LRG_SUPABASE_SERVICE_KEY")
        if not sb or not key:
            sys.exit("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing")
        missing = []
        for t in ("cycle_dials", "cycle_readings", "cycle_listing_snapshots", "cycle_owned_properties"):
            try:
                sb_req(sb, key, "GET", t + "?select=*&limit=1")
            except Exception as e:
                missing.append("%s (%s)" % (t, e))
        if missing:
            print("REFUSING --write: not reachable over PostgREST:\n  " + "\n  ".join(missing))
            print("Apply supabase/migrations/2026-11-01_market_cycle.sql and 2026-11-02_market_cycle_listings.sql first.")
            sys.exit(2)
        try:
            owned = sb_req(sb, key, "GET", "cycle_owned_properties?select=address,zip,flag,sqft&retired_at=is.null")
        except urllib.error.HTTPError:
            owned = [dict(o, sqft=None) for o in sb_req(sb, key, "GET", "cycle_owned_properties?select=address,zip,flag&retired_at=is.null")]
    else:
        owned = [dict(o) for o in OWNED_SEED]
    owned_zips = sorted({o["zip"] for o in owned} | set(cfg["geographies"]["permanent_zips"]))
    print("owned zips: %s (%s)" % (", ".join(owned_zips), "cycle_owned_properties" if a.write else "bootstrap seed"))

    # --- MLS
    readings, group_cards, sold_by_group, notes = [], {}, {}, []
    sold_cutoff = (today - dt.timedelta(days=WITHDRAW_SOLD_LOOKBACK)).isoformat()
    full_sold = {c for o in owned for c in SCC_CITIES if o.get("address") and (", %s," % c.lower()) in o["address"].lower()}
    group_secs = {}
    for gid in groups:
        print("\n[%s] fetching %d cities" % (gid, len(GROUPS[gid]["cities"])))
        sys.stdout.flush()
        cities = GROUPS[gid]["cities"]
        # owned zips' cities get the full ~90-day sold history (learned from the group's Buy cards)
        res = fetch_group(gid, cities, full_sold, sold_cutoff, lambda s: (print(s), sys.stdout.flush()), owned_zips=set(owned_zips))
        group_cards[gid], sold_by_group[gid] = res["buy"], res["sold"]
        group_secs[gid] = res["secs"]
        notes += ["%s: %s" % (gid, n) for n in res["notes"]]
        print("[%s] %d buy cards, %d sold cards, %.0fs" % (gid, len(res["buy"]), len(res["sold"]), res["secs"]))
    all_buy = [c for g in group_cards.values() for c in g]
    all_sold = [c for g in sold_by_group.values() for c in g]
    for o in owned:
        if not any(c["zip"] == o["zip"] for c in all_buy + all_sold):
            notes.append("owned zip %s not seen in any fetched city" % o["zip"])

    # --- prior snapshots
    current_mls = [c["mls"] for c in all_buy]
    if a.write:
        prior_rows, first_extra = prior_from_db(sb, key, as_of, current_mls)
        src = "database"
    elif a.prior_snapshots:
        prior_rows = [r for r in prior_from_file(a.prior_snapshots) if r["week"] < as_of]
        first_extra, src = {}, a.prior_snapshots
    else:
        prior_rows, first_extra, src = [], {}, "none"
    last_week = {r["mls"]: r["price"] for r in prior_rows}
    first_seen = {r["mls"]: (r.get("first_seen_price") or r["price"]) for r in prior_rows}
    first_seen.update({k: v for k, v in first_extra.items() if k not in first_seen})
    print("\nprior snapshot: %s — %d rows%s" % (src, len(prior_rows), "" if prior_rows else " → price-cut share, withdrawn and list-to-sale need history (stored as NO_HISTORY, not 0)"))

    all_buy_mls = {c["mls"] for c in all_buy}
    all_sold_mls = {c["mls"] for c in all_sold}
    for gid in groups:
        for geo, kind, prefix in GROUPS[gid]["geos"]:
            readings += geo_readings(prefix, geo, group_cards[gid], sold_by_group[gid], kind, as_of, today, first_seen, last_week,
                                     [r for r in prior_rows if r.get("geography") == gid], all_buy_mls, all_sold_mls, group_secs[gid],
                                     tiers if geo == "scc" else None)
    homes = [o for o in owned if o["flag"] == "home"]
    for z in owned_zips:
        readings += zip_readings(z, all_buy, all_sold, as_of, today, first_seen, last_week, homes)

    # --- NOD + Pile
    if not a.skip_nod:
        print("\n[nod]")
        readings += collect_nod(as_of, print)
    if not a.skip_pile:
        print("\n[pile] listed properties")
        readings += collect_pile(owned, as_of, today, env, print)

    print_table(readings)

    # --- coverage check
    print("\nCOVERAGE CHECK")
    if "scc" in group_cards:
        scc = group_cards["scc"]
        sfr_act = sum(1 for c in scc if c["status"] == "Active" and is_sfr(c["type"]))
        res_act = sum(1 for c in scc if c["status"] == "Active" and (is_sfr(c["type"]) or is_condo(c["type"])))
        print("  SCC actives: SFR %d; SFR+condo+townhouse %d; all types %d  (Sep 2026 refs: C.A.R./SV report ~993 SFR; Realtor.com all-types 1,987)"
              % (sfr_act, res_act, sum(1 for c in scc if c["status"] == "Active")))
    for gid, label, floor in (("sf", "San Francisco", 300), ("fremont", "Fremont", 60)):
        if gid not in group_cards:
            continue
        cs = group_cards[gid]
        act = [c for c in cs if c["status"] == "Active"]
        sfr = sum(1 for c in act if is_sfr(c["type"]))
        con = sum(1 for c in act if is_condo(c["type"]))
        verdict = "looks complete" if len(act) >= floor else "data-share coverage looks thin"
        print("  %-13s actives %d (SFR %d, condo/TH %d), under contract %d, solds fetched %d → %s (expect >= ~%d actives)"
              % (label, len(act), sfr, con, sum(1 for c in cs if c["status"] in UNDER_CONTRACT), len(sold_by_group[gid]), verdict, floor))
    for n in notes:
        print("  note: " + n)

    snaps = snapshot_rows(group_cards, as_of, first_seen)
    fail_scc = "scc" in groups and not group_cards.get("scc")
    # Silent failures must reach Telegram (Ryan 2026-11-01): one line naming every failed
    # source, every geography that came back empty, and every reading the writer refused.
    problems = ["%s (%s)" % (r["dial_id"], (r["raw"].get("reason") or "")[:80]) for r in readings
                if isinstance(r["raw"], dict) and r["raw"].get("status") == "FAILED"]
    problems += ["%s: no cards" % g for g in groups if not group_cards.get(g) and g != "scc"]
    # one city failing inside a group still leaves cards, but undercounts the whole group
    # (a San Jose failure would read as SCC inventory collapsing): alert on it too.
    problems += [n for n in notes if "FAILED" in n]
    if a.write:
        try:
            skipped = write(sb, key, readings, snaps) or {}
            problems += ["%s: not in registry, dropped" % d for d in sorted(skipped)]
        except Exception as e:
            print("WRITE FAILED: %s: %s" % (type(e).__name__, e))
            if a.alert_on_failure:
                post_alert(env, "Market-cycle weekly collector: write FAILED (%s). Readings for week %s not stored." % (str(e)[:200], as_of))
            sys.exit(1)
    else:
        path = "/tmp/market-cycle-snapshot-%s.json" % as_of
        json.dump(snaps, open(path, "w"))
        print("\nDry run: nothing written to the database. This week's snapshot (%d rows) saved to %s" % (len(snaps), path))
    if problems and a.write and a.alert_on_failure:
        post_alert(env, "Market-cycle weekly collector, week %s: %d problem(s) — %s" % (as_of, len(problems), "; ".join(problems)[:600]))
    elif problems:
        print("\nPROBLEMS (would alert with --write --alert-on-failure): " + "; ".join(problems))
    if fail_scc and a.alert_on_failure:
        post_alert(env, "Market-cycle weekly collector: Santa Clara County MLS fetch returned nothing for week %s. %s" % (as_of, "; ".join(notes)[:300]))
    print("\nMLS requests: %d (retries %d). Total runtime %.0fs" % (mlsl.stats["requests"], mlsl.stats["retries"], time.time() - t_start))
    if fail_scc:
        sys.exit(1)


# Dials this collector creates on the fly. Panels, owned zips and listed properties are
# context, never votes (brief §3.4), and owned zips / listed properties come and go with
# the registry, so they can't live in the static thesis config. Registered display-only.
AUTO_DIAL_RE = re.compile(r"^(mls_panel_[a-z0-9_]+|mls_zip_\d{5}_[a-z0-9_]+|listed_[a-z0-9_]+_pile_mentions_7d|scc_nod_filings_monthly)$")
METRIC_UP = {"active_sfr": "bear", "pending_ratio": "bull", "new_listings_7d": "bear", "median_dos": "bear",
             "price_cut_share": "bear", "withdrawn_share": "bear", "list_to_sale": "bull", "sold_ppsf_90d": "bull",
             "home_value_est": "bull", "nod_filings_month": "bear"}
FLIP = {"bear": "bull", "bull": "bear", "neutral": "neutral"}


def auto_dial_row(r):
    did = r["dial_id"]
    if did.startswith("listed_"):
        cat, geo, up = "owned_property", r.get("geography"), "neutral"
    elif did.startswith("mls_zip_"):
        cat, geo, up = "owned_property", "zip " + did.split("_")[2], "neutral"
    elif did == "scc_nod_filings_monthly":
        cat, geo, up = "local_housing", "SCC", "bear"
    else:
        cat, geo, up = "local_housing", r.get("geography"), METRIC_UP.get(r.get("metric"), "neutral")
    return {"id": did, "name": "%s %s" % (r.get("geography") or did, r.get("metric") or ""), "cadence": "monthly" if did == "scc_nod_filings_monthly" else "weekly",
            "category": cat, "source": {"name": "collect-weekly.py", "url": r["source_url"]}, "fetch_method": "pile" if did.startswith("listed_") else ("web" if did.startswith("scc_nod") else "mlslistings"),
            "units": None, "transform": "level", "direction_map": {"up": up, "down": FLIP[up]}, "band_rule": "corridor",
            "corridor": {"note": "auto-registered by collect-weekly.py; context only"}, "has_history": False, "votes": False, "geography": geo,
            "notes": "auto-registered (dynamic dial)"}


def write(sb, key, readings, snaps):
    known = {d["id"] for d in sb_get_all(sb, key, "cycle_dials?select=id&order=id")}
    rows, skipped = [], {}
    new_dials = {r["dial_id"]: auto_dial_row(r) for r in readings if r["dial_id"] not in known and AUTO_DIAL_RE.match(r["dial_id"])}
    if new_dials:
        sb_req(sb, key, "POST", "cycle_dials?on_conflict=id", list(new_dials.values()), prefer="resolution=ignore-duplicates,return=minimal")
        known |= set(new_dials)
        print("REGISTERED %d dynamic dials (display-only): %s" % (len(new_dials), ", ".join(sorted(new_dials))))
    for r in readings:
        raw = r["raw"] if isinstance(r["raw"], dict) else {}
        if r["value"] is None and raw.get("status") not in ("FAILED", "SKIPPED"):
            continue                      # not computable yet (no history): nothing to store
        if r["dial_id"] not in known:
            skipped[r["dial_id"]] = skipped.get(r["dial_id"], 0) + 1
            continue
        rows.append({"dial_id": r["dial_id"], "as_of": r["as_of"], "value": r["value"], "source_url": r["source_url"],
                     "raw": json.dumps(dict(raw, n=r["n"]))})
    for i in range(0, len(rows), 500):
        sb_req(sb, key, "POST", "cycle_readings?on_conflict=dial_id,variant,as_of,source_url", rows[i:i + 500], prefer="resolution=merge-duplicates,return=minimal")
    for i in range(0, len(snaps), 500):
        sb_req(sb, key, "POST", "cycle_listing_snapshots?on_conflict=mls,week", snaps[i:i + 500], prefer="resolution=merge-duplicates,return=minimal")
    print("\nWRITTEN: %d readings, %d listing snapshots" % (len(rows), len(snaps)))
    if skipped:
        print("SKIPPED (dial id not in cycle_dials yet — extend the thesis registry): " + ", ".join(sorted(skipped)))
    return skipped


if __name__ == "__main__":
    main()
