"""Offline tests for scripts/import_radar_cinemas.py (stdlib unittest, no network, no credentials).

Run: python -m unittest discover -s scripts/tests -v
"""
import io
import json
import os
import sys
import tempfile
import unittest
import unittest.mock
import urllib.error

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import import_radar_cinemas as imp  # noqa: E402

try:
    import shapely  # noqa: F401
    HAS_SHAPELY = True
except ImportError:
    HAS_SHAPELY = False

RS = chr(30)
FAKE_URL = "https://project.supabase.test"
FAKE_KEY = "service-role-key-placeholder"


def feature(fid, name="Cinema Test", geom=None, ftype="Feature", **props):
    return {"type": ftype, "id": fid, "properties": {"name": name, **props} if name else props,
            "geometry": geom if geom is not None else {"type": "Point", "coordinates": [13.5, 43.6]}}


def seq(*features, separator=True):
    return "\n".join((RS if separator else "") + json.dumps(f) for f in features) + "\n"


class FakeResponse:
    def __init__(self, status=200, headers=None):
        self.status, self.headers = status, headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeOpener:
    def __init__(self, existing=0, upsert_status=201):
        self.requests, self.existing, self.upsert_status = [], existing, upsert_status

    def __call__(self, req, timeout=None):
        self.requests.append(req)
        if req.get_method() == "GET":
            return FakeResponse(206, {"Content-Range": f"0-0/{self.existing}" if self.existing else "*/0"})
        return FakeResponse(self.upsert_status)

    @property
    def upserts(self):
        return [json.loads(r.data) for r in self.requests if r.get_method() == "POST"]


class RowConversion(unittest.TestCase):
    def test_osmium_type_id_formats(self):
        for fid, expected in [("n123", ("node", 123)), ("w45", ("way", 45)), ("r6", ("relation", 6)),
                              ("node/7", ("node", 7)), ("way/8", ("way", 8))]:
            row, reason = imp.feature_to_row(feature(fid))
            self.assertIsNone(reason, fid)
            self.assertEqual((row["osm_type"], row["osm_id"]), expected)
        row, _ = imp.feature_to_row({**feature("9"), "type": "node"})
        self.assertEqual((row["osm_type"], row["osm_id"]), ("node", 9))

    def test_invalid_ids_are_rejected(self):
        for fid in ["", None, "x12", "n", "n12a", "point/3", "12", "node/abc"]:
            self.assertEqual(imp.feature_to_row(feature(fid)), (None, "invalid_id"), fid)

    def test_row_fields_match_the_v14_import(self):
        row, _ = imp.feature_to_row(feature("n1", name="Multisala " + "X" * 400, **{
            "addr:city": "Ancona", "addr:street": "Via Roma", "addr:housenumber": "1", "website": "https://cinema.example.it/"}))
        self.assertEqual(row, {"osm_type": "node", "osm_id": 1, "name": ("Multisala " + "X" * 400)[:300], "latitude": 43.6, "longitude": 13.5,
                               "city": "Ancona", "address": "Via Roma 1", "website": "https://cinema.example.it/", "source": "openstreetmap", "active": True})

    def test_website_fallback_and_scheme_filter(self):
        self.assertEqual(imp.feature_to_row(feature("n1", **{"contact:website": "http://c.example.it"}))[0]["website"], "http://c.example.it")
        self.assertIsNone(imp.feature_to_row(feature("n1", website="www.cinema.it"))[0]["website"])
        self.assertIsNone(imp.feature_to_row(feature("n1", website="javascript:alert(1)"))[0]["website"])

    def test_partial_address(self):
        self.assertEqual(imp.feature_to_row(feature("n1", **{"addr:street": "Corso Italia"}))[0]["address"], "Corso Italia")
        self.assertEqual(imp.feature_to_row(feature("n1", **{"addr:housenumber": "5"}))[0]["address"], "5")
        self.assertIsNone(imp.feature_to_row(feature("n1"))[0]["address"])

    def test_skip_reasons(self):
        self.assertEqual(imp.feature_to_row(feature("n1", name=None)), (None, "no_name"))
        self.assertEqual(imp.feature_to_row({**feature("n1"), "geometry": None}), (None, "no_geometry"))
        self.assertEqual(imp.feature_to_row(feature("n1", geom={"type": "Point", "coordinates": [200, 43]})), (None, "out_of_range"))
        self.assertEqual(imp.feature_to_row(feature("n1", geom={"type": "Point", "coordinates": [13, 95]})), (None, "out_of_range"))

    def test_point_coordinates_are_not_swapped(self):
        row, _ = imp.feature_to_row(feature("n1", geom={"type": "Point", "coordinates": [12.4964, 41.9028]}))
        self.assertEqual((row["longitude"], row["latitude"]), (12.4964, 41.9028))

    @unittest.skipUnless(HAS_SHAPELY, "shapely not installed (the workflow installs it)")
    def test_polygon_uses_a_point_inside(self):
        square = {"type": "Polygon", "coordinates": [[[13.0, 43.0], [13.1, 43.0], [13.1, 43.1], [13.0, 43.1], [13.0, 43.0]]]}
        row, _ = imp.feature_to_row(feature("w1", geom=square))
        self.assertTrue(13.0 <= row["longitude"] <= 13.1 and 43.0 <= row["latitude"] <= 43.1)


class Collection(unittest.TestCase):
    def test_record_separators_blank_lines_and_stats(self):
        text = seq(feature("n1", website="https://a.it"), feature("w2", **{"addr:city": "Jesi"}), feature("r3", name=None), feature("bad"))
        rows, stats = imp.collect_rows(io.StringIO(text + "\n" + RS + "\n"))
        self.assertEqual(len(rows), 2)
        self.assertEqual((stats["features"], stats["rows"], stats["skipped_no_name"], stats["skipped_invalid_id"]), (4, 2, 1, 1))
        self.assertEqual((stats["rows_node"], stats["rows_way"], stats["rows_with_website"], stats["rows_with_city"]), (1, 1, 1, 1))

    def test_without_record_separators(self):
        rows, _ = imp.collect_rows(io.StringIO(seq(feature("n1"), feature("n2"), separator=False)))
        self.assertEqual(len(rows), 2)

    def test_duplicates_are_counted(self):
        _, stats = imp.collect_rows(io.StringIO(seq(feature("n1"), feature("node/1"), feature("n2"))))
        self.assertEqual(stats["duplicate_ids"], 1)


class Validation(unittest.TestCase):
    def stats(self, **values):
        _, base = imp.collect_rows(io.StringIO(""))
        base.update(values)
        return base

    def test_empty_export_and_zero_rows_abort(self):
        self.assertEqual(len(imp.validate(self.stats())), 2)
        self.assertIn("no importable cinemas were parsed", imp.validate(self.stats(features=5)))

    def test_invalid_ids_abort_by_default_and_are_configurable(self):
        stats = self.stats(features=10, rows=9, skipped_invalid_id=1)
        self.assertTrue(imp.validate(stats))
        self.assertEqual(imp.validate(stats, max_invalid_ids=1), [])

    def test_duplicates_abort(self):
        self.assertTrue(imp.validate(self.stats(features=2, rows=2, duplicate_ids=1)))

    def test_min_count(self):
        self.assertTrue(imp.validate(self.stats(features=5, rows=5), min_count=6))
        self.assertEqual(imp.validate(self.stats(features=5, rows=5), min_count=5), [])

    def test_baseline_requires_explicit_threshold(self):
        problems = imp.validate(self.stats(features=900, rows=900), baseline=1000)
        self.assertTrue(any("--max-drop-percent" in p for p in problems))

    def test_drop_threshold(self):
        stats = self.stats(features=900, rows=900)
        self.assertEqual(imp.validate(stats, baseline=1000, max_drop_percent=10), [])
        self.assertTrue(imp.validate(stats, baseline=1000, max_drop_percent=9.9))
        self.assertTrue(imp.validate(self.stats(features=1, rows=1), baseline=1000, max_drop_percent=0))

    def test_first_import_needs_no_threshold(self):
        self.assertEqual(imp.validate(self.stats(features=3, rows=3), baseline=0), [])


class CommandLine(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def write(self, text):
        path = os.path.join(self.dir.name, "cinemas.geojsonseq")
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def run_cli(self, argv, environ=None, opener=None):
        out = io.StringIO()
        opener = opener or FakeOpener()
        summary = imp.run(argv, environ=environ if environ is not None else {}, opener=opener, out=out)
        return summary, opener, out.getvalue()

    def test_dry_run_needs_no_credentials_and_makes_no_requests(self):
        path = self.write(seq(feature("n1"), feature("n2")))
        summary_path = os.path.join(self.dir.name, "summary.json")
        summary, opener, out = self.run_cli([path, "--dry-run", "--summary-out", summary_path],
                                            environ={"SUPABASE_URL": FAKE_URL, "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY})
        self.assertEqual(opener.requests, [])
        self.assertEqual((summary["mode"], summary["rows"], summary["existing_openstreetmap_rows"]), ("dry-run", 2, None))
        self.assertIn("nothing was written", out)
        with open(summary_path, encoding="utf-8") as f:
            self.assertEqual(json.load(f)["rows"], 2)

    def test_dry_run_still_rejects_anomalies(self):
        path = self.write(seq(feature("n1"), feature("x9")))
        with self.assertRaises(imp.ImportAborted):
            self.run_cli([path, "--dry-run"])

    def test_import_without_valid_credentials_makes_no_requests(self):
        path = self.write(seq(feature("n1")))
        for env in ({}, {"SUPABASE_URL": FAKE_URL}, {"SUPABASE_URL": "http://insecure.test", "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY}):
            opener = FakeOpener()
            with self.assertRaises(imp.ImportAborted):
                self.run_cli([path], environ=env, opener=opener)
            self.assertEqual(opener.requests, [])

    def test_import_batches_of_200_with_v14_headers(self):
        path = self.write(seq(*[feature(f"n{i}") for i in range(1, 451)]))
        summary, opener, out = self.run_cli([path], environ={"SUPABASE_URL": FAKE_URL + "/", "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY})
        self.assertEqual([len(b) for b in opener.upserts], [200, 200, 50])
        post = [r for r in opener.requests if r.get_method() == "POST"][0]
        self.assertEqual(post.full_url, FAKE_URL + "/rest/v1/radar_cinemas?on_conflict=osm_type,osm_id")
        self.assertEqual(post.get_header("Prefer"), "resolution=merge-duplicates,return=minimal")
        self.assertEqual(post.get_header("Apikey"), FAKE_KEY)
        self.assertEqual(post.get_header("Authorization"), "Bearer " + FAKE_KEY)
        count = opener.requests[0]
        self.assertEqual(count.get_method(), "GET")
        self.assertIn("source=eq.openstreetmap", count.full_url)
        self.assertEqual(summary["existing_openstreetmap_rows"], 0)
        self.assertIn("Imported or updated 450 OSM cinemas", out)
        self.assertNotIn(FAKE_KEY, out)

    def test_anomalous_reimport_writes_nothing(self):
        path = self.write(seq(feature("n1"), feature("n2")))
        env = {"SUPABASE_URL": FAKE_URL, "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY}
        for argv in ([path], [path, "--max-drop-percent", "50"]):
            opener = FakeOpener(existing=1000)
            with self.assertRaises(imp.ImportAborted):
                self.run_cli(argv, environ=env, opener=opener)
            self.assertEqual(opener.upserts, [], argv)

    def test_reimport_within_threshold(self):
        path = self.write(seq(*[feature(f"n{i}") for i in range(1, 96)]))
        opener = FakeOpener(existing=100)
        summary, _, _ = self.run_cli([path, "--max-drop-percent", "5"], environ={"SUPABASE_URL": FAKE_URL, "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY}, opener=opener)
        self.assertEqual((summary["rows"], len(opener.upserts)), (95, 1))

    def test_upload_failure_propagates(self):
        path = self.write(seq(feature("n1")))

        def failing(req, timeout=None):
            if req.get_method() == "GET":
                return FakeResponse(206, {"Content-Range": "*/0"})
            raise urllib.error.HTTPError(req.full_url, 401, "Unauthorized", {}, None)
        with self.assertRaises(urllib.error.HTTPError):
            self.run_cli([path], environ={"SUPABASE_URL": FAKE_URL, "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY}, opener=failing)

    def test_unreadable_count_aborts(self):
        path = self.write(seq(feature("n1")))
        opener = lambda req, timeout=None: FakeResponse(200, {})  # noqa: E731
        with self.assertRaises(imp.ImportAborted):
            self.run_cli([path], environ={"SUPABASE_URL": FAKE_URL, "SUPABASE_SERVICE_ROLE_KEY": FAKE_KEY}, opener=opener)

    def test_threshold_arguments_are_validated(self):
        path = self.write(seq(feature("n1")))
        for bad in (["--max-drop-percent", "101"], ["--max-drop-percent", "-1"], ["--min-count", "-3"], ["--max-drop-percent", "abc"]):
            with self.assertRaises(SystemExit):
                with unittest.mock.patch("sys.stderr", io.StringIO()):
                    imp.parse_args([path, *bad])


if __name__ == "__main__":
    unittest.main()
