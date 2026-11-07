"""Market-cycle registry + write paths: corridor merge rule, sync-registry, bootstrap
--write and collect-macro --write against a local fake PostgREST (never Supabase)."""
import contextlib, datetime as dt, importlib.util, io, json, os, sys, unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
MC = os.path.dirname(HERE)
sys.path.insert(0, MC)
sys.path.insert(0, HERE)
import sources as S  # noqa: E402
from macro_fake_postgrest import FakePostgrest  # noqa: E402


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, os.path.join(MC, file))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


sync = load("mc_sync_registry", "sync-registry.py")
collect = load("mc_collect_macro", "collect-macro.py")
boot = load("mc_bootstrap_history", "bootstrap-history.py")


def quiet(fn, *a, **k):
    with contextlib.redirect_stdout(io.StringIO()):
        return fn(*a, **k)


class TestCorridorMerge(unittest.TestCase):
    def test_authored_keys_survive_and_computed_is_added(self):
        authored = {"bull_at_or_below": 2.8, "bear_at_or_above": 4.0}
        computed = {"rule": "corridor", "bear_at_or_above": 99.0, "stats_2021_2025": {"max": 8.9}}
        out = S.merge_corridor(authored, computed)
        self.assertEqual(out["bear_at_or_above"], 4.0)
        self.assertEqual(out["bull_at_or_below"], 2.8)
        self.assertEqual(out["computed"], computed)

    def test_existing_computed_kept_when_no_new_one(self):
        out = S.merge_corridor({"bear_at_or_above": 3.0}, None, existing={"bear_at_or_above": 9.9, "computed": {"n": 5}, "stale": 1})
        self.assertEqual(out, {"computed": {"n": 5}, "bear_at_or_above": 3.0})        # authored wins, stale DB key dropped

    def test_new_computed_replaces_old_computed(self):
        self.assertEqual(S.merge_corridor(None, {"n": 2}, existing={"computed": {"n": 1}}), {"computed": {"n": 2}})

    def test_no_corridor_at_all_is_null(self):
        self.assertIsNone(S.merge_corridor(None, None, None))

    def test_authoring_the_reserved_key_is_refused(self):
        with self.assertRaises(ValueError):
            S.merge_corridor({"computed": {}}, None)

    def test_every_config_dial_merges_cleanly(self):
        for d in S.load_config()["dials"]:
            row = S.dial_row(d, {"x": 1})
            self.assertNotIn("fetch", row)
            self.assertEqual(row["fetch_method"], d["fetch"])
            for k, v in (d.get("corridor") or {}).items():
                self.assertEqual(row["corridor"][k], v, d["id"])


class FakeDbCase(unittest.TestCase):
    def setUp(self):
        self.fake = FakePostgrest()
        self.env = mock.patch.dict(os.environ, {"LRG_SUPABASE_URL": self.fake.url, "LRG_SUPABASE_SERVICE_KEY": "test-key"})
        self.env.start()
        self.cfg = S.load_config()

    def tearDown(self):
        self.env.stop()
        self.fake.close()


class TestSyncRegistry(FakeDbCase):
    def test_dry_run_counts(self):
        p = sync.plan(self.cfg)
        self.assertEqual(len(p["claims"]), 36)
        self.assertEqual(len(p["dials"]), len(self.cfg["dials"]))
        self.assertEqual(len(p["calendar"]), len(self.cfg["calendar"]))
        self.assertNotIn("diff", p)

    def test_write_is_idempotent_and_keeps_db_owned_fields(self):
        quiet(sync.main, ["--write"])
        t = self.fake.tables
        self.assertEqual(len(t["cycle_dials"]), len(self.cfg["dials"]))
        self.assertEqual(len(t["cycle_claims"]), 36)
        self.assertEqual(len(t["cycle_thesis_versions"]), 1)
        self.assertEqual(len(t["cycle_calendar"]), len(self.cfg["calendar"]))
        cpi = next(r for r in t["cycle_dials"] if r["id"] == "cpi_yoy")
        self.assertEqual(cpi["fetch_method"], "fred_csv")
        # the DB moves on: a checkpoint re-probabilises C5, bootstrap adds computed stats
        c5 = next(r for r in t["cycle_claims"] if r["id"] == "C5")
        c5["prob_current"] = 80
        cpi["corridor"] = dict(cpi["corridor"], computed={"stats_2021_2025": {"max": 8.979}})
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            sync.main(["--live"])
        self.assertIn("claims    new 0, changed 0, unchanged 36", out.getvalue())
        self.assertIn("dials     new 0, changed 0", out.getvalue())
        quiet(sync.main, ["--write"])
        self.assertEqual(len(t["cycle_calendar"]), len(self.cfg["calendar"]))          # no duplicate calendar rows
        self.assertEqual(next(r for r in t["cycle_claims"] if r["id"] == "C5")["prob_current"], 80)
        cpi = next(r for r in t["cycle_dials"] if r["id"] == "cpi_yoy")
        self.assertEqual(cpi["corridor"]["computed"], {"stats_2021_2025": {"max": 8.979}})
        self.assertEqual(cpi["corridor"]["bear_at_or_above"], 4.0)

    def test_changed_claim_text_is_patched(self):
        quiet(sync.main, ["--write"])
        c1 = next(r for r in self.fake.tables["cycle_claims"] if r["id"] == "C1")
        c1["text"] = "old wording"
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            sync.main(["--write"])
        self.assertIn("~ C1: text", out.getvalue())
        self.assertEqual(c1["text"], self.cfg["claims"][0]["text"])


class TestBootstrapWrite(FakeDbCase):
    def test_write_puts_computed_stats_under_corridor_computed(self):
        rows = [("2026-08-01", 3.353), ("2026-09-01", 3.717)]
        results = {"cpi_yoy": {"status": "OK", "rows": rows, "source_url": "https://fred/x", "note": "CPIAUCSL", "extras": {},
                               "variants": []},
                   "ust10y": {"status": "OK", "rows": rows, "source_url": "https://fred/y", "note": "DGS10", "extras": {},
                              "variants": S.corridor_variants(next(d for d in self.cfg["dials"] if d["id"] == "ust10y"), rows)}}
        computed = {"cpi_yoy": {"rule": "corridor", "bear_at_or_above": 123.0, "stats_2021_2025": {"max": 8.979}}}
        quiet(boot.write_all, self.cfg, results, computed)
        cpi = next(r for r in self.fake.tables["cycle_dials"] if r["id"] == "cpi_yoy")
        self.assertEqual(cpi["corridor"]["bear_at_or_above"], 4.0)                 # authored survives
        self.assertEqual(cpi["corridor"]["computed"]["bear_at_or_above"], 123.0)   # computed kept apart
        readings = self.fake.tables["cycle_readings"]
        self.assertEqual(sorted({(r["dial_id"], r["variant"]) for r in readings}), [("cpi_yoy", ""), ("ust10y", "")])  # 2 rows: no 10d_avg yet

    def test_write_refuses_without_the_variant_column(self):
        self.fake.tables.pop("cycle_notes")
        orig = self.fake.handle

        def no_variant(method, table, params, body, prefer):
            if table == "cycle_readings" and ("select", "variant") in params:
                raise KeyError("variant")
            return orig(method, table, params, body, prefer)
        self.fake.handle = no_variant
        with self.assertRaises(SystemExit) as cm:
            quiet(boot.write_all, self.cfg, {}, {})
        self.assertEqual(cm.exception.code, 2)


class TestCollectWrite(FakeDbCase):
    def fake_fetch(self, series):
        def fetch(dial, cfg, backfill=False):
            if dial["id"] not in series:
                raise S.SourceError("blocked (test)")
            return series[dial["id"]], "https://src/" + dial["id"], "note", {}
        return fetch

    def test_only_newer_readings_and_one_release_note(self):
        quiet(sync.main, ["--write"])
        db = collect.Db(self.fake.url, "k")
        self.fake.tables["cycle_readings"] += [
            {"id": 1, "dial_id": "cpi_yoy", "variant": "", "as_of": "2026-08-01", "value": 3.353, "source_url": "https://src/cpi_yoy"},
            {"id": 2, "dial_id": "ust10y", "variant": "", "as_of": "2026-10-28", "value": 5.05, "source_url": "https://src/ust10y"}]
        series = {"cpi_yoy": [("2026-07-01", 3.304), ("2026-08-01", 3.353), ("2026-09-01", 3.717)],
                  "ust10y": [("2026-10-%02d" % i, 5.0 + i / 100) for i in range(15, 30)]}
        res = collect.run(self.cfg, db, only={"cpi_yoy", "ust10y", "brent"}, fetch=self.fake_fetch(series))
        by = {r["dial"]["id"]: r for r in res}
        self.assertEqual(by["brent"]["status"], "FAILED")
        self.assertEqual(by["cpi_yoy"]["series"][0]["new"], [("2026-09-01", 3.717)])
        self.assertEqual([d for d, _ in by["ust10y"]["series"][0]["new"]], ["2026-10-29"])
        self.assertEqual(by["ust10y"]["series"][1]["variant"], "10d_avg")
        self.assertEqual(len(by["ust10y"]["series"][1]["new"]), 6)                  # nothing stored for the variant yet
        self.assertEqual(by["cpi_yoy"]["note_row"]["text"], "US CPI, all items, YoY printed 3.717 % YoY (2026-09) vs prior 3.353 (2026-08)")
        rows = collect.new_reading_rows(res)
        db.upsert_readings(rows)
        self.assertEqual(db.insert_notes([by["cpi_yoy"]["note_row"]]), 1)
        self.assertEqual(db.insert_notes([by["cpi_yoy"]["note_row"]]), 0)            # unique (dial_id, text)
        db.mark_fired("cpi_yoy", "2026-11-10")
        cal = [r for r in self.fake.tables["cycle_calendar"] if r["dial_id"] == "cpi_yoy"]
        self.assertTrue(any(r["fired_at"] for r in cal if r["date"] <= "2026-11-10"))
        self.assertTrue(all(r["fired_at"] is None for r in cal if r["date"] > "2026-11-10"))
        # second run: nothing new
        res2 = collect.run(self.cfg, db, only={"cpi_yoy", "ust10y"}, fetch=self.fake_fetch(series))
        self.assertEqual(sum(len(s["new"]) for r in res2 for s in r["series"]), 0)
        self.assertTrue(all(r["note_row"] is None for r in res2))

    def test_revised_recent_months_are_rewritten_not_ignored(self):
        """EDD posts WARN notices days late: Oct 2026 was stored as 463 and the file
        now says 569. The month must be rewritten; months outside the window and
        unchanged months are left alone."""
        quiet(sync.main, ["--write"])
        db = collect.Db(self.fake.url, "k")
        url = "https://src/scc_warn_workers"
        self.fake.tables["cycle_readings"] += [
            {"id": 10 + i, "dial_id": "scc_warn_workers", "variant": "", "as_of": d, "value": v, "source_url": url}
            for i, (d, v) in enumerate([("2026-07-01", 735), ("2026-08-01", 1138), ("2026-09-01", 400), ("2026-10-01", 463), ("2026-11-01", 108)])]
        fetched = [("2026-07-01", 999), ("2026-08-01", 1138), ("2026-09-01", 400), ("2026-10-01", 569), ("2026-11-01", 182)]
        res = collect.run(self.cfg, db, only={"scc_warn_workers"}, fetch=self.fake_fetch({"scc_warn_workers": fetched}))
        s = res[0]["series"][0]
        self.assertEqual(s["new"], [])
        self.assertEqual(s["revised"], [("2026-10-01", 463, 569), ("2026-11-01", 108, 182)])   # Jul is outside the 3-month window
        db.upsert_readings(collect.new_reading_rows(res))
        stored = {r["as_of"]: r["value"] for r in self.fake.tables["cycle_readings"] if r["dial_id"] == "scc_warn_workers"}
        self.assertEqual(stored["2026-10-01"], 569)
        self.assertEqual(stored["2026-11-01"], 182)
        self.assertEqual(stored["2026-07-01"], 735)
        res2 = collect.run(self.cfg, db, only={"scc_warn_workers"}, fetch=self.fake_fetch({"scc_warn_workers": fetched}))
        self.assertEqual(res2[0]["series"][0]["revised"], [])

    def test_dial_missing_from_registry_is_skipped(self):
        db = collect.Db(self.fake.url, "k")
        res = collect.run(self.cfg, db, only={"cpi_yoy"}, fetch=self.fake_fetch({"cpi_yoy": [("2026-09-01", 1.0)]}))
        self.assertEqual(res[0]["status"], "SKIPPED")

    def test_site_outage_is_quiet_until_the_next_morning_then_alerts_once(self):
        """Nov 7, 2026: FRED down 06:30-10:09 → 32-line alert. Now: deferred + hourly
        retries, silent the same day; one plain line only if still down next morning."""
        import tempfile
        quiet(sync.main, ["--write"])
        tmp = tempfile.mkdtemp()
        state = {"down": True}

        def fetch(dial, cfg, backfill=False):
            if dial["id"] == "cpi_yoy" and state["down"]:
                raise S.TransportError("TimeoutError: The read operation timed out", "fred.stlouisfed.org")
            if dial["id"] == "brent":
                raise S.SourceError("HTTP 404")
            return [("2026-09-01", 3.7)], "https://src/" + dial["id"], "note", {}

        def run(argv, today):
            out = io.StringIO()
            with mock.patch.object(collect, "STATE_DIR", tmp), mock.patch.object(S, "fetch_dial", fetch), \
                    mock.patch.object(S, "TODAY", today), contextlib.redirect_stdout(out):
                collect.main(argv)
            return out.getvalue()
        d1, d2 = dt.date(2026, 11, 7), dt.date(2026, 11, 8)
        out = run(["--write", "--only", "cpi_yoy,brent"], d1)
        self.assertIn("DEFERRED", out)
        self.assertNotIn("hasn't answered", out)
        self.assertIn("data source broken", out)                       # the 404 still alerts the same day
        self.assertIn("cpi_yoy", json.load(open(os.path.join(tmp, "macro-pending.json")))["dials"])
        out = run(["--write", "--retry-pending"], d1)                   # hourly: still down, silent
        self.assertNotIn("ALERT", out)
        out = run(["--write", "--only", "cpi_yoy"], d2)                  # next morning: one line
        self.assertIn("ALERT: Market tracker: fred.stlouisfed.org hasn't answered since Nov 7, 2026", out)
        self.assertIn("1 reading missing", out)
        out = run(["--write", "--only", "cpi_yoy"], d2)                  # not repeated
        self.assertNotIn("ALERT", out)
        state["down"] = False
        out = run(["--write", "--retry-pending"], d2)                   # back: fills in, state cleared
        self.assertIn("PENDING (site outages being retried hourly): 0", out)
        self.assertFalse(os.path.exists(os.path.join(tmp, "macro-pending.json")))
        self.assertIn("nothing pending", run(["--write", "--retry-pending"], d2))

    def test_main_write_end_to_end_without_alerting(self):
        quiet(sync.main, ["--write"])
        series = {"payrolls_mom": [("2026-08-01", 133.0), ("2026-09-01", 29.0)]}
        with mock.patch.object(S, "fetch_dial", self.fake_fetch(series)), mock.patch.object(collect.S, "telegram_alert") as alert:
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                collect.main(["--write", "--only", "payrolls_mom,brent"])
        self.assertIn("WROTE 2 readings, 1 new release notes", out.getvalue())
        alert.assert_not_called()                                                     # fake server is http://, never alerts
        note = self.fake.tables["cycle_notes"][0]
        self.assertEqual(note["dial_id"], "payrolls_mom")
        self.assertIsNone(note["surfaced_at"])
        self.assertEqual(json.loads(self.fake.tables["cycle_readings"][0]["raw"])["value"], 133.0)


if __name__ == "__main__":
    unittest.main()
