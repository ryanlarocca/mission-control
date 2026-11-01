"""Market-cycle macro collector: transforms, variants, new-readings filter, release notes.
Pure: no network (the fetchers are patched where fetch_dial is exercised)."""
import os, sys, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import sources as S  # noqa: E402


def monthly(start_year, values):
    out, y, m = [], start_year, 1
    for v in values:
        out.append(("%04d-%02d-01" % (y, m), v))
        m += 1
        if m == 13:
            y, m = y + 1, 1
    return out


class TestYoY(unittest.TestCase):
    def test_yoy_pct_matches_same_month_prior_year(self):
        rows = monthly(2024, [100.0] * 12 + [103.0, 110.0])
        out = S.yoy_pct(rows)
        self.assertEqual(out, [("2025-01-01", 3.0), ("2025-02-01", 10.0)])

    def test_yoy_pct_skips_months_without_a_prior_year(self):
        self.assertEqual(S.yoy_pct(monthly(2026, [1.0, 2.0])), [])

    def test_diff(self):
        self.assertEqual(S.diff([("a", 10.0), ("b", 13.5), ("c", 12.0)]), [("b", 3.5), ("c", -1.5)])


class TestDrawdowns(unittest.TestCase):
    def test_drawdown_from_fixed_high_starts_at_the_reference(self):
        rows = [("2024-12-31", 90.0), ("2025-01-31", 100.0), ("2025-06-30", 95.0), ("2026-09-30", 85.0)]
        self.assertEqual(S.drawdown_from_fixed(rows, 100.0, since="2025-01-01"),
                         [("2025-01-31", 0.0), ("2025-06-30", -5.0), ("2026-09-30", -15.0)])

    def test_drawdown_from_dated_close(self):
        rows = [("2026-10-05", 7700.0), ("2026-10-06", 8000.0), ("2026-10-07", 7600.0), ("2026-10-08", 8200.0)]
        out = S.apply_named_transform("drawdown_from_2026-10-06_high", rows)
        self.assertEqual(out, [("2026-10-06", 0.0), ("2026-10-07", -5.0), ("2026-10-08", 2.5)])

    def test_drawdown_from_dated_close_missing_reference_raises(self):
        with self.assertRaises(S.SourceError):
            S.apply_named_transform("drawdown_from_2026-10-06_high", [("2026-10-07", 1.0)])

    def test_drawdown_from_52w_high_uses_trailing_year_and_skips_partial_windows(self):
        rows = [("2024-01-01", 100.0), ("2024-06-01", 150.0), ("2025-01-01", 120.0), ("2025-07-01", 90.0)]
        out = dict(S.drawdown_from_rolling_high(rows, 365))
        self.assertNotIn("2024-06-01", out)                       # lookback reaches before the series start
        self.assertEqual(out["2025-01-01"], -20.0)                 # high in window = 150 (2024-06-01)
        self.assertEqual(out["2025-07-01"], -25.0)                 # 2024-06-01 rolled out; high = 120

    def test_zhvi_reference_peak_transform_reads_the_config_peak(self):
        cfg = S.load_config()
        dial = next(d for d in cfg["dials"] if d["id"] == "zhvi_scc_drawdown")
        ref = cfg["scored_object"]["reference_peak"]
        series = [("2024-12-31", 1600000.0), (ref["month"] + "-31", float(ref["value"])), ("2026-09-30", ref["value"] * 0.9)]
        with mock.patch.object(S, "zillow_county", return_value=series):
            rows, _, note, _ = S.fetch_dial(dial, cfg)
        self.assertEqual(rows[0], (ref["month"] + "-31", 0.0))
        self.assertAlmostEqual(rows[-1][1], -10.0, places=3)
        self.assertIn("fixed reference peak", note)


class TestSpreadAndRatio(unittest.TestCase):
    def test_spread_is_mortgage_minus_10y_as_of_the_survey_date_in_bp(self):
        mort = [("2026-10-01", 7.0), ("2026-10-08", 7.2), ("2026-10-15", 7.1)]
        ten = [("2026-10-02", 4.8), ("2026-10-07", 5.0), ("2026-10-15", 4.9)]
        # 10-01 precedes the first 10-yr close -> dropped; 10-08 reads the 10-07 close
        self.assertEqual(S.spread_bp(mort, ten), [("2026-10-08", 220.0), ("2026-10-15", 220.0)])

    def test_ratio_pct(self):
        self.assertEqual(S.ratio_pct([("m1", 620.0), ("m2", 5.0)], [("m1", 1987.0)]), [("m1", 31.203)])


class TestVariants(unittest.TestCase):
    def dial(self, **cor):
        return {"id": "x", "transform": "level", "direction_map": {"up": "bear", "down": "bull"}, "corridor": cor}

    def test_10d_avg(self):
        rows = [("d%02d" % i, float(i)) for i in range(1, 13)]
        (name, out), = S.corridor_variants(self.dial(read_as="10d_avg"), rows)
        self.assertEqual(name, "10d_avg")
        self.assertEqual(out[0], ("d10", 5.5))
        self.assertEqual(out[-1], ("d12", 7.5))

    def test_2d_close_is_the_less_extreme_close_toward_bear(self):
        rows = [("a", 19.0), ("b", 21.0), ("c", 20.5), ("d", 18.0)]
        (_, out), = S.corridor_variants(self.dial(read_as="2d_close"), rows)
        self.assertEqual(out, [("b", 19.0), ("c", 20.5), ("d", 18.0)])
        bull_up = dict(self.dial(read_as="2d_close"), direction_map={"up": "bull", "down": "bear"})
        (_, out), = S.corridor_variants(bull_up, rows)
        self.assertEqual(out[0], ("b", 21.0))

    def test_corridor_transform_variant_only_when_it_differs(self):
        rows = monthly(2024, [100.0] * 12 + [102.0])
        (name, out), = S.corridor_variants(self.dial(transform="yoy_pct"), rows)
        self.assertEqual((name, out), ("yoy_pct", [("2025-01-01", 2.0)]))
        same = dict(self.dial(transform="yoy_pct"), transform="yoy_pct")
        self.assertEqual(S.corridor_variants(same, rows), [])
        self.assertEqual(S.corridor_variants(dict(self.dial(), corridor=None), rows), [])

    def test_config_market_dials_get_their_read_as_variant(self):
        cfg = S.load_config()
        d = {x["id"]: x for x in cfg["dials"]}
        rows = [("2026-10-%02d" % i, float(i)) for i in range(1, 12)]
        self.assertEqual([v for v, _ in S.corridor_variants(d["ust10y"], rows)], ["10d_avg"])
        self.assertEqual([v for v, _ in S.corridor_variants(d["ccc_oas"], rows)], ["2d_close"])
        self.assertEqual([v for v, _ in S.corridor_variants(d["basket_index"], rows)], ["drawdown_from_52w_high"])


class TestNewOnly(unittest.TestCase):
    rows = [("2026-07-01", 1.0), ("2026-08-01", 2.0), ("2026-09-01", 3.0)]

    def test_nothing_stored_means_everything_is_new(self):
        self.assertEqual(S.new_only(self.rows, None), self.rows)

    def test_only_strictly_newer_than_the_latest_stored(self):
        self.assertEqual(S.new_only(self.rows, "2026-08-01"), [("2026-09-01", 3.0)])
        self.assertEqual(S.new_only(self.rows, "2026-09-01"), [])

    def test_month_end_dates_compare_on_iso_date(self):
        self.assertEqual(S.new_only([("2026-09-30", 1.0)], "2026-08-31"), [("2026-09-30", 1.0)])


class TestReleaseNotes(unittest.TestCase):
    cpi = {"id": "cpi_yoy", "name": "US CPI, all items, YoY", "cadence": "monthly", "units": "% YoY"}
    ff = {"id": "fed_funds_target_upper", "name": "Fed funds upper", "cadence": "daily", "units": "%"}

    def test_monthly_print_vs_prior(self):
        rows = [("2026-08-01", 3.4), ("2026-09-01", 3.7)]
        txt = S.release_note(self.cpi, rows, rows[-1:], ["2026-11-10"], "2026-08-01")
        self.assertEqual(txt, "US CPI, all items, YoY printed 3.7 % YoY (2026-09) vs prior 3.4 (2026-08)")

    def test_no_new_reading_no_note(self):
        self.assertIsNone(S.release_note(self.cpi, [("2026-09-01", 3.7)], [], ["2026-11-10"], "2026-09-01"))

    def test_daily_dial_notes_only_after_a_calendar_date(self):
        rows = [("2026-12-15", 4.0), ("2026-12-16", 4.0), ("2026-12-17", 4.25)]
        self.assertIsNone(S.release_note(self.ff, rows, rows[:1], ["2026-12-16"], "2026-12-14"))
        txt = S.release_note(self.ff, rows, rows[1:], ["2026-12-16"], "2026-12-15")
        self.assertEqual(txt, "Fed funds upper printed 4.25 % (2026-12-17) vs prior 4 (2026-12-16)")
        # already seen a reading after the decision -> no repeat
        self.assertIsNone(S.release_note(self.ff, rows + [("2026-12-18", 4.25)], [("2026-12-18", 4.25)], ["2026-12-16"], "2026-12-17"))


class TestMonthsSupply(unittest.TestCase):
    def test_derived_months_supply_divides_actives_by_sccaor_sales(self):
        cfg = S.load_config()
        dial = next(d for d in cfg["dials"] if d["id"] == "scc_months_supply")
        fred_rows = [("2026-08-01", 1859.0), ("2026-09-01", 1987.0)]
        sccaor = ({"2026-09": {"sales": 726.0, "inventory": 1224.0, "avg_dom": 27.0, "source_url": "u"},
                   "2026-10": {"sales": 700.0, "inventory": 1300.0, "avg_dom": 30.0, "source_url": "u"}}, [])
        with mock.patch.object(S, "fred", return_value=fred_rows), mock.patch.object(S, "sccaor_months", return_value=sccaor):
            rows, _, _, extras = S.fetch_dial(dial, cfg)
        self.assertEqual(rows, [("2026-09-01", 2.74)])                # only months with both
        self.assertEqual(extras["2026-09-01"]["raw"]["sfr_only_months"], 1.69)


if __name__ == "__main__":
    unittest.main()
