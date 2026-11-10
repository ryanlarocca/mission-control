import os, sys, tempfile, unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import sources as S


class TiingoBudget(unittest.TestCase):
    """Ryan, 2026-11-10: the basket must stay on Tiingo's free plan."""

    def setUp(self):
        self.path = os.path.join(tempfile.mkdtemp(), "usage.json")
        self.t0 = 1_800_000_000

    def test_hourly_cap(self):
        for i in range(S.TIINGO_CAPS["hour"]):
            S.tiingo_take("NVDA", now=self.t0 + i, path=self.path)
        with self.assertRaisesRegex(S.SourceError, "free plan"):
            S.tiingo_take("NVDA", now=self.t0 + 100, path=self.path)
        S.tiingo_take("NVDA", now=self.t0 + 3601, path=self.path)   # next hour is fine

    def test_daily_cap(self):
        n = 0
        for h in range(24):
            for _ in range(S.TIINGO_CAPS["hour"]):
                if n == S.TIINGO_CAPS["day"]:
                    break
                S.tiingo_take("NVDA", now=self.t0 + h * 3600 + n, path=self.path)
                n += 1
        with self.assertRaisesRegex(S.SourceError, "24 h"):
            S.tiingo_take("NVDA", now=self.t0 + 23 * 3600, path=self.path)

    def test_ticker_cap(self):
        for i in range(S.TIINGO_CAPS["month_symbols"]):
            S.tiingo_take("T%d" % i, now=self.t0 + i * 3600, path=self.path)
        S.tiingo_take("T0", now=self.t0 + 200 * 3600, path=self.path)   # a ticker already used is fine
        with self.assertRaisesRegex(S.SourceError, "tickers"):
            S.tiingo_take("NEW", now=self.t0 + 201 * 3600, path=self.path)

    def test_basket_needs_all_eleven(self):
        self.assertEqual(len(S.BASKET), 11)
        self.assertLess(len(S.BASKET) * 2, S.TIINGO_CAPS["hour"])   # a run plus a retry fit in one hour


if __name__ == "__main__":
    unittest.main()
