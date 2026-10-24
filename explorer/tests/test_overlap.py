"""Peer overlap and who-to-connect suggestions (P10)."""

import tempfile
import unittest
from pathlib import Path

from explorer.app import create_app
from explorer.config import Settings
from explorer.rgs import ParsedChannel, ParsedGraph, ParsedNode, Policy
from explorer.store import SUGGESTION_MIN_CHANNELS, Store


def pk(tag: int) -> str:
    """A valid 66-hex-char pubkey with a readable pattern."""
    return "02" + f"{tag:064x}"


S = pk(1)
P1, P2, P3 = pk(11), pk(12), pk(13)  # direct peers of S
HUB = pk(20)  # 2 hops from S, 7 channels
SMALL = pk(25)  # 2 hops from S but only 3 channels
X1, X2 = pk(61), pk(62)  # SMALL's other peers
C1, C2, C3 = pk(31), pk(32), pk(33)  # 3 hops from S, 5 channels each
TINY = pk(34)  # 3 hops from S, 1 channel
LEAVES = {name: pk(40 + index) for index, name in enumerate(
    ["c1a", "c1b", "c1c", "c1d", "c2a", "c2b", "c2c", "c2d",
     "c3a", "c3b", "c3c", "c3d"]
)}
A, B = pk(71), pk(72)  # the overlap pair (own component)
SP1, SP2 = pk(81), pk(82)  # shared peers of A and B
A_ONLY = pk(83)
B_ONLY1, B_ONLY2 = pk(84), pk(85)
DEAD = pk(86)  # channel with A disabled both ways
UNKNOWN = pk(99)

ALIASES = {
    S: "Source", P1: "Peer1", P2: "Peer2", P3: "Peer3",
    HUB: "Hub", SMALL: "SmallHub", C1: "CandOne", C2: "CandTwo", C3: "CandThree",
    TINY: "Tiny", A: "Alfa", B: "Bravo", SP1: "SharedOne", SP2: "SharedTwo",
    A_ONLY: "AlfaOnly", B_ONLY1: "BravoOnly1", B_ONLY2: "BravoOnly2", DEAD: "DeadPeer",
    **{name: f"Leaf{name}" for name in LEAVES},
}

# Candidate total capacities: HUB 25M, C1 22M, C2 12M, C3 11M sat.
CAPACITY_ORDER = [HUB, C1, C2, C3]


def policy(disabled=False):
    return Policy(1000, 50, 40, 1, 1_000_000_000, disabled)


def chan(scid, node1, node2, capacity=1_000_000, p1=None, p2=None):
    return ParsedChannel(
        scid=scid,
        node1=node1,
        node2=node2,
        capacity=capacity,
        policy1=p1 if p1 is not None else policy(),
        policy2=p2 if p2 is not None else policy(),
    )


def fixture_channels() -> list[ParsedChannel]:
    channels = [
        # S -- P1/P2/P3 -- HUB, so HUB is 2 hops and everything past it 3+.
        chan(101, S, P1), chan(102, S, P2), chan(103, S, P3),
        chan(111, HUB, P1), chan(112, HUB, P2), chan(113, HUB, P3),
        chan(121, HUB, C1, 10_000_000), chan(122, HUB, C2, 4_000_000),
        chan(123, HUB, C3, 7_000_000), chan(124, HUB, TINY),
    ]
    scid = 130
    for name, capacity in [
        ("c1a", 3_000_000), ("c1b", 3_000_000), ("c1c", 3_000_000), ("c1d", 3_000_000),
        ("c2a", 2_000_000), ("c2b", 2_000_000), ("c2c", 2_000_000), ("c2d", 2_000_000),
        ("c3a", 1_000_000), ("c3b", 1_000_000), ("c3c", 1_000_000), ("c3d", 1_000_000),
    ]:
        candidate = C1 if name.startswith("c1") else C2 if name.startswith("c2") else C3
        channels.append(chan(scid, candidate, LEAVES[name], capacity))
        scid += 1
    # 2 hops from S but only 3 channels: never a candidate.
    channels += [chan(151, P1, SMALL), chan(152, SMALL, X1), chan(153, SMALL, X2)]
    # The overlap component, separate from S's.
    channels += [
        chan(161, A, SP1), chan(162, A, SP2), chan(163, A, A_ONLY),
        chan(171, B, SP1), chan(172, B, SP2),
        chan(173, B, B_ONLY1), chan(174, B, B_ONLY2),
        # Disabled both ways: A and DEAD are not peers for overlap purposes.
        chan(181, A, DEAD, p1=policy(disabled=True), p2=policy(disabled=True)),
    ]
    return channels


class OverlapCase(unittest.TestCase):
    def store_with(self, channels):
        self.tmp = tempfile.TemporaryDirectory()
        store = Store(str(Path(self.tmp.name) / "explorer.sqlite"))
        store.open()
        nodes = {}
        for entry in channels:
            for pub in (entry.node1, entry.node2):
                if pub not in nodes:
                    parsed = ParsedNode(pubkey=pub)
                    parsed.alias = ALIASES.get(pub, "")  # type: ignore[attr-defined]
                    nodes[pub] = parsed
        store.install_graph(
            ParsedGraph(
                version=1,
                chain_hash=b"",
                timestamp=1_700_000_000,
                nodes=nodes,
                channels={entry.scid: entry for entry in channels},
            ),
            "test",
            "fixture",
        )
        store.recompute_metrics(samples=8)
        return store

    def setUp(self):
        self.store = self.store_with(fixture_channels())

    def tearDown(self):
        tmp = getattr(self, "tmp", None)
        if tmp is not None:
            tmp.cleanup()


class OverlapTest(OverlapCase):
    def test_overlap_numbers_on_the_fixture(self):
        result = self.store.overlap(A, B)
        # A's peers: SP1, SP2, A_ONLY (the disabled-both-ways channel to DEAD
        # does not count). B's: SP1, SP2, B_ONLY1, B_ONLY2.
        self.assertEqual(result["a_peers"], 3)
        self.assertEqual(result["b_peers"], 4)
        self.assertEqual(result["shared_peers"], 2)
        self.assertEqual(result["union"], 5)
        self.assertAlmostEqual(result["jaccard"], 2 / 5)
        self.assertAlmostEqual(result["overlap_a"], 2 / 3)
        self.assertAlmostEqual(result["overlap_b"], 0.5)
        self.assertEqual((result["a_alias"], result["b_alias"]), ("Alfa", "Bravo"))
        shared = result["shared"]
        self.assertEqual({row["pubkey"] for row in shared}, {SP1, SP2})
        self.assertEqual({row["alias"] for row in shared}, {"SharedOne", "SharedTwo"})
        self.assertTrue(all(row["num_channels"] == 2 for row in shared))

    def test_shared_list_is_capped_and_ordered_by_channels(self):
        # S and HUB share P1, P2, P3; all three have <= 3 channels, the
        # busiest (P1, with the SMALL channel) first.
        result = self.store.overlap(S, HUB)
        self.assertEqual([row["pubkey"] for row in result["shared"]], [P1, P2, P3])
        self.assertEqual(result["shared_peers"], 3)
        self.assertAlmostEqual(result["jaccard"], 3 / 7)

    def test_unknown_node_and_self_overlap(self):
        self.assertIsNone(self.store.overlap(UNKNOWN, B))
        self.assertIsNone(self.store.overlap(A, UNKNOWN))
        self.assertIsNone(self.store.overlap("not-a-key", B))
        same = self.store.overlap(A, A)
        self.assertEqual(same["shared_peers"], 3)
        self.assertAlmostEqual(same["jaccard"], 1.0)
        self.assertAlmostEqual(same["overlap_a"], 1.0)

    def test_disconnected_pair_has_no_overlap(self):
        result = self.store.overlap(S, A)
        self.assertEqual(result["shared_peers"], 0)
        self.assertEqual(result["jaccard"], 0.0)
        self.assertEqual(result["overlap_a"], 0.0)
        self.assertEqual(result["shared"], [])


class SuggestionsTest(OverlapCase):
    def suggestions(self, **kwargs):
        return self.store.suggestions(kwargs.pop("pubkey", S), **kwargs)

    def test_candidates_are_far_enough_and_well_connected(self):
        result = self.suggestions(min_hops=2, sort="capacity", limit=20)
        self.assertEqual(result["candidates"], 4)
        self.assertEqual(result["min_hops"], 2)
        self.assertEqual(result["min_channels"], SUGGESTION_MIN_CHANNELS)
        entries = result["suggestions"]
        self.assertEqual([row["pubkey"] for row in entries], CAPACITY_ORDER)
        # HUB sits at 2 hops, the candidates behind it at 3.
        self.assertEqual([row["hops"] for row in entries], [2, 3, 3, 3])
        # 7 channels for HUB, 5 (hub + 4 leaves) for each candidate.
        self.assertEqual([row["channels"] for row in entries], [7, 5, 5, 5])
        self.assertEqual([row["capacity"] for row in entries],
                         [25_000_000, 22_000_000, 12_000_000, 11_000_000])
        # Nodes with fewer than 5 channels are never suggested, no matter
        # how far away they are (SMALL at 2 hops, TINY and the leaves at 3+).
        pubkeys = {row["pubkey"] for row in entries}
        self.assertNotIn(SMALL, pubkeys)
        self.assertNotIn(TINY, pubkeys)
        self.assertNotIn(X1, pubkeys)
        for field in ("betweenness_rank", "closeness_rank", "eigenvector_rank",
                      "betweenness_weighted_rank", "closeness_weighted_rank",
                      "eigenvector_weighted_rank"):
            self.assertTrue(all(row[field] is not None for row in entries), field)

    def test_new_peers_counts_peers_two_hops_or_more_away(self):
        entries = {
            row["pubkey"]: row
            for row in self.suggestions(min_hops=2, sort="capacity")["suggestions"]
        }
        # HUB's peers: P1/P2/P3 (1 hop, not new) and C1/C2/C3/TINY (3 hops).
        self.assertEqual(entries[HUB]["new_peers"], 4)
        # C1's peers: HUB (2 hops, counts) and its four leaves (4 hops).
        self.assertEqual(entries[C1]["new_peers"], 5)
        self.assertEqual(entries[C2]["new_peers"], 5)
        self.assertEqual(entries[C3]["new_peers"], 5)

    def test_min_hops_moves_the_boundary(self):
        result = self.suggestions(min_hops=3, sort="capacity")
        pubkeys = [row["pubkey"] for row in result["suggestions"]]
        self.assertEqual(pubkeys, [C1, C2, C3])
        self.assertEqual(result["candidates"], 3)
        self.assertEqual(result["min_hops"], 3)
        # Even min_hops=1 keeps the small nodes out: the channel floor of 5
        # excludes S's own peers.
        everything = self.suggestions(min_hops=1, sort="capacity")
        self.assertEqual(
            [row["pubkey"] for row in everything["suggestions"]], CAPACITY_ORDER
        )

    def test_limit_truncates_but_reports_all_candidates(self):
        result = self.suggestions(min_hops=2, sort="capacity", limit=2)
        self.assertEqual(result["limit"], 2)
        self.assertEqual(result["candidates"], 4)
        self.assertEqual([row["pubkey"] for row in result["suggestions"]], [HUB, C1])

    def test_centrality_sorts_use_the_rank_ascending(self):
        for sort, field in (
            ("betweenness", "betweenness_rank"),
            ("eigenvector", "eigenvector_rank"),
        ):
            result = self.suggestions(min_hops=2, sort=sort)
            self.assertEqual(result["sort"], sort)
            entries = result["suggestions"]
            self.assertEqual(len(entries), 4)
            ranks = [row[field] for row in entries]
            self.assertEqual(ranks, sorted(ranks), sort)
            self.assertEqual(len(set(ranks)), 4, sort)

    def test_source_without_candidates_and_unknown_node(self):
        # From A, the only node at 2+ hops with enough channels would be B,
        # but B has 4 channels and stays under the floor of 5.
        result = self.store.suggestions(A)
        self.assertEqual(result["suggestions"], [])
        self.assertEqual(result["candidates"], 0)
        self.assertIsNone(self.store.suggestions(UNKNOWN))
        with self.assertRaises(ValueError):
            self.store.suggestions(S, sort="nonsense")


class OverlapApiTest(OverlapCase):
    def setUp(self):
        super().setUp()
        self.settings = Settings(
            data_dir=self.tmp.name,
            mempool_api="",
            disable_refresh=True,
            web_dir=str(Path(__file__).resolve().parents[2] / "web"),
            refresh_seconds=0,
        )
        self.client = create_app(
            self.settings, store=self.store, start_background=False
        ).test_client()

    def test_overlap_endpoint(self):
        response = self.client.get(f"/api/overlap?a={A}&b={B}")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["shared_peers"], 2)
        self.assertEqual(body["a_peers"], 3)
        self.assertEqual(body["b_peers"], 4)
        self.assertAlmostEqual(body["jaccard"], 0.4)
        self.assertAlmostEqual(body["overlap_a"], 2 / 3)
        self.assertEqual(
            {row["alias"] for row in body["shared"]}, {"SharedOne", "SharedTwo"}
        )

    def test_overlap_validation(self):
        cases = [
            f"/api/overlap?a={A}",  # missing b
            f"/api/overlap?b={B}",  # missing a
            "/api/overlap?a=notapubkey&b=" + B,
            f"/api/overlap?a={A}&b={A}",  # a node with itself
        ]
        for url in cases:
            response = self.client.get(url)
            self.assertEqual(response.status_code, 400, url)
            self.assertIn("error", response.get_json())
        missing = self.client.get(f"/api/overlap?a={UNKNOWN}&b={B}")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.get_json()["error"], "node not found")

    def test_suggest_endpoint(self):
        response = self.client.get(f"/api/suggest?pubkey={S}&sort=capacity")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["pubkey"], S)
        self.assertEqual(body["candidates"], 4)
        self.assertEqual([row["pubkey"] for row in body["suggestions"]], CAPACITY_ORDER)
        self.assertEqual(body["suggestions"][0]["alias"], "Hub")

    def test_suggest_parameters(self):
        far = self.client.get(f"/api/suggest?pubkey={S}&min_hops=3&sort=capacity")
        self.assertEqual(
            [row["pubkey"] for row in far.get_json()["suggestions"]], [C1, C2, C3]
        )
        small = self.client.get(f"/api/suggest?pubkey={S}&limit=1&sort=capacity")
        self.assertEqual(len(small.get_json()["suggestions"]), 1)
        default = self.client.get(f"/api/suggest?pubkey={S}")
        self.assertEqual(default.status_code, 200)
        self.assertEqual(default.get_json()["sort"], "betweenness")

    def test_suggest_validation(self):
        cases = [
            "/api/suggest",  # missing pubkey
            "/api/suggest?pubkey=notapubkey",
            f"/api/suggest?pubkey={S}&sort=nonsense",
            f"/api/suggest?pubkey={S}&min_hops=abc",
            f"/api/suggest?pubkey={S}&min_hops=0",
            f"/api/suggest?pubkey={S}&min_hops=9",
            f"/api/suggest?pubkey={S}&limit=0",
            f"/api/suggest?pubkey={S}&limit=101",
            f"/api/suggest?pubkey={S}&limit=abc",
        ]
        for url in cases:
            response = self.client.get(url)
            self.assertEqual(response.status_code, 400, url)
            self.assertIn("error", response.get_json())
        missing = self.client.get(f"/api/suggest?pubkey={UNKNOWN}")
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.get_json()["error"], "node not found")


if __name__ == "__main__":
    unittest.main()
