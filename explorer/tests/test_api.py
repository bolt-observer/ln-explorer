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

    def test_icons_are_served_and_shipped(self):
        """Every icon the HTML or manifest references exists, is an image, and is in the image."""
        import re
        root = Path(__file__).resolve().parents[2]
        html = self.client.get("/").get_data(as_text=True)
        links = re.findall(r'<link rel="(?:icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"', html)
        manifest_href = next(href for href in links if "manifest" in href)
        manifest = self.client.get(manifest_href).get_json()
        sizes = {icon["sizes"] for icon in manifest["icons"]}
        self.assertTrue({"192x192", "512x512"} <= sizes)
        self.assertTrue(any(icon.get("purpose") == "maskable" for icon in manifest["icons"]))
        hrefs = [href for href in links if href != manifest_href]
        hrefs += [icon["src"] for icon in manifest["icons"]] + ["/favicon.ico"]
        self.assertIn("/favicon.ico?v=", " ".join(links))
        docker = (root / "Dockerfile").read_text(encoding="utf-8")
        for href in hrefs:
            with self.subTest(href=href):
                response = self.client.get(href)
                self.assertEqual(response.status_code, 200)
                self.assertTrue(response.mimetype.startswith("image/"), response.mimetype)
                self.assertIn("web/" + href.split("?")[0].lstrip("/"), docker)

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

    def test_node_summary_bins_and_peers(self):
        summary = self.client.get(f"/api/nodes/{PUB_A}/summary").get_json()
        histogram = summary["capacity_histogram"]
        self.assertEqual(len(histogram["counts"]), len(histogram["edges"]) + 1)
        # Capacities on a bin edge belong to the bucket that starts there.
        five_m = histogram["edges"].index(5_000_000) + 1
        one_m = histogram["edges"].index(1_000_000) + 1
        self.assertEqual(histogram["counts"][five_m], 1)
        self.assertEqual(histogram["counts"][one_m], 1)
        self.assertEqual(sum(histogram["counts"]), 2)
        self.assertEqual(summary["peer_count"], 2)
        self.assertEqual([peer["pubkey"] for peer in summary["peers"]], [PUB_B, PUB_C])
        self.assertEqual(summary["peers"][0]["capacity"], 5_000_000)

        limited = self.client.get(f"/api/nodes/{PUB_A}/summary?peers=1").get_json()
        self.assertEqual(len(limited["peers"]), 1)
        self.assertEqual(limited["peer_count"], 2)

        self.store.channels[200].capacity = None
        unknown = self.client.get(f"/api/nodes/{PUB_A}/summary").get_json()
        self.assertEqual(unknown["capacity_histogram"]["unknown"], 1)
        self.assertEqual(sum(unknown["capacity_histogram"]["counts"]), 1)
        self.assertEqual(unknown["peer_count"], 2)

        missing = self.client.get("/api/nodes/" + "02" + "ab" * 32 + "/summary")
        self.assertEqual(missing.status_code, 404)

    def test_sort_by_hops_needs_reference(self):
        by_hops = self.client.get(
            f"/api/nodes?reference={PUB_B}&sort=shortest_path&dir=asc"
        ).get_json()
        self.assertEqual([row["pubkey"] for row in by_hops["objects"]], [PUB_B, PUB_A, PUB_C])
        self.assertEqual([row["shortest_path"] for row in by_hops["objects"]], [0, 1, 2])
        # Without a reference there is no hop count, so the capacity sort applies.
        plain = self.client.get("/api/nodes?sort=shortest_path&dir=asc").get_json()
        by_capacity = self.client.get("/api/nodes?sort=total_capacity&dir=asc").get_json()
        self.assertEqual(
            [row["pubkey"] for row in plain["objects"]],
            [row["pubkey"] for row in by_capacity["objects"]],
        )

    def test_roundtrip_persistence(self):
        self.store.save()
        restored = Store(self.store.db_path)
        restored.open()
        self.assertEqual(len(restored.channels), 2)
        self.assertEqual(restored.nodes[PUB_A].alias, "Alpha")
        self.assertEqual(restored.channels[100].policy1.ppm, 50)
        self.assertTrue(restored.metrics_meta["ready"] or restored.metrics)


class GraphFiltersTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.store = Store(str(Path(self.tmp.name) / "explorer.sqlite"))
        self.store.open()
        self.addCleanup(self.store._conn.close)
        settings = Settings(
            data_dir=self.tmp.name, mempool_api="", disable_refresh=True,
            web_dir=str(Path(__file__).resolve().parents[2] / "web"),
            refresh_seconds=0,
        )
        self.client = create_app(
            settings, store=self.store, start_background=False
        ).test_client()
        self.keys = {name: self.pubkey(index) for index, name in enumerate(
            ("v4", "dual", "hybrid", "v6", "tor", "unknown", "disconnected"), 1
        )}
        addresses = {
            "v4": ["1.2.3.4:9735"],
            "dual": ["2.3.4.5:9735", "[2001:db8::1]:9735"],
            "hybrid": ["3.4.5.6:9735", "hybrid.onion:9735"],
            "v6": ["[2001:db8::2]:9735"],
            "tor": ["only.onion:9735"],
            "unknown": [],
            "disconnected": ["4.5.6.7:9735"],
        }
        nodes = {
            key: ParsedNode(pubkey=key, addresses=addresses[name])
            for name, key in self.keys.items()
        }
        chain = ("v4", "dual", "hybrid", "v6", "tor", "unknown")
        channels = {
            index: ParsedChannel(
                scid=index, node1=self.keys[left], node2=self.keys[right],
                capacity=capacity,
            )
            for index, (left, right, capacity) in enumerate(
                zip(chain, chain[1:], (100, 200, 300, 400, None)), 1
            )
        }
        self.install(nodes, channels)
        self.store.apply_node_enrichment(self.keys["dual"], {"features": [18]})
        self.store.apply_node_enrichment(self.keys["hybrid"], {"features": [19]})

    @staticmethod
    def pubkey(index):
        return "02" + f"{index:064x}"

    def install(self, nodes, channels):
        self.store.install_graph(ParsedGraph(
            version=1, chain_hash=b"", timestamp=1_700_000_000,
            nodes=nodes, channels=channels,
        ), "test", "graph filters")

    def graph(self, **params):
        response = self.client.get("/api/graph", query_string=params)
        self.assertEqual(response.status_code, 200)
        return response.get_json()

    def assert_nodes(self, result, names):
        expected = {self.keys[name] for name in names}
        self.assertEqual({node["pubkey"] for node in result["nodes"]}, expected)
        self.assertEqual(result["shown_nodes"], len(expected))
        self.assertEqual(result["matched_nodes"], len(expected))
        self.assertEqual(result["total_nodes"], 6)
        self.assertEqual(result["shown_edges"], len(result["edges"]))
        for edge in result["edges"]:
            self.assertIn(edge["a"], expected)
            self.assertIn(edge["b"], expected)

    def test_network_sets_are_exclusive_and_unfiltered_keeps_no_address(self):
        self.assert_nodes(self.graph(), ("v4", "dual", "hybrid", "v6", "tor", "unknown"))
        for network, names in (
            ("clearnet", ("v4", "dual", "v6")),
            ("tor", ("tor",)),
            ("hybrid", ("hybrid",)),
        ):
            with self.subTest(network=network):
                result = self.graph(network=network)
                self.assert_nodes(result, names)
                self.assertEqual(result["filters"]["network"], network)
        # The IPv6-only match is retained even without a selected neighbor.
        result = self.graph(network="clearnet")
        self.assertEqual(len(result["edges"]), 1)
        self.assertEqual(
            {result["edges"][0]["a"], result["edges"][0]["b"]},
            {self.keys["v4"], self.keys["dual"]},
        )

    def test_ip_families_include_dual_stack_and_combine_with_network(self):
        self.assert_nodes(self.graph(ip="ipv4"), ("v4", "dual", "hybrid"))
        self.assert_nodes(self.graph(ip="ipv6"), ("dual", "v6"))
        self.assert_nodes(self.graph(network="clearnet", ip="ipv4"), ("v4", "dual"))
        self.assert_nodes(self.graph(network="tor", ip="ipv4"), ())
        self.assert_nodes(self.graph(network="hybrid", ip="ipv6"), ())

    def test_combined_filters_and_inclusive_minima(self):
        params = dict(network="clearnet", ip="ipv4", min_capacity=300,
                      min_channels=2, feature="wumbo")
        result = self.graph(**params)
        self.assert_nodes(result, ("dual",))
        self.assertEqual(result["filters"], params)
        self.assertEqual(result["edges"], [])
        self.assert_nodes(self.graph(**{**params, "min_capacity": 301}), ())
        self.assert_nodes(self.graph(**{**params, "min_channels": 3}), ())
        self.assert_nodes(self.graph(min_channels=2), ("dual", "hybrid", "v6", "tor"))
        self.assert_nodes(self.graph(min_capacity=0),
                          ("v4", "dual", "hybrid", "v6", "tor", "unknown"))
        self.assert_nodes(self.graph(min_capacity=1), ("v4", "dual", "hybrid", "v6", "tor"))

    def test_all_feature_filters_use_announced_bits(self):
        for feature, bit in (
            ("wumbo", 19), ("anchors", 23), ("dual_fund", 29),
            ("onion_messages", 39), ("route_blinding", 25),
        ):
            with self.subTest(feature=feature):
                self.store.apply_node_enrichment(self.keys["v4"], {"features": [bit]})
                self.assert_nodes(self.graph(feature=feature, min_channels=1, min_capacity=100,
                                             network="clearnet", ip="ipv4"),
                                  ("v4", "dual") if feature == "wumbo" else ("v4",))

    def test_filters_precede_limit_and_auto_threshold(self):
        hub = self.pubkey(100)
        leaves = [self.pubkey(index) for index in range(101, 161)]
        nodes = {hub: ParsedNode(pubkey=hub, addresses=["hub.onion:9735"])}
        nodes.update({
            key: ParsedNode(pubkey=key, addresses=["1.2.3.4:9735"])
            for key in leaves
        })
        channels = {
            index: ParsedChannel(scid=index, node1=hub, node2=key, capacity=100)
            for index, key in enumerate(leaves, 1)
        }
        self.install(nodes, channels)
        self.store.apply_node_enrichment(leaves[-1], {"features": [18]})
        unfiltered = self.graph(limit=50)
        self.assertEqual(unfiltered["matched_nodes"], 61)
        self.assertEqual(unfiltered["min_channels"], 2)
        self.assertEqual(unfiltered["shown_nodes"], 1)
        self.assertIsNone(unfiltered["filters"]["min_channels"])
        filtered = self.graph(limit=50, feature="wumbo")
        self.assertEqual([node["pubkey"] for node in filtered["nodes"]], [leaves[-1]])
        self.assertEqual(filtered["matched_nodes"], 1)
        self.assertEqual(filtered["min_channels"], 1)
        self.assertEqual(filtered["total_nodes"], 61)
        limited = self.graph(limit=50, network="clearnet", min_channels=1)
        self.assertEqual(limited["matched_nodes"], 60)
        self.assertEqual(limited["shown_nodes"], 50)
        self.assertEqual(limited["edges"], [])
        self.assertNotIn(hub, {node["pubkey"] for node in limited["nodes"]})
        explicit = self.graph(limit=50, min_channels=2)
        self.assertEqual(explicit["matched_nodes"], 1)
        self.assertEqual(explicit["filters"]["min_channels"], 2)
        auto = self.graph(limit=50, network="clearnet")
        self.assertEqual(auto["matched_nodes"], 60)
        self.assertEqual(auto["shown_nodes"], 50)
        self.assertEqual(auto["min_channels"], 1)
        self.assertEqual(auto["edges"], [])

    def test_empty_results_and_normalized_omitted_filters(self):
        empty = self.graph(min_capacity=1000)
        self.assert_nodes(empty, ())
        self.assertEqual(empty["edges"], [])
        self.assertEqual(empty["min_channels"], 1)
        expected = dict(network=None, ip=None, min_capacity=None,
                        min_channels=None, feature=None)
        self.assertEqual(self.graph()["filters"], expected)
        self.assertEqual(self.graph(network="", ip="", min_capacity="",
                                    min_channels="auto", feature="")["filters"], expected)
        self.assertEqual(self.graph(network="all", ip="all", feature="all")["filters"], expected)

    def test_invalid_filters_return_json_400(self):
        for name, values in {
            "network": ("ipv4", "unknown"),
            "ip": ("tor", "ipv5"),
            "feature": ("unknown",),
            "min_capacity": ("-1", "1.5", "NaN", "1e8"),
        }.items():
            for value in values:
                with self.subTest(name=name, value=value):
                    response = self.client.get("/api/graph", query_string={name: value})
                    self.assertEqual(response.status_code, 400)
                    self.assertIsInstance(response.get_json()["error"], str)


if __name__ == "__main__":
    unittest.main()
