"""Market-cycle macro collector: C.A.R. and SCCAOR parsers against saved real pages.
Fixtures (fetched 2026-11-01, trimmed):
  fixtures/macro_car_sept2026.html          car.org .../2026releases/sept2026sales, the two county tables
  fixtures/macro_sccaor_sept2026_post.html  sccaor.com 'Housing Statistics Month of September 2026' post
  fixtures/macro_sccaor_sept2026_pdf.txt    pdftotext -layout of sccaor.com .../2026/10/September2026.pdf
"""
import os, sys, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import sources as S  # noqa: E402

FIX = os.path.join(HERE, "fixtures")


def fixture(name):
    with open(os.path.join(FIX, name), encoding="utf-8") as f:
        return f.read()


class TestLabels(unittest.TestCase):
    def test_month_labels(self):
        self.assertEqual(S.month_from_label("Sept. 2026"), "2026-09")
        self.assertEqual(S.month_from_label("September 2026"), "2026-09")
        self.assertEqual(S.month_from_label("Aug. 2026"), "2026-08")
        self.assertEqual(S.month_from_label("Nov-24"), "2024-11")
        self.assertEqual(S.month_from_label("Mar-25"), "2025-03")
        self.assertIsNone(S.month_from_label("State/Region/County"))
        self.assertIsNone(S.month_from_label("Price YTY% Chg"))

    def test_car_slug_month(self):
        self.assertEqual(S.car_slug_month("/en/aboutus/mediacenter/newsreleases/2026releases/sept2026sales"), "2026-09")
        self.assertEqual(S.car_slug_month("/2026releases/July2026HomeSales"), "2026-07")
        self.assertEqual(S.car_slug_month("/2024releases/2july2024sales"), "2024-07")
        self.assertEqual(S.car_slug_month("/2026releases/dec2025sales"), "2025-12")
        self.assertIsNone(S.car_slug_month("/2026releases/2027housingforecast"))

    def test_car_release_links_keep_sales_releases_only(self):
        html = ('<a href="/en/aboutus/mediacenter/newsreleases/2026releases/sept2026sales">Sept</a>'
                '<a href="/en/aboutus/mediacenter/newsreleases/2026releases/2qtr2026HAI">HAI</a>'
                '<a href="/en/aboutus/mediacenter/newsreleases/2026releases/sept2026sales">dup</a>'
                '<a href="/en/aboutus/mediacenter/newsreleases/2026releases/July2026HomeSales">July</a>')
        self.assertEqual(S.car_release_links(html, 2026), [
            ("https://www.car.org/en/aboutus/mediacenter/newsreleases/2026releases/sept2026sales", "2026-09"),
            ("https://www.car.org/en/aboutus/mediacenter/newsreleases/2026releases/July2026HomeSales", "2026-07")])


class TestCarRelease(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.rel = S.parse_car_release(fixture("macro_car_sept2026.html"))

    def test_month(self):
        self.assertEqual(self.rel["month"], "2026-09")

    def test_santa_clara_row(self):
        scc = self.rel["counties"]["Santa Clara"]
        self.assertEqual(scc["median"], 1920000.0)
        self.assertEqual(scc["median_prior_month"], 1900000.0)
        self.assertEqual(scc["median_year_ago"], 2000000.0)
        self.assertEqual(scc["price_yoy_pct"], -4.0)
        self.assertEqual(scc["price_mtm_pct"], 1.1)
        self.assertEqual(scc["sales_yoy_pct"], 1.5)
        self.assertEqual(scc["sales_mtm_pct"], 15.3)
        self.assertEqual(scc["uii"], 2.1)
        self.assertEqual(scc["median_dom"], 11.0)
        self.assertEqual(scc["median_dom_year_ago"], 10.0)
        self.assertFalse(scc["revised"])

    def test_san_francisco_county_not_the_bay_area_region(self):
        sf = self.rel["counties"]["San Francisco"]
        self.assertEqual(sf["median"], 2054000.0)
        self.assertEqual(sf["price_yoy_pct"], 17.4)
        self.assertEqual(sf["median_dom"], 21.0)

    def test_page_without_the_table_is_a_source_error(self):
        with self.assertRaises(S.SourceError):
            S.parse_car_release("<html><body><table><tr><td>Housing Affordability Index</td></tr></table></body></html>")

    def test_missing_county_is_none_not_guessed(self):
        rel = S.parse_car_release(fixture("macro_car_sept2026.html"), counties=("Santa Clara", "Alpine"))
        self.assertIsNone(rel["counties"]["Alpine"])


class TestSccaor(unittest.TestCase):
    def test_post_html(self):
        month, rec = S.parse_sccaor_post_html(fixture("macro_sccaor_sept2026_post.html"))
        self.assertEqual(month, "2026-09")
        self.assertEqual(rec, {"median_price": 1880000.0, "sales": 726.0, "avg_dom": 27.0})

    def test_post_wording_variants(self):
        # August 2026 post wording ("reached", "stood at"), verbatim prose
        html = ("<h1>Santa Clara County Housing Statistics Month of August 2026</h1><p>In August, Santa Clara County "
                "single-family residence median home price reached <strong>$1,850,000</strong> representing a -1.6% decrease "
                "year-over-year. Single-Family Residence Sales totaled <strong>624</strong> a -13.6% year-over-year change. "
                "Average Days on Market stood at <strong>25 days</strong> compared to 27 in July and 26 a year ago.</p>")
        self.assertEqual(S.parse_sccaor_post_html(html), ("2026-08", {"median_price": 1850000.0, "sales": 624.0, "avg_dom": 25.0}))

    def test_post_without_numbers_is_a_source_error(self):
        with self.assertRaises(S.SourceError):
            S.parse_sccaor_post_html("<h1>Santa Clara County Housing Statistics Month of May 2026</h1><p>Coming soon.</p>")

    def test_pdf_text_sfr_summary(self):
        month, rec = S.parse_sccaor_pdf_text(fixture("macro_sccaor_sept2026_pdf.txt"))
        self.assertEqual(month, "2026-09")
        self.assertEqual(rec, {"new_listings": 943.0, "inventory": 1224.0, "sales": 726.0, "avg_dom": 27.0,
                               "avg_price": 2428192.0, "median_price": 1880000.0})

    def test_pdf_and_post_agree(self):
        _, pdf = S.parse_sccaor_pdf_text(fixture("macro_sccaor_sept2026_pdf.txt"))
        _, post = S.parse_sccaor_post_html(fixture("macro_sccaor_sept2026_post.html"))
        for k in ("sales", "median_price", "avg_dom"):
            self.assertEqual(pdf[k], post[k], k)

    def test_pdf_text_without_sfr_section_is_a_source_error(self):
        with self.assertRaises(S.SourceError):
            S.parse_sccaor_pdf_text("September 2026 :: Santa Clara County :: Condo & Townhome\nSummary 1 2 3\n")

    def test_index_links_and_backfill_candidates(self):
        html = ('<a href="https://www.sccaor.com/wp-content/uploads/2026/10/September2026.pdf">September 2026</a>'
                '<a href="https://www.sccaor.com/wp-content/uploads/2026/10/3Q-2026.pdf">3rd Quarter</a>'
                '<a href="/pdf/stats/2021.pdf">2021</a>')
        self.assertEqual(S.sccaor_index_links(html), {"2026-09": "https://www.sccaor.com/wp-content/uploads/2026/10/September2026.pdf"})
        self.assertEqual(S.sccaor_pdf_candidates("2024-12")[0], "https://www.sccaor.com/wp-content/uploads/2025/01/December2024.pdf")


if __name__ == "__main__":
    unittest.main()
