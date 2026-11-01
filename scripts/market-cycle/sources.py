"""Market-cycle tracker: shared fetchers, parsers, transforms and registry rows.

One code path for every free source, used by
  bootstrap-history.py  (full history + corridor numbers, Phase 0)
  collect-macro.py      (daily: new readings only + scheduled-release notes)
  sync-registry.py      (config -> cycle_dials / cycle_claims / cycle_calendar)

Spec: briefs/BRIEF_MARKET_CYCLE_TRACKER_2026-11-01.md. Registry:
config/market-cycle/thesis.v1.1.json. Stdlib only (PDFs via the system
`pdftotext` when present). A source that cannot be read raises SourceError
with the reason; nothing is ever filled in or guessed.

Readings and variants. fetch_dial() returns the dial's own series (value in
the dial's units after its `transform`). corridor_variants() returns the extra
series the dial's corridor reads: corridor.transform when it differs from the
dial transform (e.g. sp500 -> drawdown from the Oct 6 2026 close) and
corridor.read_as (10d_avg, 2d_close). Variants are stored in cycle_readings
with variant = that name; the base series has variant ''.
"""
import bisect, csv, datetime as dt, html as htmllib, io, json, os, re, shutil, statistics, subprocess, tempfile, time
import urllib.error, urllib.parse, urllib.request, zipfile
import xml.etree.ElementTree as ET
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
CONFIG = os.path.join(ROOT, "config", "market-cycle", "thesis.v1.1.json")
ENV_PATHS = [os.path.join(ROOT, ".env.local"), "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local"]
# Honest UA by default: FRED (Akamai) tarpits a spoofed Chrome UA that lacks the
# rest of a browser's headers. The Nasdaq API needs a browser-like UA.
UA = "mission-control-market-cycle/1.0 (+stdlib urllib)"
BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36"
TODAY = dt.date.today()
STORE_SINCE = "2010-01-01"                 # readings older than this are never written (bootstrap + collector)
MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"]


class SourceError(Exception):
    pass


def load_config(path=CONFIG):
    with open(path) as f:
        return json.load(f)


# ---------------------------------------------------------------- HTTP
def http_get(url, accept=None, attempts=2, timeout=45, ua=None):
    """GET with at most `attempts` tries (never hammer a blocked site). Returns (bytes, final_url, content_type)."""
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


_cache = {}


def cached(key, fn):
    """Memoise a fetch for the run, including its failure (a blocked source is asked once)."""
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


def find_pdftotext():
    return shutil.which("pdftotext") or ("/opt/homebrew/bin/pdftotext" if os.path.exists("/opt/homebrew/bin/pdftotext") else None)


def pdf_text(blob, pdftotext):
    with tempfile.TemporaryDirectory() as td:
        pdf = os.path.join(td, "doc.pdf")
        with open(pdf, "wb") as f:
            f.write(blob)
        return subprocess.run([pdftotext, "-layout", pdf, "-"], capture_output=True, text=True, timeout=120).stdout


# ---------------------------------------------------------------- FRED
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


# ---------------------------------------------------------------- Zillow
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
    return cached("zillow:zips", go)


# ---------------------------------------------------------------- EDD WARN
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
    def go():
        links = edd_links()
        notices, status = [], []
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
        pdftotext = find_pdftotext()
        rx = re.compile(r"^\s*(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(\d\d/\d\d/\d{4})\s+(.*?)\s{2,}" + re.escape(county) + r"\s+([\d,]+)\s")
        for key in ("fy2025", "fy2026"):
            if key not in links:
                status.append("%s FAILED (no PDF link on the EDD page)" % key); continue
            url = EDD_BASE + links[key]
            if not pdftotext:
                status.append("%s FAILED (published as PDF only and pdftotext is not installed)" % key); continue
            try:
                blob, _, _ = http_get(url)
                txt = pdf_text(blob, pdftotext)
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
    return cached("edd:notices:" + county, go)


def warn_monthly(notices):
    """Sum notices by notice month; quiet months inside the covered span read 0, not missing."""
    by = {}
    for d, n, _ in notices:
        by[d[:7]] = by.get(d[:7], 0) + n
    first, last = min(by), max(by)
    rows, m = [], first
    while m <= last:
        rows.append((m + "-01", float(by.get(m, 0))))
        m = next_month(m)
    return rows


# ---------------------------------------------------------------- Apartment List, basket, Indeed
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


# ---------------------------------------------------------------- HTML helpers
class _Tables(HTMLParser):
    """Collects every <table> as a list of rows of cell text (no nesting needed for C.A.R.)."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self.cur, self.row, self.cell = [], None, None, None

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self.cur = []; self.tables.append(self.cur)
        elif tag == "tr" and self.cur is not None:
            self.row = []; self.cur.append(self.row)
        elif tag in ("td", "th") and self.row is not None:
            self.cell = []

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None and self.row is not None:
            self.row.append(re.sub(r"\s+", " ", "".join(self.cell)).strip()); self.cell = None
        elif tag == "table":
            self.cur, self.row = None, None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def html_tables(text):
    p = _Tables()
    p.feed(text)
    return p.tables


def html_to_text(text):
    s = re.sub(r"<script.*?</script>|<style.*?</style>", " ", text, flags=re.S | re.I)
    s = htmllib.unescape(re.sub(r"<[^>]+>", " ", s))
    return re.sub(r"\s+", " ", s.replace("\xa0", " ")).strip()


def num(s):
    """'$1,920,000' -> 1920000.0; '-4.0%' -> -4.0; '' / '-' -> None."""
    s = (s or "").replace("$", "").replace(",", "").replace("%", "").strip()
    if s in ("", "-", "--", "n/a", "N/A", "NA"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def month_from_label(s):
    """'Sept. 2026' / 'September 2026' / 'Aug 2026' / 'Nov-24' -> 'YYYY-MM'; None if not a month label."""
    m = re.match(r"^\s*([A-Za-z]{3})[A-Za-z]*\.?[\s,-]*(\d{4}|\d{2})\s*$", s or "")
    if not m or m.group(1).lower() not in MONTHS:
        return None
    y = m.group(2) if len(m.group(2)) == 4 else "20" + m.group(2)
    return "%s-%02d" % (y, MONTHS.index(m.group(1).lower()) + 1)


def next_month(m):
    y, mo = int(m[:4]), int(m[5:7])
    return "%04d-%02d" % (y + mo // 12, mo % 12 + 1)


def prev_month(m):
    y, mo = int(m[:4]), int(m[5:7])
    return "%04d-%02d" % (y - 1, 12) if mo == 1 else "%04d-%02d" % (y, mo - 1)


# ---------------------------------------------------------------- C.A.R. monthly news releases
# The historical xlsx files are behind a Microsoft 365 login. The public monthly
# "home sales and price" release pages carry the county table (median, YoY,
# sales YoY) and the Unsold Inventory Index / Median Time on Market table.
CAR_BASE = "https://www.car.org"
CAR_INDEX = CAR_BASE + "/aboutus/mediacenter/newsreleases/%dreleases"
CAR_BACKFILL_FROM_YEAR = 2024      # 2024releases starts with the Dec 2023 release -> ~34 months
CAR_RECENT = 3                     # daily collector reads the newest 3 releases


def car_slug_month(href):
    """'.../2026releases/sept2026sales' -> '2026-09'; '2july2024sales' -> '2024-07'; None if absent."""
    slug = href.rstrip("/").rsplit("/", 1)[-1].lower()
    m = re.search(r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*?(20\d\d)", slug)
    return "%s-%02d" % (m.group(2), MONTHS.index(m.group(1)) + 1) if m else None


def car_release_links(text, year):
    """Monthly sales-release links on a C.A.R. YYYYreleases index page -> [(url, slug_month)]."""
    out, seen = [], set()
    for m in re.finditer(r'href="((?:https://www\.car\.org)?/(?:en/)?aboutus/mediacenter/newsreleases/%dreleases/([^"#?]+))"' % year, text, re.I):
        href, slug = m.group(1), m.group(2)
        if "sales" not in slug.lower():
            continue
        url = href if href.startswith("http") else CAR_BASE + href
        if url.lower() in seen:
            continue
        seen.add(url.lower())
        out.append((url, car_slug_month(slug)))
    return out


def parse_car_release(text, counties=("Santa Clara", "San Francisco")):
    """Parse a C.A.R. monthly release page. -> {"month": "YYYY-MM", "counties": {name: rec|None}}.
    rec: median, median_prior_month, median_year_ago (USD), price_mtm_pct, price_yoy_pct,
    sales_mtm_pct, sales_yoy_pct (C.A.R.'s published % changes), revised (bool), and from the
    second table uii / uii_year_ago (months) and median_dom / median_dom_year_ago (days)."""
    tables = html_tables(text)
    price_t = dom_t = None
    for t in tables:
        head = " ".join(" ".join(r) for r in t[:3]).lower().replace(" ", "")
        if price_t is None and "priceyty" in head and "median" in head:     # "Median Sold/Sales Price ..."
            price_t = t
        elif dom_t is None and "mediantimeonmarket" in head:
            dom_t = t
    if price_t is None:
        raise SourceError("no median-price county table (Price YTY% column) on the page")

    def header(t):
        for i, r in enumerate(t[:6]):
            if r and r[0].startswith("State/Region/County"):
                return i, r
        raise SourceError("county table has no 'State/Region/County' header row")

    hi, hdr = header(price_t)
    mcols = [i for i, h in enumerate(hdr) if month_from_label(h)]
    if len(mcols) < 3:
        raise SourceError("county table header has %d month columns, expected 3" % len(mcols))
    month = month_from_label(hdr[mcols[0]])
    title_month = month_from_label(price_t[0][0]) if price_t[0] else None
    if title_month and title_month != month:
        raise SourceError("table title month %s != header month %s" % (title_month, month))
    if month_from_label(hdr[mcols[2]]) != "%04d-%s" % (int(month[:4]) - 1, month[5:]):
        raise SourceError("third month column %r is not the year-ago month" % hdr[mcols[2]])

    def col(*words):
        for i, h in enumerate(hdr):
            hl = h.lower().replace(" ", "")
            if all(w in hl for w in words):
                return i
        raise SourceError("column %s not found in %r" % ("+".join(words), hdr))
    c_pmtm, c_pyoy, c_smtm, c_syoy = col("price", "mtm"), col("price", "yty"), col("sales", "mtm"), col("sales", "yty")

    dom = None
    if dom_t is not None:
        dhi, dhdr = header(dom_t)
        dcols = [i for i, h in enumerate(dhdr) if month_from_label(h)]
        if len(dcols) >= 6 and month_from_label(dhdr[dcols[0]]) == month:
            dom = (dhi, dcols)

    out = {}
    for county in counties:
        row = next((r for r in price_t[hi + 1:] if r and r[0].strip() == county), None)
        if row is None or len(row) < len(hdr):
            out[county] = None
            continue
        rec = {"median": num(row[mcols[0]]), "median_prior_month": num(row[mcols[1]]), "median_year_ago": num(row[mcols[2]]),
               "price_mtm_pct": num(row[c_pmtm]), "price_yoy_pct": num(row[c_pyoy]),
               "sales_mtm_pct": num(row[c_smtm]), "sales_yoy_pct": num(row[c_syoy]),
               "revised": any(c.strip().lower() == "r" for c in row[1:])}
        if dom:
            dhi, dcols = dom
            drow = next((r for r in dom_t[dhi + 1:] if r and r[0].strip() == county), None)
            if drow and len(drow) > dcols[5]:
                rec.update({"uii": num(drow[dcols[0]]), "uii_year_ago": num(drow[dcols[2]]),
                            "median_dom": num(drow[dcols[3]]), "median_dom_year_ago": num(drow[dcols[5]])})
        out[county] = rec
    return {"month": month, "counties": out}


def car_releases(backfill=False):
    """-> ({month: {"url", "counties"}}, status_lines). Daily: newest CAR_RECENT releases.
    Backfill: every monthly release on the index pages from CAR_BACKFILL_FROM_YEAR."""
    def go():
        first_year = CAR_BACKFILL_FROM_YEAR if backfill else TODAY.year - 1
        links, status = [], []
        for y in range(TODAY.year, first_year - 1, -1):
            try:
                body, _, _ = http_get(CAR_INDEX % y, accept="text/html")
                got = car_release_links(body.decode("utf-8", "replace"), y)
                links += got
                status.append("index %d OK (%d sales releases)" % (y, len(got)))
            except SourceError as e:
                status.append("index %d FAILED (%s)" % (y, e))
        if not links:
            raise SourceError("no C.A.R. sales releases found: " + "; ".join(status))
        links.sort(key=lambda x: x[1] or "", reverse=True)
        if not backfill:
            links = [l for l in links if l[1]][:CAR_RECENT]
        out, failed = {}, []
        for url, slug_m in links:
            if slug_m and slug_m in out:
                continue                       # duplicate slug for a month already read (e.g. 2july2024sales)
            try:
                body, _, _ = http_get(url, accept="text/html")
                rel = parse_car_release(body.decode("utf-8", "replace"))
            except SourceError as e:
                failed.append("%s (%s)" % (url.rsplit("/", 1)[-1], e))
                continue
            if rel["month"] not in out:
                out[rel["month"]] = {"url": url, "counties": rel["counties"]}
        status.append("%d releases parsed (%s..%s)" % (len(out), min(out) if out else "-", max(out) if out else "-"))
        if failed:
            status.append("FAILED pages: " + "; ".join(failed))
        if not out:
            raise SourceError("; ".join(status))
        return out, status
    return cached("car:%s" % backfill, go)


# ---------------------------------------------------------------- SCCAOR
# The housing-stats page links the last 12 monthly PDFs (SFR summary row:
# new listings, inventory, closed sales, average DOM, average/median price).
# Older PDFs stay at wp-content/uploads/<publish yyyy>/<publish mm>/<Month><yyyy>.pdf
# (published the following month; back to Feb 2023). Monthly posts (HTML,
# Aug 2026 onward) carry median, sales and average DOM in prose and are used
# to cross-check the PDF, or as the source when a month has no PDF yet.
SCCAOR_STATS = "https://www.sccaor.com/housing-stats/"
SCCAOR_UPLOADS = "https://www.sccaor.com/wp-content/uploads/"
SCCAOR_POSTS = "https://www.sccaor.com/wp-json/wp/v2/posts?search=housing%20statistics&per_page=24&_fields=link,title"
SCCAOR_BACKFILL_FROM = "2023-01"
SCCAOR_RECENT = 3


def sccaor_index_links(text):
    """Monthly PDF links on the housing-stats page -> {month: url}."""
    out = {}
    for m in re.finditer(r'href="([^"]+\.pdf)"[^>]*>\s*([^<]{3,40}?)\s*<', text, re.I):
        mo = month_from_label(m.group(2))
        if mo:
            href = m.group(1)
            out[mo] = href if href.startswith("http") else "https://www.sccaor.com" + href
    return out


def sccaor_pdf_candidates(month):
    y, mo = int(month[:4]), int(month[5:7])
    name = "%s%d.pdf" % (MONTH_NAMES[mo - 1], y)
    pubs = [next_month(month), next_month(next_month(month)), month]
    return [SCCAOR_UPLOADS + "%s/%s/%s" % (p[:4], p[5:7], name) for p in pubs]


def parse_sccaor_pdf_text(text):
    """`pdftotext -layout` output of a SCCAOR monthly PDF -> (month, rec) from the
    Single Family Residence summary row."""
    lines = text.splitlines()
    i = next((k for k, l in enumerate(lines) if ":: Single Family Residence" in l), None)
    if i is None:
        raise SourceError("no 'Single Family Residence' section in the PDF text")
    month = month_from_label(lines[i].split("::")[0].strip())
    if not month:
        raise SourceError("unreadable section title %r" % lines[i].strip())
    hdr = next((l for l in lines[i + 1:i + 4] if "Area/City" in l), "")
    want = ["New Listings", "Cur Inv", "Closed Sales", "Ave. DOM", "Ave. Price", "Med. Price"]
    pos = [hdr.find(w) for w in want]
    if min(pos) < 0 or pos != sorted(pos):
        raise SourceError("unexpected SFR header %r" % hdr.strip())
    end = next((k for k in range(i + 1, len(lines)) if "::" in lines[k]), len(lines))
    summ = next((lines[k] for k in range(i + 1, end) if lines[k].strip().startswith("Summary")), None)
    if summ is None:
        raise SourceError("no SFR Summary row")
    toks = [t for t in summ.split()[1:] if t != "$"]
    vals = [num(t) for t in toks[:6]]
    if len(vals) < 6 or any(v is None for v in vals):
        raise SourceError("unreadable SFR Summary row %r" % summ.strip())
    rec = dict(zip(["new_listings", "inventory", "sales", "avg_dom", "avg_price", "median_price"], vals))
    if rec["sales"] <= 0:
        raise SourceError("SFR Summary shows %s sales" % rec["sales"])
    return month, rec


def parse_sccaor_post_html(text):
    """A SCCAOR 'Housing Statistics Month of <Month YYYY>' post (HTML) -> (month, rec)
    with median_price, sales, avg_dom (None where the prose omits one)."""
    s = html_to_text(text)
    m = re.search(r"Housing Statistics Month of ([A-Za-z]+\.? \d{4})", s)
    month = month_from_label(m.group(1)) if m else None
    if not month:
        raise SourceError("no 'Housing Statistics Month of <Month YYYY>' title")
    med = re.search(r"single[- ]family residence median home price[^$]{0,40}\$\s*([\d,]+)", s, re.I)
    sales = re.search(r"Single[- ]Family Residence Sales[^0-9]{0,40}([\d,]+)", s, re.I)
    dom = re.search(r"Average Days on Market[^0-9]{0,40}?(\d+)\s*days", s, re.I)
    rec = {"median_price": num(med.group(1)) if med else None, "sales": num(sales.group(1)) if sales else None,
           "avg_dom": num(dom.group(1)) if dom else None}
    if rec["sales"] is None and rec["median_price"] is None:
        raise SourceError("post %s has neither a median price nor a sales count" % month)
    return month, rec


def sccaor_months(backfill=False):
    """-> ({month: rec + source_url}, status_lines)."""
    def go():
        status = []
        body, _, _ = http_get(SCCAOR_STATS, accept="text/html")
        listed = sccaor_index_links(body.decode("utf-8", "replace"))
        if not listed:
            raise SourceError("no monthly PDF links on the SCCAOR housing-stats page")
        status.append("housing-stats page OK (%d monthly PDFs %s..%s)" % (len(listed), min(listed), max(listed)))
        months = sorted(listed, reverse=True)
        if not backfill:
            months = months[:SCCAOR_RECENT]
        cands = {m: [listed[m]] for m in months}
        if backfill:
            m = SCCAOR_BACKFILL_FROM
            while m < min(listed):
                cands[m] = sccaor_pdf_candidates(m)
                m = next_month(m)
        out, missing, bad = {}, [], []
        pdftotext = find_pdftotext()
        if not pdftotext:
            status.append("PDFs FAILED (pdftotext is not installed)")
        else:
            for m in sorted(cands, reverse=True):
                got = None
                for url in cands[m]:
                    try:
                        blob, _, ctype = http_get(url, attempts=1)
                    except SourceError:
                        continue
                    if not blob.startswith(b"%PDF"):
                        continue
                    try:
                        pm, rec = parse_sccaor_pdf_text(pdf_text(blob, pdftotext))
                    except SourceError as e:
                        bad.append("%s (%s)" % (m, e)); got = False; break
                    if pm != m:
                        bad.append("%s (PDF is for %s)" % (m, pm)); got = False; break
                    rec["source_url"] = url
                    got = rec
                    break
                if got:
                    out[m] = got
                elif got is None:
                    missing.append(m)
            status.append("%d monthly PDFs parsed" % len(out))
            if missing:
                status.append("no PDF found for %s" % ", ".join(sorted(missing)))
            if bad:
                status.append("PDF FAILED: " + "; ".join(bad))
        # monthly posts: cross-check, or fill a month the PDFs don't have yet
        try:
            pb, _, _ = http_get(SCCAOR_POSTS, accept="application/json")
            posts = [p for p in json.loads(pb) if "Housing Statistics Month of" in htmllib.unescape(p.get("title", {}).get("rendered", ""))]
            if not backfill:
                posts = posts[:2]
            checked = []
            for p in posts:
                try:
                    hb, _, _ = http_get(p["link"], accept="text/html")
                    pm, prec = parse_sccaor_post_html(hb.decode("utf-8", "replace"))
                except SourceError as e:
                    status.append("post FAILED %s (%s)" % (p.get("link"), e)); continue
                if pm in out:
                    diffs = ["%s pdf %s vs post %s" % (k, out[pm][k], prec[k]) for k in ("sales", "median_price", "avg_dom")
                             if prec.get(k) is not None and prec[k] != out[pm][k]]
                    checked.append("%s %s" % (pm, "MISMATCH " + ", ".join(diffs) if diffs else "matches PDF"))
                elif backfill or pm >= max(out or {"0000-00": 1}):
                    prec["source_url"] = p["link"]
                    prec["from_post"] = True
                    out[pm] = prec
                    checked.append("%s from post (no PDF yet)" % pm)
            status.append("posts: " + ("; ".join(checked) if checked else "none"))
        except SourceError as e:
            status.append("posts FAILED (%s)" % e)
        except ValueError as e:
            status.append("posts FAILED (bad JSON: %s)" % e)
        if not out:
            raise SourceError("; ".join(status))
        return out, status
    return cached("sccaor:%s" % backfill, go)


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

    def f(d):
        i = bisect.bisect_right(ds, d) - 1
        return vs[i] if i >= 0 else None
    return f


def spread_bp(long_rows, short_rows):
    """(long - short) in basis points on each long-series date, short read as-of that date
    (mortgage30 weekly minus the 10-yr's latest close on or before the survey date)."""
    if not short_rows:
        return []
    look = asof_lookup(short_rows)
    return [(d, round((v - look(d)) * 100, 1)) for d, v in long_rows if d >= short_rows[0][0] and look(d) is not None]


def ratio_pct(num_rows, den_rows):
    b = dict(den_rows)
    return [(d, round(v / b[d] * 100, 3)) for d, v in sorted(num_rows) if b.get(d)]


def drawdown_from_fixed(rows, ref_value, since=None):
    """% from a fixed high (reference peak / a dated close), for dates on or after `since`."""
    return [(d, round((v / ref_value - 1) * 100, 3)) for d, v in rows if since is None or d >= since]


def drawdown_from_rolling_high(rows, days=365):
    """% below the highest value in the trailing `days` calendar days (inclusive of today).
    Dates whose lookback reaches before the series start are skipped (partial window)."""
    out, ds = [], [d for d, _ in rows]
    for i, (d, v) in enumerate(rows):
        lo = (dt.date.fromisoformat(d[:10]) - dt.timedelta(days=days)).isoformat()
        if lo < ds[0][:10]:
            continue
        j = bisect.bisect_left(ds, lo)
        hi = max(x for _, x in rows[j:i + 1])
        out.append((d, round((v / hi - 1) * 100, 3)))
    return out


def rolling_mean(rows, n=10):
    out = []
    for i in range(n - 1, len(rows)):
        out.append((rows[i][0], round(sum(v for _, v in rows[i - n + 1:i + 1]) / n, 4)))
    return out


def two_day_close(rows, bear_up=True):
    """A level holds on a two-day close iff both closes are past it: min of the two closes
    for a dial whose up-move is bear (CCC OAS), max otherwise."""
    pick = min if bear_up else max
    return [(rows[i][0], pick(rows[i - 1][1], rows[i][1])) for i in range(1, len(rows))]


def basket_index(series):
    """Equal-weight, rebalanced at each month start, base 100 on the first common date."""
    common = sorted(set.intersection(*[set(d for d, _ in s) for s in series.values()]))
    px = {sym: dict(s) for sym, s in series.items()}
    out, level, anchor_d, anchor_level, prev_d = [], 100.0, None, 100.0, None
    for d in common:
        if anchor_d is None:
            anchor_d, anchor_level = d, 100.0
        elif ym(d) != ym(prev_d):                      # rebalance on the last close of the prior month
            anchor_d, anchor_level = prev_d, level
        level = anchor_level * sum(px[s][d] / px[s][anchor_d] for s in px) / len(px)
        out.append((d, round(level, 4)))
        prev_d = d
    return out


def apply_named_transform(name, rows):
    """Corridor-side transforms: yoy_pct, drawdown_from_52w_high, drawdown_from_<YYYY-MM-DD>_high."""
    if name == "yoy_pct":
        return yoy_pct(rows)
    if name == "drawdown_from_52w_high":
        return drawdown_from_rolling_high(rows, 365)
    m = re.match(r"drawdown_from_(\d{4}-\d{2}-\d{2})_high$", name)
    if m:
        ref = dict(rows).get(m.group(1))
        if ref is None:
            raise SourceError("reference close %s is not in the series" % m.group(1))
        return drawdown_from_fixed(rows, ref, since=m.group(1))
    raise SourceError("unknown corridor transform %r" % name)


def corridor_variants(dial, rows):
    """-> [(variant, rows | SourceError)] the dial's corridor reads besides its base series."""
    cor = dial.get("corridor") or {}
    out = []
    t = cor.get("transform")
    if t and t != dial.get("transform"):
        try:
            out.append((t, apply_named_transform(t, rows)))
        except SourceError as e:
            out.append((t, e))
    ra = cor.get("read_as")
    if ra == "10d_avg":
        out.append(("10d_avg", rolling_mean(rows, 10)))
    elif ra == "2d_close":
        out.append(("2d_close", two_day_close(rows, bear_up=(dial.get("direction_map") or {}).get("up") == "bear")))
    elif ra:
        out.append((ra, SourceError("unknown read_as %r" % ra)))
    return out


def reading_rows(dial_id, variant, rows, source_url, note, extras=None, since=None):
    """[(date, value)] -> cycle_readings rows. Base rows (variant '') take a per-row
    source_url / raw detail from `extras` when the source has one (C.A.R. release
    page, SCCAOR PDF); variant rows carry the dial's source_url."""
    out = []
    for d, v in rows:
        if v is None or (since and d[:10] < since):
            continue
        ex = ((extras or {}).get(d) or {}) if not variant else {}
        raw = {"value": v, "source": note}
        raw.update(ex.get("raw") or {})
        out.append({"dial_id": dial_id, "variant": variant, "as_of": d[:10], "value": v,
                    "source_url": ex.get("source_url") or source_url, "raw": json.dumps(raw)})
    return out


def new_only(rows, latest_as_of):
    """Readings strictly newer than the latest stored as_of (None = nothing stored)."""
    if not latest_as_of:
        return list(rows)
    return [r for r in rows if r[0][:10] > latest_as_of[:10]]


# ---------------------------------------------------------------- per-dial fetch
def fetch_dial(dial, cfg, backfill=False):
    """-> (rows [(date, value)], source_url, note, extras {as_of: {"source_url"?, "raw"?}}).
    backfill=True reads the full public archive for the monthly-release sources
    (C.A.R., SCCAOR); the daily collector reads only the newest few. Raises SourceError."""
    f, src, tr = dial["fetch"], dial.get("source") or {}, dial["transform"]
    sid, url = src.get("series_id"), src.get("url")
    did = dial["id"]
    if f == "fred_csv":
        if tr == "derived_spread_bp":
            return spread_bp(fred("MORTGAGE30US"), fred("DGS10")), FRED_CSV + "MORTGAGE30US", "MORTGAGE30US - DGS10", {}
        if tr == "derived_ratio_pct":
            a, b = sid.split("/")
            return ratio_pct(fred(a), fred(b)), FRED_CSV + a, sid, {}
        rows = fred(sid)
        if tr == "yoy_pct":
            rows = yoy_pct(rows)
        elif tr == "diff":
            rows = diff(rows)
        return rows, FRED_CSV + sid, sid, {}
    if f == "zillow_csv":
        fname = url.rsplit("/", 1)[1]
        if did.startswith("zhvi_zip_"):
            z = did.rsplit("_", 1)[1]
            got = zillow_zips(tuple(cfg["geographies"]["owned_zips_seed"]))
            if z not in got:
                raise SourceError("zip %s not in the Zillow zip file" % z)
            return yoy_pct(got[z]), url, "zip " + z, {}
        rows = zillow_county(fname)
        if tr == "yoy_pct":
            rows = yoy_pct(rows)
        elif tr == "drawdown_from_reference_peak":
            ref = cfg["scored_object"]["reference_peak"]
            seen = dict((d[:7], v) for d, v in rows).get(ref["month"])
            rows = drawdown_from_fixed(rows, ref["value"], since=ref["month"] + "-01")
            note = "fixed reference peak %s = %s" % (ref["month"], ref["value"])
            if seen and abs(seen / ref["value"] - 1) > 0.005:
                note += " (Zillow now shows %s for that month: revised >0.5%%)" % round(seen)
            return rows, url, note, {}
        return rows, url, fname, {}
    if f == "apartmentlist":
        u, rows = apartmentlist()
        return (yoy_pct(rows) if tr == "yoy_pct" else rows), u, "San Jose, CA / City / overall", {}
    if f == "edd_warn_xlsx":
        notices, status = warn_notices()
        if not notices:
            raise SourceError("; ".join(status))
        return warn_monthly(notices), EDD_PAGE, " | ".join(status), {}
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
        return basket_index(series), "https://api.nasdaq.com/api/quote/{SYMBOL}/historical", "; ".join(note), {}
    if f == "indeed_csv":
        return indeed_metro(), INDEED_METRO, "CBSA 41940", {}
    if f == "car_html":
        rel, status = car_releases(backfill)
        county, field = src["county"], src["field"]
        rows, extras = [], {}
        for m in sorted(rel):
            rec = (rel[m]["counties"] or {}).get(county)
            if rec and rec.get(field) is not None:
                d = m + "-01"
                rows.append((d, rec[field]))
                extras[d] = {"source_url": rel[m]["url"], "raw": dict(rec, county=county, month=m)}
        if not rows:
            raise SourceError("%s %s not found in any release (%s)" % (county, field, "; ".join(status)))
        return rows, CAR_INDEX % TODAY.year, " | ".join(status), extras
    if f == "sccaor_html":
        recs, status = sccaor_months(backfill)
        field = src["field"]
        rows, extras = [], {}
        for m in sorted(recs):
            if recs[m].get(field) is not None:
                d = m + "-01"
                rows.append((d, recs[m][field]))
                extras[d] = {"source_url": recs[m]["source_url"], "raw": dict(recs[m], month=m)}
        if not rows:
            raise SourceError("SCCAOR %s not found (%s)" % (field, "; ".join(status)))
        return rows, SCCAOR_STATS, " | ".join(status), extras
    if f == "derived":
        dials = {d["id"]: d for d in cfg["dials"]}
        nrows, _, _, _ = fetch_dial(dials[src["numerator_dial"]], cfg, backfill)
        drows, _, _, dext = fetch_dial(dials[src["denominator_dial"]], cfg, backfill)
        a = dict((d[:7], v) for d, v in nrows)
        rows, extras = [], {}
        for d, v in drows:
            if v and a.get(d[:7]) is not None:
                rows.append((d, round(a[d[:7]] / v, 2)))
                raw = {"numerator": a[d[:7]], "denominator": v, "numerator_dial": src["numerator_dial"], "denominator_dial": src["denominator_dial"]}
                inv = ((dext.get(d) or {}).get("raw") or {}).get("inventory")
                if inv is not None:
                    raw["sccaor_sfr_inventory"] = inv
                    raw["sfr_only_months"] = round(inv / v, 2)
                extras[d] = {"raw": raw}
        if not rows:
            raise SourceError("no month has both %s and %s" % (src["numerator_dial"], src["denominator_dial"]))
        return rows, "derived:%s/%s" % (src["numerator_dial"], src["denominator_dial"]), "%s / %s" % (src["numerator_dial"], src["denominator_dial"]), extras
    raise SourceError("no fetcher for fetch=%s" % f)


# ---------------------------------------------------------------- registry rows (config -> cycle_* tables)
RESERVED_CORRIDOR_KEY = "computed"


def merge_corridor(authored, computed=None, existing=None):
    """Corridor merge rule (config vote_rules.corridor_note): the config's authored
    corridor keys are authoritative; bootstrap-computed stats live under
    corridor.computed and never overwrite an authored key. `existing` is the row's
    current DB corridor: its computed block survives when no new one is given."""
    out = {}
    if isinstance(existing, dict) and isinstance(existing.get(RESERVED_CORRIDOR_KEY), dict):
        out[RESERVED_CORRIDOR_KEY] = existing[RESERVED_CORRIDOR_KEY]
    if computed:
        out[RESERVED_CORRIDOR_KEY] = computed
    for k, v in (authored or {}).items():
        if k == RESERVED_CORRIDOR_KEY:
            raise ValueError("config corridor may not author the reserved key %r" % k)
        out[k] = v
    return out or None


DIAL_COLS = ("id", "name", "cadence", "category", "source", "units", "transform", "direction_map", "band_rule", "has_history", "votes", "geography")


def dial_row(d, computed=None, existing_corridor=None):
    row = {k: d.get(k) for k in DIAL_COLS}
    row["fetch_method"] = d["fetch"]          # FETCH is a reserved word in Postgres
    row["notes"] = d.get("notes")
    row["corridor"] = merge_corridor(d.get("corridor"), computed, existing_corridor)
    return row


CLAIM_CONFIG_COLS = ("id", "version", "text", "category", "scenario_tag", "prob_initial", "resolves_on", "falsifier", "data_source")


def claim_row(c, version):
    """Full row for an insert. prob_current/status are DB-owned once the row exists."""
    row = {k: c[k] for k in CLAIM_CONFIG_COLS if k != "version"}
    row.update({"version": version, "prob_current": c["prob_current"], "status": c.get("status", "open")})
    return row


def calendar_row(c):
    return {"date": c["date"] if re.match(r"\d{4}-\d{2}-\d{2}$", c["date"] or "") else None,
            "label": c["name"], "dial_id": c["dial_id"], "tentative": bool(c.get("tentative"))}


def version_row(cfg):
    return {"version": cfg["version"], "date": cfg["date"], "config": cfg}


# ---------------------------------------------------------------- scheduled-release notes
CALENDAR_DIAL_ALIAS = {"fomc_decision": "fed_funds_target_upper"}   # the event dial is manual; the rate prints on FRED


def fmt(x):
    if x is None:
        return "-"
    if isinstance(x, float):
        return ("%.0f" % x) if abs(x) >= 10000 else ("%.3f" % x).rstrip("0").rstrip(".")
    return str(x)


def release_note(dial, rows_all, rows_new, calendar_dates, prev_latest=None):
    """'X printed V vs prior P' for a calendar dial that got a new reading, else None.
    Monthly/weekly dials: any new print. Daily dials (fed funds for the FOMC): only once a
    reading dated after a calendar date arrives that we had not seen (prev_latest <= date)."""
    if not rows_new:
        return None
    period = (lambda d: d[:7]) if dial.get("cadence") in ("monthly", "quarterly") else (lambda d: d[:10])
    units = dial.get("units") or ""
    if dial.get("cadence") == "daily":
        hits = [c for c in sorted(calendar_dates) if c and (prev_latest is None or prev_latest[:10] <= c) and any(d[:10] > c for d, _ in rows_new)]
        if not hits:
            return None
        c = hits[-1]
        after = [r for r in rows_all if r[0][:10] > c]
        before = [r for r in rows_all if r[0][:10] <= c]
        d, v = after[0]
        p = before[-1] if before else None
    else:
        d, v = rows_new[-1]
        prior = [r for r in rows_all if r[0] < d]
        p = prior[-1] if prior else None
    txt = "%s printed %s %s (%s)" % (dial["name"], fmt(v), units, period(d))
    txt += (" vs prior %s (%s)" % (fmt(p[1]), period(p[0]))) if p else " (no prior reading)"
    return re.sub(r"\s+", " ", txt).strip()


# ---------------------------------------------------------------- Supabase (PostgREST)
def load_env():
    """.env.local values, overridden by the process environment (tests point at a fake server)."""
    env = {}
    for ep in ENV_PATHS:
        if os.path.exists(ep):
            with open(ep) as f:
                env = dict((k, v.strip().strip("'\"")) for k, v in re.findall(r"^([A-Z0-9_]+)=(.*)$", f.read(), re.M))
            break
    for k in ("LRG_SUPABASE_URL", "LRG_SUPABASE_SERVICE_KEY", "TELEGRAM_BOT_TOKEN", "CAMPAIGN_BOT_TOKEN", "TELEGRAM_CHAT_ID"):
        if os.environ.get(k):
            env[k] = os.environ[k]
    return env


def sb_req(sb, key, method, path, body=None, prefer=None):
    h = {"apikey": key, "Authorization": "Bearer " + key, "Content-Type": "application/json"}
    if prefer:
        h["Prefer"] = prefer
    req = urllib.request.Request(sb.rstrip("/") + "/rest/v1/" + path, data=json.dumps(body).encode() if body is not None else None, headers=h, method=method)
    with urllib.request.urlopen(req, timeout=60) as r:
        t = r.read().decode()
        return json.loads(t) if t else None


def q(v):
    return urllib.parse.quote(str(v), safe="")


def sb_probe(sb, key, paths):
    """GET each path; -> list of 'path (reason)' that failed."""
    bad = []
    for p in paths:
        try:
            sb_req(sb, key, "GET", p)
        except urllib.error.HTTPError as e:
            bad.append("%s (HTTP %d: %s)" % (p, e.code, e.read().decode()[:160]))
            e.close()
        except Exception as e:
            bad.append("%s (%s: %s)" % (p, type(e).__name__, e))
    return bad


def telegram_alert(env, text):
    """Best-effort Telegram message (MarketingBot, same as the other launchd jobs)."""
    token = env.get("CAMPAIGN_BOT_TOKEN") or env.get("TELEGRAM_BOT_TOKEN")
    chat = env.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return False
    try:
        req = urllib.request.Request("https://api.telegram.org/bot%s/sendMessage" % token,
                                     data=json.dumps({"chat_id": chat, "text": text[:3900]}).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        urllib.request.urlopen(req, timeout=20).read()
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- corridor stats helpers (bootstrap)
def seasonal(rows, years):
    by = {}
    for d, v in rows:
        y = int(d[:4])
        if y in years:
            by.setdefault(d[5:7], {}).setdefault(y, []).append(v)
    out = {}
    for mth, ys in sorted(by.items()):
        vals = [sum(v) / len(v) for v in ys.values()]
        out[mth] = {"mean": round(statistics.mean(vals), 4), "sd": round(statistics.stdev(vals), 4) if len(vals) > 1 else None, "n": len(vals)}
    return out


def stats(rows, lo="2021-01-01", hi="2025-12-31"):
    v = sorted(x for d, x in rows if lo <= d <= hi)
    if not v:
        return None
    qf = lambda p: v[min(len(v) - 1, int(round(p * (len(v) - 1))))]
    return {"window": [lo, hi], "n": len(v), "min": v[0], "p10": qf(.1), "median": qf(.5), "p90": qf(.9), "max": v[-1]}


def avg_last(rows, n=10):
    tail = [v for _, v in rows[-n:]]
    return round(sum(tail) / len(tail), 4) if tail else None
