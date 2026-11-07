"""Market-cycle shared fetch layer: retry rules, partial sources, transform aliases.
Pure: urlopen and sleep are patched; no network."""
import contextlib, http.client, importlib.util, io, os, sys, unittest, urllib.error
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
MC = os.path.dirname(HERE)
sys.path.insert(0, MC)
import sources as S  # noqa: E402

_spec = importlib.util.spec_from_file_location("mc_collect_macro_src", os.path.join(MC, "collect-macro.py"))
collect = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collect)


class _Resp(io.BytesIO):
    def geturl(self):
        return "https://example.test/x"

    @property
    def headers(self):
        return {"Content-Type": "text/csv"}


def _truncated(*a, **k):
    raise http.client.IncompleteRead(b"partial", 10)


def _http(code):
    def f(*a, **k):
        raise urllib.error.HTTPError("https://example.test/x", code, "err", {}, io.BytesIO(b""))
    return f


class TestHttpRetry(unittest.TestCase):
    def setUp(self):
        p = mock.patch.object(S.time, "sleep")
        p.start()
        self.addCleanup(p.stop)
        S.reset_hosts()
        self.addCleanup(S.reset_hosts)

    def test_truncated_body_is_retried_and_never_used(self):
        calls = [_truncated, _truncated, lambda *a, **k: _Resp(b"observation_date,X\n")]
        with mock.patch.object(S.urllib.request, "urlopen", side_effect=lambda *a, **k: calls.pop(0)(*a, **k)):
            body, _, _ = S.http_get("https://example.test/x")
        self.assertEqual(body, b"observation_date,X\n")
        self.assertEqual(calls, [])

    def test_gives_up_when_the_host_breaker_opens(self):
        with mock.patch.object(S.urllib.request, "urlopen", side_effect=_truncated) as u:
            with self.assertRaises(S.TransportError) as cm:
                S.http_get("https://example.test/x")
        self.assertEqual(u.call_count, S.HOST_TRIP)                  # 3 failures in a row, not 5
        self.assertEqual(cm.exception.host, "example.test")

    def test_open_host_is_skipped_without_a_request_other_hosts_are_not(self):
        """FRED on Nov 7, 2026: once it stops answering, its other 28 series cost nothing."""
        with mock.patch.object(S.urllib.request, "urlopen", side_effect=_truncated):
            with self.assertRaises(S.TransportError):
                S.http_get("https://fred.test/a")
        with mock.patch.object(S.urllib.request, "urlopen", side_effect=lambda *a, **k: _Resp(b"ok")) as u:
            with self.assertRaises(S.TransportError) as cm:
                S.http_get("https://fred.test/b")
            self.assertEqual(u.call_count, 0)
            self.assertIn("not answering", str(cm.exception))
            self.assertEqual(S.http_get("https://zillow.test/c")[0], b"ok")
            S.forget_failures()                                       # second pass: one probe, and it answers
            self.assertEqual(S.http_get("https://fred.test/b")[0], b"ok")

    def test_blocked_page_is_not_a_transport_failure(self):
        with mock.patch.object(S.urllib.request, "urlopen", side_effect=_http(403)):
            for _ in range(5):
                with self.assertRaises(S.SourceError) as cm:
                    S.http_get("https://example.test/x")
                self.assertNotIsInstance(cm.exception, S.TransportError)

    def test_a_cached_transport_failure_keeps_its_type(self):
        def boom():
            raise S.TransportError("timed out", "fred.test")
        for _ in range(2):
            with self.assertRaises(S.TransportError):
                S.cached("t:x", boom)

    def test_blocked_or_missing_page_is_asked_once(self):
        for code in (403, 404, 429):
            with mock.patch.object(S.urllib.request, "urlopen", side_effect=_http(code)) as u:
                with self.assertRaises(S.SourceError) as cm:
                    S.http_get("https://example.test/x")
            self.assertEqual(u.call_count, 1, code)
            self.assertEqual(str(cm.exception), "HTTP %d" % code)

    def test_server_error_is_retried(self):
        calls = [_http(503), lambda *a, **k: _Resp(b"ok")]
        with mock.patch.object(S.urllib.request, "urlopen", side_effect=lambda *a, **k: calls.pop(0)(*a, **k)):
            self.assertEqual(S.http_get("https://example.test/x")[0], b"ok")

    def test_proxy_refusal_is_not_retried(self):
        err = urllib.error.URLError("Tunnel connection failed: 403 host is not on the allow list")
        with mock.patch.object(S.urllib.request, "urlopen", side_effect=err) as u:
            with self.assertRaises(S.SourceError):
                S.http_get("https://example.test/x")
        self.assertEqual(u.call_count, 1)

    def test_stream_broken_mid_file_is_reread_from_the_start(self):
        reads = []

        def read():
            reads.append(1)
            if len(reads) < 3:
                raise http.client.IncompleteRead(b"half a file", 100)
            return ["whole file"]
        self.assertEqual(S.stream_retry(read), ["whole file"])
        self.assertEqual(len(reads), 3)

    def test_stream_parse_error_is_not_retried(self):
        reads = []

        def read():
            reads.append(1)
            raise S.SourceError("CBSA 41940 not found")
        with self.assertRaises(S.SourceError):
            S.stream_retry(read)
        self.assertEqual(len(reads), 1)


class TestSccaorFetch(unittest.TestCase):
    """sccaor_months with every HTTP call answered from fixtures."""
    PDF = "https://www.sccaor.com/wp-content/uploads/2026/10/September2026.pdf"

    def setUp(self):
        S._cache.clear()
        self.addCleanup(S._cache.clear)
        with open(os.path.join(HERE, "fixtures", "macro_sccaor_sept2026_post.html"), encoding="utf-8") as f:
            page = f.read()
        body = page[page.index("<p>In September"):page.index("</div>")]
        self.posts = [{"link": "https://www.sccaor.com/santa-clara-county-housing-statistics-month-of-september/",
                       "title": {"rendered": "Santa Clara County Housing Statistics Month of September 2026"},
                       "content": {"rendered": body}}]
        with open(os.path.join(HERE, "fixtures", "macro_sccaor_sept2026_pdf.txt"), encoding="utf-8") as f:
            self.pdf_txt = f.read()

    def run_with(self, responses):
        def http_get(url, **k):
            r = responses.get(url)
            if isinstance(r, Exception):
                raise r
            if r is None:
                raise S.SourceError("HTTP 404")
            return r, url, ""
        with mock.patch.object(S, "http_get", side_effect=http_get), \
                mock.patch.object(S, "find_pdftotext", return_value="/bin/true"), \
                mock.patch.object(S, "pdf_text", return_value=self.pdf_txt):
            return S.sccaor_months(False)

    def test_truncated_stats_page_falls_back_to_its_json_copy_and_posts_cross_check(self):
        import json
        links = '<a href="%s">September 2026</a>' % self.PDF
        out, status = self.run_with({
            S.SCCAOR_STATS: S.SourceError("IncompleteRead: IncompleteRead(106488 bytes read)"),
            S.SCCAOR_STATS_JSON: json.dumps([{"content": {"rendered": links}}]).encode(),
            self.PDF: b"%PDF-1.7 ...",
            S.SCCAOR_POSTS: json.dumps(self.posts).encode()})
        self.assertEqual(sorted(out), ["2026-09"])
        self.assertEqual(out["2026-09"]["sales"], 726.0)
        self.assertEqual(out["2026-09"]["source_url"], self.PDF)
        self.assertIn("read via its WordPress JSON copy", status[0])
        self.assertNotIn("FAILED", " ".join(status))
        self.assertIn("posts: 2026-09 matches PDF", status)

    def test_both_copies_unreadable_is_a_source_error(self):
        with self.assertRaises(S.SourceError) as cm:
            self.run_with({S.SCCAOR_STATS: S.SourceError("HTTP 403"), S.SCCAOR_STATS_JSON: S.SourceError("HTTP 403")})
        self.assertIn("housing-stats page FAILED (HTTP 403)", str(cm.exception))


class TestReferencePeakAlias(unittest.TestCase):
    def test_both_transform_names_read_the_configured_reference_peak(self):
        cfg = S.load_config()
        ref = cfg["scored_object"]["reference_peak"]
        series = [(ref["month"] + "-31", float(ref["value"])), ("2026-01-31", ref["value"] * 1.0), ("2026-09-30", ref["value"] * 0.95)]
        for name in ("drawdown_from_2026_peak", "drawdown_from_reference_peak"):
            dial = dict(next(d for d in cfg["dials"] if d["id"] == "zhvi_scc_drawdown"), transform=name)
            with mock.patch.object(S, "zillow_county", return_value=series):
                rows, _, note, _ = S.fetch_dial(dial, cfg)
            self.assertAlmostEqual(rows[-1][1], -5.0, places=3, msg=name)
            self.assertIn("fixed reference peak %s" % ref["month"], note)


class TestSecondPass(unittest.TestCase):
    def test_failed_dial_is_asked_once_more_at_the_end_of_the_run(self):
        cfg = S.load_config()
        calls = []

        def fetch(dial, cfg, backfill=False):
            calls.append(dial["id"])
            if dial["id"] == "brent":
                raise S.SourceError("HTTP 403")                    # still blocked on the second pass
            if calls.count(dial["id"]) == 1:
                raise S.SourceError("RemoteDisconnected: Remote end closed connection without response")
            return [("2026-09-01", 3.717)], "https://fred/x", "CPIAUCSL", {}
        res = {r["dial"]["id"]: r for r in collect.run(cfg, None, only={"cpi_yoy", "brent"}, fetch=fetch)}
        self.assertEqual(res["cpi_yoy"]["status"], "OK")
        self.assertEqual(res["cpi_yoy"]["series"][0]["new"], [("2026-09-01", 3.717)])
        self.assertEqual((res["brent"]["status"], res["brent"]["reason"]), ("FAILED", "HTTP 403"))
        self.assertEqual(sorted(calls), ["brent", "brent", "cpi_yoy", "cpi_yoy"])

    def test_forget_failures_keeps_successes(self):
        S._cache.clear()
        self.addCleanup(S._cache.clear)
        S._cache.update({"a": ("ok", 1), "b": ("err", "HTTP 500")})
        S.forget_failures()
        self.assertEqual(S._cache, {"a": ("ok", 1)})


class TestPartialSource(unittest.TestCase):
    def test_partly_failed_source_keeps_its_readings_and_is_reported(self):
        cfg = S.load_config()

        def fetch(dial, cfg, backfill=False):
            return [("2026-09-01", -4.0)], "https://car/x", "index 2026 FAILED (HTTP 403) | index 2025 OK (12 sales releases)", {}
        res = collect.run(cfg, None, only={"car_scc_sfr_median"}, fetch=fetch)
        self.assertEqual(res[0]["status"], "PARTIAL")
        self.assertIn("index 2026 FAILED (HTTP 403)", res[0]["reason"])
        self.assertEqual(len(collect.new_reading_rows(res)), 1)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            collect.print_report(res, dry=True)
        self.assertIn("car_scc_sfr_median                   PARTIAL: index 2026 FAILED", out.getvalue())


if __name__ == "__main__":
    unittest.main()


class WarnDedup(unittest.TestCase):
    def test_same_notice_in_two_files_has_one_key(self):
        a = S.warn_key("2026-06-29", 67, "Cepheid")
        b = S.warn_key("2026-06-29", 67, "CEPHEID  904 Caribbean Dr  Sunnyvale")
        self.assertEqual(a, b)
        self.assertNotEqual(a, S.warn_key("2026-06-29", 20, "Cepheid"))       # different headcount = different notice


class FredApi(unittest.TestCase):
    def setUp(self):
        S._cache.clear()
        S.reset_hosts()

    def test_api_key_switches_to_the_official_api(self):
        reply = b'{"observations": [{"date": "2026-09-01", "value": "4.2"}, {"date": "2026-10-01", "value": "."}]}'
        with mock.patch.dict(os.environ, {"FRED_API_KEY": "k123"}), \
                mock.patch.object(S.urllib.request, "urlopen", side_effect=lambda req, **k: _Resp(reply)) as u:
            self.assertEqual(S.fred("UNRATE"), [("2026-09-01", 4.2)])
        self.assertIn("api.stlouisfed.org", u.call_args[0][0].full_url)
        self.assertIn("api_key=k123", u.call_args[0][0].full_url)

    def test_no_key_keeps_the_csv_download(self):
        with mock.patch.object(S, "fred_api_key", return_value=None), \
                mock.patch.object(S.urllib.request, "urlopen", side_effect=lambda req, **k: _Resp(b"observation_date,UNRATE\n2026-09-01,4.2\n")) as u:
            self.assertEqual(S.fred("UNRATE"), [("2026-09-01", 4.2)])
        self.assertIn("fredgraph.csv", u.call_args[0][0].full_url)
