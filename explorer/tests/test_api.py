import json
import tempfile
import unittest
from pathlib import Path

from explorer.app import create_app
from explorer.config import Settings
from explorer.rgs import ParsedChannel, ParsedGraph, ParsedNode, Policy
from explorer.store import Store


PUB_A = "02" + "11" * 32
PUB_B = "02" + "22" * 32
PUB_C = "03" + "33" * 32


def sample_graph() -> ParsedGraph:
    nodes = {
        PUB_A: ParsedNode(pubkey=PUB_A, addresses=["1.2.3.4:9735"]),
        PUB_B: ParsedNode(pubkey=PUB_B, addresses=["example.onion:9735"]),
        PUB_C: ParsedNode(pubkey=PUB_C, addresses=["[2001:db8::1]:9735"]),
    }
    nodes[PUB_A].alias = "Alpha"  # type: ignore[attr-defined]
    nodes[PUB_B].alias = "Bravo"  # type: ignore[attr-defined]
    channels = {
        100: ParsedChannel(
            scid=100,
            node1=PUB_A,
            node2=PUB_B,
            capacity=5_000_000,
            policy1=Policy(1000, 50, 40, 1000, 5_000_000_000, False),
            policy2=Policy(0, 1, 40, 1000, 5_000_000_000, False),
        ),
        200: ParsedChannel(
            scid=200,
            node1=PUB_A,
            node2=PUB_C,
            capacity=1_000_000,
            policy1=Policy(500, 100, 144, 1, 1_000_000_000, False),
            policy2=Policy(2000, 200, 40, 1000, 1_000_000_000, True),
        ),
    }
    return ParsedGraph(version=1, chain_hash=b"", timestamp=1_700_000_000, nodes=nodes, channels=channels)


class ApiTest(unittest.TestCase):
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
        self.store.install_graph(sample_graph(), "test", "fixture")
        self.store.recompute_metrics(samples=3)
        self.client = create_app(
            self.settings, store=self.store, start_background=False
        ).test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def test_health_and_pages(self):
        health = self.client.get("/api/health")
        self.assertEqual(health.status_code, 200)
        self.assertTrue(health.get_json()["ready"])
        for path in ("/", "/nodes", "/stats", f"/node/{PUB_A}", "/channel/100", "/search"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)
            self.assertIn(b"bolt.observer", response.data)

    def test_node_channel_search_and_path(self):
        listed = self.client.get("/api/nodes?sort=total_capacity&dir=desc").get_json()
        self.assertEqual(listed["total_count"], 3)
        self.assertEqual(listed["objects"][0]["alias"], "Alpha")
        self.assertGreater(listed["objects"][0]["total_capacity"], 0)
        self.assertIsNotNone(listed["objects"][0]["betweenness_rank"])

        node = self.client.get(f"/api/nodes/{PUB_A}").get_json()
        self.assertEqual(node["alias"], "Alpha")
        self.assertTrue(node["ipv4"])
        self.assertEqual(node["num_channels"], 2)

        channels = self.client.get(f"/api/nodes/{PUB_A}/channels").get_json()
        self.assertEqual(channels["total_count"], 2)

        channel = self.client.get("/api/channels/100").get_json()
        self.assertEqual(channel["capacity"], 5_000_000)
        self.assertEqual(channel["node1"]["alias"], "Alpha")

        found = self.client.get("/api/search?q=bravo").get_json()
        self.assertEqual(found["nodes"][0]["pubkey"], PUB_B)

        filtered = self.client.get(
            "/api/nodes?condition=num_channels|gt|1&quantifier=all"
        ).get_json()
        self.assertEqual([row["pubkey"] for row in filtered["objects"]], [PUB_A])

        tor_only = self.client.get("/api/nodes?protocol=tor").get_json()
        self.assertEqual(tor_only["total_count"], 1)
        self.assertEqual(tor_only["objects"][0]["alias"], "Bravo")

        route = self.client.get(f"/api/path?source={PUB_B}&target={PUB_C}").get_json()
        self.assertEqual(route["hops"], 2)
        self.assertEqual(route["path"][1]["alias"], "Alpha")

        graph = self.client.get("/api/graph?min_channels=1&limit=100").get_json()
        self.assertEqual(graph["shown_nodes"], 3)
        self.assertEqual(graph["shown_edges"], 2)
        bare = self.client.get("/api/graph").get_json()
        self.assertLessEqual(bare["limit"], 400)
        self.assertLessEqual(bare["shown_nodes"], 400)

        missing = self.client.get("/api/nodes/" + "02" + "ab" * 32)
        self.assertEqual(missing.status_code, 404)
        self.assertEqual(missing.get_json()["error"], "node not found")
        bad_channels = self.client.get("/api/nodes/not-a-key/channels")
        self.assertEqual(bad_channels.status_code, 404)
        self.assertTrue(bad_channels.is_json)
        trailing = self.client.get("/api/nodes/not-a-key/channels/")
        self.assertEqual(trailing.status_code, 404)
        self.assertTrue(trailing.is_json)
        unknown = self.client.get("/api/does-not-exist")
        self.assertEqual(unknown.status_code, 404)
        self.assertEqual(unknown.get_json()["error"], "not found")

    def test_feature_filter_autocomplete_and_node_view_fields(self):
        self.store.apply_node_enrichment(PUB_A, {"features": [18, 24]})
        self.store.apply_node_enrichment(PUB_B, {"features": [8]})

        node = self.client.get(f"/api/nodes/{PUB_A}").get_json()
        self.assertIn("closeness_weighted_rank", node)
        self.assertIsNotNone(node["closeness_weighted_rank"])
        self.assertIn("features", node)
        names = {feature["name"] for feature in node["features"]}
        self.assertIn("option_support_large_channel", names)
        self.assertIn("option_route_blinding", names)
        self.assertTrue(node["wumbo"])
        self.assertTrue(node["route_blinding"])
        # Features unknown -> nothing announced, not "no wumbo".
        unknown = self.client.get(f"/api/nodes/{PUB_C}").get_json()
        self.assertEqual(unknown["features"], [])
        self.assertIsNone(unknown["wumbo"])
        known_without = self.client.get(f"/api/nodes/{PUB_B}").get_json()
        self.assertFalse(known_without["wumbo"])

        filtered = self.client.get("/api/nodes?feature=wumbo").get_json()
        self.assertEqual({row["pubkey"] for row in filtered["objects"]}, {PUB_A})
        invalid = self.client.get("/api/nodes?feature=nonsense")
        self.assertEqual(invalid.status_code, 400)

        status = self.client.get("/api/status").get_json()
        self.assertEqual(status["features_known"], 2)

    def test_autocomplete_min_length_and_matches(self):
        short = self.client.get("/api/autocomplete?q=a")
        self.assertEqual(short.status_code, 200)
        self.assertEqual(short.get_json(), [])
        empty = self.client.get("/api/autocomplete?q=")
        self.assertEqual(empty.status_code, 200)
        self.assertEqual(empty.get_json(), [])
        matched = self.client.get("/api/autocomplete?q=al&limit=8").get_json()
        self.assertEqual(matched[0]["pubkey"], PUB_A)
        self.assertEqual(matched[0]["alias"], "Alpha")
        self.assertGreater(matched[0]["num_channels"], 0)
        by_key = self.client.get(f"/api/autocomplete?q={PUB_B[:6]}").get_json()
        self.assertEqual(by_key[0]["pubkey"], PUB_B)

    def test_roundtrip_persistence(self):
        self.store.save()
        restored = Store(self.store.db_path)
        restored.open()
        self.assertEqual(len(restored.channels), 2)
        self.assertEqual(restored.nodes[PUB_A].alias, "Alpha")
        self.assertEqual(restored.channels[100].policy1.ppm, 50)
        self.assertTrue(restored.metrics_meta["ready"] or restored.metrics)


if __name__ == "__main__":
    unittest.main()
