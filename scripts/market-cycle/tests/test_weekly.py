"""Unit tests for the market-cycle weekly collector and tripwire engine.

Run: python3 -m unittest discover -s scripts/market-cycle/tests
Fixtures: tests/fixtures/mlsl_*.html are real MLSListings result pages fetched
2026-11-01 (trimmed); tests/fixtures/tripwires.json is synthetic.
"""
import copy
import datetime as dt
import importlib.util
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MC = os.path.dirname(HERE)
FX = os.path.join(HERE, "fixtures")
sys.path.insert(0, MC)
import mlsl  # noqa: E402


def load(name, fname):
    spec = importlib.util.spec_from_file_location(name, os.path.join(MC, fname))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


cw = load("collect_weekly", "collect-weekly.py")
tw = load("tripwires", "tripwires.py")
with open(os.path.join(os.path.dirname(os.path.dirname(MC)), "config", "market-cycle", "thesis.v1.1.json")) as _f:
    CFG = json.load(_f)
TIERS = CFG["geographies"]["tiers"]


def page(name):
    with open(os.path.join(FX, name), encoding="utf-8") as f:
        return f.read()


def card(mls, price, status="Active", dos=10, type_="Single Family Residence", address=None, sold_price=None, sold_date=None, zip_="95123", sqft=None):
    return {"mls": mls, "price": price, "status": status, "days_on_site": dos, "type": type_, "address": address or ("%s Main St" % mls[-3:]),
            "zip": zip_, "sold_price": sold_price, "sold_date": sold_date, "sqft": sqft, "city": "San Jose"}


class CardParsing(unittest.TestCase):
    def test_buy_page_monte_sereno(self):
        cards, bad = mlsl.parse_cards(page("mlsl_buy_monte_sereno.html"))
        self.assertEqual(bad, [])
        self.assertEqual(len(cards), 9)
        self.assertEqual(mlsl.result_count(page("mlsl_buy_monte_sereno.html")), 9)
        c = cards[0]
        self.assertEqual((c["mls"], c["address"], c["city"], c["zip"], c["price"], c["status"], c["days_on_site"], c["type"], c["sqft"]),
                         ("ML82065632", "17815 Daves Ave", "Monte Sereno", "95030", 5288000, "Active", 9, "Single Family Residence", 4400))
        self.assertIsNone(c["sold_date"])
        self.assertTrue(c["url"].startswith("https://www.mlslistings.com/property/ml82065632/"))
        self.assertEqual(sum(1 for c in cards if c["status"] == "Pending"), 1)

    def test_sold_page_has_date_and_sale_price(self):
        cards, bad = mlsl.parse_cards(page("mlsl_sold_monte_sereno.html"))
        self.assertEqual((len(cards), bad), (10, []))
        c = cards[0]
        self.assertEqual((c["status"], c["sold_date"], c["sold_price"], c["price"], c["days_on_site"], c["sqft"]),
                         ("Sold", "2026-10-30", 3375000, 3375000, 32, 2608))
        dates = [c["sold_date"] for c in cards]
        self.assertEqual(dates, sorted(dates, reverse=True))   # newest first: lets paging stop at a cutoff

    def test_campbell_mixed_statuses_and_types(self):
        body = page("mlsl_buy_campbell_p1.html")
        cards, bad = mlsl.parse_cards(body)
        self.assertEqual((len(cards), bad, mlsl.result_count(body)), (31, [], 137))
        statuses = {c["status"] for c in cards}
        self.assertTrue({"Active", "Pending", "Contingent"} <= statuses)
        types = {c["type"] for c in cards}
        self.assertTrue({"Single Family Residence", "Townhouse", "Condominium"} <= types)
        self.assertTrue(all(c["city"] == "Campbell" and c["zip"] and c["zip"].startswith("950") for c in cards))
        self.assertEqual(sum(cw.is_sfr(c["type"]) for c in cards), 14)
        self.assertEqual(sum(cw.is_condo(c["type"]) for c in cards), 14)

    def test_block_that_runs_into_next_card_is_refused(self):
        body = page("mlsl_buy_monte_sereno.html")
        i = body.find('data-target="ML82065632"')
        self.assertIsNone(mlsl.parse_block("ML00000000", body[i:i + 20000]))


class Metrics(unittest.TestCase):
    def test_tier_bucketing_edges(self):
        self.assertEqual(cw.tier_of(1_299_999, TIERS), "lt_1_3m")
        self.assertEqual(cw.tier_of(1_300_000, TIERS), "1_3m_2m")
        self.assertEqual(cw.tier_of(1_999_999, TIERS), "1_3m_2m")
        self.assertEqual(cw.tier_of(2_000_000, TIERS), "2m_3m")
        self.assertEqual(cw.tier_of(3_000_000, TIERS), "3m_plus")
        self.assertEqual(cw.tier_of(12_500_000, TIERS), "3m_plus")
        self.assertIsNone(cw.tier_of(None, TIERS))

    def test_pending_ratio(self):
        cards = [card("A1", 1, "Active"), card("A2", 1, "Active"), card("A3", 1, "Active"), card("A4", 1, "Active"),
                 card("P1", 1, "Pending"), card("C1", 1, "Contingent"), card("U1", 1, "Active Under Contract")]
        self.assertEqual(cw.pending_ratio(cards), (0.75, 4, 3))
        self.assertEqual(cw.pending_ratio([card("P1", 1, "Pending")]), (None, 0, 1))

    def test_new_listings_and_median_dos(self):
        cards = [card("A", 1, dos=0), card("B", 1, dos=7), card("C", 1, dos=8), card("D", 1, "Pending", dos=3), card("E", 1, dos=None)]
        self.assertEqual(cw.new_listings(cards), 3)
        self.assertEqual(cw.median([0, 7, 8, None]), 7)

    def test_price_cut_across_two_snapshot_weeks(self):
        wk1 = [card("M1", 1_500_000), card("M2", 2_000_000), card("M3", 900_000)]
        first_seen = {c["mls"]: c["price"] for c in wk1}
        # first run: nothing to compare with → 0 by construction
        r0 = cw.price_cut_share(wk1, {}, {})
        self.assertEqual((r0["share_first"], r0["with_history"]), (0.0, 0))
        snap1 = cw.snapshot_rows({"scc": wk1}, "2026-11-02", {})
        self.assertEqual({r["mls"]: r["first_seen_price"] for r in snap1}, first_seen)
        # week 2: M1 cut, M2 raised, M3 unchanged, M4 new
        wk2 = [card("M1", 1_450_000), card("M2", 2_100_000), card("M3", 900_000), card("M4", 1_200_000)]
        last = {r["mls"]: r["price"] for r in snap1}
        r = cw.price_cut_share(wk2, first_seen, last)
        self.assertEqual((r["cut_first"], r["cut_wow"], r["n"], r["share_first"]), (1, 1, 4, 25.0))
        snap2 = cw.snapshot_rows({"scc": wk2}, "2026-11-09", first_seen)
        fs2 = {x["mls"]: x["first_seen_price"] for x in snap2}
        self.assertEqual(fs2, {"M1": 1_500_000, "M2": 2_000_000, "M3": 900_000, "M4": 1_200_000})
        # week 3: M2 cut back to below last week but not below first seen; M1 unchanged (still below first)
        wk3 = [card("M1", 1_450_000), card("M2", 2_050_000), card("M3", 900_000), card("M4", 1_200_000)]
        r3 = cw.price_cut_share(wk3, fs2, {x["mls"]: x["price"] for x in snap2})
        self.assertEqual((r3["cut_first"], r3["cut_wow"]), (1, 1))

    def test_list_to_sale(self):
        solds = [card("S1", 1_100_000, "Sold", sold_price=1_100_000, sold_date="2026-10-30"),
                 card("S2", 950_000, "Sold", sold_price=950_000, sold_date="2026-10-31"),
                 card("S3", 800_000, "Sold", sold_price=800_000, sold_date="2026-10-31")]       # no list price on record
        last_list = {"S1": 1_000_000, "S2": 1_000_000}
        self.assertEqual(cw.list_to_sale(solds, last_list), (102.5, 2))
        self.assertEqual(cw.list_to_sale(solds, {}), (None, 0))

    def test_withdrawn_and_relist(self):
        prior = [{"mls": "W1", "status": "Active", "address": "1 Oak St"}, {"mls": "W2", "status": "Active", "address": "2 Elm St"},
                 {"mls": "W3", "status": "Active", "address": "3 Fir St"}, {"mls": "W4", "status": "Active", "address": "4 Ash St"}]
        now_act = [card("W2", 1, address="2 Elm St"), card("N3", 1, address="3 Fir St")]      # W3 came back as N3 (relist)
        share, d = cw.withdrawn_relist(now_act, buy_mls={"W2", "N3"}, sold_mls={"W4"}, prior_rows=prior)
        self.assertEqual((d["withdrawn"], d["relisted"], d["prior_actives"]), (2, 1, 4))   # W1 + W3 gone unsold
        self.assertEqual(share, 75.0)
        self.assertEqual(cw.withdrawn_relist(now_act, set(), set(), [])[0], None)

    def test_sold_ppsf_and_street_key(self):
        solds = [card("S1", 0, "Sold", sold_price=1_500_000, sqft=1500), card("S2", 0, "Sold", sold_price=2_000_000, sqft=1600),
                 card("S3", 0, "Sold", sold_price=1_000_000, sqft=None)]
        self.assertEqual(cw.sold_ppsf(solds), (1125.0, 2))
        self.assertEqual(cw.street_key("5764 Halleck Dr, San Jose, CA 95123"), "Halleck")
        self.assertEqual(cw.street_key("2116 Quito Rd, San Jose, CA 95130"), "Quito")

    def test_properant_parse(self):
        text = ("Across Santa Clara County the platform is tracking 386 in pre-foreclosure, 323 under a notice of default and 63 with an auction date set. "
                "Month Notices Of Default Sale Notices October 2026 39 16 September 2026 52 22 August 2026 59 17 Recorded filings by recording month")
        p = cw.parse_properant_county(text)
        self.assertEqual(p["stock"], 323)
        self.assertEqual(p["monthly"][:2], [("2026-10", 39, 16), ("2026-09", 52, 22)])
        self.assertEqual(cw.month_end("2026-02"), "2026-02-28")
        self.assertEqual(cw.parse_properant_state("Alameda County ( 359 ) Santa Clara County ( 323 ) Stanislaus"), 323)


class Tripwires(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(FX, "tripwires.json")) as f:
            self.fx = json.load(f)
        self.today = dt.date.fromisoformat(self.fx["today"])

    def run_fx(self, readings=None, events=None):
        res = tw.evaluate(CFG, readings if readings is not None else self.fx["readings"], events if events is not None else self.fx["events"], self.today)
        return {r["tripwire_id"]: r for r in res}

    def test_fixture_outcomes(self):
        r = self.run_fx()
        self.assertEqual(r["ccc_oas_record"]["status"], "FIRED")
        self.assertEqual(r["ccc_oas_record"]["fired_on"], "2026-10-30")       # 10-27 alone was one day, not a two-day close
        self.assertEqual(r["ant_ipo_fail"]["status"], "FIRED")
        self.assertEqual(r["fed_intermeeting"]["status"], "ALREADY_FIRED")
        self.assertEqual(r["hormuz"]["status"], "QUIET")
        self.assertEqual(r["scc_price_reduced_record"]["status"], "QUIET")    # one month >= 58.54, not two
        self.assertEqual(r["scc_warn_spike"]["status"], "QUIET")
        self.assertEqual(r["scc_actives_yoy"]["status"], "QUIET")
        self.assertEqual(r["claim_early"]["status"], "MANUAL")

    def test_card_is_exactly_three_lines(self):
        c = self.run_fx()["ccc_oas_record"]["card"]
        lines = c.split("\n")
        self.assertEqual(len(lines), 3)
        self.assertIn("20.6", lines[1])
        self.assertIn("2026", lines[1])
        self.assertEqual(lines[2], "Out-of-cycle review within 24h")

    def test_persistence_price_reduced_two_consecutive(self):
        rd = copy.deepcopy(self.fx["readings"])
        rd.append({"dial_id": "realtor_price_reduced_share_scc", "as_of": "2026-11-01", "value": 60.0, "source_url": "fred"})
        r = self.run_fx(rd)
        self.assertEqual(r["scc_price_reduced_record"]["status"], "QUIET")       # 59.1, 57.9, 60.0: broken run
        rd.append({"dial_id": "realtor_price_reduced_share_scc", "as_of": "2026-12-01", "value": 61.0, "source_url": "fred"})
        r = tw.evaluate(CFG, rd, [], dt.date(2026, 12, 2))
        r = {x["tripwire_id"]: x for x in r}
        self.assertEqual((r["scc_price_reduced_record"]["status"], r["scc_price_reduced_record"]["fired_on"]), ("FIRED", "2026-12-01"))

    def test_warn_fires_on_single_month_at_threshold(self):
        rd = copy.deepcopy(self.fx["readings"]) + [{"dial_id": "scc_warn_workers", "as_of": "2026-11-01", "value": 1588, "source_url": "edd"}]
        self.assertEqual(self.run_fx(rd)["scc_warn_spike"]["status"], "FIRED")

    def test_onset_fires_once_per_episode(self):
        pts = [("2026-10-%02d" % i, v) for i, v in zip(range(20, 27), [21, 21, 21, 19, 21, 21, 21])]
        # runs of >=20: 20-22 (onset 21st), 24-26 (onset 25th); the most recent episode is returned
        self.assertEqual(tw.onset(pts, lambda v: v >= 20, 2, 5), 5)
        self.assertIsNone(tw.onset(pts[:1], lambda v: v >= 20, 2, 5))
        gap = [("2026-10-01", 21), ("2026-10-20", 21)]                  # not consecutive: 19-day gap on a daily dial
        self.assertIsNone(tw.onset(gap, lambda v: v >= 20, 2, 5))

    def test_scc_actives_yoy_fires_on_two_weeks_above(self):
        rd = [r for r in self.fx["readings"] if r["dial_id"] != "mls_scc_active_sfr"]
        rd += [{"dial_id": "mls_scc_active_sfr", "as_of": "2026-10-26", "value": 1000, "source_url": "x"},
               {"dial_id": "mls_scc_active_sfr", "as_of": "2026-11-02", "value": 1060, "source_url": "x"},     # +41.3% vs Nov-25 x k
               {"dial_id": "mls_scc_active_sfr", "as_of": "2026-11-09", "value": 1080, "source_url": "x"}]     # +44.0%
        r = tw.evaluate(CFG, rd, [], dt.date(2026, 11, 9))
        r = {x["tripwire_id"]: x for x in r}["scc_actives_yoy"]
        self.assertEqual((r["status"], r["fired_on"]), ("FIRED", "2026-11-09"))
        self.assertAlmostEqual(r["reading"], 44.0, places=1)

    def test_scc_actives_yoy_below_zero_and_own_history(self):
        rd = [{"dial_id": "mls_scc_active_sfr", "as_of": "2025-11-03", "value": 1000, "source_url": "x"},
              {"dial_id": "mls_scc_active_sfr", "as_of": "2025-11-10", "value": 1000, "source_url": "x"},
              {"dial_id": "mls_scc_active_sfr", "as_of": "2026-11-02", "value": 990, "source_url": "x"},
              {"dial_id": "mls_scc_active_sfr", "as_of": "2026-11-09", "value": 980, "source_url": "x"}]
        r = {x["tripwire_id"]: x for x in tw.evaluate(CFG, rd, [], dt.date(2026, 11, 9))}["scc_actives_yoy"]
        self.assertEqual(r["status"], "FIRED")
        self.assertIn("own reading", r["detail"])

    def test_manual_event_needs_marker_and_recency(self):
        rd = [{"dial_id": "hormuz_status", "as_of": "2026-11-01", "value": 1, "source_url": "news"}]          # not a manual tripwire reading
        self.assertEqual(self.run_fx(rd, [])["hormuz"]["status"], "QUIET")
        rd = [{"dial_id": "hormuz_status", "as_of": "2026-06-01", "value": 1, "source_url": "manual:tripwire", "raw": "old"}]
        self.assertEqual(self.run_fx(rd, [])["hormuz"]["status"], "QUIET")
        rd = [{"dial_id": "hormuz_status", "as_of": "2026-11-01", "value": 1, "source_url": "manual:tripwire", "raw": "Strait reopened"}]
        self.assertEqual(self.run_fx(rd, [])["hormuz"]["status"], "FIRED")

    def test_baseline_the_day_before_is_not_a_second_week(self):
        """Nov 1 (manual baseline) + Nov 2 (Monday run) fired '2 consecutive weeks' on Nov 2, 2026."""
        rd = [r for r in self.fx["readings"] if r["dial_id"] != "mls_scc_active_sfr"]
        rd += [{"dial_id": "mls_scc_active_sfr", "as_of": "2026-10-26", "value": 1000, "source_url": "x"},
               {"dial_id": "mls_scc_active_sfr", "as_of": "2026-11-01", "value": 1060, "source_url": "x"},     # +41.3%
               {"dial_id": "mls_scc_active_sfr", "as_of": "2026-11-02", "value": 1080, "source_url": "x"}]     # +44.0%, one day later
        self.assertEqual([p for p, _ in tw.thin(tw.series(rd, "mls_scc_active_sfr"), 5)], ["2026-10-26", "2026-11-02"])
        r = {x["tripwire_id"]: x for x in tw.evaluate(CFG, rd, [], dt.date(2026, 11, 2))}["scc_actives_yoy"]
        self.assertEqual(r["status"], "QUIET")
        rd.append({"dial_id": "mls_scc_active_sfr", "as_of": "2026-11-09", "value": 1085, "source_url": "x"})
        r = {x["tripwire_id"]: x for x in tw.evaluate(CFG, rd, [], dt.date(2026, 11, 9))}["scc_actives_yoy"]
        self.assertEqual((r["status"], r["fired_on"]), ("FIRED", "2026-11-09"))

    def test_thin_measures_from_the_first_reading_of_a_period(self):
        pts = [("2026-11-01", 1), ("2026-11-02", 2), ("2026-11-05", 3), ("2026-11-07", 4), ("2026-11-09", 5)]
        self.assertEqual(tw.thin(pts, 5), [("2026-11-05", 3), ("2026-11-09", 5)])

    def test_backfilled_crossing_is_history_not_news(self):
        """The first live run after the backfill fired scc_warn_spike on Oct 2025 (2,066 workers)."""
        rd = [{"dial_id": "scc_warn_workers", "as_of": "2025-10-01", "value": 2066, "source_url": "edd"},
              {"dial_id": "scc_warn_workers", "as_of": "2026-10-01", "value": 569, "source_url": "edd"}]
        r = {x["tripwire_id"]: x for x in tw.evaluate(CFG, rd, [], dt.date(2026, 11, 2))}["scc_warn_spike"]
        self.assertEqual(r["status"], "HISTORICAL")
        self.assertNotIn("card", r)

    def test_manual_readings_never_feed_a_threshold(self):
        rd = [{"dial_id": "scc_warn_workers", "as_of": "2026-11-01", "value": 2000, "source_url": "manual:baseline"}]
        self.assertEqual(self.run_fx(rd, [])["scc_warn_spike"]["status"], "NO_DATA")

    def test_no_data(self):
        r = self.run_fx([], [])
        self.assertEqual(r["ccc_oas_record"]["status"], "NO_DATA")
        self.assertEqual(r["scc_actives_yoy"]["status"], "NO_DATA")


if __name__ == "__main__":
    unittest.main()



class TestAutoDials(unittest.TestCase):
    """Dynamic dials (panels, owned zips, listed properties, NOD filings) register display-only."""

    def test_patterns_and_rows(self):
        R = cw.R
        cases = [
            (R("mls_panel_fremont_pending_ratio", "2026-11-01", 0.52, 163, "u", "fremont", "pending_ratio", {}), "local_housing", "bull"),
            # digits in the metric name (new_listings_7d) were dropped on the first live write 2026-11-01
            (R("mls_panel_scc_condos_new_listings_7d", "2026-11-01", 30, 400, "u", "scc_condos", "new_listings_7d", {}), "local_housing", "bear"),
            (R("mls_zip_95118_sold_ppsf_90d", "2026-11-01", 1084, 51, "u", "zip 95118", "sold_ppsf_90d", {}), "owned_property", "neutral"),
            (R("listed_halleck_pile_mentions_7d", "2026-11-01", 5, 5, "pile:Halleck", "listed:Halleck", "pile_mentions_7d", {}), "owned_property", "neutral"),
            (R("scc_nod_filings_monthly", "2026-10-31", 46, 1, "u", "SCC", "nod_filings_month", {}), "local_housing", "bear"),
        ]
        for r, cat, up in cases:
            self.assertTrue(cw.AUTO_DIAL_RE.match(r["dial_id"]), r["dial_id"])
            row = cw.auto_dial_row(r)
            self.assertEqual(row["category"], cat)
            self.assertEqual(row["direction_map"]["up"], up)
            self.assertFalse(row["votes"])
            self.assertEqual(row["band_rule"], "corridor")
        for static in ("mls_scc_active_sfr", "realtor_active_scc", "ccc_oas"):
            self.assertIsNone(cw.AUTO_DIAL_RE.match(static), static)
