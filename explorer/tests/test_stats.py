"""Tests for fee statistics, snapshot aggregates, long history, and prices."""

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from explorer.app import create_app
from explorer.config import Settings
from explorer.fees import far_out_bounds, filter_outliers, summarize
from explorer.refresh import (
    _history_all_rows,
    daily_prices,
    refresh_history,
    refresh_prices,
    refresh_once,
)
from explorer.rgs import ParsedChannel, ParsedGraph, ParsedNode, Policy
from explorer.sources import SourceError
from explorer.store import SNAPSHOT_AGGREGATE_COLUMNS, Store, _downsample

PUB_A = "02" + "11" * 32
PUB_D = "03" + "44" * 32
JUNK_PPM = 2147483647
NOW = 1_790_000_000


def peer_key(index: int) -> str:
    return "02" + f"{index:064x}"


def aggregate_graph() -> ParsedGraph:
    """40 normal one-policy channels, 2 placeholder-fee channels, 1 dead pair."""
    nodes = {PUB_A: ParsedNode(pubkey=PUB_A), PUB_D: ParsedNode(pubkey=PUB_D)}
    channels: dict[int, ParsedChannel] = {}
    for index in range(40):
        scid = 1000 + index
        channels[scid] = ParsedChannel(
            scid=scid,
            node1=PUB_A,
            node2=peer_key(index),
            capacity=1_000_000 + index * 1000,
            policy1=Policy(index * 100, 10 + index * 5, 40, 1, 1, False),
            policy2=None,
        )
    for scid in (2000, 2001):
        channels[scid] = ParsedChannel(
            scid=scid,
            node1=PUB_A,
            node2=peer_key(scid),
            capacity=None,
            policy1=Policy(1, JUNK_PPM, 40, 1, 1, False),
            policy2=None,
        )
    channels[3000] = ParsedChannel(
        scid=3000,
        node1=PUB_A,
        node2=PUB_D,
        capacity=500_000,
        policy1=Policy(5, 5, 40, 1, 1, True),
        policy2=Policy(5, 5, 40, 1, 1, True),
    )
    return ParsedGraph(
        version=1, chain_hash=b"", timestamp=1_700_000_000, nodes=nodes, channels=channels
    )


def expected_capweighted() -> float:
    total = sum((10 + index * 5) * (1_000_000 + index * 1000) for index in range(40))
    weights = sum(1_000_000 + index * 1000 for index in range(40))
    return total / weights


class FeesTest(unittest.TestCase):
    def test_far_out_fences_drop_placeholder_fees(self):
        values = [10.0 + 5 * index for index in range(40)] + [float(JUNK_PPM)] * 2
        low, high = far_out_bounds(values)
        self.assertLess(high, JUNK_PPM)
        kept = [value for value, _weight in filter_outliers(values)]
        self.assertEqual(len(kept), 40)
        summary = summarize(values)
        self.assertEqual(summary["count"], 42)
        self.assertGreater(summary["mean"], 1_000_000)
        self.assertAlmostEqual(summary["mean_filtered"], 107.5)
        self.assertLess(summary["p90"], 500)

    def test_small_samples_pass_through(self):
        self.assertIsNone(far_out_bounds([1.0, 2.0, 3.0]))
        summary = summarize([1.0, JUNK_PPM])
        self.assertAlmostEqual(summary["mean_filtered"], (1 + JUNK_PPM) / 2)

    def test_capacity_weighted_mean(self):
        summary = summarize([10.0, 20.0, 30.0, 40.0], [1.0, 1.0, 2.0, 1.0])
        self.assertAlmostEqual(summary["mean_capweighted"], 26.0)
        self.assertAlmostEqual(summary["mean"], 25.0)

    def test_capacity_weighted_mean_filters_first(self):
        values = [float(value) for value in (10, 20, 30, 40, 50, 60, 70, 80)] + [float(JUNK_PPM)]
        weights = [1.0] * 8 + [1_000_000.0]
        summary = summarize(values, weights)
        self.assertAlmostEqual(summary["mean_capweighted"], 45.0)
        self.assertAlmostEqual(summary["mean_filtered"], 45.0)

    def test_empty_input(self):
        summary = summarize([])
        self.assertEqual(summary["count"], 0)
        for key in ("min", "max", "mean", "median", "std", "p90", "mean_filtered", "mean_capweighted"):
            self.assertIsNone(summary[key], key)
        self.assertIsNone(summarize([], [])[ "mean_capweighted"])


class SnapshotAggregatesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "explorer.sqlite"))
        self.store.open()
        self.store.install_graph(aggregate_graph(), "test", "fixture")
        with mock.patch("explorer.store.time.time", return_value=NOW):
            self.row = self.store.record_local_snapshot()

    def tearDown(self):
        self.tmp.cleanup()

    def test_row_has_every_aggregate_column(self):
        for column in SNAPSHOT_AGGREGATE_COLUMNS:
            self.assertIn(column, self.row, column)
        connection = sqlite3.connect(self.store.db_path)
        connection.row_factory = sqlite3.Row
        try:
            stored = dict(
                connection.execute("SELECT * FROM snapshots ORDER BY ts DESC LIMIT 1").fetchone()
            )
        finally:
            connection.close()
        self.assertEqual(stored["ts"], NOW)
        for column in SNAPSHOT_AGGREGATE_COLUMNS:
            self.assertIn(column, stored, column)

    def test_channel_and_fee_aggregates(self):
        self.assertEqual(self.row["channel_count"], 43)
        self.assertEqual(self.row["enabled_channels"], 42)
        self.assertEqual(self.row["disabled_channels"], 1)
        self.assertEqual(self.row["capacity_known_channels"], 41)
        self.assertEqual(self.row["gossip_capacity"], 40_000_000 + sum(range(40)) * 1000 + 500_000)
        self.assertEqual(self.row["fee_rate_count"], 42)
        self.assertEqual(self.row["base_fee_count"], 42)
        # The raw mean is dominated by the two placeholder rates.
        self.assertGreater(self.row["fee_rate_mean"], 1_000_000)
        # The filtered mean drops them again.
        self.assertAlmostEqual(self.row["fee_rate_mean_filtered"], 107.5)
        self.assertAlmostEqual(self.row["fee_rate_mean_capweighted"], expected_capweighted())
        self.assertEqual(self.row["fee_rate_min"], 10)
        self.assertEqual(self.row["fee_rate_max"], JUNK_PPM)
        self.assertEqual(self.row["base_fee_min"], 0)
        self.assertEqual(self.row["base_fee_max"], 3900)
        self.assertAlmostEqual(self.row["med_channel_capacity"], 1_019_000)

    def test_prune_keeps_three_years(self):
        connection = sqlite3.connect(self.store.db_path)
        try:
            connection.execute(
                "INSERT INTO snapshots (ts, node_count) VALUES (?, 1)",
                (NOW - int(3.5 * 365.25 * 86400),),
            )
            connection.commit()
        finally:
            connection.close()
        with mock.patch("explorer.store.time.time", return_value=NOW + 10):
            self.store.record_local_snapshot()
        self.assertTrue(all(row["ts"] > NOW - int(3 * 365.25 * 86400) for row in self.store.local_snapshots))


class HistoryMergeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "explorer.sqlite"))
        self.store.open()
        self.store.record_external_history(
            [
                {"ts": 100, "node_count": 10, "channel_count": 20, "total_capacity": 30},
                {"ts": 200, "node_count": 11, "channel_count": 21, "total_capacity": 31},
                {"ts": 300, "node_count": 12, "channel_count": 22, "total_capacity": 32,
                 "med_fee_rate": 4.0, "med_base_fee": 5.0},
            ]
        )
        connection = self.store._conn
        connection.executemany(
            "INSERT INTO snapshots (ts, node_count, channel_count, total_capacity) VALUES (?, ?, ?, ?)",
            [(150, 1, 1, 1), (350, 2, 2, 2), (400, 3, 3, 3)],
        )
        connection.commit()
        self.store._load()

    def tearDown(self):
        self.tmp.cleanup()

    def test_local_points_continue_after_external_until(self):
        payload = self.store.history_payload("all")
        stamps = [(point["ts"], point["source"]) for point in payload["points"]]
        self.assertEqual(
            stamps,
            # Local rows inside mempool's span are left out: one source per date.
            [(100, "mempool"), (200, "mempool"), (300, "mempool"),
             (350, "local"), (400, "local")],
        )
        self.assertEqual(payload["external_until"], 300)
        self.assertEqual(payload["local_since"], 150)
        self.assertTrue(payload["external_stale"])
        self.assertIn("methodology difference", payload["notes"])

    def test_fresh_series_is_not_stale(self):
        fresh = int(__import__("time").time()) - 3600
        self.store.record_external_history([{"ts": fresh, "node_count": 1, "channel_count": 1}])
        payload = self.store.history_payload("all")
        self.assertFalse(payload["external_stale"])
        self.assertEqual(payload["points"][-1]["ts"], fresh)

    def test_prices_fill_usd_columns(self):
        self.store.record_prices({0: (50_000.0, 45_000.0)})
        later = 5 * 86400 + 100
        connection = self.store._conn
        connection.execute(
            "INSERT INTO snapshots (ts, node_count, channel_count, total_capacity) VALUES (?, 4, 4, 4)",
            (later,),
        )
        connection.commit()
        self.store._load()
        payload = self.store.history_payload("all")
        point = next(item for item in payload["points"] if item["ts"] == 350)
        self.assertEqual(point["usd_price"], 50_000.0)
        self.assertAlmostEqual(point["capacity_usd"], 2 / 1e8 * 50_000.0)
        far = next(item for item in payload["points"] if item["ts"] == later)
        self.assertIsNone(far["usd_price"])
        self.assertIsNone(far["capacity_usd"])

    def test_range_and_downsampling_keep_first_local_point(self):
        base = 1_500_000_000
        connection = self.store._conn
        connection.execute("DELETE FROM history_external")
        connection.execute("DELETE FROM snapshots")
        self.store.record_external_history(
            [{"ts": base + index * 86400, "node_count": index, "channel_count": index} for index in range(1200)]
        )
        last = base + 1200 * 86400
        connection.executemany(
            "INSERT INTO snapshots (ts, node_count, channel_count, total_capacity) VALUES (?, ?, ?, ?)",
            [(last + 60, 7, 7, 7), (last + 120, 8, 8, 8), (last + 180, 9, 9, 9)],
        )
        connection.commit()
        self.store._load()
        payload = self.store.history_payload("all")
        self.assertLessEqual(len(payload["points"]), 1000)
        # Buckets keep their last point, so the series stays ordered and dense.
        stamps = [point["ts"] for point in payload["points"]]
        self.assertEqual(stamps, sorted(stamps))
        self.assertLess(stamps[0], base + 2 * 86400)
        self.assertEqual(stamps[-1], last + 180)
        first_local = next(point for point in payload["points"] if point["source"] == "local")
        self.assertEqual(first_local["ts"], last + 60)
        one_year = self.store.history_payload("1y")
        cutoff = __import__("time").time() - 365 * 86400
        self.assertTrue(all(point["ts"] >= cutoff for point in one_year["points"]))


    def test_downsample_of_local_only_series(self):
        base = 1_600_000_000
        points = [{"ts": base + index * 3600, "source": "local"} for index in range(1500)]
        kept = _downsample(points, 1000)
        self.assertLessEqual(len(kept), 1000)
        self.assertEqual(kept[0]["ts"], base)
        self.assertEqual(kept[-1]["ts"], base + 1499 * 3600)
        stamps = [point["ts"] for point in kept]
        self.assertEqual(stamps, sorted(stamps))


class MempoolParsingTest(unittest.TestCase):
    def test_statistics_all_computes_node_count(self):
        payload = [
            {"added": 200, "channel_count": 2, "total_capacity": 3, "tor_nodes": 1,
             "clearnet_nodes": 2, "unannounced_nodes": 3, "clearnet_tor_nodes": 4},
            {"added": 100, "channel_count": 1, "total_capacity": 1, "tor_nodes": 1,
             "clearnet_nodes": 2, "unannounced_nodes": 3, "clearnet_tor_nodes": 0},
        ]
        rows = _history_all_rows(payload)
        self.assertEqual([row["ts"] for row in rows], [100, 200])
        self.assertEqual([row["node_count"] for row in rows], [6, 10])
        self.assertEqual(rows[0]["channel_count"], 1)

    def test_backends_with_different_gaps_are_unioned(self):
        responses = iter([
            [{"added": 100, "channel_count": 1, "total_capacity": 1}],
            [{"added": 300, "channel_count": 3, "total_capacity": 3}],
            [],
        ])

        class Backends(FakeMempool):
            def statistics_all(self):
                return next(responses)

            def statistics(self, interval="latest"):
                return [{"added": 200, "channel_count": 2, "total_capacity": 2}]

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = Store(str(Path(tmp.name) / "explorer.sqlite"))
        store.open()
        refresh_history(store, Backends())
        self.assertEqual([row["ts"] for row in store.external_history], [100, 200, 300])
        self.assertEqual(store.external_until(), 300)

    def test_daily_price_downsampling(self):
        day = 86400 * 100
        payload = {
            "prices": [
                {"time": day + 3600, "USD": 10, "EUR": -1},
                {"time": day + 7200, "USD": 12, "EUR": 11},
                {"time": day + 10800, "USD": 13, "EUR": -1},
                {"time": 86400 * 101 + 3600, "USD": -1, "EUR": -1},
            ]
        }
        daily = daily_prices(payload)
        self.assertEqual(daily, {day: (13.0, 11.0)})


class LegacyHistoryMigrationTest(unittest.TestCase):
    def test_meta_blob_imported_once(self):
        self.tmp = tempfile.TemporaryDirectory()
        try:
            path = str(Path(self.tmp.name) / "explorer.sqlite")
            store = Store(path)
            store.open()
            legacy = [
                {"ts": 5, "node_count": 1, "channel_count": 2, "total_capacity": 3,
                 "med_fee_rate": 4, "med_base_fee": 5, "source": "mempool"}
            ]
            store._conn.execute(
                "INSERT INTO meta (key, value) VALUES ('history_external', ?)",
                (json.dumps(legacy),),
            )
            store._conn.commit()
            reopened = Store(path)
            reopened.open()
            self.assertEqual(len(reopened.external_history), 1)
            self.assertEqual(reopened.external_history[0]["node_count"], 1)
            self.assertEqual(reopened.external_history[0]["med_fee_rate"], 4)
            self.assertEqual(
                reopened._conn.execute(
                    "SELECT COUNT(*) FROM meta WHERE key = 'history_external'"
                ).fetchone()[0],
                0,
            )
        finally:
            self.tmp.cleanup()


class StatsApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.settings = Settings(
            data_dir=self.tmp.name,
            mempool_api="",
            disable_refresh=True,
            web_dir=str(Path(__file__).resolve().parents[2] / "web"),
            refresh_seconds=0,
        )
        self.store = Store(str(Path(self.tmp.name) / "explorer.sqlite"))
        self.store.open()
        self.store.install_graph(aggregate_graph(), "test", "fixture")
        with mock.patch("explorer.store.time.time", return_value=NOW):
            self.store.record_local_snapshot()
        self.client = create_app(
            self.settings, store=self.store, start_background=False
        ).test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_history_snapshots_prices_with_mempool_disabled(self):
        for path in ("/api/history", "/api/history?range=1y", "/api/snapshots", "/api/prices"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
        history = self.client.get("/api/history").get_json()
        self.assertEqual(history["external_until"], None)
        self.assertFalse(history["external_stale"])
        self.assertEqual(history["local_since"], NOW)
        self.assertEqual(history["currency_rates"], {})
        self.assertTrue(history["notes"])
        self.assertEqual(len(history["points"]), 1)
        self.assertEqual(history["points"][0]["source"], "local")
        self.assertEqual(history["points"][0]["node_count"], 44)

        snapshots = self.client.get("/api/snapshots?limit=5").get_json()["snapshots"]
        self.assertEqual(len(snapshots), 1)
        self.assertEqual(snapshots[0]["ts"], NOW)
        self.assertAlmostEqual(snapshots[0]["fee_rate_mean_filtered"], 107.5)

        prices = self.client.get("/api/prices").get_json()
        self.assertEqual(prices, {"current": {}, "latest_daily": None})

    def test_stats_fees_block(self):
        body = self.client.get("/api/stats").get_json()
        self.assertEqual(body["fees"]["rate"]["count"], 42)
        self.assertEqual(body["fees"]["enabled_channels"], 42)
        self.assertEqual(body["fees"]["disabled_channels"], 1)
        self.assertAlmostEqual(body["average_fee_rate_ppm"], 107.5)
        self.assertGreater(body["raw_average_fee_rate_ppm"], 1_000_000)
        self.assertAlmostEqual(body["raw_average_fee_rate_ppm"], body["fees"]["rate"]["mean"])
        self.assertAlmostEqual(body["average_fee_rate_ppm"], body["fees"]["rate"]["mean_filtered"])
        self.assertAlmostEqual(
            body["fees"]["rate"]["mean_capweighted"], expected_capweighted()
        )

    def test_empty_store_endpoints_do_not_crash(self):
        empty_tmp = tempfile.TemporaryDirectory()
        try:
            store = Store(str(Path(empty_tmp.name) / "explorer.sqlite"))
            store.open()
            client = create_app(
                self.settings, store=store, start_background=False
            ).test_client()
            for path in ("/api/history", "/api/snapshots", "/api/prices", "/api/stats"):
                response = client.get(path)
                self.assertEqual(response.status_code, 200, path)
            history = client.get("/api/history").get_json()
            self.assertEqual(history["points"], [])
            self.assertEqual(client.get("/api/snapshots").get_json()["snapshots"], [])
        finally:
            empty_tmp.cleanup()


class FakeMempool:
    """Stands in for the Mempool client; never touches the network."""

    enabled = True

    def __init__(self, fail=None):
        self.calls = []
        self.fail = fail or set()

    def statistics_all(self):
        self.calls.append("statistics_all")
        if "statistics_all" in self.fail:
            raise SourceError("HTTP 429 from statistics/all", status=429)
        return [
            {"added": 200, "channel_count": 2, "total_capacity": 3, "tor_nodes": 1,
             "clearnet_nodes": 2, "unannounced_nodes": 3, "clearnet_tor_nodes": 4},
            {"added": 100, "channel_count": 1, "total_capacity": 1, "tor_nodes": 1,
             "clearnet_nodes": 2, "unannounced_nodes": 3, "clearnet_tor_nodes": 0},
        ]

    def statistics(self, interval="latest"):
        self.calls.append(f"statistics:{interval}")
        if "statistics" in self.fail:
            raise SourceError("HTTP 500 from statistics", status=500)
        return [{"added": 200, "med_fee_rate": 9, "med_base_fee_mtokens": 8, "avg_fee_rate": 7}]

    def prices(self):
        self.calls.append("prices")
        if "prices" in self.fail:
            raise SourceError("HTTP 500 from prices", status=500)
        return {"time": 123, "USD": 60_000, "EUR": 55_000, "GBP": 47_000}

    def historical_prices(self):
        self.calls.append("historical_prices")
        if "historical_prices" in self.fail:
            raise SourceError("HTTP 429 from historical-price", status=429)
        day = 86400 * 100
        return {"prices": [{"time": day + 3600, "USD": 10, "EUR": -1}, {"time": day + 7200, "USD": 12, "EUR": 11}]}


class RefreshHistoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "explorer.sqlite"))
        self.store.open()

    def tearDown(self):
        self.tmp.cleanup()

    def test_history_and_prices_fetched_once_per_day(self):
        mempool = FakeMempool()
        refresh_history(self.store, mempool)
        refresh_prices(self.store, mempool)
        self.assertIn("statistics_all", mempool.calls)
        self.assertIn("historical_prices", mempool.calls)
        rows = self.store.external_history
        self.assertEqual([row["ts"] for row in rows], [100, 200])
        self.assertEqual([row["node_count"] for row in rows], [6, 10])
        self.assertEqual(self.store.current_prices["USD"], 60_000)
        self.assertEqual(self.store.daily_prices, {86400 * 100: (12.0, 11.0)})
        # A second run inside 24h fetches nothing new except current prices.
        mempool.calls.clear()
        refresh_history(self.store, mempool)
        refresh_prices(self.store, mempool)
        self.assertEqual(mempool.calls, ["prices"])

    def test_mempool_errors_keep_the_cache(self):
        mempool = FakeMempool(fail={"statistics_all", "statistics", "historical_prices", "prices"})
        refresh_history(self.store, mempool)
        refresh_prices(self.store, mempool)
        self.assertEqual(self.store.external_history, [])
        self.assertEqual(self.store.current_prices, {})
        self.assertEqual(self.store.daily_prices, {})

    def test_refresh_once_records_a_local_snapshot_without_mempool(self):
        settings = Settings(
            data_dir=self.tmp.name,
            mempool_api="",
            refresh_seconds=0,
            metrics_samples=3,
        )
        self.store.install_graph(aggregate_graph(), "test", "fixture")
        with mock.patch("explorer.refresh.load_graph") as loader:
            loader.return_value = mock.Mock(
                graph=aggregate_graph(), source="test", detail="fixture"
            )
            refresh_once(self.store, settings)
        self.assertEqual(len(self.store.local_snapshots), 1)
        snapshot = self.store.local_snapshots[0]
        self.assertAlmostEqual(snapshot["fee_rate_mean_filtered"], 107.5)
        payload = self.store.history_payload("all")
        self.assertEqual(payload["points"][0]["source"], "local")


if __name__ == "__main__":
    unittest.main()
