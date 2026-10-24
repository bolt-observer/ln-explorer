"""Fee policy change log and daily fee distributions."""

import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest import mock

from explorer import feehistory
from explorer.rgs import ParsedChannel, ParsedGraph, ParsedNode, Policy
from explorer.store import Store


def policy(ppm, base=1000, disabled=False):
    return Policy(base_msat=base, ppm=ppm, cltv=40, min_htlc_msat=1, max_htlc_msat=10, disabled=disabled)


def graph(ts, channels):
    nodes = {}
    parsed = {}
    for scid, (p1, p2) in channels.items():
        a, b = "02" + "a" * 64, "03" + "b" * 64
        nodes[a] = ParsedNode(pubkey=a)
        nodes[b] = ParsedNode(pubkey=b)
        parsed[scid] = ParsedChannel(scid=scid, node1=a, node2=b, capacity=None, policy1=p1, policy2=p2)
    return ParsedGraph(version=1, chain_hash=b"", timestamp=ts, nodes=nodes, channels=parsed)


class DistributionTests(unittest.TestCase):
    def test_percentiles_match_numpy_linear(self):
        values = [1.0, 2.0, 3.0, 4.0]
        self.assertEqual(feehistory.percentile(values, 50), 2.5)
        self.assertEqual(feehistory.percentile(values, 25), 1.75)
        self.assertEqual(feehistory.percentile(values, 90), 3.7)

    def test_distribution_skips_disabled_and_caps_mean(self):
        dist = feehistory.distribution(
            [policy(10, base=0), policy(100), policy(2_147_483_647), policy(5, disabled=True), None]
        )
        self.assertEqual(dist["half_channels"], 3)
        self.assertEqual(dist["p50"], 100)
        self.assertEqual(dist["mean_le50k"], 55)
        self.assertAlmostEqual(dist["zero_base_share"], 1 / 3)
        self.assertEqual(sum(dist["hist"]), 3)
        self.assertEqual(dist["hist"][-1], 1)

    def test_policy_changes_only_on_fee_or_disabled(self):
        old = {1: SimpleNamespace(policy1=policy(10), policy2=policy(20))}
        new = {
            1: SimpleNamespace(policy1=policy(10), policy2=policy(25)),
            2: SimpleNamespace(policy1=policy(1), policy2=None),
        }
        rows = feehistory.policy_changes(old, new, 100, baseline=False)
        self.assertEqual(sorted(rows), [(1, 1, 100, 1000, 25, 0), (2, 0, 100, 1000, 1, 0)])
        self.assertEqual(len(feehistory.policy_changes(old, new, 100, baseline=True)), 3)


class StoreFeeHistoryTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(os.path.join(self.tmp.name, "x.sqlite"))
        self.store.open()

    def tearDown(self):
        self.tmp.cleanup()

    def test_baseline_then_changes_and_daily_row(self):
        for ts, p2 in ((1000, policy(20)), (2000, policy(30, disabled=True)), (3000, policy(30, disabled=True))):
            with mock.patch("explorer.store.time.time", return_value=float(ts)):
                self.store.install_graph(graph(ts, {10: (policy(10), p2)}), "rgs", "")
        changes = self.store.channel_policy_history(10)
        self.assertEqual([(c["dir"], c["ppm"], c["disabled"]) for c in changes], [(0, 10, False), (1, 20, False), (1, 30, True)])
        self.store.record_local_snapshot()
        payload = self.store.fee_history_payload("all")
        live = next(series for series in payload["series"] if series["source"] == "live")
        self.assertEqual(live["points"][-1][1], 1)  # one enabled half-channel
        self.assertEqual(live["points"][-1][3], 10)
        hist = self.store._conn.execute("SELECT hist FROM fee_daily WHERE source = 'live'").fetchone()[0]
        self.assertEqual(sum(json.loads(hist)), 1)


if __name__ == "__main__":
    unittest.main()


class DatasetTests(unittest.TestCase):
    def test_bundled_lnresearch_dataset_loads_once(self):
        import sqlite3

        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
        conn.executescript(feehistory.SCHEMA)
        written = feehistory.load_datasets(conn)
        self.assertGreater(written, 1000)
        self.assertEqual(feehistory.load_datasets(conn), 0)
        first = conn.execute(
            "SELECT day, p50, half_channels FROM fee_daily WHERE source = 'lnresearch' ORDER BY day LIMIT 1"
        ).fetchone()
        self.assertEqual(first[0], 1547942400)  # 2019-01-20
        self.assertGreaterEqual(first[2], 20000)
        payload = feehistory.history_payload(conn)
        self.assertEqual(payload["series"][0]["source"], "lnresearch")
