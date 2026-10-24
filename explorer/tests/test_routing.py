"""Route search: exact backward fees, eligibility, Yen k-paths, /api/route."""

import tempfile
import unittest
from pathlib import Path

from explorer.app import create_app
from explorer.config import Settings
from explorer.rgs import ParsedChannel, ParsedGraph, ParsedNode, Policy, format_scid
from explorer.routing import find_routes, routing_graph
from explorer.store import Store

PUB_S = "02" + "11" * 32
PUB_M1 = "02" + "22" * 32
PUB_M2 = "03" + "33" * 32
PUB_T = "03" + "44" * 32
PUB_A = "02" + "55" * 32
PUB_B = "03" + "66" * 32
PUB_U = "02" + "77" * 32  # known node without any channel
UNKNOWN = "02" + "ab" * 32  # valid format, never seen

ALIASES = {
    PUB_S: "Sender",
    PUB_M1: "Mid1",
    PUB_M2: "Mid2",
    PUB_T: "Target",
    PUB_A: "Alfa",
    PUB_B: "Bravo",
    PUB_U: "Lonely",
}

BIG = 10_000_000_000  # 10 BTC in msat: no HTLC constraint


def policy(base=0, ppm=0, cltv=0, min_htlc=0, max_htlc=BIG, disabled=False):
    return Policy(base, ppm, cltv, min_htlc, max_htlc, disabled)


def channel(scid, node1, node2, capacity=1_000_000, p1=None, p2=None):
    return ParsedChannel(
        scid=scid,
        node1=node1,
        node2=node2,
        capacity=capacity,
        policy1=p1 if p1 is not None else policy(),
        policy2=p2 if p2 is not None else policy(),
    )


def node_path(path: dict) -> list[str]:
    return [hop["from"] for hop in path["hops"]] + [path["hops"][-1]["to"]]


class RouteCase(unittest.TestCase):
    def parsed_graph(self, channels, timestamp=1_700_000_000):
        nodes = {}
        for entry in channels:
            for pub in (entry.node1, entry.node2):
                if pub not in nodes:
                    parsed = ParsedNode(pubkey=pub)
                    parsed.alias = ALIASES.get(pub, "")  # type: ignore[attr-defined]
                    nodes[pub] = parsed
        if PUB_U not in nodes:
            lonely = ParsedNode(pubkey=PUB_U)
            lonely.alias = ALIASES[PUB_U]  # type: ignore[attr-defined]
            nodes[PUB_U] = lonely
        return ParsedGraph(
            version=1,
            chain_hash=b"",
            timestamp=timestamp,
            nodes=nodes,
            channels={entry.scid: entry for entry in channels},
        )

    def store_with(self, channels, timestamp=1_700_000_000):
        self.tmp = tempfile.TemporaryDirectory()
        store = Store(str(Path(self.tmp.name) / "explorer.sqlite"))
        store.open()
        store.install_graph(self.parsed_graph(channels, timestamp), "test", "fixture")
        return store

    def line_graph(self):
        """S -> M1 -> M2 -> T, the only simple path (fees on the sender side)."""
        return self.store_with(
            [
                channel(101, PUB_S, PUB_M1, capacity=10_000_000,
                        p1=policy(base=1000, ppm=1000, cltv=40)),
                channel(102, PUB_M1, PUB_M2, capacity=10_000_000,
                        p1=policy(base=0, ppm=2000, cltv=33)),
                channel(103, PUB_M2, PUB_T, capacity=10_000_000,
                        p1=policy(base=500, ppm=1000, cltv=144)),
            ]
        )

    def diamond_graph(self):
        """Four simple S->T paths, all base fees zero:

        S-A-T     fees 100 ppm  (A->T)   cost 100  + 2 * 1001 = 2102
        S-B-A-T   fees 0 + 100             cost 100  + 3 * 1001 = 3103
        S-B-T     fees 2000 ppm (B->T)     cost 2000 + 2 * 1001 = 4002
        S-A-B-T   fees 10 + 2000           cost 2010 + 3 * 1001 = 5013

        for 1_000_000 msat, hop penalty 1_000_000 * 1e-6 + 1000 = 1001 msat.
        """
        return self.store_with(
            [
                channel(401, PUB_S, PUB_A),
                channel(402, PUB_A, PUB_T, p1=policy(ppm=100)),
                channel(403, PUB_S, PUB_B),
                channel(404, PUB_B, PUB_T, p1=policy(ppm=2000)),
                channel(405, PUB_A, PUB_B, p1=policy(ppm=10)),
            ]
        )

    def tearDown(self):
        tmp = getattr(self, "tmp", None)
        if tmp is not None:
            tmp.cleanup()


class BackwardFeesTest(RouteCase):
    def test_exact_backward_fees_on_three_hops(self):
        store = self.line_graph()
        result = find_routes(store, PUB_S, PUB_T, 1_000_000, k=5)
        self.assertIsNone(result["reason"])
        self.assertEqual(len(result["paths"]), 1)  # only one simple path
        path = result["paths"][0]
        # Hand-computed, walking back from the receiver (amount 1_000_000 msat):
        #   hop 3 (M2->T): fee = 500 + 1_000_000 * 1000 / 1e6      = 1500 msat
        #   hop 2 (M1->M2): amount = 1_000_000 + 1500 = 1_001_500,
        #                   fee = 0 + 1_001_500 * 2000 / 1e6        = 2003 msat
        #                   (a naive forward computation would say 2000)
        #   hop 1 (S->M1): amount = 1_001_500 + 2003 = 1_003_503, fee 0
        #                  (the sender's own channel charges nothing)
        #   total fee 3503 msat = 3503 ppm of the amount
        self.assertEqual(path["hop_count"], 3)
        self.assertEqual(path["total_fee_msat"], 3503)
        self.assertEqual(path["total_fee_ppm"], 3503.0)
        hop1, hop2, hop3 = path["hops"]
        self.assertEqual((hop1["fee_msat"], hop1["amount_msat"]), (0, 1_003_503))
        self.assertEqual((hop2["fee_msat"], hop2["amount_msat"]), (2003, 1_001_500))
        self.assertEqual((hop3["fee_msat"], hop3["amount_msat"]), (1500, 1_000_000))
        self.assertEqual(hop1["base_fee_msat"], 1000)
        self.assertEqual(hop1["fee_rate_ppm"], 1000)
        # CLTV of the forwarding hops only; the sender's own 40 is not added.
        self.assertEqual(path["total_cltv"], 33 + 144)
        self.assertEqual(hop2["cltv_delta"], 33)
        self.assertEqual(hop3["cltv_delta"], 144)
        # Every capacity is known: bottleneck is the min, zero unknown hops.
        self.assertEqual(path["bottleneck_capacity"], 10_000_000)
        self.assertEqual(path["unknown_capacity_hops"], 0)
        self.assertEqual(path["path_min_htlc"], 0)
        self.assertEqual(path["path_max_htlc"], BIG)
        # Identifiers and aliases survive the round trip.
        self.assertEqual(hop1["scid"], "101")
        self.assertEqual(hop1["short_id"], format_scid(101))
        self.assertEqual(hop1["from_alias"], "Sender")
        self.assertEqual(hop1["to_alias"], "Mid1")
        self.assertEqual(node_path(path), [PUB_S, PUB_M1, PUB_M2, PUB_T])

    def test_unknown_capacity_makes_the_bottleneck_null(self):
        channels = [
            channel(101, PUB_S, PUB_M1, capacity=None,
                    p1=policy(base=1000, ppm=1000)),
            channel(103, PUB_M1, PUB_T, capacity=5_000_000,
                    p1=policy(base=500, ppm=1000)),
        ]
        store = self.store_with(channels)
        path = find_routes(store, PUB_S, PUB_T, 100_000)["paths"][0]
        self.assertIsNone(path["bottleneck_capacity"])
        self.assertEqual(path["unknown_capacity_hops"], 1)


class EligibilityTest(RouteCase):
    def parallel_store(self, cheap):
        """Two parallel S->T channels; the cheap one is 1 ppm, the other dear."""
        return self.store_with(
            [
                channel(201, PUB_S, PUB_T, **cheap),
                channel(202, PUB_S, PUB_T, p1=policy(base=1000, ppm=100)),
            ]
        )

    def test_max_htlc_bounds_the_amount(self):
        store = self.parallel_store({"p1": policy(ppm=1, max_htlc=500_000)})
        # 1_000_000 msat exceeds the cheap channel's 500_000 msat max HTLC.
        big = find_routes(store, PUB_S, PUB_T, 1_000_000)["paths"]
        self.assertEqual(big[0]["hops"][0]["scid"], "202")
        small = find_routes(store, PUB_S, PUB_T, 400_000)["paths"]
        self.assertEqual(small[0]["hops"][0]["scid"], "201")
        self.assertEqual(small[0]["path_max_htlc"], 500_000)

    def test_min_htlc_bounds_the_amount(self):
        store = self.parallel_store({"p1": policy(ppm=1, min_htlc=300_000)})
        # 200_000 msat is below the cheap channel's 300_000 msat minimum.
        tiny = find_routes(store, PUB_S, PUB_T, 200_000)["paths"]
        self.assertEqual(tiny[0]["hops"][0]["scid"], "202")
        fit = find_routes(store, PUB_S, PUB_T, 400_000)["paths"]
        self.assertEqual(fit[0]["hops"][0]["scid"], "201")
        self.assertEqual(fit[0]["path_min_htlc"], 300_000)

    def test_capacity_bounds_the_amount(self):
        # 100 sat = 100_000 msat of capacity cannot carry 1_000_000 msat.
        store = self.parallel_store({"capacity": 100, "p1": policy(ppm=1)})
        big = find_routes(store, PUB_S, PUB_T, 1_000_000)["paths"]
        self.assertEqual(big[0]["hops"][0]["scid"], "202")
        # Unknown capacity imposes no limit of its own.
        store = self.parallel_store({"capacity": None, "p1": policy(ppm=1)})
        unknown = find_routes(store, PUB_S, PUB_T, 1_000_000)["paths"]
        self.assertEqual(unknown[0]["hops"][0]["scid"], "201")
        self.assertIsNone(unknown[0]["hops"][0]["capacity"])


class DisabledDirectionTest(RouteCase):
    def test_disabled_direction_is_pruned_but_the_reverse_works(self):
        store = self.store_with(
            [
                # The sender side of S-M1 is disabled, M1's side is not.
                channel(301, PUB_S, PUB_M1, p1=policy(disabled=True)),
                channel(302, PUB_M1, PUB_T),
            ]
        )
        forward = find_routes(store, PUB_S, PUB_T, 100_000)
        self.assertEqual(forward["paths"], [])
        self.assertEqual(forward["reason"], "no route")
        backward = find_routes(store, PUB_T, PUB_S, 100_000)
        self.assertIsNone(backward["reason"])
        self.assertEqual(node_path(backward["paths"][0]), [PUB_T, PUB_M1, PUB_S])


class KPathsTest(RouteCase):
    def test_paths_are_distinct_simple_and_sorted_by_cost(self):
        store = self.diamond_graph()
        result = find_routes(store, PUB_S, PUB_T, 1_000_000, k=4)
        self.assertFalse(result["timed_out"])
        paths = result["paths"]
        self.assertEqual(len(paths), 4)
        sequences = [node_path(path) for path in paths]
        expected = [
            [PUB_S, PUB_A, PUB_T],
            [PUB_S, PUB_B, PUB_A, PUB_T],
            [PUB_S, PUB_B, PUB_T],
            [PUB_S, PUB_A, PUB_B, PUB_T],
        ]
        self.assertEqual(
            sorted(tuple(item) for item in sequences),
            sorted(tuple(item) for item in expected),
        )
        for sequence in sequences:
            self.assertEqual(len(sequence), len(set(sequence)))
        costs = [path["search_cost_msat"] for path in paths]
        self.assertEqual(costs, sorted(costs))
        self.assertEqual(costs, [2102.0, 3103.0, 4002.0, 5013.0])
        # The reported fees are the exact backward fees, penalty excluded.
        self.assertEqual(paths[0]["total_fee_msat"], 100)
        self.assertEqual(paths[0]["hop_count"], 2)
        self.assertEqual(paths[3]["total_fee_msat"], 2010)

    def test_k_larger_than_the_number_of_paths(self):
        store = self.diamond_graph()
        result = find_routes(store, PUB_S, PUB_T, 1_000_000, k=5)
        self.assertEqual(len(result["paths"]), 4)
        self.assertIsNone(result["reason"])
        self.assertFalse(result["timed_out"])

    def test_no_route_reason(self):
        store = self.diamond_graph()
        # A known node without channels is reachable by nothing.
        empty = find_routes(store, PUB_S, PUB_U, 1_000_000)
        self.assertEqual(empty["paths"], [])
        self.assertEqual(empty["reason"], "no route")
        self.assertFalse(empty["timed_out"])
        self.assertEqual(find_routes(store, PUB_S, UNKNOWN, 1_000_000)["reason"], "unknown node")
        same = find_routes(store, PUB_S, PUB_S, 1_000_000)
        self.assertEqual(same["reason"], "source and target are the same node")
        self.assertEqual(find_routes(store, PUB_S, PUB_T, 0)["reason"], "amount must be positive")

    def test_time_budget_is_respected(self):
        store = self.diamond_graph()
        # A zero budget still returns the first (Dijkstra) path, then stops.
        tight = find_routes(store, PUB_S, PUB_T, 1_000_000, k=5, time_budget=0.0)
        self.assertEqual(len(tight["paths"]), 1)
        self.assertTrue(tight["timed_out"])
        roomy = find_routes(store, PUB_S, PUB_T, 1_000_000, k=5, time_budget=30.0)
        self.assertEqual(len(roomy["paths"]), 4)
        self.assertFalse(roomy["timed_out"])

    def test_routing_graph_is_cached_until_the_snapshot_moves(self):
        store = self.diamond_graph()
        first = routing_graph(store)
        self.assertIs(routing_graph(store), first)
        # Installing a new snapshot (here with an extra direct channel)
        # invalidates the cache.
        channels = [
            channel(401, PUB_S, PUB_A),
            channel(402, PUB_A, PUB_T, p1=policy(ppm=100)),
            channel(406, PUB_S, PUB_T, p1=policy(ppm=5000)),
        ]
        store.install_graph(self.parsed_graph(channels, 1_700_000_001), "test", "again")
        self.assertIsNot(routing_graph(store), first)
        path = find_routes(store, PUB_S, PUB_T, 1_000_000)["paths"][0]
        self.assertEqual(path["hop_count"], 1)
        self.assertEqual(path["hops"][0]["scid"], "406")


class RouteApiTest(RouteCase):
    def setUp(self):
        self.store = self.line_graph()
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

    def test_valid_request_returns_computed_fees(self):
        response = self.client.get(
            f"/api/route?from={PUB_S}&to={PUB_T}&amount_sat=1000"
        )
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["amount_sat"], 1000)
        self.assertEqual(body["amount_msat"], 1_000_000)
        self.assertIsNone(body["reason"])
        self.assertFalse(body["timed_out"])
        self.assertEqual(len(body["paths"]), 1)
        path = body["paths"][0]
        self.assertEqual(path["total_fee_msat"], 3503)
        self.assertEqual(path["total_fee_ppm"], 3503.0)
        self.assertEqual([hop["amount_msat"] for hop in path["hops"]],
                         [1_003_503, 1_001_500, 1_000_000])

    def test_no_route_is_a_200_with_a_reason(self):
        # Both endpoints exist in the graph but nothing connects them.
        self.store.install_graph(
            self.parsed_graph(
                [channel(101, PUB_S, PUB_M1), channel(302, PUB_B, PUB_T)]
            ),
            "test",
            "split",
        )
        response = self.client.get(
            f"/api/route?from={PUB_S}&to={PUB_T}&amount_sat=1000"
        )
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["paths"], [])
        self.assertEqual(body["reason"], "no route")

    def test_input_validation(self):
        cases = [
            f"/api/route?to={PUB_T}&amount_sat=1000",  # missing from
            f"/api/route?from={PUB_S}&amount_sat=1000",  # missing to
            f"/api/route?from=notapubkey&to={PUB_T}&amount_sat=1000",
            f"/api/route?from={PUB_S}&to={PUB_T}",  # missing amount
            f"/api/route?from={PUB_S}&to={PUB_T}&amount_sat=abc",
            f"/api/route?from={PUB_S}&to={PUB_T}&amount_sat=0",
            f"/api/route?from={PUB_S}&to={PUB_T}&amount_sat=-5",
            f"/api/route?from={PUB_S}&to={PUB_T}&amount_sat=10000000001",
            f"/api/route?from={PUB_S}&to={PUB_T}&amount_sat=1000&k=xyz",
            f"/api/route?from={PUB_S}&to={PUB_S}&amount_sat=1000",
        ]
        for url in cases:
            response = self.client.get(url)
            self.assertEqual(response.status_code, 400, url)
            self.assertIn("error", response.get_json())

    def test_unknown_node_is_404(self):
        response = self.client.get(
            f"/api/route?from={UNKNOWN}&to={PUB_T}&amount_sat=1000"
        )
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.get_json()["error"], "node not found")

    def test_amount_is_capped_at_one_bitcoin_and_k_at_five(self):
        response = self.client.get(
            f"/api/route?from={PUB_S}&to={PUB_T}&amount_sat=1000.5"
        )
        # Fractions of a satoshi are not an integer amount.
        self.assertEqual(response.status_code, 400)
        response = self.client.get(
            f"/api/route?from={PUB_S}&to={PUB_T}&amount_sat=500000000&k=99"
        )
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["amount_sat"], 100_000_000)
        self.assertEqual(body["k"], 5)
        # No channel can carry 100 BTC of HTLC, so no route - but no error.
        self.assertEqual(body["paths"], [])
        self.assertEqual(body["reason"], "no route")

    def test_path_endpoint_is_unchanged(self):
        response = self.client.get(f"/api/path?source={PUB_S}&target={PUB_T}")
        self.assertEqual(response.status_code, 200)
        body = response.get_json()
        self.assertEqual(body["hops"], 3)
        self.assertEqual(body["path"][0]["pubkey"], PUB_S)


if __name__ == "__main__":
    unittest.main()
