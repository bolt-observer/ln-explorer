"""Weighted harmonic closeness from the shared Dijkstra-Brandes pass."""

import unittest

from explorer.metrics import compute_metrics

PUB_H = "02" + "aa" * 32  # hub
PUB_P = "02" + "bb" * 32  # one tiny-capacity hop from the hub
PUB_M = "03" + "cc" * 32  # midpoint of the high-capacity path
PUB_Q = "03" + "dd" * 32  # two high-capacity hops from the hub
PUB_R = "03" + "ee" * 32  # extra neighbour of the hub

TINY = 1
HUGE = 1_000_000_000

CAPACITIES = {
    frozenset((PUB_H, PUB_P)): TINY,
    frozenset((PUB_H, PUB_M)): HUGE,
    frozenset((PUB_M, PUB_Q)): HUGE,
    frozenset((PUB_H, PUB_R)): HUGE,
}
ADJACENCY = {
    PUB_H: [PUB_M, PUB_P, PUB_R],
    PUB_M: [PUB_H, PUB_Q],
    PUB_Q: [PUB_M],
    PUB_P: [PUB_H],
    PUB_R: [PUB_H],
}


def capacity_weight(left: str, right: str) -> float:
    """Same preference as the router: larger capacity is a shorter distance."""
    return 1.0 + 1.0 / (1.0 + CAPACITIES[frozenset((left, right))])


class WeightedClosenessTest(unittest.TestCase):
    def setUp(self):
        self.result = compute_metrics(
            ADJACENCY, samples=8, capacity_weight=capacity_weight, seed=1
        )["nodes"]

    def test_high_capacity_path_flips_the_closeness_order(self):
        # By hops P (1/2/2/3) beats Q (1/2/3/3) ...
        self.assertGreater(self.result[PUB_P]["closeness"], self.result[PUB_Q]["closeness"])
        self.assertLess(
            self.result[PUB_P]["closeness_rank"], self.result[PUB_Q]["closeness_rank"]
        )
        # ... but weighted, P's single tiny channel is a longer distance than
        # Q's two huge ones, so Q is the closer node.
        self.assertGreater(
            self.result[PUB_Q]["closeness_weighted"], self.result[PUB_P]["closeness_weighted"]
        )
        self.assertLess(
            self.result[PUB_Q]["closeness_weighted_rank"],
            self.result[PUB_P]["closeness_weighted_rank"],
        )

    def test_ranks_cover_every_node_exactly_once(self):
        for key in ("closeness_rank", "closeness_weighted_rank"):
            ranks = sorted(row[key] for row in self.result.values())
            self.assertEqual(ranks, list(range(1, len(self.result) + 1)), key)
        # Every node carries both scores.
        for row in self.result.values():
            self.assertIn("closeness_weighted", row)
            self.assertIsNotNone(row["closeness_weighted"])
            self.assertIsNotNone(row["closeness_weighted_rank"])

    def test_without_a_weight_the_weighted_copy_matches(self):
        plain = compute_metrics(ADJACENCY, samples=8, seed=1)["nodes"]
        for pubkey, row in plain.items():
            self.assertAlmostEqual(row["closeness_weighted"], row["closeness"])
            self.assertEqual(row["closeness_weighted_rank"], row["closeness_rank"])


if __name__ == "__main__":
    unittest.main()
