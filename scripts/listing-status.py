#!/usr/bin/env python3
"""Listing-status check: is a lead's property on the market right now?

Source: mlslistings.com public search — the real MLS for Santa Clara / San
Mateo / Santa Cruz / Monterey / San Benito, carrying the statewide CA data
share. Plain HTTP, no login, no browser (~0.5 s per search). What we learned
2026-10-30: Zillow / Redfin / Homes.com refuse even a real Chrome after one
hit; MLSListings answers urllib straight away.

Per lead: an Address search ("<num> <street>, <city>, CA") when the city is
known, then a bare street-name search (statewide, e.g. "miller" — the
suffix form "Miller Ave" MISSES listings, "Miller" finds them). Cards are
matched on house number + street + city. Active / Active Under Contract /
Pending all count as on market.

Usage:
  python3 scripts/listing-status.py                 # dry run, source "Historic Sellers"
  python3 scripts/listing-status.py --write         # stamp leads.listing cluster-wide
  python3 scripts/listing-status.py --source "Direct Mail" --write
  python3 scripts/listing-status.py --phone +14085063108 --write
  python3 scripts/listing-status.py --all --write   # every live lead with an address
Writes {status, price, dom, type, mls, url, source, checked_at} to
leads.listing on every row of the phone cluster; not_listed is stamped too so
the card shows when it was last checked.
"""
import re, json, sys, os, time, gzip, html, argparse, datetime, http.cookiejar, urllib.request, urllib.parse, urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATHS = [os.path.join(ROOT, ".env.local"), "/Users/ryanlarocca/Projects/PROJECTS/mission-control/.env.local"]
env = {}
for ep in ENV_PATHS:
    if os.path.exists(ep):
        env = dict((k, v.strip("'\"")) for k, v in re.findall(r"^([A-Z0-9_]+)=(.*)$", open(ep).read(), re.M)); break
SB, KEY = env.get("LRG_SUPABASE_URL"), env.get("LRG_SUPABASE_SERVICE_KEY")
if not SB or not KEY: sys.exit("LRG_SUPABASE_URL / LRG_SUPABASE_SERVICE_KEY missing from .env.local")
SBH = {"apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json"}

# ---------- MLSListings
BASE = "https://www.mlslistings.com"
cj = http.cookiejar.CookieJar()
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k): return None
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cj), NoRedirect())
_tok = None
def token():
    global _tok
    if not _tok:
        body = opener.open(BASE + "/", timeout=30).read().decode("utf-8", "ignore")
        _tok = re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]*)"', body).group(1)
    return _tok
def get(url, hops=0):
    try: return opener.open(urllib.request.Request(url, headers={"Accept": "text/html"}), timeout=30).read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location")
        if e.code in (301, 302, 303, 307) and loc and hops < 4:
            return get(loc if loc.startswith("http") else BASE + loc, hops + 1)
        raise
CARD = re.compile(r"(\d+[A-Za-z]?) ([^,$]+?), ([A-Za-z .]+), CA (\d{5})?\s*\$([\d,]+)\s+(Active Under Contract|Active|Pending|Contingent)\s*(?:(\d+) Days? on Site)?\s*([A-Za-z /]+?)\s+MLS #: (\w+)")
def cards(body):
    out, seen = [], set()
    for m0 in re.finditer(r'data-target="([A-Z]{2}\w+)"', body):
        mls = m0.group(1)
        if mls in seen: continue
        blk = body[m0.start(): m0.start() + 20000]
        t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", blk)))
        m = CARD.search(t)
        if not m: continue
        seen.add(mls)
        href = re.search(r'href="(/property/[^"]+)"', blk)
        out.append({"mls": mls, "num": m.group(1), "street": m.group(2), "city": m.group(3).strip(), "zip": m.group(4),
                    "price": int(m.group(5).replace(",", "")), "status": m.group(6), "dom": int(m.group(7)) if m.group(7) else None,
                    "type": m.group(8).strip(), "url": BASE + href.group(1) if href else None})
    return out
def search(text, ttype, max_pages=8):
    data = [("__RequestVerificationToken", token()), ("transactionType", "Buy"), ("searchTextType", ttype), ("searchText", text),
            ("listing_status", "Active"), ("listing_status", "ActiveUnderContract"), ("listing_status", "Pending")]
    req = urllib.request.Request(BASE + "/Search/ResultPost", data=urllib.parse.urlencode(data).encode(), headers={"Referer": BASE + "/"})
    try: resp = opener.open(req, timeout=30); loc = resp.geturl(); body = resp.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        loc = e.headers.get("Location")
        if not loc: raise
        loc = loc if loc.startswith("http") else BASE + loc
        body = get(loc)
    out = cards(body)
    n = re.search(r"([\d,]+)\s+Results?", body); count = int(n.group(1).replace(",", "")) if n else len(out)
    p = 2
    while len(out) < count and p <= max_pages and "/1?" in loc:
        more = [c for c in cards(get(loc.replace("/1?", f"/{p}?"))) if c["mls"] not in {x["mls"] for x in out}]
        if not more: break
        out += more; p += 1
    return count, out

# ---------- address handling
SUF = {"street": "st", "avenue": "ave", "av": "ave", "drive": "dr", "road": "rd", "boulevard": "blvd", "court": "ct", "lane": "ln",
       "place": "pl", "circle": "cir", "terrace": "ter", "parkway": "pkwy", "highway": "hwy"}
SUF_RE = r" (st|ave|dr|rd|blvd|ct|ln|pl|way|cir|ter|pkwy|hwy)$"
def norm(s):
    return " ".join(SUF.get(x, x) for x in re.sub(r"[.,#]", " ", s.lower()).split() if x not in ("n", "s", "e", "w", "north", "south", "east", "west"))
def key(s): return re.sub(SUF_RE, "", norm(s))
def parse(raw):
    a = re.sub(r"\(.*?\)", "", raw).strip(); parts = [p.strip() for p in a.split(",") if p.strip()]
    city = parts[1] if len(parts) > 1 and not re.fullmatch(r"ca", parts[1], re.I) else None
    out = []
    for alt in re.split(r"\s/\s", parts[0]):
        m = re.match(r"^(\d+(?:\s*[/-]\s*\d+)*)\s+(.+)$", alt.strip())
        if not m: out.append({"nums": [], "street": alt.strip(), "city": city}); continue
        out.append({"nums": [int(x) for x in re.split(r"\s*[/-]\s*", m.group(1))], "street": m.group(2).strip(), "city": city})
    return out
def check(p):
    hits, notes, seen = [], [], set()
    bare = key(p["street"])
    if not bare: return hits, ["no street"]
    tries = ([("Address", f"{p['nums'][0]} {norm(p['street'])}, {p['city']}, CA")] if p["nums"] and p["city"] else []) + [("Street", bare)]
    for ttype, q in tries:
        try: count, cs = search(q, ttype)
        except Exception as e: notes.append(f"{ttype} '{q}': {e}"); continue
        on_street = [k for k in cs if key(k["street"]) == bare]
        notes.append(f"{ttype} '{q}': {count} results, {len(on_street)} on street")
        for k in on_street:
            if int(re.sub(r"\D", "", k["num"]) or 0) not in p["nums"]: continue
            if p["city"] and k["city"].lower() != p["city"].lower(): continue
            if k["mls"] not in seen: seen.add(k["mls"]); hits.append(k)
        if not p["nums"]: notes.append("no house number; on street: " + "; ".join(f"{k['num']} {k['street']} {k['city']} {k['status']} ${k['price']:,}" for k in on_street[:5]))
        time.sleep(0.3)
    return hits, notes

# ---------- leads
def sb_get(path):
    return json.load(urllib.request.urlopen(urllib.request.Request(SB + "/rest/v1/" + path, headers=SBH)))
def sb_patch(ids, body):
    req = urllib.request.Request(SB + "/rest/v1/leads?id=in.(" + ",".join(ids) + ")", data=json.dumps(body).encode(), headers={**SBH, "Prefer": "return=minimal"}, method="PATCH")
    urllib.request.urlopen(req).read()

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", default="Historic Sellers"); ap.add_argument("--all", action="store_true")
    ap.add_argument("--phone"); ap.add_argument("--write", action="store_true"); ap.add_argument("--out", default="/tmp/listing-status.json")
    a = ap.parse_args()
    q = "leads?select=id,name,caller_phone,property_address,status,created_at,is_junk,is_dnc&property_address=not.is.null&order=created_at.asc&limit=5000"
    if a.phone: q += "&caller_phone=eq." + urllib.parse.quote(a.phone)
    elif not a.all: q += "&source=eq." + urllib.parse.quote(a.source)
    rows = sb_get(q)
    cl = {}
    for r in rows:
        if a.all and (r.get("is_junk") or r.get("is_dnc") or r.get("status") in ("dead", "closed_lost")): continue
        c = cl.setdefault(r["caller_phone"], {"phone": r["caller_phone"], "ids": [], "name": None, "address": None})
        c["ids"].append(r["id"]); c["name"] = r["name"] or c["name"]; c["address"] = r["property_address"] or c["address"]
    # rows of the same phone without an address still get the stamp
    if cl:
        extra = sb_get("leads?select=id,caller_phone&property_address=is.null&caller_phone=in.(" + ",".join(urllib.parse.quote(p) for p in cl) + ")&limit=5000")
        for r in extra: cl[r["caller_phone"]]["ids"].append(r["id"])
    print(f"{len(cl)} clusters with an address — {'WRITE' if a.write else 'dry run'}")
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    results, n_on, n_unres = [], 0, 0
    for c in cl.values():
        hits, notes, unresolved = [], [], False
        for p in parse(c["address"]):
            h, n = check(p); hits += h; notes += n
            if not p["nums"]: unresolved = True
        best = sorted(hits, key=lambda k: ("Active", "Active Under Contract", "Pending", "Contingent").index(k["status"]) if k["status"] in ("Active", "Active Under Contract", "Pending", "Contingent") else 9)[:1]
        if best:
            b = best[0]; listing = {"status": b["status"], "price": b["price"], "dom": b["dom"], "type": b["type"], "mls": b["mls"], "url": b["url"], "source": "mlslistings", "checked_at": now}
            tag = f"ON MARKET {b['status']} ${b['price']:,}{' ' + str(b['dom']) + 'd' if b['dom'] is not None else ''} {b['type']} {b['mls']}"; n_on += 1
        elif unresolved:
            listing = None; tag = "unresolved (no house number)"; n_unres += 1
        else:
            listing = {"status": "not_listed", "source": "mlslistings", "checked_at": now}; tag = "not listed"
        print(f"{(c['name'] or '-')[:22]:22} {c['phone']}  {c['address'][:40]:40} → {tag}   | {' | '.join(notes)[:120]}")
        if a.write and listing is not None: sb_patch(c["ids"], {"listing": listing})
        results.append({**c, "listing": listing, "notes": notes})
    json.dump(results, open(a.out, "w"), indent=1)
    print(f"\nON MARKET {n_on} · not listed {len(results) - n_on - n_unres} · unresolved {n_unres} of {len(results)} → {a.out}{'  (written)' if a.write else ''}")

if __name__ == "__main__": main()
