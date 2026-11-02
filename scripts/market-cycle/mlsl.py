"""MLSListings public-search fetch core for the market-cycle collectors.

The fetch itself (token + cookies, POST /Search/ResultPost, follow the 302 to
the server-minted `criteria` URL, page by swapping "/1?" for "/{n}?") is
copied from scripts/listing-status.py (and the Sold-card regex from
scripts/comps.py), which proved it on 2026-10-30. Those scripts are owned by
other agents and are NOT imported: this module is a self-contained copy,
generalised to any transaction type / status set and with a richer card dict.

Facts learned the hard way (do not "fix" them):
  * The `criteria` blob is gzip+base64 JSON with a 32-byte server signature,
    so it can't be hand-built: only the form fields below shape a search
    (transactionType, searchTextType, searchText, listing_status).
  * City search works; Zip search returns nothing in direct mode. Filter by
    the card's zip instead.
  * A street search must use the bare street name ("Miller", not "Miller Ave").
  * Recently Sold reaches back ~90 days; Sold cards carry ONE price (the sale
    price) and no list price, on the card or on the detail page.
  * ~32 cards per page.

Stdlib only.
"""
import datetime as dt
import html
import http.cookiejar
import re
import time
import urllib.error
import urllib.parse
import urllib.request

BASE = "https://www.mlslistings.com"
UA = "mission-control-market-cycle/1.0 (+stdlib urllib)"
PAGE_SLEEP = 0.35          # seconds between page requests: be polite
ATTEMPTS = 2               # one request + at most one retry, never more

BUY_STATUSES = ["Active", "ActiveUnderContract", "Pending"]

_cj = http.cookiejar.CookieJar()


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


_opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(_cj), _NoRedirect())
_tok = None
stats = {"requests": 0, "retries": 0}


def _open(req, timeout=30):
    """One HTTP call with at most ATTEMPTS tries; redirects are returned as HTTPError."""
    last = None
    for i in range(ATTEMPTS):
        try:
            stats["requests"] += 1
            return _opener.open(req, timeout=timeout)
        except urllib.error.HTTPError:
            raise                               # 3xx (handled by caller) or a real status: no retry
        except Exception as e:                  # timeout / reset
            last = e
            if i + 1 < ATTEMPTS:
                stats["retries"] += 1
                time.sleep(2)
    raise last


def token():
    global _tok
    if not _tok:
        body = _open(urllib.request.Request(BASE + "/", headers={"User-Agent": UA})).read().decode("utf-8", "ignore")
        m = re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]*)"', body)
        if not m:
            raise RuntimeError("MLSListings home page has no __RequestVerificationToken (layout changed?)")
        _tok = m.group(1)
    return _tok


def get(url, hops=0):
    try:
        return _open(urllib.request.Request(url, headers={"Accept": "text/html", "User-Agent": UA})).read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location")
        if e.code in (301, 302, 303, 307) and loc and hops < 4:
            return get(loc if loc.startswith("http") else BASE + loc, hops + 1)
        raise


# ---------------------------------------------------------------- card parsing
# Price / status / days / type / MLS, then optional Bd / Ba / Sq Ft facts.
_CORE = re.compile(
    r"\$([\d,]+)\s*"
    r"(Active Under Contract|Active|Pending|Contingent|Sold on ([A-Z][a-z]{2} \d{1,2}, \d{4}))\s*"
    r"(?:(\d+) Days? on Site)?\s*([A-Za-z0-9 /&()-]+?)\s+MLS #: (\w+)"
    r"(?: (\d+) Bd)?(?: ([\d/]+) Ba)?(?: ([\d,]+) Sq Ft)?(?: ([\d,.–-]+) (?:Sq Ft|Acres?) Lot)?")
# The address sits right before the price: "<street>, <City>, CA <zip>[-xxxx]".
_ADDR = re.compile(r"([^,]{1,80}), ([A-Za-z .'-]{2,40}), CA ?(\d{5})?(?:-\d{4})?\s*$")
# Banners precede the address; their digits can masquerade as a house number.
_BANNER = re.compile(r"\b(NEW|OPEN|VIRTUAL TOUR|PRICE REDUCED|COMING SOON|BACK ON MARKET)\b"
                     r"(?: \d{1,2}/\d{1,2})?(?: \d{1,2}:\d{2} [ap]m - \d{1,2}:\d{2} [ap]m)?")


def _num(s):
    if not s:
        return None
    s = s.replace(",", "")
    return int(s) if s.isdigit() else None


def parse_block(mls, blk):
    """Parse one card's HTML (starting at its data-target) into a dict, or None."""
    t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<style.*?</style>|<script.*?</script>|<[^>]+>", " ", blk, flags=re.S)))
    banners = sorted(set(m.group(1) for m in _BANNER.finditer(t[:600])))
    t = _BANNER.sub(" ", t)
    t = re.sub(r"\s+", " ", t)
    m = _CORE.search(t)
    if not m or m.group(6) != mls:          # the regex ran into the next card: refuse
        return None
    a = _ADDR.search(t[:m.start()].strip())
    address = city = zipc = None
    if a:
        address, city, zipc = a.group(1).strip(), a.group(2).strip(), a.group(3)
        address = re.sub(r"^.*?(?=\d+[A-Za-z]? |Address Not Disclosed)", "", address) or address
    sold = m.group(3)
    price = _num(m.group(1))
    href = re.search(r'href="(/property/[^"]+)"', blk)
    return {
        "mls": mls,
        "address": address,
        "city": city,
        "zip": zipc,
        "price": price,
        "status": "Sold" if sold else m.group(2),
        "days_on_site": _num(m.group(4)),
        "type": m.group(5).strip(),
        "url": BASE + href.group(1) if href else None,
        "sold_date": dt.datetime.strptime(sold, "%b %d, %Y").date().isoformat() if sold else None,
        "sold_price": price if sold else None,       # Sold cards show the sale price only
        "beds": _num(m.group(7)),
        "sqft": _num(m.group(9)),
        "banners": banners,
    }


def parse_cards(body):
    """Every card on one result page → (parsed cards, unparsed mls ids)."""
    out, bad, seen = [], [], set()
    for m0 in re.finditer(r'data-target="([A-Z]{2}\w+)"', body):
        mls = m0.group(1)
        if mls in seen:
            continue
        seen.add(mls)
        c = parse_block(mls, body[m0.start(): m0.start() + 20000])
        (out.append(c) if c else bad.append(mls))
    return out, bad


def result_count(body):
    n = re.search(r"([\d,]+)\s+Results?", body)
    return int(n.group(1).replace(",", "")) if n else None


# ---------------------------------------------------------------- search
def search_full(transaction, search_type, text, statuses=None, max_pages=150, stop=None):
    """Run one search and page through it.

    transaction: "Buy" | "recentlySold" | "rent"; search_type: "City" | "Street" | "Address".
    statuses: listing_status values for Buy (default Active / AUC / Pending).
    stop(cards_on_page) -> True ends paging early (e.g. sold dates past a cutoff).
    Returns {"count": site's result count, "cards": [...], "unparsed": [mls...], "pages": n, "url": criteria url}.
    """
    if statuses is None and transaction == "Buy":
        statuses = BUY_STATUSES
    data = [("__RequestVerificationToken", token()), ("transactionType", transaction),
            ("searchTextType", search_type), ("searchText", text)]
    data += [("listing_status", s) for s in (statuses or [])]
    req = urllib.request.Request(BASE + "/Search/ResultPost", data=urllib.parse.urlencode(data).encode(),
                                 headers={"Referer": BASE + "/", "User-Agent": UA})
    try:
        resp = _open(req)
        loc = resp.geturl()
        body = resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location")
        if not loc:
            raise
        loc = loc if loc.startswith("http") else BASE + loc
        body = get(loc)
    count = result_count(body)
    cards, unparsed, seen = [], [], set()
    page = 1
    while True:
        got, bad = parse_cards(body)
        new = [c for c in got if c["mls"] not in seen]
        seen.update(c["mls"] for c in new)
        seen.update(bad)
        unparsed += [b for b in bad if b not in unparsed]
        cards += new
        if not new and not bad:
            break
        if count is not None and len(seen) >= count:
            break
        if page >= max_pages or "/1?" not in loc:
            break
        if stop and stop(new):
            break
        page += 1
        time.sleep(PAGE_SLEEP)
        body = get(loc.replace("/1?", "/%d?" % page))
    return {"count": count, "cards": cards, "unparsed": unparsed, "pages": page, "url": loc}


def search(transaction, search_type, text, statuses=None, **kw):
    """search(transaction, search_type, text, statuses=[...]) -> list[card]."""
    return search_full(transaction, search_type, text, statuses, **kw)["cards"]
