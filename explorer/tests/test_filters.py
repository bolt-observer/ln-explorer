"""Multi-condition node filters, filter-fields, and the node channels table."""

import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote

from explorer.app import create_app
from explorer.config import Settings
from explorer.rgs import ParsedChannel, ParsedGraph, ParsedNode, Policy
from explorer.store import FILTER_FIELDS, Store, validate_filter_tree

HUB = "02" + "aa" * 32
N4 = "02" + "bb" * 32
NT = "03" + "cc" * 32
NB = "02" + "dd" * 32

# Distinct funding blocks so the age column is testable; the newest block
# (750000) is the approximate chain tip.
CH_V4 = (700000 << 40) | 1  # HUB - Clearnet, 3M sats, enabled
CH_TOR = (720000 << 40) | 2  # HUB - Onion, 5M sats, enabled
CH_DEAD = (750000 << 40) | 3  # HUB - Both, 1M sats, disabled both ways
CH_LINK = (730000 << 40) | 4  # Onion - Both, 2M sats, enabled
CH_NOCAP = (710000 << 40) | 5  # HUB - Clearnet, capacity unknown


def scid(block: int, index: int) -> int:
    return (block << 40) | index


def policy(base: int, ppm: int, cltv: int, disabled: bool = False) -> Policy:
    return Policy(base, ppm, cltv, 1000, 900_000_000, disabled)


def sample_graph() -> ParsedGraph:
    nodes = {
        HUB: ParsedNode(pubkey=HUB, addresses=["9.9.9.9:9735"]),
        N4: ParsedNode(pubkey=N4, addresses=["8.8.8.8:9735"]),
        NT: ParsedNode(pubkey=NT, addresses=["abcdefghijklmnop.onion:9735"]),
        NB: ParsedNode(pubkey=NB, addresses=["7.7.7.7:9735", "qrstuvwxyz12345.onion:9735"]),
    }
    nodes[HUB].alias = "Hub"  # type: ignore[attr-defined]
    nodes[N4].alias = "Clearnet"  # type: ignore[attr-defined]
    nodes[NT].alias = "Onion"  # type: ignore[attr-defined]
    nodes[NB].alias = "Both"  # type: ignore[attr-defined]
    channels = {
        CH_V4: ParsedChannel(
            scid=CH_V4, node1=HUB, node2=N4, capacity=3_000_000,
            policy1=policy(1000, 100, 40), policy2=policy(2000, 200, 80),
        ),
        CH_TOR: ParsedChannel(
            scid=CH_TOR, node1=HUB, node2=NT, capacity=5_000_000,
            policy1=policy(500, 50, 80), policy2=policy(0, 1, 144),
        ),
        CH_DEAD: ParsedChannel(
            scid=CH_DEAD, node1=HUB, node2=NB, capacity=1_000_000,
            policy1=policy(2000, 300, 144, disabled=True),
            policy2=policy(4000, 400, 40, disabled=True),
        ),
        CH_LINK: ParsedChannel(
            scid=CH_LINK, node1=NT, node2=NB, capacity=2_000_000,
            policy1=policy(300, 30, 40), policy2=policy(600, 60, 40),
        ),
        CH_NOCAP: ParsedChannel(
            scid=CH_NOCAP, node1=HUB, node2=N4, capacity=None,
            policy1=policy(700, 70, 40), policy2=policy(800, 80, 40),
        ),
    }
    return ParsedGraph(
        version=1, chain_hash=b"", timestamp=1_700_000_000,
        nodes=nodes, channels=channels,
    )


def leaf(field: str, rel: str, value) -> dict:
    return {"field": field, "rel": rel, "value": value}


class FilterTestBase(unittest.TestCase):
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
        self.store.recompute_metrics(samples=4)
        self.client = create_app(
            self.settings, store=self.store, start_background=False
        ).test_client()

    def tearDown(self):
        self.tmp.cleanup()

    def nodes(self, query: str):
        response = self.client.get(f"/api/nodes?{query}")
        self.assertEqual(response.status_code, 200, response.get_json())
        return {row["pubkey"] for row in response.get_json()["objects"]}

    def nodes_with_filter(self, tree) -> set:
        return self.nodes(f"filter={quote(json.dumps(tree))}")


class NestedFilterTest(FilterTestBase):
    def test_and_or_not_evaluation(self):
        # Hub: 4 channels, ipv4. Clearnet: 2, ipv4. Onion: 2, tor. Both: 2, ipv4+tor.
        tor = leaf("tor", "eq", 1)
        two = leaf("num_channels", "gte", 2)
        self.assertEqual(
            self.nodes_with_filter({"op": "and", "items": [tor, two]}), {NT, NB}
        )
        self.assertEqual(
            self.nodes_with_filter(
                {"op": "or", "items": [leaf("num_channels", "gt", 3), tor]}
            ),
            {HUB, NT, NB},
        )
        # "not" negates the OR of its items.
        self.assertEqual(self.nodes_with_filter({"op": "not", "items": [tor]}), {HUB, N4})
        self.assertEqual(
            self.nodes_with_filter(
                {"op": "not", "items": [leaf("num_channels", "gt", 3), tor]}
            ),
            {N4},
        )
        # Nested groups: (tor or ipv6) and not (fewer than two channels).
        self.assertEqual(
            self.nodes_with_filter(
                {
                    "op": "and",
                    "items": [
                        {"op": "or", "items": [leaf("tor", "eq", 1), leaf("ipv6", "eq", 1)]},
                        {"op": "not", "items": [leaf("num_channels", "lt", 2)]},
                    ],
                }
            ),
            {NT, NB},
        )

    def test_bool_and_unknown_feature_fields(self):
        # wumbo eq 1 only matches nodes whose feature bits were learned.
        self.store.apply_node_enrichment(NT, {"features": [18]})
        self.assertEqual(
            self.nodes_with_filter({"op": "and", "items": [leaf("wumbo", "eq", 1)]}),
            {NT},
        )
        # Nodes with unknown bits match neither eq 1 nor eq 0.
        self.assertEqual(self.nodes_with_filter({"op": "and", "items": [leaf("wumbo", "eq", 0)]}), set())

    def test_flat_conditions_keep_working(self):
        # Channel counts in the fixture: Hub 4, Clearnet 2, Onion 2, Both 2.
        self.assertEqual(self.nodes("condition=num_channels|gte|2"), {HUB, N4, NT, NB})
        self.assertEqual(self.nodes("condition=num_channels|lte|1"), set())
        self.assertEqual(self.nodes("condition=num_channels|neq|2"), {HUB})
        self.assertEqual(
            self.nodes("condition=tor|eq|1&condition=ipv4|eq|1"), {NB}
        )
        self.assertEqual(
            self.nodes(
                "condition=num_channels|gt|3&condition=tor|eq|1&quantifier=any"
            ),
            {HUB, NT, NB},
        )
        self.assertEqual(
            self.nodes("condition=num_channels|gt|1&quantifier=none"), set()
        )


class FilterValidationTest(FilterTestBase):
    def bad(self, query: str):
        response = self.client.get(f"/api/nodes?{query}")
        self.assertEqual(response.status_code, 400, query)
        self.assertTrue(response.get_json()["error"])
        return response.get_json()["error"]

    def test_bad_field_relation_value(self):
        self.bad(f"filter={quote(json.dumps({'op': 'and', 'items': [leaf('bogus', 'gt', 1)]}))}")
        self.bad(f"filter={quote(json.dumps({'op': 'and', 'items': [leaf('tor', 'like', 1)]}))}")
        self.bad(f"filter={quote(json.dumps({'op': 'and', 'items': [leaf('tor', 'eq', 'yes')]}))}")
        self.bad(f"filter={quote(json.dumps({'op': 'xor', 'items': [leaf('tor', 'eq', 1)]}))}")
        self.bad(f"filter={quote(json.dumps({'op': 'and', 'items': []}))}")
        self.bad(f"filter={quote(json.dumps({'op': 'and', 'items': [3]}))}")
        self.bad(f"filter={quote(json.dumps([leaf('tor', 'eq', 1)]))}")
        self.bad("filter=not-json")
        self.assertIn("unknown filter field", self.bad("condition=bogus|gt|1"))
        self.bad("condition=num_channels|like|1")
        self.bad("condition=num_channels|gt|abc")
        self.bad("condition=num_channels|gt")

    def test_depth_and_leaf_limits(self):
        ok_depth = {"op": "and", "items": [
            {"op": "or", "items": [{"op": "not", "items": [leaf("tor", "eq", 1)]}]}
        ]}
        self.assertEqual(
            validate_filter_tree(ok_depth),
            {"op": "and", "items": [
                {"op": "or", "items": [
                    {"op": "not", "items": [{"field": "tor", "rel": "eq", "value": 1.0}]}
                ]}
            ]},
        )
        too_deep = leaf("tor", "eq", 1)
        for _ in range(4):
            too_deep = {"op": "and", "items": [too_deep]}
        self.bad(f"filter={quote(json.dumps(too_deep))}")

        leaves = [leaf("num_channels", "gte", 0) for _ in range(20)]
        self.assertEqual(self.nodes_with_filter({"op": "and", "items": leaves}), {HUB, N4, NT, NB})
        self.bad(f"filter={quote(json.dumps({'op': 'and', 'items': leaves + [leaf('tor', 'eq', 1)]}))}")

    def test_leaf_counts_across_groups(self):
        # 21 leaves split over nested groups are still 21.
        tree = {
            "op": "or",
            "items": [
                {"op": "and", "items": [leaf("num_channels", "gt", index) for index in range(10)]},
                {"op": "and", "items": [leaf("num_channels", "gt", index) for index in range(11)]},
            ],
        }
        self.bad(f"filter={quote(json.dumps(tree))}")

    def test_protocol_and_match_validation(self):
        self.bad("protocol=ipx")
        self.bad("protocol=ipv4&protocol_match=both")
        self.assertEqual(self.nodes("protocol=ipv4,tor&protocol_match=all"), {NB})
        self.assertEqual(self.nodes("protocol=ipv4,tor&protocol_match=any"), {HUB, N4, NT, NB})
        # Default is any, like the original explorer's OR.
        self.assertEqual(self.nodes("protocol=ipv4,tor"), {HUB, N4, NT, NB})
        self.assertEqual(self.nodes("protocol=ipv4"), {HUB, N4, NB})


class FilterFieldsTest(FilterTestBase):
    def test_filter_fields_endpoint(self):
        response = self.client.get("/api/filter-fields")
        self.assertEqual(response.status_code, 200)
        fields = response.get_json()
        self.assertTrue(fields)
        by_name = {row["field"]: row for row in fields}
        self.assertEqual(set(by_name), set(FILTER_FIELDS))
        self.assertEqual(by_name["num_channels"]["label"], "Channels")
        self.assertEqual(by_name["num_channels"]["kind"], "number")
        self.assertIsNone(by_name["num_channels"]["unit"])
        self.assertEqual(by_name["total_capacity"]["unit"], "sat")
        self.assertEqual(by_name["first_seen"]["unit"], "unix")
        self.assertEqual(by_name["wumbo"]["kind"], "bool")
        for rank in ("betweenness_rank", "closeness_weighted_rank", "eigenvector_rank"):
            self.assertIn(rank, by_name)
        self.assertIn("shortest_path", by_name)


class NodeChannelsTest(FilterTestBase):
    def hub_rows(self, **kwargs):
        result = self.store.channels_for(HUB, 1, 50, **kwargs)
        return result["objects"]

    def test_default_sort_is_capacity_desc(self):
        rows = self.hub_rows()
        self.assertEqual([row["scid"] for row in rows], [str(CH_TOR), str(CH_V4), str(CH_DEAD), str(CH_NOCAP)])

    def test_missing_values_sort_last(self):
        rows = self.hub_rows(sort="capacity", direction="asc")
        self.assertEqual(rows[-1]["scid"], str(CH_NOCAP))
        self.assertEqual(rows[-1]["capacity"], None)
        rows = self.hub_rows(sort="capacity", direction="desc")
        self.assertEqual(rows[-1]["scid"], str(CH_NOCAP))

    def test_sort_keys(self):
        rows = self.hub_rows(sort="out_ppm", direction="asc")
        self.assertEqual(
            [row["outgoing"]["fee_rate_ppm"] for row in rows], [50, 70, 100, 300]
        )
        rows = self.hub_rows(sort="in_base", direction="desc")
        self.assertEqual(
            [row["incoming"]["base_fee_msat"] for row in rows], [4000, 2000, 800, 0]
        )
        rows = self.hub_rows(sort="cltv", direction="desc")
        self.assertEqual(
            [row["outgoing"]["cltv_delta"] for row in rows], [144, 80, 40, 40]
        )
        # Age in days: oldest funding block first when descending.
        rows = self.hub_rows(sort="age", direction="desc")
        self.assertEqual(
            [row["funding_block"] for row in rows], [700000, 710000, 720000, 750000]
        )
        self.assertAlmostEqual(rows[0]["age_days"], 50000 / 144)
        self.assertAlmostEqual(rows[-1]["age_days"], 0.0)
        rows = self.hub_rows(sort="short_id", direction="asc")
        self.assertEqual([row["scid"] for row in rows], [str(CH_V4), str(CH_NOCAP), str(CH_TOR), str(CH_DEAD)])
        rows = self.hub_rows(sort="peer_alias", direction="asc")
        self.assertEqual([row["peer_alias"] for row in rows], ["Both", "Clearnet", "Clearnet", "Onion"])

    def test_text_filter(self):
        rows = self.hub_rows(q="onion")
        self.assertEqual([row["scid"] for row in rows], [str(CH_TOR)])
        rows = self.hub_rows(q=f"{700000}x0x1")
        self.assertEqual([row["scid"] for row in rows], [str(CH_V4)])
        rows = self.hub_rows(q=str(CH_V4))
        self.assertEqual([row["scid"] for row in rows], [str(CH_V4)])
        rows = self.hub_rows(q=NT[:20])
        self.assertEqual([row["scid"] for row in rows], [str(CH_TOR)])
        # Alias words combine with AND.
        rows = self.hub_rows(q="clear")
        self.assertEqual({row["scid"] for row in rows}, {str(CH_V4), str(CH_NOCAP)})
        rows = self.hub_rows(q="clear zzz")
        self.assertEqual(rows, [])

    def test_state_filter(self):
        rows = self.hub_rows(state="disabled")
        self.assertEqual([row["scid"] for row in rows], [str(CH_DEAD)])
        self.assertEqual(rows[0]["state"], "disabled")
        rows = self.hub_rows(state="active")
        self.assertEqual({row["scid"] for row in rows}, {str(CH_V4), str(CH_TOR), str(CH_NOCAP)})
        self.assertTrue(all(row["state"] == "active" for row in rows))
        self.assertEqual(len(self.hub_rows(state="all")), 4)

    def test_row_carries_policies_and_htlc_bounds(self):
        row = self.hub_rows(q="onion")[0]
        self.assertEqual(row["outgoing"]["min_htlc_msat"], 1000)
        self.assertEqual(row["outgoing"]["max_htlc_msat"], 900_000_000)
        self.assertEqual(row["incoming"]["cltv_delta"], 144)
        self.assertEqual(row["peer_pubkey"], NT)

    def test_api_params_validated(self):
        base = f"/api/nodes/{HUB}/channels"
        body = self.client.get(base).get_json()
        self.assertEqual(body["total_count"], 4)
        self.assertEqual(body["price"], None)
        body = self.client.get(f"{base}?sort=out_ppm&dir=asc&state=active&q=onion").get_json()
        self.assertEqual([row["scid"] for row in body["objects"]], [str(CH_TOR)])
        for query in (
            f"{base}?sort=bogus",
            f"{base}?dir=up",
            f"{base}?state=off",
        ):
            response = self.client.get(query)
            self.assertEqual(response.status_code, 400, query)
            self.assertTrue(response.get_json()["error"])

    def test_api_price_block(self):
        self.store.set_current_prices({"USD": 50_000.0, "EUR": 40_000.0, "time": 123})
        body = self.client.get(f"/api/nodes/{HUB}/channels").get_json()
        self.assertEqual(body["price"], {"usd": 50_000.0, "eur": 40_000.0})
        self.store.set_current_prices({"EUR": 40_000.0})
        body = self.client.get(f"/api/nodes/{HUB}/channels").get_json()
        self.assertEqual(body["price"], {"usd": None, "eur": 40_000.0})

    def test_page_size_and_pagination(self):
        body = self.client.get(f"/api/nodes/{HUB}/channels?page=1&page_size=2").get_json()
        self.assertEqual(len(body["objects"]), 2)
        self.assertEqual(body["pages"], 2)
        body = self.client.get(f"/api/nodes/{HUB}/channels?page=9&page_size=2").get_json()
        self.assertEqual(body["page"], 2)


if __name__ == "__main__":
    unittest.main()
