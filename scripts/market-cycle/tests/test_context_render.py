"""cycle-context.py: the comps macro-context block rendered from a fixture.

  python3 -m unittest discover -s scripts/market-cycle/tests -p 'test_context_*.py'

Stdlib only; no network (the fixture replaces Supabase).
"""
import copy, importlib.util, json, os, subprocess, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(os.path.dirname(HERE), "cycle-context.py")
FIXTURE = os.path.join(HERE, "fixtures", "context_95123.json")

spec = importlib.util.spec_from_file_location("cycle_context", SCRIPT)
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)
CFG = cc.load_config()


def fixture():
    with open(FIXTURE) as f:
        return json.load(f)


class BlockShape(unittest.TestCase):
    def test_at_most_ten_lines_and_labelled(self):
        lines = cc.render(fixture(), CFG, "95123", 1150000, "2027-04")
        self.assertLessEqual(len(lines), 10)
        self.assertTrue(lines[0].startswith("MACRO CONTEXT (market-cycle tracker) — context, not comps"))
        self.assertIn("as of Nov 1, 2026", lines[0])

    def test_exit_line_only_with_exit_month(self):
        self.assertFalse(any(l.startswith("Exit") for l in cc.render(fixture(), CFG, "95123", 1150000)))
        self.assertTrue(any(l.startswith("Exit Apr 2027") for l in cc.render(fixture(), CFG, "95123", 1150000, "2027-04")))

    def test_cli_prints_the_block(self):
        out = subprocess.run([sys.executable, SCRIPT, "--zip", "95123", "--price", "1150000", "--exit-month", "2027-04", "--fixture", FIXTURE],
                             capture_output=True, text=True, check=True).stdout.strip().split("\n")
        self.assertEqual(out, cc.render(fixture(), CFG, "95123", 1150000, "2027-04"))


class MissingData(unittest.TestCase):
    def test_absent_dials_say_na(self):
        lines = cc.render(fixture(), CFG, "95123", 1150000)
        self.assertIn("list-to-sale " + cc.NA, lines[2])
        self.assertIn("days on site " + cc.NA, lines[3])      # tier has no DOS reading
        self.assertNotIn("sold 90d", lines[3])                # optional part omitted, not n/a'd

    def test_empty_data_never_invents_numbers(self):
        lines = cc.render({"today": "2026-11-01", "readings": {}}, CFG, "95123", 1150000, "2027-04")
        self.assertLessEqual(len(lines), 10)
        self.assertIn("partition: " + cc.NA, lines[1])
        self.assertIn("thesis v1.1", lines[1])                # weights fall back to the committed thesis
        self.assertEqual(lines[2].count(cc.NA), 5)
        self.assertEqual(lines[3], "Tier <$1.3M (SCC): actives %s · days on site %s · cut share %s" % (cc.NA, cc.NA, cc.NA))
        self.assertEqual(lines[5], "Stale-comp drift: " + cc.NA)
        self.assertEqual(lines[6], "Exit Apr 2027: " + cc.NA)
        self.assertEqual(lines[7], "Last checkpoint: n/a (none yet) · Next: Dec 14, 2026 (shakedown)")

    def test_null_values_are_missing(self):
        d = fixture()
        d["readings"]["mls_zip_95123_active_sfr"] = [["2026-10-26", None]]
        self.assertIn("actives " + cc.NA, cc.render(d, CFG, "95123", 1150000)[4])


class Drift(unittest.TestCase):
    def test_zip_level_series(self):
        line = cc.render(fixture(), CFG, "95123", 1150000)[5]
        # 1,188,000 vs 1,199,000 (Jul) and 1,205,000 (Jun)
        self.assertEqual(cc.fsigned((1188000 / 1199000 - 1) * 100), "-0.9%")
        self.assertEqual(cc.fsigned((1188000 / 1205000 - 1) * 100), "-1.4%")
        self.assertEqual(line, "Stale-comp drift (zip 95123 ZHVI; latest print Sep 2026): 60d -0.9% · 90d -1.4% → a comp sold 90 days ago: index moved -1.4% since")

    def test_county_fallback_is_labelled(self):
        d = fixture()
        del d["readings"]["zhvi_zip_95123_level"]
        line = cc.render(d, CFG, "95123", 1150000)[5]
        self.assertIn("county ZHVI, no zip level series yet", line)
        self.assertIn("90d %s" % cc.fsigned((1562682 / 1576000 - 1) * 100), line)

    def test_short_history_gives_na_for_90d(self):
        d = fixture()
        d["readings"]["zhvi_zip_95123_level"] = d["readings"]["zhvi_zip_95123_level"][-3:]   # Jul, Aug, Sep
        line = cc.render(d, CFG, "95123", 1150000)[5]
        self.assertIn("60d -0.9% · 90d " + cc.NA, line)
        self.assertNotIn("a comp sold 90 days ago", line)


class ExitFraming(unittest.TestCase):
    def test_linear_path_to_band_midpoints(self):
        dd = cc.drawdown_state(fixture(), CFG)
        self.assertEqual(dd["month"], "2026-09")
        self.assertAlmostEqual(dd["today"], (1562682 / 1630177 - 1) * 100)
        self.assertAlmostEqual(dd["deepest"], (1551929 / 1630177 - 1) * 100)
        moves = {sid: m for sid, m, _ in cc.exit_path(dd, CFG, "2027-04")}

        def expected(mid, span, gone):
            frac = min(1.0, gone / span)
            ddx = dd["today"] + (mid - dd["today"]) * frac
            return ((1 + ddx / 100) / (1 + dd["today"] / 100) - 1) * 100
        self.assertAlmostEqual(moves["bear"], expected((-29.9 + -15) / 2, 21, 7))   # Sep 2026 → Jun 2028 trough
        self.assertAlmostEqual(moves["base"], expected(-11.5, 8, 7))                # → May 2027
        self.assertAlmostEqual(moves["bull"], expected((-8 + dd["deepest"]) / 2, 4, 7))  # → Jan 2027, flat after
        line = cc.render(fixture(), CFG, "95123", 1150000, "2027-04")[6]
        self.assertTrue(line.startswith("Exit Apr 2027 (<$1.3M ≈ county; straight line from today's -4.1% to each band's midpoint by its typical trough, flat after): "))
        self.assertIn("Bear -6.4% (~$1.08M)", line)
        self.assertIn("Bull -2.4% (~$1.12M)", line)

    def test_exit_before_latest_print_is_no_move(self):
        moves = cc.exit_path(cc.drawdown_state(fixture(), CFG), CFG, "2026-09")
        for sid, m, out in moves:
            self.assertFalse(out)
            self.assertAlmostEqual(m, 0.0)

    def test_bull_ruled_out_once_drawdown_passes_minus_8(self):
        d = fixture()
        d["readings"]["zhvi_scc"].append(["2026-10-31", 1776795 * 0.91])   # -9%
        lines = cc.render(d, CFG, "95123", 1150000, "2027-04")
        self.assertIn("Base band reached, Bull ruled out", lines[1])
        self.assertIn("Bull ruled out", lines[6])


class Checkpoints(unittest.TestCase):
    def test_last_checkpoint_one_liner_and_next_monday_after_cpi(self):
        d = fixture()
        d["checkpoint"] = {"date": "2027-01-18", "kind": "monthly", "weights_after": {"bear": 40, "base": 45, "bull": 15},
                           "argument": "Three categories agree and a tripwire fired. The IPO window is wobbling."}
        d["weight_move"] = None
        d["calendar"] = [{"date": "2027-02-10", "dial_id": "cpi_yoy", "label": "CPI (Jan)"}]
        lines = cc.render(d, CFG, "95123", 1150000, today="2027-02-01")
        self.assertIn("Bear 40 · Base 45 · Bull 15 (checkpoint, Jan 18, 2027)", lines[1])
        self.assertEqual(lines[-1], "Last checkpoint Jan 18, 2027 (monthly): Three categories agree and a tripwire fired. · Next: Feb 15, 2027 (quarterly)")

    def test_tiers_follow_config_bounds(self):
        self.assertEqual(cc.tier_for(CFG, 1299999)["id"], "lt_1_3m")
        self.assertEqual(cc.tier_for(CFG, 1300000)["id"], "1_3m_2m")
        self.assertEqual(cc.tier_for(CFG, 3000000)["id"], "3m_plus")


class Formatting(unittest.TestCase):
    def test_half_up_and_no_negative_zero(self):
        self.assertEqual(cc.fnum(2.25, 1), "2.3")
        self.assertEqual(cc.fnum(-2.25, 1), "-2.3")
        self.assertEqual(cc.fnum(-0.04, 1), "0.0")
        self.assertEqual(cc.fsigned(0.04), "0.0%")
        self.assertEqual(cc.fint(2455), "2,455")
        self.assertEqual(cc.fmoney(1150000), "$1.15M")
        self.assertEqual(cc.fmoney(850000), "$850k")


if __name__ == "__main__":
    unittest.main()
