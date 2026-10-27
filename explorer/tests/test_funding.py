"""Channel capacity from funding outputs: lookups, caching, and snapshot backfill."""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from explorer.funding import PAGE, resolve_pass, run_once, split_scid
from explorer.rgs import ParsedChannel, ParsedGraph, ParsedNode, Policy
from explorer.sources import SourceError
from explorer.store import Store

PUB_A = "02" + "11" * 32
PUB_B = "02" + "22" * 32
PUB_C = "03" + "33" * 32


def scid_of(block: int, tx: int, out: int = 0) -> int:
    return (block << 40) | (tx << 16) | out


AB = scid_of(970_000, 3, 1)
AC = scid_of(970_000, 7, 0)  # same block and 25-tx page as AB
BC = scid_of(970_100, 30, 0)  # next page of another block


def tx_with(values: list[int]) -> dict:
    return {"vout": [{"value": value, "scriptpubkey_type": "v0_p2wsh"} for value in values]}


class FakeEsplora:
    """Blocks are {height: [tx, ...]}; serves esplora's paging and errors."""

    def __init__(self, blocks: dict, fail: dict | None = None):
        self.blocks = blocks
        self.fail = fail or {}
        self.calls: list[tuple] = []

    def block_hash(self, height: int) -> str:
        self.calls.append(("hash", height))
        if ("hash", height) in self.fail:
            raise SourceError("boom", status=self.fail[("hash", height)])
        if height not in self.blocks:
            raise SourceError("not found", status=404)
        return f"{height:064x}"

    def block_txs(self, block_hash: str, start: int) -> list:
        height = int(block_hash, 16)
        self.calls.append(("txs", height, start))
        if ("txs", height, start) in self.fail:
            raise SourceError("boom", status=self.fail[("txs", height, start)])
        txs = self.blocks[height]
        if start >= len(txs):
            raise SourceError("start index out of range", status=400)
        return txs[start : start + PAGE]


def block(n: int, outputs: dict[int, list[int]]) -> list[dict]:
    """A block of n transactions; `outputs` maps tx index to its output values."""
    return [tx_with(outputs.get(i, [546])) for i in range(n)]


class ResolvePassTest(unittest.TestCase):
    def test_split_scid(self):
        self.assertEqual(split_scid(scid_of(971_472, 2362, 1)), (971_472, 2362, 1))

    def test_shares_block_hash_and_page(self):
        client = FakeEsplora({970_000: block(10, {3: [1, 5_000_000], 7: [2_000_000]}), 970_100: block(40, {30: [9_000_000]})})
        result = resolve_pass(client, [AB, AC, BC], budget=100, known_hashes={})
        self.assertEqual(result.resolved, {AB: 5_000_000, AC: 2_000_000, BC: 9_000_000})
        # Two blocks: one hash + one page each, not one request per channel.
        self.assertEqual(result.requests, 4)
        self.assertEqual(client.calls[1], ("txs", 970_000, 0))
        self.assertEqual(client.calls[3], ("txs", 970_100, 25))

    def test_known_hash_saves_a_request_and_new_ones_are_reported(self):
        client = FakeEsplora({970_000: block(10, {3: [1, 5]})})
        learned = {}
        result = resolve_pass(client, [AB], 10, {}, on_hash=lambda h, v: learned.update({h: v}))
        self.assertEqual(result.requests, 2)
        self.assertIn(970_000, learned)
        again = resolve_pass(client, [AB], 10, dict(learned))
        self.assertEqual(again.requests, 1)

    def test_budget_stops_and_counts_remaining(self):
        client = FakeEsplora({970_000: block(10, {3: [1, 5]}), 970_100: block(40, {30: [9]})})
        result = resolve_pass(client, [AB, AC, BC], budget=2, known_hashes={})
        self.assertEqual(set(result.resolved), {AB, AC})
        self.assertEqual(result.remaining, 1)
        self.assertEqual(result.requests, 2)

    def test_missing_outputs_are_invalid(self):
        bad_tx = scid_of(970_000, 12, 0)  # block has 10 transactions
        bad_out = scid_of(970_000, 3, 5)  # tx 3 has 2 outputs
        past_page = scid_of(970_000, 40, 0)  # page start beyond the block
        no_block = scid_of(999_999, 1, 0)
        client = FakeEsplora({970_000: block(10, {3: [1, 5]})})
        result = resolve_pass(client, [bad_tx, bad_out, past_page, no_block], 100, {})
        self.assertEqual(result.resolved, {})
        self.assertEqual(sorted(result.invalid), sorted([bad_tx, bad_out, past_page, no_block]))

    def test_rate_limit_stops_the_pass(self):
        client = FakeEsplora({970_000: block(10, {3: [1, 5]}), 970_100: block(40, {30: [9]})}, fail={("hash", 970_000): 429})
        result = resolve_pass(client, [AB, BC], 100, {})
        self.assertTrue(result.rate_limited)
        self.assertEqual(result.resolved, {})
        self.assertEqual(result.remaining, 2)

    def test_server_errors_are_transient(self):
        client = FakeEsplora({970_000: block(10, {3: [1, 5]}), 970_100: block(40, {30: [9]})}, fail={("txs", 970_000, 0): 503})
        result = resolve_pass(client, [AB, BC], 100, {})
        self.assertEqual(result.errors, [AB])
        self.assertEqual(result.resolved, {BC: 9})


def policy() -> Policy:
    return Policy(1000, 100, 40, 1, 1_000_000_000, False)


def graph(ts: int, scids: list[int], capacity: int | None = None) -> ParsedGraph:
    ends = {AB: (PUB_A, PUB_B), AC: (PUB_A, PUB_C), BC: (PUB_B, PUB_C)}
    nodes = {pub: ParsedNode(pubkey=pub, addresses=[]) for pub in (PUB_A, PUB_B, PUB_C)}
    channels = {
        scid: ParsedChannel(scid=scid, node1=ends[scid][0], node2=ends[scid][1], capacity=capacity, policy1=policy(), policy2=policy())
        for scid in scids
    }
    return ParsedGraph(version=1, chain_hash=b"", timestamp=ts, nodes=nodes, channels=channels)


class StoreFundingTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = str(Path(self.tmp.name) / "explorer.sqlite")
        self.store = Store(self.path)
        self.store.open()
        # A fresh database trusts events from its creation on; these tests use
        # synthetic timestamps far before "now".
        self.store._conn.execute("UPDATE meta SET value = '0' WHERE key = 'topology_complete_since'")

    def tearDown(self):
        self.tmp.cleanup()

    def test_legacy_database_boundary_is_its_oldest_kept_event(self):
        conn = self.store._conn
        conn.execute("DELETE FROM meta WHERE key = 'topology_complete_since'")
        conn.execute("INSERT INTO events (ts, kind, scid) VALUES (500, 'channel_open', 1), (900, 'channel_close', 2)")
        conn.commit()
        self.store._migrate()
        row = conn.execute("SELECT value FROM meta WHERE key = 'topology_complete_since'").fetchone()
        self.assertEqual(row[0], "500")

    def test_resolver_keeps_live_channels_first(self):
        old_closed = scid_of(800_000, 1)
        client = FakeEsplora({800_000: block(5, {1: [7]}), 970_000: block(10, {3: [1, 5]})})
        result = resolve_pass(client, [AB, old_closed], budget=2, known_hashes={})
        self.assertEqual(result.resolved, {AB: 5})

    def test_capacity_is_cached_permanently_and_reapplied(self):
        self.store.install_graph(graph(1000, [AB, AC]), "rgs", "")
        self.assertEqual(self.store.capacity_coverage(), 0.0)
        self.assertEqual(sorted(self.store.funding_pending()), sorted([AB, AC]))
        client = FakeEsplora({970_000: block(10, {3: [1, 5_000_000], 7: [2_000_000]})})
        run_once(self.store, client, budget=100)
        self.assertEqual(self.store.capacity_coverage(), 1.0)
        self.assertEqual(self.store.derived[PUB_A]["total_capacity"], 7_000_000)
        self.assertEqual(self.store.funding_pending(), [])
        # A new snapshot without capacities keeps them, and so does a restart.
        self.store.install_graph(graph(2000, [AB, AC]), "rgs", "")
        self.assertEqual(self.store.channels[AB].capacity, 5_000_000)
        self.store.save()
        reopened = Store(self.path)
        reopened.open()
        self.assertEqual(reopened.funding[AC], 2_000_000)
        self.assertEqual(reopened.block_hashes(), {970_000: f"{970_000:064x}"})
        reopened.install_graph(graph(3000, [AB, AC]), "rgs", "")
        self.assertEqual(reopened.capacity_coverage(), 1.0)

    def test_failed_lookups_wait_before_retrying(self):
        self.store.install_graph(graph(1000, [AB, AC]), "rgs", "")
        self.store.record_funding({}, [AB], [AC], now=10_000)
        self.assertEqual(self.store.funding_pending(now=10_000 + 60), [])
        self.assertEqual(self.store.funding_pending(now=10_000 + 7 * 3600), [AC])
        self.assertEqual(sorted(self.store.funding_pending(now=10_000 + 8 * 86400)), sorted([AB, AC]))

    def start_history(self, scids):
        """Two installs: the second starts the event log (events_since)."""
        with mock.patch("explorer.store.time.time", return_value=990_000):
            self.store.install_graph(graph(990_000, scids), "rgs", "")
        with mock.patch("explorer.store.time.time", return_value=1_000_000):
            self.store.install_graph(graph(1_000_000, scids), "rgs", "")

    def test_backfill_rebuilds_earlier_snapshots(self):
        self.start_history([AB, AC])
        with mock.patch("explorer.store.time.time", return_value=1_000_010):
            self.store.record_local_snapshot()
        with mock.patch("explorer.store.time.time", return_value=1_010_000):
            self.store.install_graph(graph(1_010_000, [AB, BC]), "rgs", "")  # AC closed, BC opened
        with mock.patch("explorer.store.time.time", return_value=1_010_010):
            self.store.record_local_snapshot()
        self.assertEqual([s["total_capacity"] for s in self.store.local_snapshots], [0, 0])
        # The closed channel is still looked up: the first snapshot needs it.
        self.assertIn(AC, self.store.funding_pending())
        self.store.record_funding({AB: 5_000_000, AC: 2_000_000, BC: 9_000_000}, [], [])
        self.assertEqual(self.store.backfill_snapshot_capacity(), 2)
        snaps = self.store.local_snapshots
        self.assertEqual([s["total_capacity"] for s in snaps], [7_000_000, 14_000_000])
        self.assertEqual([s["capacity_known_channels"] for s in snaps], [2, 2])
        # Nothing new to learn: a second run is a no-op.
        self.assertEqual(self.store.backfill_snapshot_capacity(), 0)

    def test_backfill_skips_snapshots_it_cannot_reproduce(self):
        self.start_history([AB, AC])
        with mock.patch("explorer.store.time.time", return_value=1_000_010):
            self.store.record_local_snapshot()
        # Pretend the recorded count disagrees with what the events rebuild.
        self.store._conn.execute("UPDATE snapshots SET channel_count = 40")
        self.store.local_snapshots[0]["channel_count"] = 40
        self.store.record_funding({AB: 5_000_000, AC: 2_000_000}, [], [])
        self.assertEqual(self.store.backfill_snapshot_capacity(), 0)

    def test_backfill_never_lowers_a_total_and_uses_known_close_capacity(self):
        self.start_history([AB, AC])
        self.store.channels[AB].capacity = 100_000_000  # learned earlier (e.g. mempool)
        with mock.patch("explorer.store.time.time", return_value=1_000_010):
            self.store.record_local_snapshot()
        self.assertEqual(self.store.local_snapshots[-1]["total_capacity"], 100_000_000)
        with mock.patch("explorer.store.time.time", return_value=1_010_000):
            self.store.install_graph(graph(1_010_000, [AC, BC]), "rgs", "")  # AB closes
        # AB's lookup fails; AC resolves. Without AB's capacity the rebuilt total would drop.
        self.store.record_funding({AC: 1_000_000}, [], [AB])
        self.store._conn.execute("UPDATE events SET capacity = NULL WHERE scid = ?", (AB,))
        self.store._conn.execute("UPDATE channel_closures SET capacity = NULL WHERE scid = ?", (AB,))
        self.assertEqual(self.store.backfill_snapshot_capacity(), 0)
        self.assertEqual(self.store.local_snapshots[0]["total_capacity"], 100_000_000)
        # With the capacity the close event recorded, the snapshot gains AC.
        self.store._conn.execute("UPDATE events SET capacity = 100000000 WHERE scid = ? AND kind = 'channel_close'", (AB,))
        self.assertEqual(self.store.backfill_snapshot_capacity(), 1)
        self.assertEqual(self.store.local_snapshots[0]["total_capacity"], 101_000_000)

    def test_backfill_skips_snapshots_older_than_complete_history(self):
        self.start_history([AB, AC])
        with mock.patch("explorer.store.time.time", return_value=1_000_010):
            self.store.record_local_snapshot()
        self.store._raise_topology_boundary(1_000_011)  # events before this were pruned
        self.store.record_funding({AB: 5_000_000, AC: 2_000_000}, [], [])
        self.assertEqual(self.store.backfill_snapshot_capacity(), 0)

    def test_backfill_ignores_snapshots_before_a_replayed_change(self):
        self.start_history([AB, AC])
        with mock.patch("explorer.store.time.time", return_value=1_005_000):
            self.store.install_graph(graph(1_005_000, [AB, BC]), "rgs", "")
        with mock.patch("explorer.store.time.time", return_value=1_005_010):
            self.store.record_local_snapshot()  # AB + BC
        # A restart before save(): the same change is logged again later.
        self.store._conn.executemany(
            "INSERT INTO events (ts, kind, scid) VALUES (?, ?, ?)",
            [(1_006_000, "channel_close", AC), (1_006_000, "channel_open", BC)],
        )
        with mock.patch("explorer.store.time.time", return_value=1_006_010):
            self.store.record_local_snapshot()  # AB + BC, after the replay
        self.store.record_funding({AB: 5_000_000, AC: 2_000_000, BC: 9_000_000}, [], [])
        self.assertEqual(self.store.backfill_snapshot_capacity(), 1)
        snaps = {snap["ts"]: snap["total_capacity"] for snap in self.store.local_snapshots}
        self.assertEqual(snaps[1_006_010], 14_000_000)
        self.assertEqual(snaps[1_005_010], 0)  # not rebuilt from a log it cannot trust


class TransportFailureTest(unittest.TestCase):
    def test_timeouts_are_transient_and_keep_earlier_results(self):
        client = FakeEsplora({970_000: block(10, {3: [1, 5]}), 970_100: block(40, {30: [9]})})
        real = client.block_txs

        def flaky(block_hash, start):
            if int(block_hash, 16) == 970_100:
                raise TimeoutError("read timed out")
            return real(block_hash, start)

        client.block_txs = flaky
        result = resolve_pass(client, [AB, BC], 100, {})
        self.assertEqual(result.resolved, {AB: 5})
        self.assertEqual(result.errors, [BC])


if __name__ == "__main__":
    unittest.main()
