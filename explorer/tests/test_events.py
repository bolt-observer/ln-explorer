"""Change events from snapshot diffs, closure lookups, and rank history."""

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from explorer.app import create_app
from explorer.config import Settings
from explorer.refresh import resolve_closures
from explorer.rgs import ParsedChannel, ParsedGraph, ParsedNode, Policy, format_scid
from explorer.sources import SourceError
from explorer.store import CLOSE_MAX_LOOKUPS, EVENT_HARD_CAP, Store

PUB_A = "02" + "11" * 32
PUB_B = "02" + "22" * 32
PUB_C = "03" + "33" * 32
PUB_D = "03" + "44" * 32

DAY = 86400
DAY1 = 1_700_000_000 // DAY * DAY
DAY2 = DAY1 + DAY
NOW = 1_790_000_000


def scid_of(block: int, tx: int = 1, out: int = 0) -> int:
    return (block << 40) | (tx << 16) | out


SCID_AB = scid_of(100, 1)
SCID_AC = scid_of(101, 2)
SCID_FRESH = scid_of(800_000, 3)
SCID_STALE = scid_of(700_000, 4)


def policy(ppm: int = 1, base: int = 1000, disabled: bool = False) -> Policy:
    return Policy(base, ppm, 40, 1, 1_000_000_000, disabled)


def parsed_node(pubkey: str, alias: str = "", addresses: list | None = None) -> ParsedNode:
    node = ParsedNode(pubkey=pubkey, addresses=addresses or [])
    if alias:
        node.alias = alias  # type: ignore[attr-defined]
    return node


def base_graph(ts: int) -> ParsedGraph:
    """A-B (A's policy flips disabled->enabled later) and A-C."""
    nodes = {
        PUB_A: parsed_node(PUB_A, "Alpha", ["1.2.3.4:9735"]),
        PUB_B: parsed_node(PUB_B, "Bravo"),
        PUB_C: parsed_node(PUB_C, "Charlie"),
    }
    channels = {
        SCID_AB: ParsedChannel(
            scid=SCID_AB,
            node1=PUB_A,
            node2=PUB_B,
            capacity=5_000_000,
            policy1=policy(ppm=50),
            policy2=policy(ppm=1, disabled=True),
        ),
        SCID_AC: ParsedChannel(
            scid=SCID_AC,
            node1=PUB_A,
            node2=PUB_C,
            capacity=1_000_000,
            policy1=policy(ppm=100),
            policy2=policy(ppm=100),
        ),
    }
    return ParsedGraph(version=1, chain_hash=b"", timestamp=ts, nodes=nodes, channels=channels)


def next_graph(ts: int) -> ParsedGraph:
    """A-C closed, fresh B-C open, old C-D re-announced, A's fees change."""
    nodes = dict(base_graph(ts).nodes)
    nodes[PUB_D] = parsed_node(PUB_D, "Delta")
    channels = {
        SCID_AB: ParsedChannel(
            scid=SCID_AB,
            node1=PUB_A,
            node2=PUB_B,
            capacity=5_000_000,
            policy1=policy(ppm=80),
            policy2=policy(ppm=1),
        ),
        SCID_FRESH: ParsedChannel(
            scid=SCID_FRESH,
            node1=PUB_B,
            node2=PUB_C,
            capacity=2_000_000,
            policy1=policy(),
            policy2=policy(),
        ),
        SCID_STALE: ParsedChannel(
            scid=SCID_STALE,
            node1=PUB_C,
            node2=PUB_D,
            capacity=3_000_000,
            policy1=policy(),
            policy2=policy(),
        ),
    }
    return ParsedGraph(version=1, chain_hash=b"", timestamp=ts, nodes=nodes, channels=channels)


class StoreTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.store = Store(str(Path(self.tmp.name) / "explorer.sqlite"))
        self.store.open()

    def tearDown(self):
        self.tmp.cleanup()

    def daily_rows(self) -> dict:
        return {
            (row["day"], row["kind"]): (row["count"], row["capacity"])
            for row in self.store._conn.execute("SELECT * FROM event_daily")
        }

    def closure(self, scid: int) -> dict:
        row = self.store._conn.execute(
            "SELECT * FROM channel_closures WHERE scid = ?", (scid,)
        ).fetchone()
        return dict(row) if row else {}


class SnapshotDiffTest(StoreTestCase):
    def test_diff_detects_open_close_reappeared_and_fee_change(self):
        self.store.install_graph(base_graph(1_000), "test", "fixture")
        self.assertEqual(self.store.query_events(), [])
        self.store.install_graph(next_graph(2_000), "test", "fixture 2")

        events = self.store.query_events(limit=50)
        by_kind = {}
        for event in events:
            by_kind.setdefault(event["kind"], []).append(event)

        self.assertEqual(len(by_kind.get("channel_open", [])), 1)
        opened = by_kind["channel_open"][0]
        self.assertEqual(opened["scid"], SCID_FRESH)
        self.assertEqual((opened["pubkey"], opened["peer"]), (PUB_B, PUB_C))
        self.assertEqual(opened["capacity"], 2_000_000)

        self.assertEqual(len(by_kind.get("channel_reappeared", [])), 1)
        reappeared = by_kind["channel_reappeared"][0]
        self.assertEqual(reappeared["scid"], SCID_STALE)

        self.assertEqual(len(by_kind.get("channel_close", [])), 1)
        closed = by_kind["channel_close"][0]
        self.assertEqual(closed["scid"], SCID_AC)
        self.assertEqual((closed["pubkey"], closed["peer"]), (PUB_A, PUB_C))
        self.assertEqual(closed["capacity"], 1_000_000)

        fee_changes = by_kind.get("policy_fee", [])
        self.assertEqual(len(fee_changes), 1)
        fee = fee_changes[0]
        self.assertEqual(
            (fee["pubkey"], fee["scid"], fee["field"], fee["old"], fee["new"]),
            (PUB_A, SCID_AB, "ppm", "50", "80"),
        )

        # The disabled -> enabled flip is counted, not stored as an event.
        self.assertNotIn("channel_enabled", by_kind)
        daily = self.daily_rows()
        day = next(iter(daily))[0]
        self.assertEqual(daily[(day, "channel_open")], (1, 2_000_000))
        self.assertEqual(daily[(day, "channel_close")], (1, 1_000_000))
        self.assertEqual(daily[(day, "channel_reappeared")], (1, 3_000_000))
        self.assertEqual(daily[(day, "policy_fee")], (1, 0))
        self.assertEqual(daily[(day, "channel_enabled")], (1, 0))

        # The close queued a closure row for the mempool lookup.
        closure = self.closure(SCID_AC)
        self.assertEqual(closure["node1"], PUB_A)
        self.assertEqual(closure["node2"], PUB_C)
        self.assertEqual(closure["capacity"], 1_000_000)
        self.assertIsNone(closure["closing_reason"])
        self.assertEqual(closure["lookups"], 0)

        self.assertIsNotNone(self.store.events_since)
        flows = self.store.flows_payload()
        self.assertFalse(flows["accumulating"])
        self.assertEqual(flows["events_since"], self.store.events_since)

    def test_no_diff_without_previous_graph_or_with_same_timestamp(self):
        self.store.install_graph(base_graph(1_000), "test", "fixture")
        self.assertEqual(self.store.query_events(), [])
        self.assertIsNone(self.store.events_since)
        self.assertTrue(self.store.flows_payload()["accumulating"])

        # Same timestamp: nothing is diffed even though the graph changed.
        self.store.install_graph(next_graph(1_000), "test", "fixture")
        self.assertEqual(self.store.query_events(), [])
        self.assertIsNone(self.store.events_since)

        # A different timestamp against the now-current graph does diff.
        self.store.install_graph(base_graph(1_001), "test", "fixture")
        self.assertTrue(self.store.query_events())


class EnrichmentEventTest(StoreTestCase):
    def test_alias_color_and_address_events_with_flap_suppression(self):
        self.store.install_graph(base_graph(1_000), "test", "fixture")
        # The previous alias is empty, so the first name is not a change.
        self.store.apply_node_enrichment(PUB_A, {"alias": "Alpha", "color": "#aabbcc"})
        self.store.apply_node_enrichment(PUB_A, {"alias": "Renamed"})
        self.store.apply_node_enrichment(PUB_A, {"addresses": ["5.6.7.8:9735"]})
        # Exact reverse of the recorded change inside 24h: suppressed.
        self.store.apply_node_enrichment(PUB_A, {"addresses": ["1.2.3.4:9735"]})
        self.store.apply_node_enrichment(PUB_A, {"addresses": ["9.9.9.9:9735"]})
        # Old color was empty until above, so this is the first color change.
        self.store.apply_node_enrichment(PUB_A, {"color": "#ff0000"})
        self.store.save()

        events = self.store.query_events()
        kinds = [event["kind"] for event in events]
        self.assertEqual(kinds.count("alias"), 1)
        self.assertEqual(kinds.count("addresses"), 2)
        self.assertEqual(kinds.count("color"), 1)
        alias = next(event for event in events if event["kind"] == "alias")
        self.assertEqual((alias["old"], alias["new"]), ("Alpha", "Renamed"))
        first_addresses = [
            event for event in events if event["kind"] == "addresses" and "5.6.7.8" in event["new"]
        ]
        self.assertEqual(len(first_addresses), 1)
        self.assertEqual(first_addresses[0]["old"], '["1.2.3.4:9735"]')

    def test_alias_change_from_lnd_style_snapshot(self):
        self.store.install_graph(base_graph(1_000), "test", "fixture")
        renamed = base_graph(2_000)
        renamed.nodes[PUB_A].alias = "Alpha2"  # type: ignore[attr-defined]
        self.store.install_graph(renamed, "test", "fixture 2")
        events = [event for event in self.store.query_events() if event["kind"] == "alias"]
        self.assertEqual(len(events), 1)
        self.assertEqual((events[0]["old"], events[0]["new"]), ("Alpha", "Alpha2"))


class RetentionTest(StoreTestCase):
    def test_pruning_keeps_policy_fee_shorter_than_the_rest(self):
        self.store.install_graph(base_graph(1_000), "test", "fixture")
        self.store.install_graph(next_graph(2_000), "test", "fixture 2")
        rows = [
            (NOW - 40 * DAY, "policy_fee", None, None, None, "ppm", "1", "2", None),
            (NOW - 400 * DAY, "alias", None, None, None, "alias", "a", "b", None),
            (NOW - 10 * DAY, "channel_open", None, None, None, None, None, None, 5),
            (NOW - 10 * DAY, "policy_fee", None, None, None, "ppm", "1", "3", None),
        ]
        self.store._conn.executemany(
            "INSERT INTO events (ts, kind, pubkey, peer, scid, field, old, new, capacity)"
            " VALUES (?,?,?,?,?,?,?,?,?)",
            rows,
        )
        self.store._conn.executemany(
            "INSERT OR REPLACE INTO event_daily (day, kind, count, capacity) VALUES (?, ?, ?, ?)",
            [
                (NOW - 6 * 365 * DAY, "channel_open", 1, 1),
                (NOW - 10 * DAY - (NOW % DAY), "channel_open", 2, 2),
            ],
        )
        self.store._conn.commit()
        with mock.patch("explorer.store.time.time", return_value=NOW):
            self.store.save()
        stamps = {
            (row["ts"], row["kind"])
            for row in self.store._conn.execute("SELECT ts, kind FROM events")
        }
        self.assertNotIn((NOW - 40 * DAY, "policy_fee"), stamps)
        self.assertNotIn((NOW - 400 * DAY, "alias"), stamps)
        self.assertIn((NOW - 10 * DAY, "channel_open"), stamps)
        self.assertIn((NOW - 10 * DAY, "policy_fee"), stamps)
        days = {row["day"] for row in self.store._conn.execute("SELECT day FROM event_daily")}
        self.assertNotIn(NOW - 6 * 365 * DAY, days)
        self.assertIn(NOW - 10 * DAY - (NOW % DAY), days)

    def test_hard_cap_deletes_the_oldest_rows(self):
        self.store.install_graph(base_graph(1_000), "test", "fixture")
        self.store.install_graph(next_graph(2_000), "test", "fixture 2")
        with mock.patch("explorer.store.time.time", return_value=NOW), mock.patch(
            "explorer.store.EVENT_HARD_CAP", 3
        ):
            self.store.save()
        total = self.store._conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        self.assertLessEqual(total, EVENT_HARD_CAP)
        remaining = [
            row["id"]
            for row in self.store._conn.execute("SELECT id FROM events ORDER BY id DESC LIMIT 3")
        ]
        newest = self.store._conn.execute("SELECT MAX(id) FROM events").fetchone()[0]
        self.assertIn(newest, remaining)


class FakeCloseMempool:
    enabled = True

    def __init__(self, behaviors: dict):
        self.behaviors = behaviors
        self.calls = []

    def channel(self, scid: int):
        self.calls.append(scid)
        behavior = self.behaviors.get(scid)
        if isinstance(behavior, Exception):
            raise behavior
        return behavior


class ClosureLookupTest(StoreTestCase):
    def insert_closure(self, scid: int, ts: int) -> None:
        self.store._conn.execute(
            "INSERT OR REPLACE INTO channel_closures"
            " (scid, closed_seen_ts, capacity, node1, node2, lookups, last_lookup)"
            " VALUES (?,?,?,?,?,0,0)",
            (scid, ts, 1_000, PUB_A, PUB_B),
        )
        self.store._conn.commit()

    def test_resolution_pending_giveup_and_rate_limit(self):
        import time as _time

        base = int(_time.time())
        behaviors = {
            1: {"closing_reason": 2, "closing_date": 1_700_000_000,
                "closing_transaction_id": "abc123", "status": 1},
            2: {},
            3: SourceError("HTTP 404", status=404),
            4: SourceError("HTTP 429", status=429),
        }
        for scid in (1, 2, 3, 4):
            self.insert_closure(scid, base + scid)
        mempool = FakeCloseMempool(behaviors)

        # Newest close first; the 429 stops the batch before anything else.
        self.assertEqual(resolve_closures(self.store, mempool, 10), 0)
        self.assertEqual(mempool.calls, [4])

        behaviors[4] = {"closing_reason": 3, "closing_date": 1_700_000_100}
        resolved = resolve_closures(self.store, mempool, 10)
        self.assertEqual(resolved, 2)
        self.assertEqual(mempool.calls, [4, 4, 3, 2, 1])

        resolved_row = self.closure(1)
        self.assertEqual(resolved_row["closing_reason"], 2)
        self.assertEqual(resolved_row["closing_txid"], "abc123")
        self.assertEqual(resolved_row["mempool_status"], 1)
        self.assertIn("2023-11-14", resolved_row["closing_date"])
        self.assertEqual(self.closure(4)["closing_reason"], 3)

        pending = self.closure(2)
        self.assertIsNone(pending["closing_reason"])
        self.assertEqual(pending["lookups"], 1)
        gave_up = self.closure(3)
        self.assertIsNone(gave_up["closing_reason"])
        self.assertEqual(gave_up["lookups"], CLOSE_MAX_LOOKUPS)

        # Nothing is due again within 12h.
        self.assertEqual(self.store.closure_candidates(10), [])
        later = _time.time() + 13 * 3600
        self.assertEqual([row["scid"] for row in self.store.closure_candidates(10, now=later)], [2])
        with mock.patch("explorer.refresh.time.time", return_value=later):
            self.assertEqual(resolve_closures(self.store, FakeCloseMempool({2: {}}), 10), 0)
        self.assertEqual(self.closure(2)["lookups"], 2)

        flows = self.store.flows_payload(days=90, now=later)
        self.assertEqual(flows["close_types"]["2"], 1)
        self.assertEqual(flows["close_types"]["3"], 1)
        self.assertEqual(flows["close_types"]["pending"], 1)

    def test_budget_limits_the_batch(self):
        base = int(__import__("time").time())
        for scid in (11, 12):
            self.insert_closure(scid, base + scid)
        mempool = FakeCloseMempool({scid: {} for scid in (11, 12)})
        self.assertEqual(resolve_closures(self.store, mempool, 1), 0)
        self.assertEqual(mempool.calls, [12])


class RankHistoryTest(StoreTestCase):
    def setUp(self):
        super().setUp()
        self.store.install_graph(base_graph(1_000), "test", "fixture")
        self.store.recompute_metrics(samples=3)

    def test_daily_write_once_and_rank_changes(self):
        stored = self.store.record_rank_history(top=3, now=DAY1 + 100)
        self.assertGreater(stored, 0)
        metrics_stored = {
            row[0]
            for row in self.store._conn.execute(
                "SELECT DISTINCT metric FROM rank_history"
            )
        }
        self.assertTrue({"total_capacity", "num_channels", "betweenness"} <= metrics_stored)
        self.assertEqual(self.store.record_rank_history(top=3, now=DAY1 + 200), 0)

        first = self.store.rankings_payload("total_capacity", 10, now=DAY1 + 300)
        self.assertEqual([entry["pubkey"] for entry in first["objects"][:3]], [PUB_A, PUB_B, PUB_C])
        self.assertEqual(first["objects"][0]["rank"], 1)
        self.assertEqual(first["objects"][0]["rank_change_1d"], None)
        self.assertEqual(first["objects"][0]["history"], [1])
        self.assertIn("total_capacity", first["metrics"])
        self.assertIn("betweenness", first["metrics"])

        # Charlie grows past Bravo: C climbs one rank, B falls one.
        self.store.set_channel_capacities({SCID_AB: 100_000, SCID_AC: 4_000_000})
        stored = self.store.record_rank_history(top=3, now=DAY2 + 100)
        self.assertGreater(stored, 0)

        second = self.store.rankings_payload("total_capacity", 10, now=DAY2 + 200)
        ranks = {entry["pubkey"]: entry for entry in second["objects"]}
        self.assertEqual(ranks[PUB_A]["rank"], 1)
        self.assertEqual(ranks[PUB_A]["rank_change_1d"], 0)
        self.assertEqual(ranks[PUB_C]["rank"], 2)
        self.assertEqual(ranks[PUB_C]["rank_change_1d"], 1)
        self.assertEqual(ranks[PUB_B]["rank"], 3)
        self.assertEqual(ranks[PUB_B]["rank_change_1d"], -1)
        self.assertEqual(ranks[PUB_A]["history"], [1, 1])

        movers = self.store.ranking_movers("total_capacity", days=1, limit=5, now=DAY2 + 300)
        self.assertEqual(movers["climbers"][0]["pubkey"], PUB_C)
        self.assertEqual(movers["climbers"][0]["change"], 1)
        self.assertEqual(movers["fallers"][0]["pubkey"], PUB_B)
        self.assertEqual(movers["fallers"][0]["change"], -1)

        series = self.store.node_rank_history(PUB_B, days=30, now=DAY2 + 400)
        self.assertEqual(
            [(point["day"], point["rank"]) for point in series["series"]["total_capacity"]],
            [(DAY1, 2), (DAY2, 3)],
        )

    def test_metrics_not_ready_stores_capacity_and_channels(self):
        self.store.metrics = {}
        self.store.metrics_meta["ready"] = False
        stored = self.store.record_rank_history(top=5, now=DAY1 + 100)
        self.assertGreater(stored, 0)
        metrics = {
            row["metric"]
            for row in self.store._conn.execute("SELECT DISTINCT metric FROM rank_history")
        }
        self.assertEqual(metrics, {"total_capacity", "num_channels"})

    def test_movers_need_two_days(self):
        self.store.record_rank_history(top=3, now=DAY1 + 100)
        empty = self.store.ranking_movers("total_capacity", days=1, now=DAY1 + 200)
        self.assertEqual(empty["climbers"], [])
        self.assertEqual(empty["fallers"], [])


class EventsApiTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.settings = Settings(
            data_dir=self.tmp.name,
            mempool_api="",
            disable_refresh=True,
            web_dir=str(Path(__file__).resolve().parents[2] / "web"),
            refresh_seconds=0,
        )

    def tearDown(self):
        self.tmp.cleanup()

    def client_for(self, store):
        return create_app(self.settings, store=store, start_background=False).test_client()

    def test_new_endpoints_on_an_empty_database(self):
        store = Store(str(Path(self.tmp.name) / "empty.sqlite"))
        store.open()
        client = self.client_for(store)
        paths = [
            "/api/events",
            "/api/events?kind=channel_open&limit=5",
            "/api/flows",
            "/api/flows?days=30",
            "/api/rankings",
            "/api/rankings?metric=betweenness&limit=5",
            "/api/rankings/movers",
            "/api/rankings/movers?metric=num_channels&days=7",
            f"/api/nodes/{PUB_A}/events",
            f"/api/nodes/{PUB_A}/ranks",
            "/api/stats",
        ]
        for path in paths:
            response = client.get(path)
            self.assertEqual(response.status_code, 200, path)
        flows = client.get("/api/flows").get_json()
        self.assertTrue(flows["accumulating"])
        self.assertEqual(flows["series"], {})
        self.assertIsNone(flows["events_since"])
        self.assertEqual(client.get("/api/events").get_json()["events"], [])
        rankings = client.get("/api/rankings").get_json()
        self.assertEqual(rankings["objects"], [])
        self.assertIn("total_capacity", rankings["metrics"])
        stats = client.get("/api/stats").get_json()
        self.assertEqual(
            stats["flows_7d"],
            {
                "opens": 0,
                "closes": 0,
                "net_channels": 0,
                "opened_capacity": 0,
                "closed_capacity": 0,
                "fee_changes": 0,
            },
        )

    def test_event_filters_and_decorations(self):
        store = Store(str(Path(self.tmp.name) / "full.sqlite"))
        store.open()
        store.install_graph(base_graph(1_000), "test", "fixture")
        store.install_graph(next_graph(2_000), "test", "fixture 2")
        client = self.client_for(store)

        body = client.get("/api/events?limit=500").get_json()
        self.assertTrue(body["events"])
        opened = next(
            event
            for event in body["events"]
            if event["kind"] == "channel_open" and event["scid"] == SCID_FRESH
        )
        self.assertEqual(opened["short_id"], format_scid(SCID_FRESH))
        self.assertEqual(opened["pubkey_alias"], "Bravo")
        self.assertEqual(opened["peer_alias"], "Charlie")

        only_closes = client.get("/api/events?kind=channel_close").get_json()["events"]
        self.assertEqual([event["scid"] for event in only_closes], [SCID_AC])
        by_scid = client.get(f"/api/events?scid={SCID_AB}").get_json()["events"]
        self.assertEqual([event["kind"] for event in by_scid], ["policy_fee"])
        node_events = client.get(f"/api/nodes/{PUB_C}/events").get_json()["events"]
        self.assertTrue(
            {event["kind"] for event in node_events} >= {"channel_close", "channel_open"}
        )
        # PUB_C is only the peer of the A-C close and the B-C open.
        self.assertTrue(all(event["pubkey"] != PUB_C for event in node_events if event["kind"] == "policy_fee"))

        flows = client.get("/api/flows?days=90").get_json()
        self.assertFalse(flows["accumulating"])
        self.assertEqual(flows["series"]["channel_open"][0]["count"], 1)
        self.assertEqual(flows["series"]["channel_close"][0]["capacity"], 1_000_000)
        stats = client.get("/api/stats").get_json()
        self.assertEqual(stats["flows_7d"]["opens"], 1)
        self.assertEqual(stats["flows_7d"]["closes"], 1)
        self.assertEqual(stats["flows_7d"]["net_channels"], 0)
        self.assertEqual(stats["flows_7d"]["fee_changes"], 1)

        bad = client.get("/api/nodes/not-a-key/events")
        self.assertEqual(bad.status_code, 400)
        bad_scid = client.get("/api/events?scid=nope")
        self.assertEqual(bad_scid.status_code, 400)


if __name__ == "__main__":
    unittest.main()


class AliasFlapTest(unittest.TestCase):
    def test_alias_bouncing_between_backends_is_recorded_once(self):
        import tempfile
        from pathlib import Path

        from explorer.store import Store

        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = Store(str(Path(tmp.name) / "explorer.sqlite"))
        store.open()
        pubkey = "02" + "ab" * 32
        store.apply_node_enrichment(pubkey, {"alias": "old"})
        store.apply_node_enrichment(pubkey, {"alias": "new"})
        store.apply_node_enrichment(pubkey, {"alias": "old"})
        store.apply_node_enrichment(pubkey, {"alias": "new"})
        store.save()
        events = store.query_events(kind="alias")
        self.assertEqual([(e["old"], e["new"]) for e in events], [("old", "new")])
