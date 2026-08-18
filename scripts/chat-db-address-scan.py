#!/usr/bin/env python3
"""
Scan the Mac's iMessage/SMS chat.db for messages mentioning a street address,
roll them up per-address, and score how likely each one is a flip/deal convo.

Runs ON THE MAC (chat.db is local + needs Full Disk Access). Read-only.

Usage:
    # 1. Snapshot the db first (avoids WAL/lock weirdness on a live Messages app)
    cp ~/Library/Messages/chat.db      /tmp/chat.db
    cp ~/Library/Messages/chat.db-wal  /tmp/chat.db-wal 2>/dev/null || true
    cp ~/Library/Messages/chat.db-shm  /tmp/chat.db-shm 2>/dev/null || true

    # 2. Scan it
    python3 scripts/chat-db-address-scan.py --db /tmp/chat.db --years 5 --outdir ./out

Outputs two CSVs into --outdir:
    addresses.csv  - one row per distinct address (the analysis sheet)
    mentions.csv   - one row per matching message (the audit trail)
"""

import argparse
import csv
import os
import re
import sqlite3
import sys
from collections import defaultdict
from datetime import datetime, timedelta, timezone

# chat.db stores dates as offsets from 2001-01-01 UTC (Apple/Core Data epoch).
APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)

# ---------------------------------------------------------------- address regex

# Ordered longest-first within each family so "Street" wins over "St".
SUFFIXES = (
    "Streets?|Str|St|Avenues?|Ave|Av|Roads?|Rd|Drives?|Dr|Lanes?|Ln|Courts?|Ct|"
    "Boulevards?|Blvd|Ways?|Places?|Pl|Circles?|Cir|Terraces?|Ter|Highways?|Hwy|"
    "Parkways?|Pkwy|Trails?|Trl|Loops?|Runs?|Paths?|Pike|Rows?|Squares?|Sq|"
    "Crossings?|Xing|Bends?|Bnd|Coves?|Cv|Ridges?|Rdg|Hills?|Parks?|Points?|Pt|"
    "Bays?|Creeks?|Crk|Glens?|Groves?|Grv|Knolls?|Meadows?|Mdw|Springs?|Spg|"
    "Valleys?|Vly|Views?|Vw|Villages?|Vlg|Walks?|Woods?|Manors?|Landings?|Ldg|"
    "Estates?|Farms?|Ferry|Fords?|Forks?|Gardens?|Gdn|Gates?|Greens?|Harbors?|"
    "Havens?|Heights|Hts|Isles?|Junctions?|Jct|Keys?|Lakes?|Mills?|Mounts?|"
    "Mountains?|Mtn|Oaks?|Orchards?|Overlooks?|Passes?|Pass|Plazas?|Plz|Ranch|"
    "Reserves?|Rise|Shores?|Summits?|Traces?|Trce|Vistas?|Bluffs?|Branch|Brooks?|"
    "Canyons?|Cliffs?|Commons?|Corners?|Crest|Dale|Downs|Falls|Fields?|Flats?|"
    "Forest|Fort|Gateway|Hollow|Inlet|Islands?|Lodge|Mews|Neck|Pines?|Ports?|"
    "Prairie|Rapids|River|Stations?|Sta|Streams?|Turnpike|Tpke|Villas?|Wells?"
)

DIRECTIONAL = r"(?:N|S|E|W|NE|NW|SE|SW|North|South|East|West|Northeast|Northwest|Southeast|Southwest)\.?"

# Street-name words: letters/digits/apostrophes/hyphens, 1-4 of them, greedy so
# the LAST suffix in the run terminates the match. Matters because plenty of
# street names embed a suffix word themselves -- 'Post Oak Ln', 'Mill Run Ct',
# 'Oak Ridge Park Dr' -- and a non-greedy match would truncate at 'Oak'/'Run'.
ADDRESS_RE = re.compile(
    r"\b(?P<num>\d{1,6}(?:-\d{1,5})?)\s+"
    r"(?P<dir>" + DIRECTIONAL + r"\s+)?"
    r"(?P<name>(?:[A-Za-z][A-Za-z'\-\.]*|\d{1,3}(?:st|nd|rd|th))(?:\s+(?:[A-Za-z][A-Za-z'\-\.]*|\d{1,3}(?:st|nd|rd|th))){0,3})\s+"
    r"(?P<suffix>" + SUFFIXES + r")\b\.?"
    r"(?P<unit>\s*(?:#|Apt\.?|Unit|Ste\.?|Suite)\s*[A-Za-z0-9\-]{1,8})?",
    re.IGNORECASE,
)

# Words that must never be treated as a street name (kills "$450 per month Rd"-style
# noise and common false positives from prices/dates/measurements).
NAME_STOPWORDS = {
    "per", "and", "or", "the", "a", "an", "of", "to", "for", "at", "in", "on",
    "am", "pm", "k", "sq", "ft", "min", "mins", "hour", "hours", "day", "days",
    "more", "less", "under", "over", "about", "around",
}

# Signals this address is being discussed as a deal, not just an address.
FLIP_KEYWORDS = {
    3: ["arv", "rehab", "flip", "wholesale", "assignment fee", "comps", "comping",
        "as-is", "as is", "distressed", "off market", "off-market", "pocket listing",
        "seller financ", "subject to", "sub-to", "hard money"],
    2: ["passed", "pass on", "passing on", "not interested", "too tight", "no margin",
        "numbers don't work", "numbers dont work", "doesn't pencil", "doesnt pencil",
        "walk away", "walked away", "overpriced", "won't work", "wont work",
        "margin", "spread", "profit", "roi", "cap rate"],
    1: ["under contract", "closing", "offer", "asking", "list price", "listed at",
        "budget", "contractor", "inspection", "appraisal", "foundation", "roof",
        "hvac", "sewer", "lot", "acquisition", "deal", "purchase price", "cash"],
}

PASSED_MARKERS = [
    "passed", "pass on", "passing on", "not interested", "too tight", "no margin",
    "numbers don't work", "numbers dont work", "doesn't pencil", "doesnt pencil",
    "walk away", "walked away", "won't work", "wont work", "we're out", "were out",
    "take a pass", "gonna pass", "going to pass",
]

# ---------------------------------------------------------------- text recovery


def decode_attributed_body(blob):
    """
    macOS Ventura+ often leaves message.text NULL and stores the body in
    attributedBody, an NSAttributedString serialized as an NSTypedStream.

    Full typedstream parsing is overkill here; the payload we want sits right
    after the 'NSString' class marker as a length-prefixed UTF-8 run. Lengths
    >= 128 are escaped with a 0x81 lead byte followed by a uint16 LE.
    """
    if not blob:
        return None
    if isinstance(blob, str):
        return blob
    marker = blob.find(b"NSString")
    if marker == -1:
        return None
    # Skip 'NSString' + the 0x01 0x94 0x84 0x01 '+' preamble Apple writes.
    p = marker + len(b"NSString")
    while p < len(blob) and blob[p] in (0x01, 0x94, 0x84, 0x2B):
        p += 1
    if p >= len(blob):
        return None
    if blob[p] == 0x81:
        if p + 3 > len(blob):
            return None
        length = int.from_bytes(blob[p + 1:p + 3], "little")
        p += 3
    else:
        length = blob[p]
        p += 1
    chunk = blob[p:p + length]
    if not chunk:
        return None
    text = chunk.decode("utf-8", errors="replace").strip()
    return text or None


def apple_date_to_dt(raw):
    """message.date is ns since Apple epoch on macOS 10.13+, seconds before that."""
    if raw is None:
        return None
    try:
        raw = int(raw)
    except (TypeError, ValueError):
        return None
    if raw == 0:
        return None
    seconds = raw / 1_000_000_000 if abs(raw) > 10 ** 11 else raw
    try:
        return APPLE_EPOCH + timedelta(seconds=seconds)
    except OverflowError:
        return None


# ---------------------------------------------------------------- normalization

CANONICAL_SUFFIX = {
    "street": "St", "streets": "St", "str": "St", "st": "St",
    "avenue": "Ave", "avenues": "Ave", "ave": "Ave", "av": "Ave",
    "road": "Rd", "roads": "Rd", "rd": "Rd",
    "drive": "Dr", "drives": "Dr", "dr": "Dr",
    "lane": "Ln", "lanes": "Ln", "ln": "Ln",
    "court": "Ct", "courts": "Ct", "ct": "Ct",
    "boulevard": "Blvd", "boulevards": "Blvd", "blvd": "Blvd",
    "circle": "Cir", "circles": "Cir", "cir": "Cir",
    "terrace": "Ter", "terraces": "Ter", "ter": "Ter",
    "place": "Pl", "places": "Pl", "pl": "Pl",
    "highway": "Hwy", "highways": "Hwy", "hwy": "Hwy",
    "parkway": "Pkwy", "parkways": "Pkwy", "pkwy": "Pkwy",
    "trail": "Trl", "trails": "Trl", "trl": "Trl",
    "square": "Sq", "squares": "Sq", "sq": "Sq",
    "crossing": "Xing", "crossings": "Xing", "xing": "Xing",
    "point": "Pt", "points": "Pt", "pt": "Pt",
    "heights": "Hts", "hts": "Hts",
}

DIR_CANON = {
    "n": "N", "north": "N", "s": "S", "south": "S", "e": "E", "east": "E",
    "w": "W", "west": "W", "ne": "NE", "northeast": "NE", "nw": "NW",
    "northwest": "NW", "se": "SE", "southeast": "SE", "sw": "SW",
    "southwest": "SW",
}


def normalize_address(m):
    """Collapse '123 N. Main Street' / '123 n main st' to one canonical key."""
    num = m.group("num")
    raw_dir = (m.group("dir") or "").strip().rstrip(".").lower()
    direction = DIR_CANON.get(raw_dir, raw_dir.upper() if raw_dir else "")
    name_words = [w.strip(".") for w in m.group("name").split()]
    name = " ".join(w.capitalize() if w.islower() or w.isupper() else w for w in name_words)
    suffix_raw = m.group("suffix").rstrip(".").lower()
    suffix = CANONICAL_SUFFIX.get(suffix_raw, suffix_raw.capitalize())
    parts = [num]
    if direction:
        parts.append(direction)
    parts.extend([name, suffix])
    return " ".join(parts)


def plausible_street_name(m):
    """Reject matches whose 'street name' is really filler between numbers."""
    words = [w.lower().strip(".") for w in m.group("name").split()]
    if not words:
        return False
    if all(w in NAME_STOPWORDS for w in words):
        return False
    if words[0] in NAME_STOPWORDS and len(words) == 1:
        return False
    # "$300 to 400 Ave" -> name is bare digits, not an ordinal street
    if all(w.isdigit() for w in words):
        return False
    return True


def score_message(text):
    """Weighted keyword score + whether this message reads like a pass."""
    low = text.lower()
    score = 0
    hits = []
    for weight, words in FLIP_KEYWORDS.items():
        for w in words:
            if w in low:
                score += weight
                hits.append(w)
    passed = any(marker in low for marker in PASSED_MARKERS)
    return score, hits, passed


# ---------------------------------------------------------------- db read


def load_messages(db_path, cutoff_dt):
    uri = f"file:{os.path.abspath(db_path)}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='message'")
    if not cur.fetchone():
        raise SystemExit(f"{db_path} has no 'message' table — is that really a chat.db?")

    cur.execute("PRAGMA table_info(message)")
    cols = {r["name"] for r in cur.fetchall()}
    body_col = "m.attributedBody" if "attributedBody" in cols else "NULL"

    sql = f"""
        SELECT
            m.ROWID           AS rowid,
            m.date            AS date,
            m.text            AS text,
            {body_col}        AS attributed_body,
            m.is_from_me      AS is_from_me,
            h.id              AS handle_id,
            c.display_name    AS chat_name,
            c.chat_identifier AS chat_identifier
        FROM message m
        LEFT JOIN handle h              ON m.handle_id = h.ROWID
        LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
        LEFT JOIN chat c                ON c.ROWID = cmj.chat_id
        ORDER BY m.date ASC
    """
    for row in cur.execute(sql):
        sent_at = apple_date_to_dt(row["date"])
        if sent_at is None or sent_at < cutoff_dt:
            continue
        text = row["text"] or decode_attributed_body(row["attributed_body"])
        if not text or not text.strip():
            continue
        yield {
            "rowid": row["rowid"],
            "sent_at": sent_at,
            "text": text.strip(),
            "is_from_me": bool(row["is_from_me"]),
            "counterparty": row["handle_id"] or row["chat_identifier"] or "unknown",
            "chat_name": row["chat_name"] or row["chat_identifier"] or "",
        }
    conn.close()


# ---------------------------------------------------------------- main


def main():
    ap = argparse.ArgumentParser(description="Scan chat.db for property addresses.")
    ap.add_argument("--db", default=os.path.expanduser("~/Library/Messages/chat.db"),
                    help="path to chat.db (snapshot it first; see module docstring)")
    ap.add_argument("--years", type=float, default=5.0, help="how far back to scan")
    ap.add_argument("--outdir", default="./out", help="directory for the CSVs")
    ap.add_argument("--min-score", type=int, default=0,
                    help="drop addresses whose best flip score is below this")
    args = ap.parse_args()

    cutoff = datetime.now(timezone.utc) - timedelta(days=args.years * 365.25)
    os.makedirs(args.outdir, exist_ok=True)

    rollup = defaultdict(lambda: {
        "mentions": 0, "first": None, "last": None, "contacts": set(),
        "score": 0, "keywords": set(), "passed": False, "samples": [],
    })
    mention_rows = []
    scanned = 0

    for msg in load_messages(args.db, cutoff):
        scanned += 1
        seen_in_msg = set()
        for m in ADDRESS_RE.finditer(msg["text"]):
            if not plausible_street_name(m):
                continue
            key = normalize_address(m)
            if key in seen_in_msg:
                continue
            seen_in_msg.add(key)

            score, hits, passed = score_message(msg["text"])
            e = rollup[key]
            e["mentions"] += 1
            e["first"] = msg["sent_at"] if e["first"] is None else min(e["first"], msg["sent_at"])
            e["last"] = msg["sent_at"] if e["last"] is None else max(e["last"], msg["sent_at"])
            e["contacts"].add(msg["counterparty"])
            e["score"] = max(e["score"], score)
            e["keywords"].update(hits)
            e["passed"] = e["passed"] or passed
            if len(e["samples"]) < 3:
                snippet = " ".join(msg["text"].split())
                e["samples"].append(snippet[:300])

            mention_rows.append({
                "address": key,
                "raw_match": m.group(0),
                "sent_at": msg["sent_at"].astimezone().isoformat(timespec="seconds"),
                "direction": "me" if msg["is_from_me"] else "them",
                "counterparty": msg["counterparty"],
                "chat": msg["chat_name"],
                "flip_score": score,
                "reads_as_pass": "yes" if passed else "",
                "message": " ".join(msg["text"].split())[:1000],
            })

    addr_path = os.path.join(args.outdir, "addresses.csv")
    with open(addr_path, "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow([
            "address", "flip_score", "reads_as_pass", "mentions",
            "first_mention", "last_mention", "contacts", "keywords",
            "sample_1", "sample_2", "sample_3",
            "resold_date", "resold_price", "notes",
        ])
        ordered = sorted(rollup.items(), key=lambda kv: (-kv[1]["score"], -kv[1]["mentions"]))
        kept = 0
        for key, e in ordered:
            if e["score"] < args.min_score:
                continue
            kept += 1
            samples = e["samples"] + ["", "", ""]
            w.writerow([
                key, e["score"], "yes" if e["passed"] else "", e["mentions"],
                e["first"].astimezone().date().isoformat(),
                e["last"].astimezone().date().isoformat(),
                "; ".join(sorted(e["contacts"])[:6]),
                ", ".join(sorted(e["keywords"])[:12]),
                samples[0], samples[1], samples[2],
                "", "", "",
            ])

    mention_path = os.path.join(args.outdir, "mentions.csv")
    with open(mention_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=[
            "address", "raw_match", "sent_at", "direction", "counterparty",
            "chat", "flip_score", "reads_as_pass", "message",
        ])
        w.writeheader()
        w.writerows(mention_rows)

    passed_ct = sum(1 for e in rollup.values() if e["passed"])
    print(f"scanned messages : {scanned}")
    print(f"address mentions : {len(mention_rows)}")
    print(f"distinct addrs   : {len(rollup)} ({kept} written, min-score={args.min_score})")
    print(f"reads as a pass  : {passed_ct}")
    print(f"-> {addr_path}")
    print(f"-> {mention_path}")


if __name__ == "__main__":
    sys.exit(main())
