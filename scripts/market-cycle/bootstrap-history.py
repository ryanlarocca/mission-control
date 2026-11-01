#!/usr/bin/env python3
"""Market-cycle tracker, Phase 0: history bootstrap + corridor numbers.

Spec: briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md (Part 3.4, Part 4 Phase 0).
Registry: config/market-cycle/thesis.v1.1.json (every dial with has_history=true
is fetched here).

For each dial: fetch the full free history, apply the dial's transform, and
print one line: dial id, source, OK / FAILED(reason), rows, first, last,
latest value. Then compute the corridors:
  (a) seasonal_1sd dials: per-calendar-month mean and sd over the prior 5 years
  (b) CCC OAS (BAMLH0A3HYC): 2010-01-01..2025-12-31 maximum
  (c) Realtor.com price-reduced share (PRIREDCOU / ACTLISCOU): 2016-2025 maximum
  (d) EDD WARN: 2025 monthly average of Santa Clara County affected workers
  (e) ZHVI SCC all homes: 2026 peak month + value, current drawdown; tier YoY
A source that cannot be fetched is reported FAILED with the reason. Nothing is
ever filled in: no placeholder numbers.

Usage:
  python3 scripts/market-cycle/bootstrap-history.py            # dry run (prints only; no DB)
  python3 scripts/market-cycle/bootstrap-history.py --write    # upsert into the cycle_* tables
  python3 scripts/market-cycle/bootstrap-history.py --only ccc_oas,brent

--write needs supabase/migrations/2026-11-01_market_cycle.sql applied first; it
probes every cycle_* table over PostgREST and refuses to run if one is missing.
Stdlib only. The EDD fiscal-year WARN reports are PDF-only, so those are read
with the system `pdftotext` (poppler) when present; otherwise they are FAILED.
"""
import argparse, csv, datetime as dt, io, json, math, os, re, shutil, statistics, subprocess, sys, tempfile, time
import urllib.error, urllib.parse, urllib.request, zipfile
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CONFIG = os.path.join(ROOT, "config", "market-cycle", "thesis.v1.1.json")
ENV_PATHS = [os.path.join(ROOT, ".env.local"), "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local"]
# Honest UA by default: FRED (Akamai) tarpits a spoofed Chrome UA that lacks the
# rest of a browser's headers. The Nasdaq API needs a browser-like UA.
UA = "mission-control-market-cycle/1.0 (+stdlib urllib)"
BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
TODAY = dt.date.today()
SEASONAL_YEARS = list(range(TODAY.year - 5, TODAY.year))          # prior 5 full calendar years
STORE_SINCE = "2010-01-01"                                         # readings written with --write
TABLES = ["cycle_thesis_versions", "cycle_claims", "cycle_dials", "cycle_readings", "cycle_checkpoints",
          "cycle_weight_moves", "cycle_owned_properties", "cycle_calendar"]


class SourceError(Exception):
    pass


# ---------------------------------------------------------------- HTTP
def http_get(url, accept=None, attempts=2, timeout=45, ua=None):
    """GET with at most `attempts` tries (never hammer a blocked site). Returns bytes."""
    last = None
    for i in range(attempts):
        try:
            h = {"User-Agent": ua or UA}
            if accept:
                h["Accept"] = accept
            req = urllib.request.Request(url, headers=h)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read(), r.geturl(), r.headers.get("Content-Type", "")
        except urllib.error.HTTPError as e:
            last = "HTTP %d" % e.code
            if e.code in (401, 403, 404, 410, 429):
                break                       # blocked or missing: retrying won't help
        except Exception as e:              # timeouts, DNS, resets
            last = "%s: %s" % (type(e).__name__, e)
        if i + 1 < attempts:
            time.sleep(3)
    raise SourceError(last or "unknown error")


def http_lines(url, attempts=2, timeout=300):
    """Stream a large text file line by line (Zillow zip file, Indeed metro file)."""
    last = None
    for i in range(attempts):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            r = urllib.request.urlopen(req, timeout=timeout)
            return io.TextIOWrapper(r, encoding="utf-8", errors="replace", newline="")
        except urllib.error.HTTPError as e:
            last = "HTTP %d" % e.code
            if e.code in (401, 403, 404, 410, 429):
                break
        except Exception as e:
            last = "%s: %s" % (type(e).__name__, e)
        if i + 1 < attempts:
            time.sleep(3)
    raise SourceError(last or "unknown error")


# ---------------------------------------------------------------- sources
_cache = {}


def cached(key, fn):
    if key not in _cache:
        try:
            _cache[key] = ("ok", fn())
        except SourceError as e:
            _cache[key] = ("err", str(e))
        except Exception as e:
            _cache[key] = ("err", "%s: %s" % (type(e).__name__, e))
    st, val = _cache[key]
    if st == "err":
        raise SourceError(val)
    return val


FRED_CSV = "https://fred.stlouisfed.org/graph/fredgraph.csv?id="


def fred(series):
    def go():
        body, _, ctype = http_get(FRED_CSV + series)
        text = body.decode("utf-8", "replace")
        if not text.startswith("observation_date"):
            raise SourceError("not a FRED CSV (content-type %s)" % ctype)
        rows = []
        for line in text.splitlines()[1:]:
            d, _, v = line.partition(",")
            v = v.strip()
            if not v or v == ".":
                continue
            rows.append((d, float(v)))
        if not rows:
            raise SourceError("FRED returned no observations")
        return rows
    return cached("fred:" + series, go)


ZILLOW = "https://files.zillowstatic.com/research/public_csvs/zhvi/"


def zillow_county(fname, county="Santa Clara County", state="CA"):
    def go():
        body, _, _ = http_get(ZILLOW + fname)
        rdr = csv.reader(io.StringIO(body.decode("utf-8", "replace")))
        hdr = next(rdr)
        dates = [(i, h) for i, h in enumerate(hdr) if re.match(r"\d{4}-\d{2}-\d{2}$", h)]
        for row in rdr:
            if row[hdr.index("RegionName")] == county and row[hdr.index("State")] == state:
                return [(h, float(row[i])) for i, h in dates if row[i]]
        raise SourceError("%s not found in %s" % (county, fname))
    return cached("zillow:" + fname + county, go)


def zillow_zips(zips):
    fname = "Zip_zhvi_uc_sfrcondo_tier_0.33_0.67_sm_sa_month.csv"

    def go():
        rdr = csv.reader(http_lines(ZILLOW + fname))
        hdr = next(rdr)
        dates = [(i, h) for i, h in enumerate(hdr) if re.match(r"\d{4}-\d{2}-\d{2}$", h)]
        ri, out = hdr.index("RegionName"), {}
        for row in rdr:
            if len(row) > ri and row[ri] in zips:
                out[row[ri]] = [(h, float(row[i])) for i, h in dates if i < len(row) and row[i]]
        return out
    got = cached("zillow:zips", go)
    return got


EDD_PAGE = "https://edd.ca.gov/en/jobs_and_training/Layoff_Services_WARN/"
EDD_BASE = "https://edd.ca.gov"


def excel_date(serial):
    return (dt.date(1899, 12, 30) + dt.timedelta(days=int(float(serial)))).isoformat()


def xlsx_rows(blob, sheet_name_prefix):
    NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    z = zipfile.ZipFile(io.BytesIO(blob))
    ss = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            ss.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    rels = {r.get("Id"): r.get("Target") for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))}
    for s in ET.fromstring(z.read("xl/workbook.xml")).find("m:sheets", NS):
        if not s.get("name", "").strip().startswith(sheet_name_prefix):
            continue
        target = rels[s.get("{%s}id" % NS["r"])].lstrip("/")
        target = target if target.startswith("xl/") else "xl/" + target
        out = []
        for row in ET.fromstring(z.read(target)).findall(".//m:sheetData/m:row", NS):
            cells = {}
            for c in row.findall("m:c", NS):
                col = re.match(r"[A-Z]+", c.get("r")).group(0)
                v = c.find("m:v", NS)
                if v is not None:
                    x = v.text or ""
                    if c.get("t") == "s":
                        x = ss[int(x)]
                else:
                    t = c.find(".//m:t", NS)
                    x = t.text if t is not None else ""
                cells[col] = x
            out.append(cells)
        return out
    raise SourceError("sheet '%s' not found in workbook" % sheet_name_prefix)


def edd_links():
    def go():
        body, _, _ = http_get(EDD_PAGE, accept="text/html")
        t = body.decode("utf-8", "replace")
        links = {}
        for m in re.finditer(r'href="([^"]+)"[^>]*>([^<]{0,160})', t):
            href, label = m.group(1), m.group(2)
            if href.lower().endswith(".xlsx") and "latest" in label.lower():
                links["latest_xlsx"] = href
            fy = re.search(r"(\d{4})-(\d{4}) WARN Report", label)
            if fy and href.lower().endswith(".pdf"):
                links["fy%s" % fy.group(2)] = href
        if "latest_xlsx" not in links:
            raise SourceError("no 'Latest WARN report' xlsx link on the EDD page")
        return links
    return cached("edd:links", go)


def warn_notices(county="Santa Clara County"):
    """[(notice_date_iso, employees, source_url)] for the county, from the
    latest xlsx (current FY) + the FY2024-25 and FY2025-26 PDFs. Returns
    (notices, file_status) where file_status lists each file OK/FAILED."""
    links = edd_links()
    notices, status = [], []
    # current fiscal year: xlsx
    url = EDD_BASE + links["latest_xlsx"]
    try:
        blob, _, _ = http_get(url)
        rows = xlsx_rows(blob, "Detailed WARN Report")
        hdr_i = next(i for i, r in enumerate(rows) if r.get("A", "").startswith("County"))
        n = 0
        for r in rows[hdr_i + 1:]:
            if r.get("A", "").strip() == county and r.get("B") and r.get("G"):
                notices.append((excel_date(r["B"]), int(float(r["G"])), url)); n += 1
        title = rows[0].get("A", "").split("\n")[0]
        status.append("xlsx OK (%s; %d %s notices)" % (title.strip(), n, county))
    except Exception as e:
        status.append("xlsx FAILED (%s)" % e)
    # prior fiscal years: PDF only
    pdftotext = shutil.which("pdftotext") or ("/opt/homebrew/bin/pdftotext" if os.path.exists("/opt/homebrew/bin/pdftotext") else None)
    rx = re.compile(r"^\s*(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(.*?)\s{2,}" + re.escape(county) + r"\s+([\d,]+)\s")
    for key in ("fy2025", "fy2026"):
        if key not in links:
            status.append("%s FAILED (no PDF link on the EDD page)" % key); continue
        url = EDD_BASE + links[key]
        if not pdftotext:
            status.append("%s FAILED (published as PDF only and pdftotext is not installed)" % key); continue
        try:
            blob, _, _ = http_get(url)
            with tempfile.TemporaryDirectory() as td:
                pdf = os.path.join(td, "warn.pdf"); open(pdf, "wb").write(blob)
                txt = subprocess.run([pdftotext, "-layout", pdf, "-"], capture_output=True, text=True, timeout=120).stdout
            lines = [l for l in txt.splitlines() if county in l]
            n = 0
            for l in lines:
                m = rx.search(l)
                if m:
                    mo, da, yr = m.group(1).split("/")
                    notices.append(("%s-%s-%s" % (yr, mo, da), int(m.group(5).replace(",", "")), url)); n += 1
            miss = len(lines) - n
            status.append("%s PDF OK (%d notices%s)" % (key, n, ", %d lines unparsed" % miss if miss else ""))
        except Exception as e:
            status.append("%s FAILED (%s)" % (key, e))
    return notices, status


APARTMENTLIST_PAGE = "https://www.apartmentlist.com/research/category/data-rent-estimates"


def apartmentlist(name="San Jose, CA", ltype="City", bed="overall"):
    def go():
        body, _, _ = http_get(APARTMENTLIST_PAGE, accept="text/html")
        m = re.search(r'((?:https:)?//[^"\' ]+/Apartment_List_Rent_Estimates_(\d{4})_(\d{2})\.csv)', body.decode("utf-8", "replace"))
        if not m:
            raise SourceError("no Rent_Estimates CSV link on the Apartment List data page")
        url = m.group(1) if m.group(1).startswith("http") else "https:" + m.group(1)
        blob, _, _ = http_get(url)
        rdr = csv.reader(io.StringIO(blob.decode("utf-8", "replace")))
        hdr = next(rdr)
        months = [(i, h) for i, h in enumerate(hdr) if re.match(r"\d{4}_\d{2}$", h)]
        for row in rdr:
            if row[0] == name and row[1] == ltype and row[hdr.index("bed_size")] == bed:
                return url, [(h.replace("_", "-") + "-01", float(row[i])) for i, h in months if row[i] not in ("", "NA")]
        raise SourceError("%s / %s / %s row not found" % (name, ltype, bed))
    return cached("al", go)


BASKET = ["NVDA", "AAPL", "GOOGL", "META", "AVGO", "AMD", "AMAT", "LRCX", "KLAC", "INTC", "CSCO"]


def stooq_probe():
    """Brief named Stooq. Probe once; report why it can't be used."""
    def go():
        body, _, _ = http_get("https://stooq.com/q/d/l/?s=nvda.us&i=d", attempts=1)
        t = body[:200].decode("utf-8", "replace")
        if t.startswith("Date,"):
            return "OK"
        if "verify your browser" in body.decode("utf-8", "replace"):
            raise SourceError("serves a JavaScript proof-of-work challenge instead of CSV")
        raise SourceError("not a CSV response")
    return cached("stooq", go)


def nasdaq_closes(sym, days=800):
    def go():
        frm = (TODAY - dt.timedelta(days=days)).isoformat()
        url = "https://api.nasdaq.com/api/quote/%s/historical?assetclass=stocks&fromdate=%s&todate=%s&limit=9999" % (sym, frm, TODAY.isoformat())
        body, _, _ = http_get(url, accept="application/json", ua=BROWSER_UA)
        d = json.loads(body)
        rows = ((d.get("data") or {}).get("tradesTable") or {}).get("rows") or []
        if not rows:
            raise SourceError("Nasdaq API returned no rows for %s (%s)" % (sym, (d.get("status") or {}).get("bCodeMessage")))
        out = []
        for r in rows:
            mo, da, yr = r["date"].split("/")
            out.append(("%s-%s-%s" % (yr, mo, da), float(r["close"].replace("$", "").replace(",", ""))))
        return sorted(out)
    return cached("nasdaq:" + sym, go)


INDEED_METRO = "https://raw.githubusercontent.com/hiring-lab/job_postings_tracker/master/US/metro_job_postings_us.csv"


def indeed_metro(cbsa="41940"):
    def go():
        rdr = csv.reader(http_lines(INDEED_METRO))
        hdr = next(rdr)
        ci, di, vi = hdr.index("cbsa_code"), hdr.index("date"), hdr.index("indeed_job_postings_index")
        out = [(r[di], float(r[vi])) for r in rdr if len(r) > vi and r[ci] == cbsa and r[vi]]
        if not out:
            raise SourceError("CBSA %s not found" % cbsa)
        return sorted(out)
    return cached("indeed", go)


CAR_PAGE = "https://www.car.org/marketdata/data/housingdata"


def car_historical(label):
    def go():
        body, _, _ = http_get(CAR_PAGE, accept="text/html")
        t = body.decode("utf-8", "replace")
        links = {m.group(2).strip(): m.group(1) for m in re.finditer(r'href="(https://carorg\.sharepoint\.com/[^"]+)"[^>]*>([^<]+)', t)}
        if not links:
            raise SourceError("no historical-data links on the C.A.R. page")
        return links
    links = cached("car:links", go)
    href = next((v for k, v in links.items() if k.lower().startswith(label.lower())), None)
    if not href:
        raise SourceError("C.A.R. link '%s' not found" % label)

    def dl():
        url = href.replace("&amp;", "&") + "&download=1"
        try:
            blob, final, ctype = http_get(url, attempts=1)
        except SourceError as e:
            if str(e) in ("HTTP 401", "HTTP 403"):
                raise SourceError("C.A.R. historical xlsx is behind a Microsoft 365 login (SharePoint %s)" % e)
            raise
        if "login.microsoftonline.com" in final or "html" in ctype:
            raise SourceError("C.A.R. historical xlsx is behind a Microsoft 365 login (SharePoint redirects to login.microsoftonline.com)")
        return blob
    return cached("car:" + label, dl)


# ---------------------------------------------------------------- transforms
def ym(d):
    return d[:7]


def yoy_pct(rows):
    by = {ym(d): v for d, v in rows}
    out = []
    for d, v in rows:
        prev = by.get("%04d-%s" % (int(d[:4]) - 1, d[5:7]))
        if prev:
            out.append((d, round((v / prev - 1) * 100, 3)))
    return out


def diff(rows):
    return [(rows[i][0], round(rows[i][1] - rows[i - 1][1], 3)) for i in range(1, len(rows))]


def asof_lookup(rows):
    """Return f(date) -> latest value on or before date."""
    ds = [d for d, _ in rows]; vs = [v for _, v in rows]
    import bisect

    def f(d):
        i = bisect.bisect_right(ds, d) - 1
        return vs[i] if i >= 0 else None
    return f


def drawdown_2026(rows):
    in26 = [(d, v) for d, v in rows if d.startswith("%d-" % 2026)]
    if not in26:
        return None, []
    pd, pv = max(in26, key=lambda x: x[1])
    return (pd, pv), [(d, round((v / pv - 1) * 100, 3)) for d, v in rows if d >= pd]


def basket_index(series):
    """Equal-weight, rebalanced at each month start, base 100 on the first common date."""
    common = sorted(set.intersection(*[set(d for d, _ in s) for s in series.values()]))
    px = {sym: dict(s) for sym, s in series.items()}
    out, level, anchor_d, anchor_level = [], 100.0, None, 100.0
    for d in common:
        if anchor_d is None:
            anchor_d, anchor_level = d, 100.0
        elif ym(d) != ym(prev_d):                      # rebalance on the last close of the prior month
            anchor_d, anchor_level = prev_d, level
        level = anchor_level * sum(px[s][d] / px[s][anchor_d] for s in px) / len(px)
        out.append((d, round(level, 4)))
        prev_d = d
    return out


# ---------------------------------------------------------------- per-dial fetch
def fetch_dial(dial, cfg):
    """-> (rows [(date, value)], source_url, note). Raises SourceError."""
    f, src, tr = dial["fetch"], dial["source"], dial["transform"]
    sid, url = src.get("series_id"), src.get("url")
    did = dial["id"]
    if f == "fred_csv":
        if tr == "derived_spread_bp":
            m, t = fred("MORTGAGE30US"), fred("DGS10")
            look = asof_lookup(t)
            rows = [(d, round((v - look(d)) * 100, 1)) for d, v in m if look(d) is not None and d >= t[0][0]]
            return rows, FRED_CSV + "MORTGAGE30US", "MORTGAGE30US - DGS10"
        if tr == "derived_ratio_pct":
            num, den = sid.split("/")
            a, b = dict(fred(num)), dict(fred(den))
            rows = [(d, round(a[d] / b[d] * 100, 3)) for d in sorted(a) if d in b and b[d]]
            return rows, FRED_CSV + num, sid
        rows = fred(sid)
        if tr == "yoy_pct":
            rows = yoy_pct(rows)
        elif tr == "diff":
            rows = diff(rows)
        return rows, FRED_CSV + sid, sid
    if f == "zillow_csv":
        fname = url.rsplit("/", 1)[1]
        if did.startswith("zhvi_zip_"):
            z = did.rsplit("_", 1)[1]
            got = zillow_zips(tuple(cfg["geographies"]["owned_zips_seed"]))
            if z not in got:
                raise SourceError("zip %s not in the Zillow zip file" % z)
            return yoy_pct(got[z]), url, "zip " + z
        rows = zillow_county(fname)
        if tr == "yoy_pct":
            rows = yoy_pct(rows)
        elif tr == "drawdown_from_2026_peak":
            _, rows = drawdown_2026(rows)
            if not rows:
                raise SourceError("no 2026 prints yet")
        return rows, url, fname
    if f == "apartmentlist":
        u, rows = apartmentlist()
        return (yoy_pct(rows) if tr == "yoy_pct" else rows), u, "San Jose, CA / City / overall"
    if f == "edd_warn_xlsx":
        notices, status = warn_notices()
        if not notices:
            raise SourceError("; ".join(status))
        by = {}
        for d, n, _ in notices:
            by[d[:7]] = by.get(d[:7], 0) + n
        # fill zero months inside the covered span so a quiet month reads 0, not missing
        first, last = min(by), max(by)
        y, m = int(first[:4]), int(first[5:])
        rows = []
        while "%04d-%02d" % (y, m) <= last:
            k = "%04d-%02d" % (y, m)
            rows.append((k + "-01", float(by.get(k, 0))))
            m += 1
            if m == 13:
                y, m = y + 1, 1
        return rows, EDD_PAGE, " | ".join(status)
    if f == "nasdaq_api":
        note = []
        try:
            stooq_probe(); note.append("stooq OK")
        except SourceError as e:
            note.append("stooq FAILED (%s); using Nasdaq API" % e)
        series, missing = {}, []
        for s in BASKET:
            try:
                series[s] = nasdaq_closes(s)
            except SourceError as e:
                missing.append("%s: %s" % (s, e))
        if missing:
            raise SourceError("basket incomplete, not computed: " + "; ".join(missing))
        return basket_index(series), "https://api.nasdaq.com/api/quote/{SYMBOL}/historical", "; ".join(note)
    if f == "indeed_csv":
        return indeed_metro(), INDEED_METRO, "CBSA 41940"
    if f == "car_xlsx":
        label = "Sales of Existing" if "sales" in did else "Median Prices of Existing"
        car_historical(label)        # raises with the reason when blocked
        raise SourceError("C.A.R. xlsx downloaded but no parser is defined yet")
    raise SourceError("no fetcher for fetch=%s" % f)


# ---------------------------------------------------------------- corridors
def seasonal(rows):
    by = {}
    for d, v in rows:
        y = int(d[:4])
        if y in SEASONAL_YEARS:
            by.setdefault(d[5:7], {}).setdefault(y, []).append(v)
    out = {}
    for mth, years in sorted(by.items()):
        vals = [sum(v) / len(v) for v in years.values()]
        out[mth] = {"mean": round(statistics.mean(vals), 4), "sd": round(statistics.stdev(vals), 4) if len(vals) > 1 else None, "n": len(vals)}
    return out


def stats(rows, lo="2021-01-01", hi="2025-12-31"):
    v = sorted(x for d, x in rows if lo <= d <= hi)
    if not v:
        return None
    q = lambda p: v[min(len(v) - 1, int(round(p * (len(v) - 1))))]
    return {"window": [lo, hi], "n": len(v), "min": v[0], "p10": q(.1), "median": q(.5), "p90": q(.9), "max": v[-1]}


def avg_last(rows, n=10):
    tail = [v for _, v in rows[-n:]]
    return round(sum(tail) / len(tail), 4) if tail else None


def fmt(x):
    if x is None:
        return "-"
    if isinstance(x, float):
        return ("%.0f" % x) if abs(x) >= 10000 else ("%.3f" % x).rstrip("0").rstrip(".")
    return str(x)


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
        s = seasonal(r["rows"])
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
                          "latest_10d_avg": avg_last(rows), "latest": rows[-1], "computed_on": TODAY.isoformat()}
        if complete:
            lines.append("    2010-2025 max = %s on %s; latest %s = %s; 10-day avg %s" % (mv, md, rows[-1][0], rows[-1][1], avg_last(rows)))
        else:
            lines.append("    FAILED (incomplete history): FRED serves BAMLH0A3HYC only from %s (ICE licence: ~3 years)." % first)
            lines.append("    The 2010-2025 maximum CANNOT be computed from FRED. Max inside the available %s..2025-12-31 window = %s on %s (NOT the threshold)." % (first, mv, md))
            lines.append("    latest %s = %s; 10-day avg %s" % (rows[-1][0], rows[-1][1], avg_last(rows)))
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

    # (e) ZHVI
    lines.append("(e) ZHVI Santa Clara County (all homes, SA): 2026 peak, current drawdown; tier YoY")
    if "zhvi_scc" in ok:
        rows = ok["zhvi_scc"]["rows"]
        peak, dd = drawdown_2026(rows)
        if peak:
            pd, pv = peak
            ld, lv = rows[-1]
            cur = (lv / pv - 1) * 100
            maxdd = min(v for _, v in dd)
            c = {"rule": "corridor", "peak_2026": {"month": pd[:7], "value": round(pv)}, "provisional_until": "shakedown 2026-12-14",
                 "latest": {"month": ld[:7], "value": round(lv)}, "current_drawdown_pct": round(cur, 2), "max_drawdown_pct": round(maxdd, 2),
                 "scenario_bounds_pct": {"bull_above": -8, "bear_at_or_below": -15}, "computed_on": TODAY.isoformat()}
            cor["zhvi_scc"] = c; cor["zhvi_scc_drawdown"] = c
            lines.append("    2026 peak %s = $%s; latest %s = $%s; current drawdown %.2f%% (max so far %.2f%%) -> partition today: %s" % (
                pd[:7], format(round(pv), ","), ld[:7], format(round(lv), ","), cur, maxdd,
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
    lines.append("(f) other corridor dials: 2021-2025 distribution + latest (thresholds are set at the shakedown)")
    for did, r in ok.items():
        d = dials[did]
        if d["band_rule"] != "corridor" or did in cor:
            continue
        rows = r["rows"]
        c = {"rule": "corridor", "thresholds": None, "set_at": "shakedown", "stats_2021_2025": stats(rows),
             "latest": rows[-1], "latest_10d_avg": avg_last(rows) if d["cadence"] == "daily" else None, "computed_on": TODAY.isoformat()}
        extra = ""
        if did == "sp500":
            ref = dict(rows).get("2026-10-06")
            if ref:
                c["oct6_2026_high"] = ref
                c["drawdown_from_oct6_pct"] = round((rows[-1][1] / ref - 1) * 100, 2)
                after = [v for dd_, v in rows if dd_ > "2026-10-06"]
                c["closed_above_oct6_since"] = any(v > ref for v in after)
                extra = " | Oct 6 high %s, drawdown %+.2f%%, closed above since: %s" % (ref, c["drawdown_from_oct6_pct"], c["closed_above_oct6_since"])
        if did == "basket_index":
            yr = [(dd_, v) for dd_, v in rows if dd_ >= (dt.date.fromisoformat(rows[-1][0]) - dt.timedelta(days=365)).isoformat()]
            hd, hv = max(yr, key=lambda x: x[1])
            c["high_52w"] = {"date": hd, "value": hv}
            c["drawdown_from_52w_high_pct"] = round((rows[-1][1] / hv - 1) * 100, 2)
            c["base_date"] = rows[0][0]
            extra = " | 52w high %s on %s, drawdown %+.2f%% (C30 line -30%%)" % (fmt(hv), hd, c["drawdown_from_52w_high_pct"])
        if did == "mortgage_spread":
            extra = " | C11 line 180 bp; brief norm ~170 bp"
        cor[did] = c
        s = c["stats_2021_2025"]
        lines.append("    %-34s latest %s = %-9s%s 2021-25 min/med/max %s/%s/%s%s" % (
            did, rows[-1][0], fmt(rows[-1][1]), (" 10d avg %s" % fmt(c["latest_10d_avg"])) if c["latest_10d_avg"] is not None else "",
            fmt(s["min"]) if s else "-", fmt(s["median"]) if s else "-", fmt(s["max"]) if s else "-", extra))
    return cor, lines


# ---------------------------------------------------------------- Supabase (--write only)
def load_env():
    for ep in ENV_PATHS:
        if os.path.exists(ep):
            return dict((k, v.strip("'\"")) for k, v in re.findall(r"^([A-Z0-9_]+)=(.*)$", open(ep).read(), re.M))
    return {}


def sb_req(sb, key, method, path, body=None, prefer=None):
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    req = urllib.request.Request(sb + "/rest/v1/" + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        t = r.read().decode()
        return json.loads(t) if t else None


def write_all(cfg, results, corridors):
    env = load_env()
    sb, key = env.get("LRG_SUPABASE_URL"), env.get("LRG_SUPABASE_SERVICE_KEY")
    if not sb or not key:
        sys.exit("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing from .env.local")
    missing = []
    for t in TABLES:
        try:
            sb_req(sb, key, "GET", t + "?select=*&limit=1")
        except urllib.error.HTTPError as e:
            missing.append("%s (HTTP %d: %s)" % (t, e.code, e.read().decode()[:120]))
        except Exception as e:
            missing.append("%s (%s: %s)" % (t, type(e).__name__, e))
    if missing:
        print("\nREFUSING --write: these tables are not reachable over PostgREST:\n  " + "\n  ".join(missing))
        print("Apply supabase/migrations/2026-11-01_market_cycle.sql first (owner's tap), then re-run with --write.")
        sys.exit(2)

    sb_req(sb, key, "POST", "cycle_thesis_versions?on_conflict=version", [{"version": cfg["version"], "date": cfg["date"], "config": cfg}],
           prefer="resolution=ignore-duplicates,return=minimal")
    claims = [{k: c[k] for k in ("id", "text", "category", "scenario_tag", "prob_initial", "prob_current", "resolves_on", "falsifier", "data_source", "status")}
              | {"version": cfg["version"]} for c in cfg["claims"]]
    sb_req(sb, key, "POST", "cycle_claims?on_conflict=id", claims, prefer="resolution=ignore-duplicates,return=minimal")
    dial_rows = []
    for d in cfg["dials"]:
        row = {k: d[k] for k in ("id", "name", "cadence", "category", "source", "units", "transform", "direction_map", "band_rule", "has_history", "votes", "geography")}
        row["fetch_method"] = d["fetch"]          # FETCH is a reserved word in Postgres
        row["notes"] = d.get("notes"); row["corridor"] = corridors.get(d["id"], d.get("corridor")); row["updated_at"] = dt.datetime.now(dt.timezone.utc).isoformat()
        dial_rows.append(row)
    sb_req(sb, key, "POST", "cycle_dials?on_conflict=id", dial_rows, prefer="resolution=merge-duplicates,return=minimal")
    print("  upserted %d dials (with corridors), %d claims (insert-only), thesis v%s (insert-only)" % (len(dial_rows), len(claims), cfg["version"]))

    n = 0
    for did, r in results.items():
        if r["status"] != "OK":
            continue
        rows = [{"dial_id": did, "as_of": d[:10], "value": v, "source_url": r["source_url"], "raw": json.dumps({"value": v, "source": r["note"]})}
                for d, v in r["rows"] if d[:10] >= STORE_SINCE]
        for i in range(0, len(rows), 500):
            sb_req(sb, key, "POST", "cycle_readings?on_conflict=dial_id,as_of,source_url", rows[i:i + 500], prefer="resolution=merge-duplicates,return=minimal")
        n += len(rows)
    print("  upserted %d readings (as_of >= %s)" % (n, STORE_SINCE))

    have = sb_req(sb, key, "GET", "cycle_owned_properties?select=address,zip,flag&retired_at=is.null")
    seed = [{"address": "5764 Halleck Dr, San Jose, CA 95123", "zip": "95123", "flag": "for_sale", "bought_on": "2026-10-01", "listed_on": "2026-10-14", "source": "bootstrap"},
            {"address": "2116 Quito Rd, San Jose, CA 95130", "zip": "95130", "flag": "for_sale", "bought_on": "2026-10-08", "listed_on": "2026-10-22", "source": "bootstrap"},
            {"address": None, "zip": "95118", "flag": "home", "bought_on": None, "listed_on": None, "source": "bootstrap"}]
    new = [s for s in seed if not any(h["zip"] == s["zip"] and h["flag"] == s["flag"] for h in have)]
    if new:
        sb_req(sb, key, "POST", "cycle_owned_properties", new, prefer="return=minimal")
    print("  owned properties: %d seeded, %d already present" % (len(new), len(seed) - len(new)))

    have = {h["label"] for h in sb_req(sb, key, "GET", "cycle_calendar?select=label")}
    cal = [{"date": c["date"] if re.match(r"\d{4}-\d{2}-\d{2}$", c["date"]) else None, "label": c["name"], "dial_id": c["dial_id"], "tentative": c["tentative"]}
           for c in cfg["calendar"] if c["name"] not in have]
    if cal:
        sb_req(sb, key, "POST", "cycle_calendar", cal, prefer="return=minimal")
    print("  calendar: %d inserted" % len(cal))

    if not sb_req(sb, key, "GET", "cycle_weight_moves?select=id&bootstrap_exception=is.true&limit=1"):
        m = cfg["weight_moves"][0]
        sb_req(sb, key, "POST", "cycle_weight_moves", [{"date": m["date"], "from_weights": m["from"], "to_weights": m["to"], "readings_cited": {"bootstrap": m["readings_cited"]},
               "argument": m["reason"], "opposite_case": m["opposite_case"], "reverses_if": m["reverses_if"], "bootstrap_exception": True}], prefer="return=minimal")
        print("  weight move #0 inserted")


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--write", action="store_true", help="upsert readings/corridors/registry into Supabase (default: dry run)")
    ap.add_argument("--only", help="comma-separated dial ids")
    a = ap.parse_args()
    cfg = json.load(open(CONFIG))
    only = set(a.only.split(",")) if a.only else None
    dials = [d for d in cfg["dials"] if d["has_history"] and (not only or d["id"] in only)]
    print("market-cycle bootstrap %s — %s — %d dials with history — %s" % (cfg["version"], TODAY.isoformat(), len(dials), "WRITE" if a.write else "DRY RUN (no database access)"))
    print("%-34s %-30s %-8s %6s  %-10s  %-10s  %s" % ("dial", "source", "status", "rows", "first", "last", "latest"))
    results = {}
    for d in dials:
        src = d["source"].get("series_id") or d["fetch"]
        try:
            rows, url, note = fetch_dial(d, cfg)
            if not rows:
                raise SourceError("parsed 0 rows")
            results[d["id"]] = {"status": "OK", "rows": rows, "source_url": url, "note": note}
            print("%-34s %-30s %-8s %6d  %-10s  %-10s  %s" % (d["id"], src[:30], "OK", len(rows), rows[0][0], rows[-1][0], fmt(rows[-1][1])))
            if d["fetch"] in ("edd_warn_xlsx", "nasdaq_api"):
                print("    note: " + note)
        except SourceError as e:
            results[d["id"]] = {"status": "FAILED", "reason": str(e)}
            print("%-34s %-30s FAILED(%s)" % (d["id"], src[:30], e))
        sys.stdout.flush()
    nok = sum(1 for r in results.values() if r["status"] == "OK")
    print("\n%d OK, %d FAILED" % (nok, len(results) - nok))
    corridors, lines = compute_corridors(results, cfg)
    print("\nCORRIDORS")
    print("\n".join(lines))
    if a.write:
        print("\nWRITING")
        write_all(cfg, results, corridors)
    else:
        print("\nDry run: nothing written. --write upserts readings, corridors, registry and the owned-property seed.")


if __name__ == "__main__":
    main()
