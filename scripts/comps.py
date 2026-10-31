#!/usr/bin/env python3
"""Comps from the public MLS (mlslistings.com), no browser, no login.

Same fetch as scripts/listing-status.py. Pulls a city's Recently Sold
(≈ last 90 days — that's as far back as the public site goes), Active
(asking) and For Rent cards, filters by zip + property type, and prints
$/sf, price per door and days on market.

  python3 scripts/comps.py --city "San Jose" --zips 95126,95125,95128 --types duplex,income
  python3 scripts/comps.py --city "San Jose" --types commercial --min-sqft 1500
  python3 scripts/comps.py --city Cupertino --types sfr --min-sqft 1800 --max-sqft 2800 --rent

Types: sfr, condo, townhouse, duplex, income (Residential Income = 2–4+ units),
commercial (Commercial Sale), land, any.
"""
import re, sys, os, html, json, argparse, datetime, collections, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("ls", os.path.join(HERE, "listing-status.py"))
ls = importlib.util.module_from_spec(spec); spec.loader.exec_module(ls)

CARD = re.compile(
    r"(\d+[A-Za-z]?) ([^,$]+?), ([A-Za-z .]+), CA (\d{5})?(?:-\d{4})?\s*\$([\d,]+)\s*"
    r"(Active Under Contract|Active|Pending|Contingent|Sold on ([A-Z][a-z]{2} \d{1,2}, \d{4}))\s*"
    r"(?:(\d+) Days? on Site)?\s*([A-Za-z /]+?)\s+MLS #: (\w+)"
    r"(?: (\d+) Bd)?(?: ([\d/]+) Ba)?(?: ([\d,]+) Sq Ft)?(?: ([\d,–-]+) Sq Ft Lot)?(?: (\d+) Garage)?(?: (\d{4}) Year Built)?")
TYPE_RX = {"sfr": r"Single Family", "condo": r"Condominium", "townhouse": r"Townhouse", "duplex": r"Duplex",
           "income": r"Residential Income|Triplex|Fourplex|Multi", "commercial": r"Commercial", "land": r"^Land", "any": r"."}

def pull(city, tx, max_pages=80):
    data = [("__RequestVerificationToken", ls.token()), ("transactionType", tx), ("searchTextType", "City"), ("searchText", city)]
    if tx == "Buy": data += [("listing_status", s) for s in ("Active", "ActiveUnderContract", "Pending")]
    req = ls.urllib.request.Request(ls.BASE + "/Search/ResultPost", data=ls.urllib.parse.urlencode(data).encode(), headers={"Referer": ls.BASE + "/"})
    try: resp = ls.opener.open(req, timeout=30); loc = resp.geturl(); body = resp.read().decode("utf-8", "ignore")
    except ls.urllib.error.HTTPError as e:
        loc = e.headers.get("Location"); loc = loc if loc.startswith("http") else ls.BASE + loc; body = ls.get(loc)
    n = re.search(r"([\d,]+)\s+Results?", body); count = int(n.group(1).replace(",", "")) if n else 0
    out, seen = [], set()
    for p in range(1, max_pages + 1):
        b = body if p == 1 else ls.get(loc.replace("/1?", f"/{p}?"))
        new = 0
        for m0 in re.finditer(r'data-target="([A-Z]{2}\w+)"', b):
            if m0.group(1) in seen: continue
            seen.add(m0.group(1)); new += 1
            t = re.sub(r"\s+", " ", html.unescape(re.sub(r"<style.*?</style>|<[^>]+>", " ", b[m0.start(): m0.start() + 20000], flags=re.S)))
            # open-house banners ("OPEN 11/6 2:00 pm - 3:00 pm") precede the address and
            # their digits can masquerade as a house number — drop them first.
            t = re.sub(r"\b(NEW|OPEN|VIRTUAL TOUR|PRICE REDUCED)\b(?: \d{1,2}/\d{1,2})?(?: \d{1,2}:\d{2} [ap]m - \d{1,2}:\d{2} [ap]m)?", " ", t)
            m = CARD.search(t)
            if not m: continue
            num = lambda s: int(s.replace(",", "")) if s and s.replace(",", "").isdigit() else None
            href = re.search(r'href="(/property/[^"]+)"', b[m0.start(): m0.start() + 20000])
            out.append({"addr": f"{m.group(1)} {m.group(2)}", "city": m.group(3).strip(), "zip": m.group(4), "price": num(m.group(5)),
                        "status": "Sold" if m.group(7) else m.group(6), "sold": m.group(7), "dom": num(m.group(8)), "type": m.group(9).strip(),
                        "mls": m.group(10), "bd": num(m.group(11)), "ba": m.group(12), "sqft": num(m.group(13)), "lot": num(m.group(14) or ""),
                        "yr": m.group(16), "url": ls.BASE + href.group(1) if href else None})
        if not new or len(seen) >= count: break
    return count, out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--city", required=True); ap.add_argument("--zips", default=""); ap.add_argument("--types", default="any")
    ap.add_argument("--min-sqft", type=int); ap.add_argument("--max-sqft", type=int); ap.add_argument("--rent", action="store_true")
    ap.add_argument("--json"); a = ap.parse_args()
    zips = {z.strip() for z in a.zips.split(",") if z.strip()}
    rx = re.compile("|".join(TYPE_RX[t.strip()] for t in a.types.split(",")), re.I)
    def keep(r):
        if zips and r["zip"] not in zips: return False
        if not rx.search(r["type"]): return False
        if a.min_sqft and (r["sqft"] or 0) < a.min_sqft: return False
        if a.max_sqft and r["sqft"] and r["sqft"] > a.max_sqft: return False
        return True
    def doors(r):
        if re.search(r"Duplex", r["type"]): return 2
        if re.search(r"Triplex", r["type"]): return 3
        if re.search(r"Fourplex", r["type"]): return 4
        return None
    def show(title, rows, rent=False):
        rows = sorted(rows, key=lambda r: (r["sold"] is None, r["sold"] and -datetime.datetime.strptime(r["sold"], "%b %d, %Y").toordinal(), -(r["price"] or 0)))
        print(f"\n## {title} — {len(rows)}")
        if not rows: return
        print(f"{'date / status':14} {'address':30} {'zip':5} {'price':>12} {'$/sf':>7} {'$/door':>9} {'sf':>6} {'bd':>3} {'yr':>4} {'dom':>4}  type")
        for r in rows:
            psf = f"{r['price']/r['sqft']:,.0f}" if r["price"] and r["sqft"] else "-"
            d = doors(r); pd = f"{r['price']/d/1000:,.0f}k" if d and r["price"] else "-"
            when = datetime.datetime.strptime(r["sold"], "%b %d, %Y").strftime("%Y-%m-%d") if r["sold"] else r["status"]
            print(f"{when:14} {r['addr'][:30]:30} {r['zip'] or '':5} {('$' + format(r['price'], ',')) if r['price'] else '-':>12} {psf:>7} {pd:>9} {r['sqft'] or '-':>6} {r['bd'] or '-':>3} {r['yr'] or '-':>4} {r['dom'] if r['dom'] is not None else '-':>4}  {r['type']}")
        if not rent:
            with_sf = [r for r in rows if r["price"] and r["sqft"]]
            if with_sf:
                psfs = sorted(r["price"] / r["sqft"] for r in with_sf)
                print(f"   $/sf median {psfs[len(psfs)//2]:,.0f}  (range {psfs[0]:,.0f}–{psfs[-1]:,.0f}, n={len(psfs)})")
    sold_count, sold = pull(a.city, "recentlySold"); act_count, act = pull(a.city, "Buy")
    dates = [datetime.datetime.strptime(r["sold"], "%b %d, %Y").date() for r in sold if r["sold"]]
    print(f"{a.city}: {sold_count} recently sold (public window {min(dates)} → {max(dates)}), {act_count} active/pending")
    show("SOLD (matching)", [r for r in sold if keep(r)])
    show("ACTIVE / PENDING (asking)", [r for r in act if keep(r)])
    if a.rent:
        rc, rents = pull(a.city, "rent"); show("FOR RENT (monthly)", [r for r in rents if keep(r)], rent=True)
    if a.json: json.dump({"sold": [r for r in sold if keep(r)], "active": [r for r in act if keep(r)]}, open(a.json, "w"), indent=1)

if __name__ == "__main__": main()
