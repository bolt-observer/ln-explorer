import tempfile
import unittest
from pathlib import Path

from explorer.refresh import apply_channel_page, enrich_profiles, fill_capacities
from explorer.rgs import ParsedChannel, ParsedGraph, ParsedNode, Policy
from explorer.sources import SourceError
from explorer.store import Store

PUB_A = "02" + "11" * 32
PUB_B = "02" + "22" * 32
PUB_C = "03" + "33" * 32


def graph() -> ParsedGraph:
    nodes = {
        PUB_A: ParsedNode(pubkey=PUB_A),
        PUB_B: ParsedNode(pubkey=PUB_B),
        PUB_C: ParsedNode(pubkey=PUB_C),
    }
    channels = {
        100: ParsedChannel(
            scid=100,
            node1=PUB_A,
            node2=PUB_B,
            capacity=None,
            policy1=Policy(1, 1, 40, 1, 1, False),
            policy2=Policy(1, 1, 40, 1, 1, False),
        ),
        200: ParsedChannel(
            scid=200,
            node1=PUB_A,
            node2=PUB_C,
            capacity=None,
            policy1=Policy(1, 1, 40, 1, 1, False),
            policy2=Policy(1, 1, 40, 1, 1, False),
        ),
    }
    return ParsedGraph(version=1, chain_hash=b"", timestamp=1, nodes=nodes, channels=channels)


class FakeMempool:
    def __init__(self):
        self.calls = []
        self.channel_calls = []

    def node(self, pubkey):
        self.calls.append(pubkey)
        if pubkey == PUB_B:
            raise SourceError("HTTP 500 from node", status=500)
        if pubkey == PUB_C:
            raise SourceError("HTTP 429 from node", status=429)
        return {"alias": "Alpha", "capacity": 10, "sockets": ["1.2.3.4:9735"], "color": "#ffffff"}

    def node_channels(self, pubkey, index=0, status="active"):
        self.channel_calls.append((pubkey, index))
        if pubkey == PUB_A and index == -1:
            rows = [
                {
                    "id": "100",
                    "capacity": 4_000_000,
                    "node": {"public_key": PUB_B, "alias": "Bravo", "capacity": 9},
                }
            ]
            rows.extend([{"id": str(1000 + i), "capacity": 1} for i in range(9)])
            return rows, 10
        if pubkey == PUB_B and index == -1:
            raise SourceError("HTTP 500 from channels", status=500)
        raise SourceError("HTTP 429 from channels", status=429)


class RefreshBehaviorTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "explorer.sqlite"))
        self.store.open()
        self.store.install_graph(graph(), "test", "fixture")

    def tearDown(self):
        self.tmp.cleanup()

    def test_profile_errors_skip_until_rate_limit(self):
        mempool = FakeMempool()
        done = enrich_profiles(self.store, mempool, [PUB_A, PUB_B, PUB_C, PUB_A])
        self.assertEqual(done, 1)
        self.assertEqual(mempool.calls, [PUB_A, PUB_B, PUB_C])
        self.assertEqual(self.store.nodes[PUB_A].alias, "Alpha")
        self.assertEqual(self.store.nodes[PUB_B].alias, "")

    def test_channel_page_sets_capacity_and_peer_alias(self):
        updated = apply_channel_page(
            self.store,
            [
                {
                    "short_id": "0x0x100",
                    "capacity": 1,
                    "node": {"public_key": PUB_B, "alias": "Bravo"},
                },
                {"id": "100", "capacity": 7_000_000, "node": {"public_key": PUB_B, "alias": "Bravo"}},
            ],
        )
        self.assertEqual(updated, 1)
        self.assertEqual(self.store.channels[100].capacity, 7_000_000)
        self.assertEqual(self.store.nodes[PUB_B].alias, "Bravo")
        self.assertGreater(self.store.capacity_coverage(), 0)

    def test_capacity_fill_uses_bulk_page_and_skips_errors(self):
        mempool = FakeMempool()
        self.store.nodes[PUB_A].capacity_done = True
        self.store.nodes[PUB_A].capacity_page = 22
        used = fill_capacities(self.store, mempool, page_budget=8)
        self.assertEqual(used, 4)
        self.assertEqual(mempool.channel_calls[0], (PUB_A, -1))
        self.assertEqual(self.store.channels[100].capacity, 4_000_000)
        self.assertEqual(self.store.nodes[PUB_B].alias, "Bravo")
        self.assertTrue(self.store.nodes[PUB_A].capacity_done)
        self.assertEqual(self.store.nodes[PUB_A].capacity_scan, 2)
        self.assertFalse(self.store.nodes[PUB_B].capacity_done)
        self.assertEqual(self.store.nodes[PUB_B].capacity_page, 0)
        self.assertEqual(mempool.channel_calls[-1][0], PUB_C)

    def test_capacity_tail_confirms_a_short_page(self):
        class TailMempool:
            def __init__(self):
                self.calls = []

            def node_channels(self, pubkey, index=0, status="active"):
                self.calls.append(index)
                if pubkey != PUB_A:
                    raise SourceError("HTTP 429 from channels", status=429)
                if index == -1:
                    rows = [{"id": "100", "capacity": 5}]
                    rows.extend([{"id": str(3000 + i), "capacity": 1} for i in range(999)])
                    return rows, 1010
                if index == 1000:
                    return [{"id": "200", "capacity": 9, "short_id": "0x0x200"}], 1010
                raise SourceError("HTTP 429 from channels", status=429)

        mempool = TailMempool()
        used = fill_capacities(self.store, mempool, page_budget=3)
        self.assertEqual(used, 3)
        self.assertEqual(mempool.calls, [-1, 1000, 1000])
        self.assertEqual(self.store.channels[100].capacity, 5)
        self.assertEqual(self.store.channels[200].capacity, 9)
        self.assertTrue(self.store.nodes[PUB_A].capacity_done)
        self.assertEqual(self.store.nodes[PUB_A].capacity_page, 1001)


if __name__ == "__main__":
    unittest.main()
