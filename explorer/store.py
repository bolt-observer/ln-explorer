"""In-memory Lightning graph with a sqlite cache.

The process serves whatever is already on disk immediately, then a refresh
job swaps in a newer snapshot. Node aliases and capacities learned from
mempool survive a gossip refresh that does not itself carry those fields.
"""

from __future__ import annotations

import json
import logging
import sqlite3
import statistics
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field

from explorer import features
from explorer import fees
from explorer.metrics import compute_metrics
from explorer.rgs import ParsedGraph, Policy, format_scid

logger = logging.getLogger(__name__)

# Snapshot aggregate columns added on top of the original seven. Old rows keep
# their values; the new columns are NULL until the next refresh fills them.
SNAPSHOT_AGGREGATE_COLUMNS: dict[str, str] = {
    "enabled_channels": "INTEGER",
    "disabled_channels": "INTEGER",
    "capacity_known_channels": "INTEGER",
    "gossip_capacity": "INTEGER",
    "avg_channel_capacity": "REAL",
    "med_channel_capacity": "REAL",
    "fee_rate_count": "INTEGER",
    "fee_rate_min": "REAL",
    "fee_rate_max": "REAL",
    "fee_rate_mean": "REAL",
    "fee_rate_median": "REAL",
    "fee_rate_std": "REAL",
    "fee_rate_p90": "REAL",
    "fee_rate_mean_filtered": "REAL",
    "fee_rate_mean_capweighted": "REAL",
    "base_fee_count": "INTEGER",
    "base_fee_min": "REAL",
    "base_fee_max": "REAL",
    "base_fee_mean": "REAL",
    "base_fee_median": "REAL",
    "base_fee_std": "REAL",
    "base_fee_p90": "REAL",
    "base_fee_mean_filtered": "REAL",
    "base_fee_mean_capweighted": "REAL",
}

# One row per refresh (~8/day); anything older than three years is dropped.
SNAPSHOT_RETENTION_SECONDS = int(3 * 365.25 * 86400)
HISTORY_RANGES = {"1y": 365 * 86400, "3y": int(3 * 365.25 * 86400)}
STALE_AFTER_SECONDS = 3 * 86400
HISTORY_MAX_POINTS = 1000
EXTERNAL_HISTORY_COLUMNS = (
    "node_count",
    "channel_count",
    "total_capacity",
    "tor_nodes",
    "clearnet_nodes",
    "clearnet_tor_nodes",
    "unannounced_nodes",
    "med_fee_rate",
    "med_base_fee",
    "avg_fee_rate",
)

SORT_FIELDS = {
    "alias",
    "num_channels",
    "active_channels",
    "total_capacity",
    "avg_out_base",
    "med_out_base",
    "max_out_base",
    "avg_out_ppm",
    "med_out_ppm",
    "max_out_ppm",
    "avg_in_base",
    "med_in_base",
    "avg_in_ppm",
    "med_in_ppm",
    "avg_capacity",
    "med_capacity",
    "max_capacity",
    "betweenness_rank",
    "betweenness_weighted_rank",
    "closeness_rank",
    "closeness_weighted_rank",
    "eigenvector_rank",
    "eigenvector_weighted_rank",
}

# --- Change events (snapshot diffs) ---------------------------------------
#
# One refresh diffs the incoming snapshot against the previous graph and
# records opens/closes/fee changes plus node-field changes from enrichment.
# Individual policy_fee rows are only kept for a month (there are many),
# everything else for a year; the daily aggregate outlives both so charts
# survive pruning.
# A scid whose funding block is within NEW_CHANNEL_BLOCKS of the newest
# block in the snapshot is a fresh open; anything older was re-announced.
NEW_CHANNEL_BLOCKS = 4032
EVENT_RETENTION_SECONDS = 365 * 86400
POLICY_FEE_RETENTION_SECONDS = 30 * 86400
EVENT_HARD_CAP = 400_000
EVENT_DAILY_RETENTION_SECONDS = int(5 * 365.25 * 86400)
FLAP_SUPPRESS_SECONDS = 24 * 3600.0
# mempool.space backends lag each other, so alias/color can bounce between an
# old and a new value for days; a reversal within this window is not an event.
FIELD_FLAP_SUPPRESS_SECONDS = 7 * 86400.0
CAPACITY_EVENT_KINDS = frozenset({"channel_open", "channel_reappeared", "channel_close"})

# mempool's closing codes: 1 unknown, 2 mutual close, 3 force close,
# 4 force close with penalty.
CLOSE_REASONS = {1: "unknown", 2: "mutual close", 3: "force close", 4: "force close with penalty"}
CLOSE_MAX_LOOKUPS = 6
CLOSE_RETRY_SECONDS = 12 * 3600.0

# --- Rank history -----------------------------------------------------------
RANK_METRICS = (
    "total_capacity",
    "num_channels",
    "betweenness",
    "betweenness_weighted",
    "closeness",
    "closeness_weighted",
    "eigenvector",
    "eigenvector_weighted",
)
CENTRALITY_METRICS = RANK_METRICS[2:]
RANK_HISTORY_RETENTION_SECONDS = 365 * 86400
RANK_SPARKLINE_DAYS = 90


def _utc_day(ts: float | None = None) -> int:
    """Midnight UTC of ``ts`` as an epoch second (same key the prices table uses)."""
    moment = time.time() if ts is None else ts
    return int(moment // 86400) * 86400


class _Directed:
    """Compare so that ``reverse`` flips order without moving missing rows."""

    def __init__(self, value, reverse: bool):
        self.value = value
        self.reverse = reverse

    def __lt__(self, other: "_Directed") -> bool:
        if self.reverse:
            return self.value > other.value
        return self.value < other.value


def _capacity_choice(channel_caps: list[int], external: int | None) -> tuple[int, str]:
    """Prefer a full channel sum, otherwise a node total from mempool."""
    summed = int(sum(channel_caps)) if channel_caps else 0
    external_value = int(external or 0)
    if summed and summed >= external_value:
        return summed, "channels"
    if external_value:
        return external_value, "mempool"
    return 0, "unknown"


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    return float(statistics.median(values))


def _mean(values: list[float]) -> float:
    if not values:
        return 0.0
    return float(statistics.fmean(values))


def _filtered_mean(values: list[float]) -> float:
    """Outlier-corrected mean (Tukey far-out fences; small samples pass through).

    A single 2147483647 ppm placeholder policy must not explode a node's
    average fee. Maxima stay raw; only the averages are filtered.
    """
    summary = fees.summarize(values)
    return summary["mean_filtered"] or 0.0


def _downsample(points: list[dict], max_points: int) -> list[dict]:
    """Keep the last point of each of at most ``max_points`` time buckets.

    The first local point is never dropped: it anchors the dashed
    continuation of the series after mempool's statistics stop.
    """
    if len(points) <= max_points:
        return points
    first_ts = points[0]["ts"]
    # span / (max_points - 1) keeps the bucket count at or below the cap even
    # when the span divides exactly; the re-insert below trades, never adds.
    width = max(1.0, (points[-1]["ts"] - first_ts) / max(1, max_points - 1))
    kept: list[dict] = []
    previous_bucket = None
    for point in points:
        bucket = int((point["ts"] - first_ts) // width)
        if kept and bucket == previous_bucket:
            kept[-1] = point
        else:
            kept.append(point)
            previous_bucket = bucket
    first_local = next(
        (point for point in points if point.get("source") == "local"), None
    )
    if first_local is not None and not any(
        point["ts"] == first_local["ts"] and point.get("source") == "local"
        for point in kept
    ):
        index = next(
            (i for i, point in enumerate(kept) if point["ts"] > first_local["ts"]),
            len(kept),
        )
        kept.insert(index, first_local)
        # Hold the cap by dropping the kept point closest in time to the one
        # just re-inserted (never the first local point itself).
        if len(kept) > max_points:
            neighbours = []
            if index > 0:
                neighbours.append(kept[index - 1])
            if index + 1 < len(kept):
                neighbours.append(kept[index + 1])
            if neighbours:
                kept.remove(
                    min(neighbours, key=lambda point: abs(point["ts"] - first_local["ts"]))
                )
    return kept


def _history_note(until: int | None, stale: bool) -> str:
    ours = (
        "The dashed line is this explorer's own gossip snapshot, taken every refresh. "
        "It counts only nodes and channels in the public rapid gossip sync snapshot "
        "(capacity only where known), so its lower level is a methodology difference, "
        "not a network event."
    )
    if until is None:
        return "No mempool.space history is available yet. " + ours
    date = time.strftime("%Y-%m-%d", time.gmtime(until))
    gaps = (
        "mempool.space serves its Lightning statistics from several backends with "
        "different gaps (some stopped updating on 2026-08-30); every response we see "
        "is merged, and lines break across gaps longer than 10 days. "
    )
    if stale:
        return (
            f"mempool.space network statistics stop on {date}. " + gaps
            + "Points after that come only from our own snapshots. " + ours
        )
    return f"Solid lines: mempool.space network statistics, latest {date}. " + gaps + ours



def _protocols(addresses: list[str]) -> tuple[bool, bool, bool]:
    ipv4 = ipv6 = tor = False
    for address in addresses:
        host = address.split(":")[0].lower()
        if ".onion" in address.lower() or address.lower().startswith("torv2:"):
            tor = True
        elif host.count(".") == 3 and all(part.isdigit() for part in host.split(".")):
            ipv4 = True
        elif ":" in address and ".onion" not in address.lower():
            ipv6 = True
    return ipv4, ipv6, tor


@dataclass
class NodeRecord:
    pubkey: str
    alias: str = ""
    color: str = ""
    addresses: list[str] = field(default_factory=list)
    country: str = ""
    city: str = ""
    first_seen: int | None = None
    capacity: int | None = None
    enriched_at: float = 0.0
    capacity_page: int = 0
    capacity_done: bool = False
    # 0 = progress from the offset-by-one scanner. 2 = bulk page, then stride 10.
    capacity_scan: int = 0
    # Announced feature bits (BOLT 9), from RGS v2 or mempool profiles.
    features: list[int] = field(default_factory=list)


@dataclass
class ChannelRecord:
    scid: int
    node1: str
    node2: str
    capacity: int | None = None
    policy1: Policy | None = None
    policy2: Policy | None = None

    def short_id(self) -> str:
        return format_scid(self.scid)

    def other(self, pubkey: str) -> str:
        return self.node2 if pubkey == self.node1 else self.node1

    def policy_for(self, pubkey: str) -> Policy | None:
        if pubkey == self.node1:
            return self.policy1
        if pubkey == self.node2:
            return self.policy2
        return None

    def peer_policy(self, pubkey: str) -> Policy | None:
        if pubkey == self.node1:
            return self.policy2
        if pubkey == self.node2:
            return self.policy1
        return None


def _policy_blob(policy: Policy | None) -> tuple:
    if policy is None:
        return (None, None, None, None, None, None)
    return (
        policy.base_msat,
        policy.ppm,
        policy.cltv,
        policy.min_htlc_msat,
        policy.max_htlc_msat,
        1 if policy.disabled else 0,
    )


def _policy_load(row, prefix: str) -> Policy | None:
    base = row[f"{prefix}_base"]
    if base is None and row[f"{prefix}_ppm"] is None:
        return None
    return Policy(
        base_msat=base or 0,
        ppm=row[f"{prefix}_ppm"] or 0,
        cltv=row[f"{prefix}_cltv"] or 0,
        min_htlc_msat=row[f"{prefix}_min"] or 0,
        max_htlc_msat=row[f"{prefix}_max"] or 0,
        disabled=bool(row[f"{prefix}_disabled"]),
    )


class Store:
    def __init__(self, db_path: str):
        self.db_path = db_path
        self._lock = threading.RLock()
        self.nodes: dict[str, NodeRecord] = {}
        self.channels: dict[int, ChannelRecord] = {}
        self.by_node: dict[str, list[int]] = {}
        self.derived: dict[str, dict] = {}
        self.metrics: dict[str, dict] = {}
        self.metrics_meta = {"ready": False, "samples": 0, "capacity_weighted": False}
        self.network_stats: dict = {}
        # Local aggregate rows (the ``snapshots`` table) and mempool's long
        # series (``history_external``) are kept apart; /api/history merges them.
        self.local_snapshots: list[dict] = []
        self.external_history: list[dict] = []
        self.current_prices: dict = {}
        self.daily_prices: dict[int, tuple[float | None, float | None]] = {}
        self.last_history_fetch = 0.0
        self.last_price_fetch = 0.0
        self.updated_at = 0.0
        self.graph_timestamp = 0
        self.source = ""
        self.source_detail = ""
        self.last_error = ""
        # Change events buffered during one refresh; flushed to sqlite in one
        # executemany, never kept across refreshes.
        self.events_since: int | None = None
        self._pending_events: list[dict] = []
        self._pending_daily: list[tuple[str, int, int]] = []
        # Last recorded address change per pubkey (normalized sets), used to
        # suppress flapping between two sources inside 24h.
        self._last_address_flip: dict[str, tuple[frozenset, frozenset, float]] = {}
        self._last_field_change: dict[tuple[str, str], tuple[str, str, float]] = {}
        self._rank_day_written: int | None = None
        self._conn = None

    def open(self) -> None:
        from pathlib import Path

        Path(self.db_path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._migrate()
        self._load()

    def _migrate(self) -> None:
        assert self._conn is not None
        self._conn.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE IF NOT EXISTS nodes (
                pubkey TEXT PRIMARY KEY,
                alias TEXT,
                color TEXT,
                addresses TEXT,
                country TEXT,
                city TEXT,
                first_seen INTEGER,
                capacity INTEGER,
                enriched_at REAL
            );
            CREATE TABLE IF NOT EXISTS channels (
                scid INTEGER PRIMARY KEY,
                node1 TEXT,
                node2 TEXT,
                capacity INTEGER,
                n1_base INTEGER, n1_ppm INTEGER, n1_cltv INTEGER,
                n1_min INTEGER, n1_max INTEGER, n1_disabled INTEGER,
                n2_base INTEGER, n2_ppm INTEGER, n2_cltv INTEGER,
                n2_min INTEGER, n2_max INTEGER, n2_disabled INTEGER
            );
            CREATE TABLE IF NOT EXISTS metrics (
                pubkey TEXT PRIMARY KEY,
                betweenness REAL,
                betweenness_weighted REAL,
                closeness REAL,
                closeness_weighted REAL,
                eigenvector REAL,
                eigenvector_weighted REAL,
                betweenness_rank INTEGER,
                betweenness_weighted_rank INTEGER,
                closeness_rank INTEGER,
                closeness_weighted_rank INTEGER,
                eigenvector_rank INTEGER,
                eigenvector_weighted_rank INTEGER
            );
            CREATE TABLE IF NOT EXISTS snapshots (
                ts INTEGER PRIMARY KEY,
                node_count INTEGER,
                channel_count INTEGER,
                total_capacity INTEGER,
                med_base_fee INTEGER,
                med_fee_rate INTEGER,
                source TEXT
            );
            CREATE TABLE IF NOT EXISTS history_external (
                ts INTEGER PRIMARY KEY,
                node_count INTEGER,
                channel_count INTEGER,
                total_capacity INTEGER,
                tor_nodes INTEGER,
                clearnet_nodes INTEGER,
                clearnet_tor_nodes INTEGER,
                unannounced_nodes INTEGER,
                med_fee_rate REAL,
                med_base_fee REAL,
                avg_fee_rate REAL
            );
            CREATE TABLE IF NOT EXISTS prices (
                day INTEGER PRIMARY KEY,
                usd REAL,
                eur REAL
            );
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY,
                ts INTEGER,
                kind TEXT,
                pubkey TEXT,
                peer TEXT,
                scid INTEGER,
                field TEXT,
                old TEXT,
                new TEXT,
                capacity INTEGER
            );
            CREATE INDEX IF NOT EXISTS events_ts ON events (ts);
            CREATE INDEX IF NOT EXISTS events_pubkey_ts ON events (pubkey, ts);
            CREATE INDEX IF NOT EXISTS events_scid ON events (scid);
            CREATE INDEX IF NOT EXISTS events_kind_ts ON events (kind, ts);
            CREATE TABLE IF NOT EXISTS event_daily (
                day INTEGER,
                kind TEXT,
                count INTEGER,
                capacity INTEGER,
                PRIMARY KEY (day, kind)
            );
            CREATE TABLE IF NOT EXISTS channel_closures (
                scid INTEGER PRIMARY KEY,
                closed_seen_ts INTEGER,
                capacity INTEGER,
                node1 TEXT,
                node2 TEXT,
                closing_reason INTEGER,
                closing_date TEXT,
                closing_txid TEXT,
                mempool_status INTEGER,
                lookups INTEGER,
                last_lookup REAL
            );
            CREATE TABLE IF NOT EXISTS rank_history (
                day INTEGER,
                metric TEXT,
                pubkey TEXT,
                rank INTEGER,
                value REAL,
                PRIMARY KEY (day, metric, pubkey)
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS rank_history_node ON rank_history (pubkey, metric, day);
            """
        )
        snapshot_columns = {row[1] for row in self._conn.execute("PRAGMA table_info(snapshots)")}
        for column, declaration in SNAPSHOT_AGGREGATE_COLUMNS.items():
            if column not in snapshot_columns:
                self._conn.execute(
                    f"ALTER TABLE snapshots ADD COLUMN {column} {declaration}"
                )
        columns = {row[1] for row in self._conn.execute("PRAGMA table_info(nodes)")}
        if "capacity_page" not in columns:
            self._conn.execute(
                "ALTER TABLE nodes ADD COLUMN capacity_page INTEGER NOT NULL DEFAULT 0"
            )
        if "capacity_done" not in columns:
            self._conn.execute(
                "ALTER TABLE nodes ADD COLUMN capacity_done INTEGER NOT NULL DEFAULT 0"
            )
        if "capacity_scan" not in columns:
            self._conn.execute(
                "ALTER TABLE nodes ADD COLUMN capacity_scan INTEGER NOT NULL DEFAULT 0"
            )
        if "features" not in columns:
            self._conn.execute("ALTER TABLE nodes ADD COLUMN features TEXT")
        metric_columns = {
            row[1] for row in self._conn.execute("PRAGMA table_info(metrics)")
        }
        for column, declaration in (
            ("closeness_weighted", "REAL"),
            ("closeness_weighted_rank", "INTEGER"),
        ):
            if column not in metric_columns:
                self._conn.execute(
                    f"ALTER TABLE metrics ADD COLUMN {column} {declaration}"
                )
        self._import_legacy_history_blob()
        # Rows written before the aggregate columns copied mempool's reported
        # total into total_capacity; that is not our measurement.
        self._conn.execute(
            "UPDATE snapshots SET total_capacity = NULL"
            " WHERE fee_rate_count IS NULL AND gossip_capacity IS NULL"
        )
        self._conn.commit()

    def _import_legacy_history_blob(self) -> None:
        """Move meta.history_external (pre-table cache) into history_external."""
        assert self._conn is not None
        row = self._conn.execute(
            "SELECT value FROM meta WHERE key = 'history_external'"
        ).fetchone()
        if not row:
            return
        rows: list[dict] = []
        try:
            legacy = json.loads(row[0] or "[]")
            if isinstance(legacy, list):
                rows = [self._external_row(item) for item in legacy if int(item.get("ts") or 0)]
        except (json.JSONDecodeError, AttributeError, TypeError, ValueError):
            rows = []
        if rows:
            self._upsert_external_history(rows)
            logger.info("Imported %s legacy external history rows from meta", len(rows))
        self._conn.execute("DELETE FROM meta WHERE key = 'history_external'")

    def _load(self) -> None:
        assert self._conn is not None
        with self._lock:
            for row in self._conn.execute("SELECT * FROM nodes"):
                addresses = json.loads(row["addresses"] or "[]")
                self.nodes[row["pubkey"]] = NodeRecord(
                    pubkey=row["pubkey"],
                    alias=row["alias"] or "",
                    color=row["color"] or "",
                    addresses=addresses,
                    country=row["country"] or "",
                    city=row["city"] or "",
                    first_seen=row["first_seen"],
                    capacity=row["capacity"],
                    enriched_at=row["enriched_at"] or 0.0,
                    capacity_page=row["capacity_page"] or 0,
                    capacity_done=bool(row["capacity_done"]),
                    capacity_scan=row["capacity_scan"] or 0,
                    features=json.loads(row["features"]) if row["features"] else [],
                )
            self.channels.clear()
            for row in self._conn.execute("SELECT * FROM channels"):
                self.channels[row["scid"]] = ChannelRecord(
                    scid=row["scid"],
                    node1=row["node1"],
                    node2=row["node2"],
                    capacity=row["capacity"],
                    policy1=_policy_load(row, "n1"),
                    policy2=_policy_load(row, "n2"),
                )
            self.metrics = {}
            for row in self._conn.execute("SELECT * FROM metrics"):
                self.metrics[row["pubkey"]] = {
                    "betweenness": row["betweenness"],
                    "betweenness_weighted": row["betweenness_weighted"],
                    "closeness": row["closeness"],
                    "closeness_weighted": row["closeness_weighted"],
                    "eigenvector": row["eigenvector"],
                    "eigenvector_weighted": row["eigenvector_weighted"],
                    "betweenness_rank": row["betweenness_rank"],
                    "betweenness_weighted_rank": row["betweenness_weighted_rank"],
                    "closeness_rank": row["closeness_rank"],
                    "closeness_weighted_rank": row["closeness_weighted_rank"],
                    "eigenvector_rank": row["eigenvector_rank"],
                    "eigenvector_weighted_rank": row["eigenvector_weighted_rank"],
                }
            self.local_snapshots = [
                dict(row)
                for row in self._conn.execute("SELECT * FROM snapshots ORDER BY ts ASC")
            ]
            self._load_external_history()
            self.daily_prices = {
                int(row["day"]): (row["usd"], row["eur"])
                for row in self._conn.execute("SELECT day, usd, eur FROM prices")
            }
            meta = {
                row["key"]: row["value"]
                for row in self._conn.execute("SELECT key, value FROM meta")
            }
            self.updated_at = float(meta.get("updated_at") or 0)
            self.graph_timestamp = int(meta.get("graph_timestamp") or 0)
            self.source = meta.get("source") or ""
            self.source_detail = meta.get("source_detail") or ""
            self.events_since = (
                int(meta["events_since"]) if meta.get("events_since") else None
            )
            self._rank_day_written = (
                int(meta["rank_history_day"]) if meta.get("rank_history_day") else None
            )
            self.last_history_fetch = float(meta.get("last_mempool_history_fetch") or 0)
            self.last_price_fetch = float(meta.get("last_mempool_price_fetch") or 0)
            if meta.get("network_stats"):
                self.network_stats = json.loads(meta["network_stats"])
            if meta.get("current_prices"):
                prices = json.loads(meta["current_prices"])
                if isinstance(prices, dict):
                    self.current_prices = prices
            self.metrics_meta["ready"] = bool(self.metrics)
            self._reindex()
            logger.info(
                "Loaded cache: %s nodes, %s channels, %s local snapshots, %s history rows",
                len(self.nodes),
                len(self.channels),
                len(self.local_snapshots),
                len(self.external_history),
            )

    def _load_external_history(self) -> None:
        assert self._conn is not None
        self.external_history = [
            dict(row)
            for row in self._conn.execute(
                "SELECT * FROM history_external"
                " WHERE channel_count IS NOT NULL OR total_capacity IS NOT NULL"
                " ORDER BY ts ASC"
            )
        ]

    @staticmethod
    def _external_row(item: dict) -> dict:
        def number(key: str):
            value = item.get(key)
            if value is None or value == "":
                return None
            try:
                return int(value)
            except (TypeError, ValueError):
                return None

        row = {"ts": int(item.get("ts") or 0)}
        for column in EXTERNAL_HISTORY_COLUMNS:
            row[column] = number(column)
        return row

    def _upsert_external_history(self, rows: list[dict]) -> None:
        """Merge rows by ts. A None field keeps the value already stored."""
        assert self._conn is not None
        columns = ", ".join(EXTERNAL_HISTORY_COLUMNS)
        placeholders = ", ".join(f":{column}" for column in EXTERNAL_HISTORY_COLUMNS)
        updates = ", ".join(
            f"{column} = COALESCE(excluded.{column}, history_external.{column})"
            for column in EXTERNAL_HISTORY_COLUMNS
        )
        self._conn.executemany(
            f"""INSERT INTO history_external (ts, {columns})
                VALUES (:ts, {placeholders})
                ON CONFLICT(ts) DO UPDATE SET {updates}""",
            rows,
        )

    def record_external_history(self, rows: list[dict]) -> int:
        """Store mempool's long-term network statistics (merged by timestamp)."""
        with self._lock:
            clean = [
                self._external_row(row)
                for row in rows
                if isinstance(row, dict) and int(row.get("ts") or 0)
            ]
            if not clean:
                return 0
            self._upsert_external_history(clean)
            self._conn.commit()
            self._load_external_history()
        return len(clean)

    def record_prices(self, daily: dict[int, tuple[float | None, float | None]]) -> int:
        """Store one BTC price per UTC day (day is the 00:00 UTC timestamp)."""
        rows = [
            (int(day), usd, eur)
            for day, (usd, eur) in daily.items()
            if usd is not None or eur is not None
        ]
        with self._lock:
            self._conn.executemany(
                "INSERT OR REPLACE INTO prices (day, usd, eur) VALUES (?, ?, ?)", rows
            )
            self._conn.commit()
            for day, usd, eur in rows:
                self.daily_prices[day] = (usd, eur)
        return len(rows)

    def set_current_prices(self, payload: dict) -> None:
        with self._lock:
            self.current_prices = dict(payload)
            self.set_meta("current_prices", json.dumps(self.current_prices))

    def set_meta(self, key: str, value: str) -> None:
        assert self._conn is not None
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value)
            )
            self._conn.commit()

    def mark_history_fetched(self) -> None:
        self.last_history_fetch = time.time()
        self.set_meta("last_mempool_history_fetch", str(self.last_history_fetch))

    def mark_prices_fetched(self) -> None:
        self.last_price_fetch = time.time()
        self.set_meta("last_mempool_price_fetch", str(self.last_price_fetch))

    def _reindex(self) -> None:
        by_node: dict[str, list[int]] = defaultdict(list)
        for scid, channel in self.channels.items():
            by_node[channel.node1].append(scid)
            by_node[channel.node2].append(scid)
            self.nodes.setdefault(channel.node1, NodeRecord(pubkey=channel.node1))
            self.nodes.setdefault(channel.node2, NodeRecord(pubkey=channel.node2))
        self.by_node = dict(by_node)
        self._recompute_derived()

    def _fee_lists(self, pubkey: str):
        out_base, out_ppm, in_base, in_ppm, caps = [], [], [], [], []
        active = 0
        for scid in self.by_node.get(pubkey, []):
            channel = self.channels[scid]
            if channel.capacity:
                caps.append(channel.capacity)
            outgoing = channel.policy_for(pubkey)
            incoming = channel.peer_policy(pubkey)
            if outgoing is not None:
                out_base.append(outgoing.base_msat)
                out_ppm.append(outgoing.ppm)
            if incoming is not None:
                in_base.append(incoming.base_msat)
                in_ppm.append(incoming.ppm)
            enabled = False
            if outgoing is not None and not outgoing.disabled:
                enabled = True
            if incoming is not None and not incoming.disabled:
                enabled = True
            if outgoing is None and incoming is None:
                enabled = True
            if enabled:
                active += 1
        return out_base, out_ppm, in_base, in_ppm, caps, active

    def _derived_record(self, pubkey: str) -> dict:
        """The per-node derived table row, shared by full and single recompute.

        Averages of fee fields drop far-out outliers (Tukey fences) so a
        single placeholder policy such as 2147483647 ppm cannot dominate;
        medians and maxima stay raw.
        """
        node = self.nodes[pubkey]
        out_base, out_ppm, in_base, in_ppm, caps, active = self._fee_lists(pubkey)
        channel_count = len(self.by_node.get(pubkey, []))
        ipv4, ipv6, tor = _protocols(node.addresses)
        total, capacity_source = _capacity_choice(caps, node.capacity)
        return {
            "num_channels": channel_count,
            "active_channels": active,
            "total_capacity": total,
            "capacity_source": capacity_source,
            "avg_capacity": _mean(caps),
            "med_capacity": _median(caps),
            "max_capacity": max(caps) if caps else 0,
            "avg_out_base": _filtered_mean(out_base),
            "med_out_base": _median(out_base),
            "max_out_base": max(out_base) if out_base else 0,
            "avg_out_ppm": _filtered_mean(out_ppm),
            "med_out_ppm": _median(out_ppm),
            "max_out_ppm": max(out_ppm) if out_ppm else 0,
            "avg_in_base": _filtered_mean(in_base),
            "med_in_base": _median(in_base),
            "avg_in_ppm": _filtered_mean(in_ppm),
            "med_in_ppm": _median(in_ppm),
            "ipv4": ipv4,
            "ipv6": ipv6,
            "tor": tor,
        }

    def _recompute_derived(self) -> None:
        self.derived = {
            pubkey: self._derived_record(pubkey) for pubkey in self.nodes
        }

    def install_graph(self, graph: ParsedGraph, source: str, detail: str) -> None:
        """Replace topology, keeping previously learned aliases and capacities.

        When a previous graph is loaded and the snapshot moved, the old and
        new graphs are diffed first (still inside the lock, O(channels), no
        per-channel sqlite access) and the change events are flushed at once.
        """
        with self._lock:
            now = int(time.time())
            if (self.channels or self.nodes) and graph.timestamp != self.graph_timestamp:
                events, disabled_flips, enabled_flips = self._diff_events(graph, now)
                self._pending_events.extend(events)
                if disabled_flips:
                    self._pending_daily.append(("channel_disabled", disabled_flips, 0))
                if enabled_flips:
                    self._pending_daily.append(("channel_enabled", enabled_flips, 0))
                if self.events_since is None and self._conn is not None:
                    self.events_since = now
                    self._conn.execute(
                        "INSERT OR REPLACE INTO meta (key, value) VALUES ('events_since', ?)",
                        (str(now),),
                    )
                if self._conn is not None:
                    self._flush_events()
            previous = self.nodes
            nodes: dict[str, NodeRecord] = {}
            for pubkey, parsed in graph.nodes.items():
                old = previous.get(pubkey)
                alias = getattr(parsed, "alias", "") or (old.alias if old else "")
                color = getattr(parsed, "color", "") or (old.color if old else "")
                addresses = list(parsed.addresses) or (old.addresses if old else [])
                # RGS v2 carries feature bytes; v1 does not, so keep whatever
                # the mempool profile enrichment already learned.
                announced = features.bits_from_bytes(getattr(parsed, "features", b"") or b"")
                feature_bits = announced or (old.features if old else [])
                nodes[pubkey] = NodeRecord(
                    pubkey=pubkey,
                    alias=alias,
                    color=color,
                    addresses=addresses,
                    country=old.country if old else "",
                    city=old.city if old else "",
                    first_seen=old.first_seen if old else None,
                    capacity=old.capacity if old else None,
                    enriched_at=old.enriched_at if old else 0.0,
                    capacity_page=old.capacity_page if old else 0,
                    capacity_done=old.capacity_done if old else False,
                    capacity_scan=old.capacity_scan if old else 0,
                    features=feature_bits,
                )
            channels = {
                scid: ChannelRecord(
                    scid=parsed.scid,
                    node1=parsed.node1,
                    node2=parsed.node2,
                    capacity=parsed.capacity,
                    policy1=parsed.policy1,
                    policy2=parsed.policy2,
                )
                for scid, parsed in graph.channels.items()
            }
            # A channel capacity from the new snapshot wins. Otherwise keep a
            # value we already fetched (for example from mempool).
            for scid, channel in channels.items():
                old = self.channels.get(scid)
                if channel.capacity is None and old and old.capacity:
                    channel.capacity = old.capacity
            self.nodes = nodes
            self.channels = channels
            self.metrics = {}
            self.metrics_meta = {"ready": False, "samples": 0, "capacity_weighted": False}
            self.source = source
            self.source_detail = detail
            self.graph_timestamp = graph.timestamp
            self.updated_at = time.time()
            self.last_error = ""
            self._reindex()

    def _diff_events(self, graph: ParsedGraph, now: int) -> tuple[list[dict], int, int]:
        """Diff the incoming snapshot against the live graph (lock held).

        Returns event rows plus disabled/enabled flip counts. Disabled flips
        are counted per refresh but not stored as individual events.
        """
        events: list[dict] = []
        disabled_flips = enabled_flips = 0
        if self.channels:
            old_channels = self.channels
            highest_block = max((scid >> 40 for scid in graph.channels), default=0)
            fresh_from = highest_block - NEW_CHANNEL_BLOCKS
            for scid, channel in graph.channels.items():
                if scid in old_channels:
                    continue
                kind = "channel_open" if (scid >> 40) >= fresh_from else "channel_reappeared"
                events.append(
                    {
                        "ts": now,
                        "kind": kind,
                        "pubkey": channel.node1,
                        "peer": channel.node2,
                        "scid": scid,
                        "field": None,
                        "old": None,
                        "new": None,
                        "capacity": channel.capacity,
                    }
                )
            for scid, old in old_channels.items():
                if scid in graph.channels:
                    continue
                events.append(
                    {
                        "ts": now,
                        "kind": "channel_close",
                        "pubkey": old.node1,
                        "peer": old.node2,
                        "scid": scid,
                        "field": None,
                        "old": None,
                        "new": None,
                        "capacity": old.capacity,
                    }
                )
            for scid, channel in graph.channels.items():
                old = old_channels.get(scid)
                if old is None:
                    continue
                for owner, before, after in (
                    (channel.node1, old.policy1, channel.policy1),
                    (channel.node2, old.policy2, channel.policy2),
                ):
                    if before is None or after is None:
                        continue
                    peer = channel.node2 if owner == channel.node1 else channel.node1
                    capacity = channel.capacity or old.capacity
                    if before.disabled != after.disabled:
                        if after.disabled:
                            disabled_flips += 1
                        else:
                            enabled_flips += 1
                    if before.ppm != after.ppm:
                        events.append(
                            {
                                "ts": now,
                                "kind": "policy_fee",
                                "pubkey": owner,
                                "peer": peer,
                                "scid": scid,
                                "field": "ppm",
                                "old": str(before.ppm),
                                "new": str(after.ppm),
                                "capacity": capacity,
                            }
                        )
                    if before.base_msat != after.base_msat:
                        events.append(
                            {
                                "ts": now,
                                "kind": "policy_fee",
                                "pubkey": owner,
                                "peer": peer,
                                "scid": scid,
                                "field": "base",
                                "old": str(before.base_msat),
                                "new": str(after.base_msat),
                                "capacity": capacity,
                            }
                        )
        # Node fields come from LND/file snapshots and mempool enrichment, not
        # from RGS v1; record a change only when both values are non-empty.
        for pubkey, parsed in graph.nodes.items():
            old = self.nodes.get(pubkey)
            if old is None:
                continue
            alias = getattr(parsed, "alias", "") or ""
            if alias and old.alias and alias != old.alias and not self._field_flaps(pubkey, "alias", old.alias, alias, now):
                events.append(
                    {
                        "ts": now,
                        "kind": "alias",
                        "pubkey": pubkey,
                        "peer": None,
                        "scid": None,
                        "field": "alias",
                        "old": old.alias,
                        "new": alias,
                        "capacity": None,
                    }
                )
            color = getattr(parsed, "color", "") or ""
            if color and old.color and color != old.color and not self._field_flaps(pubkey, "color", old.color, color, now):
                events.append(
                    {
                        "ts": now,
                        "kind": "color",
                        "pubkey": pubkey,
                        "peer": None,
                        "scid": None,
                        "field": "color",
                        "old": old.color,
                        "new": color,
                        "capacity": None,
                    }
                )
            if parsed.addresses and old.addresses:
                event = self._address_event(pubkey, old.addresses, parsed.addresses, now)
                if event is not None:
                    events.append(event)
        return events, disabled_flips, enabled_flips

    def _field_flaps(self, pubkey: str, field_name: str, old: str, new: str, ts: float) -> bool:
        """True when old->new reverses this node's last recorded change recently."""
        key = (pubkey, field_name)
        previous = self._last_field_change.get(key)
        if (
            previous is not None
            and ts - previous[2] < FIELD_FLAP_SUPPRESS_SECONDS
            and {previous[0], previous[1]} == {old, new}
        ):
            # A reversal, or the same change again after a reversal.
            return True
        self._last_field_change[key] = (old, new, float(ts))
        return False

    @staticmethod
    def _normalized_addresses(addresses: list[str]) -> frozenset[str]:
        return frozenset(
            address.strip().lower() for address in addresses if address and address.strip()
        )

    def _address_event(
        self, pubkey: str, old_addresses: list[str], new_addresses: list[str], ts: int
    ) -> dict | None:
        """An addresses change, unless it reverses a recent one (flap guard)."""
        old_set = self._normalized_addresses(old_addresses)
        new_set = self._normalized_addresses(new_addresses)
        if not old_set or not new_set or old_set == new_set:
            return None
        previous = self._last_address_flip.get(pubkey)
        if (
            previous is not None
            and ts - previous[2] < FLAP_SUPPRESS_SECONDS
            and previous[0] == new_set
            and previous[1] == old_set
        ):
            return None
        self._last_address_flip[pubkey] = (old_set, new_set, float(ts))
        return {
            "ts": ts,
            "kind": "addresses",
            "pubkey": pubkey,
            "peer": None,
            "scid": None,
            "field": "addresses",
            "old": json.dumps(sorted(old_set)),
            "new": json.dumps(sorted(new_set)),
            "capacity": None,
        }

    def _flush_events(self) -> None:
        """Write the buffered events in one pass, then apply retention."""
        assert self._conn is not None
        conn = self._conn
        now = int(time.time())
        if self._pending_events or self._pending_daily:
            conn.executemany(
                "INSERT INTO events (ts, kind, pubkey, peer, scid, field, old, new, capacity)"
                " VALUES (:ts, :kind, :pubkey, :peer, :scid, :field, :old, :new, :capacity)",
                self._pending_events,
            )
            closures = [
                (event["scid"], event["ts"], event["capacity"], event["pubkey"], event["peer"])
                for event in self._pending_events
                if event["kind"] == "channel_close"
            ]
            if closures:
                conn.executemany(
                    "INSERT OR REPLACE INTO channel_closures"
                    " (scid, closed_seen_ts, capacity, node1, node2, lookups, last_lookup)"
                    " VALUES (?,?,?,?,?,0,0)",
                    closures,
                )
            aggregates: dict[tuple[int, str], list[int]] = {}
            for kind, count, capacity in self._pending_daily:
                slot = aggregates.setdefault((_utc_day(now), kind), [0, 0])
                slot[0] += count
                slot[1] += capacity or 0
            for event in self._pending_events:
                slot = aggregates.setdefault(
                    (event["ts"] - event["ts"] % 86400, event["kind"]), [0, 0]
                )
                slot[0] += 1
                if event["kind"] in CAPACITY_EVENT_KINDS:
                    slot[1] += int(event.get("capacity") or 0)
            conn.executemany(
                "INSERT INTO event_daily (day, kind, count, capacity) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(day, kind) DO UPDATE SET"
                " count = count + excluded.count, capacity = capacity + excluded.capacity",
                [
                    (day, kind, slot[0], slot[1])
                    for (day, kind), slot in sorted(aggregates.items())
                ],
            )
            self._pending_events = []
            self._pending_daily = []
        self._prune_events(now)
        conn.commit()

    def _prune_events(self, now: int) -> None:
        """Drop old events, keep the daily aggregate for charts."""
        assert self._conn is not None
        conn = self._conn
        conn.execute("DELETE FROM events WHERE ts < ?", (now - EVENT_RETENTION_SECONDS,))
        conn.execute(
            "DELETE FROM events WHERE kind = 'policy_fee' AND ts < ?",
            (now - POLICY_FEE_RETENTION_SECONDS,),
        )
        total = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        if total > EVENT_HARD_CAP:
            conn.execute(
                "DELETE FROM events WHERE id <= "
                "(SELECT MIN(id) FROM (SELECT id FROM events ORDER BY id DESC LIMIT ?))",
                (EVENT_HARD_CAP,),
            )
        conn.execute(
            "DELETE FROM event_daily WHERE day < ?", (now - EVENT_DAILY_RETENTION_SECONDS,)
        )

    def query_events(
        self,
        kind: str | None = None,
        pubkey: str | None = None,
        scid: int | None = None,
        limit: int = 100,
        before: int | None = None,
    ) -> list[dict]:
        """Change events, newest first, with aliases and short channel ids."""
        assert self._conn is not None
        clauses: list[str] = []
        params: list = []
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        if pubkey:
            clauses.append("(pubkey = ? OR peer = ?)")
            params.extend([pubkey, pubkey])
        if scid is not None:
            clauses.append("scid = ?")
            params.append(scid)
        if before:
            clauses.append("ts < ?")
            params.append(int(before))
        sql = "SELECT * FROM events"
        if clauses:
            sql += " WHERE " + " AND ".join(clauses)
        sql += " ORDER BY id DESC LIMIT ?"
        params.append(max(1, min(int(limit), 500)))
        with self._lock:
            rows = [dict(row) for row in self._conn.execute(sql, params)]
        for row in rows:
            node = self.nodes.get(row.get("pubkey") or "")
            peer = self.nodes.get(row.get("peer") or "")
            row["pubkey_alias"] = node.alias if node else ""
            row["peer_alias"] = peer.alias if peer else ""
            row["short_id"] = format_scid(row["scid"]) if row.get("scid") else ""
        return rows

    def flows_payload(self, days: int = 90, now: float | None = None) -> dict:
        """Daily open/close series, close-type breakdown, and accumulation state."""
        assert self._conn is not None
        moment = int(time.time() if now is None else now)
        days = max(1, min(int(days), 365))
        first_day = _utc_day(moment) - (days - 1) * 86400
        with self._lock:
            slots: dict[str, dict[int, dict]] = {}
            for row in self._conn.execute(
                "SELECT day, kind, count, capacity FROM event_daily WHERE day >= ? ORDER BY day ASC",
                (first_day,),
            ):
                slots.setdefault(row["kind"], {})[int(row["day"])] = {
                    "count": int(row["count"] or 0),
                    "capacity": int(row["capacity"] or 0),
                }
            close_types: dict[str, int] = {str(reason): 0 for reason in CLOSE_REASONS}
            close_types.update({"pending": 0, "gave_up": 0})
            for row in self._conn.execute(
                "SELECT closing_reason,"
                " SUM(CASE WHEN lookups >= ? THEN 1 ELSE 0 END) AS gave_up,"
                " COUNT(*) AS total FROM channel_closures"
                " WHERE closed_seen_ts >= ? GROUP BY closing_reason",
                (CLOSE_MAX_LOOKUPS, moment - days * 86400),
            ):
                reason = row["closing_reason"]
                total = int(row["total"] or 0)
                if reason is None:
                    gave_up = int(row["gave_up"] or 0)
                    close_types["gave_up"] += gave_up
                    close_types["pending"] += total - gave_up
                else:
                    close_types[str(int(reason))] += total
            series = {
                kind: [dict(day=day, **slot) for day, slot in sorted(per_day.items())]
                for kind, per_day in slots.items()
            }
        return {
            "days": days,
            "series": series,
            "close_types": close_types,
            "close_reasons": {
                str(reason): label for reason, label in CLOSE_REASONS.items()
            }
            | {"pending": "pending lookup", "gave_up": "unknown (lookup gave up)"},
            "events_since": self.events_since,
            "accumulating": self.events_since is None,
        }

    def flows_7d(self, now: float | None = None) -> dict:
        """Seven-day open/close/fee-change totals from the daily aggregate."""
        assert self._conn is not None
        moment = int(time.time() if now is None else now)
        first_day = _utc_day(moment) - 6 * 86400
        with self._lock:
            rows = {
                row["kind"]: (int(row["count"] or 0), int(row["capacity"] or 0))
                for row in self._conn.execute(
                    "SELECT kind, SUM(count) AS count, SUM(capacity) AS capacity"
                    " FROM event_daily WHERE day >= ? AND kind IN"
                    " ('channel_open', 'channel_close', 'policy_fee') GROUP BY kind",
                    (first_day,),
                )
            }
        opens, opened_capacity = rows.get("channel_open", (0, 0))
        closes, closed_capacity = rows.get("channel_close", (0, 0))
        fee_changes = rows.get("policy_fee", (0, 0))[0]
        return {
            "opens": opens,
            "closes": closes,
            "net_channels": opens - closes,
            "opened_capacity": opened_capacity,
            "closed_capacity": closed_capacity,
            "fee_changes": fee_changes,
        }

    # --- Channel closure lookups -------------------------------------------

    def closure_candidates(self, limit: int, now: float | None = None) -> list[dict]:
        """Unresolved closures due for another mempool lookup, newest first."""
        assert self._conn is not None
        moment = time.time() if now is None else now
        with self._lock:
            rows = self._conn.execute(
                "SELECT scid, lookups, last_lookup FROM channel_closures"
                " WHERE closing_reason IS NULL AND lookups < ?"
                " AND (last_lookup IS NULL OR last_lookup = 0 OR last_lookup <= ?)"
                " ORDER BY closed_seen_ts DESC LIMIT ?",
                (CLOSE_MAX_LOOKUPS, moment - CLOSE_RETRY_SECONDS, max(0, int(limit))),
            ).fetchall()
        return [dict(row) for row in rows]

    def update_closure(self, scid: int, fields: dict) -> None:
        """Persist one closure-lookup result (partial updates allowed)."""
        assert self._conn is not None
        if not fields:
            return
        assignments = ", ".join(f"{column} = :{column}" for column in fields)
        with self._lock:
            self._conn.execute(
                f"UPDATE channel_closures SET {assignments} WHERE scid = :scid",
                {**fields, "scid": scid},
            )
            self._conn.commit()

    def closure_rows(self, limit: int = 50) -> list[dict]:
        """Newest closures with their resolution state, for debugging."""
        assert self._conn is not None
        with self._lock:
            rows = self._conn.execute(
                "SELECT * FROM channel_closures ORDER BY closed_seen_ts DESC LIMIT ?",
                (max(1, int(limit)),),
            ).fetchall()
        return [dict(row) for row in rows]

    # --- Rank history --------------------------------------------------------

    def record_rank_history(self, top: int, now: float | None = None) -> int:
        """Store today's top ranks once per UTC day (after metrics ran).

        When the centrality metrics are not ready yet, only capacity and
        channel counts are stored for that day.
        """
        assert self._conn is not None
        day = _utc_day(now)
        with self._lock:
            if self._rank_day_written == day:
                return 0
            rows = self._rank_rows(day, max(1, int(top)))
            if rows:
                self._conn.executemany(
                    "INSERT OR REPLACE INTO rank_history (day, metric, pubkey, rank, value)"
                    " VALUES (?,?,?,?,?)",
                    rows,
                )
            self._conn.execute(
                "DELETE FROM rank_history WHERE day < ?",
                (day - RANK_HISTORY_RETENTION_SECONDS,),
            )
            self._conn.execute(
                "INSERT OR REPLACE INTO meta (key, value) VALUES ('rank_history_day', ?)",
                (str(day),),
            )
            self._conn.commit()
            self._rank_day_written = day
        return len(rows)

    def _rank_rows(self, day: int, top: int) -> list[tuple]:
        """Today's rows: capacity/channels descending, centrality by its rank."""
        rows: list[tuple] = []
        for metric in ("total_capacity", "num_channels"):
            entries = sorted(
                (
                    (info[metric], pubkey)
                    for pubkey, info in self.derived.items()
                    if info.get("num_channels") and info.get(metric) is not None
                ),
                key=lambda item: (-item[0], item[1]),
            )
            rows.extend(
                (day, metric, pubkey, index, float(value))
                for index, (value, pubkey) in enumerate(entries[:top], start=1)
            )
        present = set()
        for metrics in self.metrics.values():
            present.update(
                metric
                for metric in CENTRALITY_METRICS
                if metrics.get(metric) is not None and metrics.get(f"{metric}_rank") is not None
            )
        for metric in sorted(present):
            entries = sorted(
                (
                    (metrics[f"{metric}_rank"], pubkey, metrics[metric])
                    for pubkey, metrics in self.metrics.items()
                    if metrics.get(metric) is not None
                    and metrics.get(f"{metric}_rank") is not None
                ),
                key=lambda item: (item[0], item[1]),
            )
            rows.extend(
                (day, metric, pubkey, int(rank), float(value))
                for rank, pubkey, value in entries[:top]
            )
        return rows

    def available_rank_metrics(self) -> list[str]:
        """Rankings this store can currently serve."""
        with self._lock:
            metrics = ["total_capacity", "num_channels"]
            present = set()
            for row in self.metrics.values():
                present.update(
                    metric for metric in CENTRALITY_METRICS if row.get(metric) is not None
                )
            metrics.extend(metric for metric in CENTRALITY_METRICS if metric in present)
            return metrics

    def current_ranking(self, metric: str, limit: int) -> list[dict]:
        """Live top list, ordered the same way as the node table."""
        if metric not in RANK_METRICS:
            metric = "total_capacity"
        with self._lock:
            ordered: list[tuple[int, str, float]] = []
            if metric in ("total_capacity", "num_channels"):
                entries = sorted(
                    (
                        (info[metric], pubkey)
                        for pubkey, info in self.derived.items()
                        if info.get("num_channels") and info.get(metric) is not None
                    ),
                    key=lambda item: (-item[0], item[1]),
                )
                ordered = [
                    (index, pubkey, float(value))
                    for index, (value, pubkey) in enumerate(entries[:limit], start=1)
                ]
            else:
                entries = sorted(
                    (
                        (row[f"{metric}_rank"], pubkey, row[metric])
                        for pubkey, row in self.metrics.items()
                        if row.get(metric) is not None and row.get(f"{metric}_rank") is not None
                    ),
                    key=lambda item: (item[0], item[1]),
                )
                ordered = [
                    (int(rank), pubkey, float(value))
                    for rank, pubkey, value in entries[:limit]
                ]
            result = []
            for rank, pubkey, value in ordered:
                node = self.nodes.get(pubkey)
                result.append(
                    {
                        "rank": rank,
                        "pubkey": pubkey,
                        "alias": node.alias if node else "",
                        "value": value,
                    }
                )
            return result

    def _stored_rank_day(self, metric: str, target_day: int) -> int | None:
        """Newest stored day for a metric at or before ``target_day``."""
        assert self._conn is not None
        row = self._conn.execute(
            "SELECT MAX(day) FROM rank_history WHERE metric = ? AND day <= ?",
            (metric, target_day),
        ).fetchone()
        return int(row[0]) if row and row[0] is not None else None

    def _rank_map(self, metric: str, day: int) -> dict[str, int]:
        assert self._conn is not None
        return {
            row["pubkey"]: int(row["rank"])
            for row in self._conn.execute(
                "SELECT pubkey, rank FROM rank_history WHERE metric = ? AND day = ?",
                (metric, day),
            )
        }

    def rankings_payload(self, metric: str, limit: int, now: float | None = None) -> dict:
        """Current top list with 1d/7d/30d rank changes and sparkline history."""
        assert self._conn is not None
        if metric not in RANK_METRICS:
            metric = "total_capacity"
        today = _utc_day(now)
        with self._lock:
            objects = self.current_ranking(metric, limit)
            history: dict[str, list[int]] = defaultdict(list)
            for row in self._conn.execute(
                "SELECT pubkey, day, rank FROM rank_history WHERE metric = ? AND day >= ?"
                " ORDER BY day ASC",
                (metric, today - RANK_SPARKLINE_DAYS * 86400),
            ):
                history[row["pubkey"]].append(int(row["rank"]))
            span_days = {}
            for span in (1, 7, 30):
                day = self._stored_rank_day(metric, today - span * 86400)
                span_days[span] = (day, self._rank_map(metric, day)) if day is not None else (None, {})
            stored = self._conn.execute(
                "SELECT MIN(day) AS first, MAX(day) AS last FROM rank_history"
            ).fetchone()
            metrics = self.available_rank_metrics()
        for entry in objects:
            entry["history"] = history.get(entry["pubkey"], [])
            for span in (1, 7, 30):
                _day, ranks = span_days[span]
                previous = ranks.get(entry["pubkey"])
                # Positive means the node climbed (its rank number dropped).
                entry[f"rank_change_{span}d"] = (
                    previous - entry["rank"] if previous is not None else None
                )
        return {
            "metric": metric,
            "metrics": metrics,
            "days": {"first": stored["first"], "last": stored["last"]},
            "objects": objects,
        }

    def ranking_movers(
        self, metric: str, days: int = 7, limit: int = 20, now: float | None = None
    ) -> dict:
        """Biggest climbers and fallers between two stored days."""
        assert self._conn is not None
        if metric not in RANK_METRICS:
            metric = "total_capacity"
        days = max(1, min(int(days), 365))
        today = _utc_day(now)
        with self._lock:
            latest = self._stored_rank_day(metric, today)
            reference = self._stored_rank_day(metric, today - days * 86400)
            empty = {
                "metric": metric,
                "days": days,
                "from_day": reference,
                "to_day": latest,
                "climbers": [],
                "fallers": [],
            }
            if latest is None or reference is None or latest <= reference:
                return empty
            old_ranks = self._rank_map(metric, reference)
            new_ranks = self._rank_map(metric, latest)
            shared = [
                (old_ranks[pubkey] - rank, pubkey, rank, old_ranks[pubkey])
                for pubkey, rank in new_ranks.items()
                if pubkey in old_ranks
            ]
            shared.sort(key=lambda item: (-item[0], item[2]))

            def describe(items):
                described = []
                for change, pubkey, rank, previous in items:
                    node = self.nodes.get(pubkey)
                    described.append(
                        {
                            "pubkey": pubkey,
                            "alias": node.alias if node else "",
                            "rank": rank,
                            "previous_rank": previous,
                            "change": change,
                        }
                    )
                return described
            return {
                **empty,
                "climbers": describe(shared[:limit]),
                "fallers": describe(sorted(shared, key=lambda item: (item[0], item[2]))[:limit]),
            }

    def node_rank_history(self, pubkey: str, days: int = 180, now: float | None = None) -> dict:
        """Per-metric (day, rank) series for one node."""
        assert self._conn is not None
        days = max(1, min(int(days), 365 * 2))
        cutoff = _utc_day(now) - days * 86400
        with self._lock:
            rows = self._conn.execute(
                "SELECT metric, day, rank FROM rank_history WHERE pubkey = ? AND day >= ?"
                " ORDER BY metric ASC, day ASC",
                (pubkey, cutoff),
            ).fetchall()
        series: dict[str, list[dict]] = defaultdict(list)
        for row in rows:
            series[row["metric"]].append({"day": int(row["day"]), "rank": int(row["rank"])})
        return {"pubkey": pubkey, "days": days, "series": dict(series)}

    def apply_node_enrichment(self, pubkey: str, fields: dict, stamp: bool = True) -> None:
        """Record enrichment fields.

        Each alias/color/addresses value that replaces a non-empty old value
        buffers a change event; save() flushes the buffer once per refresh.
        """
        with self._lock:
            node = self.nodes.get(pubkey)
            if node is None:
                node = NodeRecord(pubkey=pubkey)
                self.nodes[pubkey] = node
            now = int(time.time())
            if fields.get("alias"):
                alias = str(fields["alias"])
                if node.alias and alias != node.alias and not self._field_flaps(pubkey, "alias", node.alias, alias, now):
                    self._pending_events.append(
                        {
                            "ts": now,
                            "kind": "alias",
                            "pubkey": pubkey,
                            "peer": None,
                            "scid": None,
                            "field": "alias",
                            "old": node.alias,
                            "new": alias,
                            "capacity": None,
                        }
                    )
                node.alias = alias
            if fields.get("color"):
                color = str(fields["color"])
                if node.color and color != node.color and not self._field_flaps(pubkey, "color", node.color, color, now):
                    self._pending_events.append(
                        {
                            "ts": now,
                            "kind": "color",
                            "pubkey": pubkey,
                            "peer": None,
                            "scid": None,
                            "field": "color",
                            "old": node.color,
                            "new": color,
                            "capacity": None,
                        }
                    )
                node.color = color
            if fields.get("addresses"):
                addresses = list(fields["addresses"])
                if node.addresses:
                    event = self._address_event(pubkey, node.addresses, addresses, now)
                    if event is not None:
                        self._pending_events.append(event)
                node.addresses = addresses
            if fields.get("country"):
                node.country = str(fields["country"])
            if fields.get("city"):
                node.city = str(fields["city"])
            if fields.get("first_seen"):
                node.first_seen = int(fields["first_seen"])
            if fields.get("capacity"):
                node.capacity = int(fields["capacity"])
            if fields.get("features"):
                # An empty profile answer never wipes bits learned from gossip.
                bits = [
                    int(bit)
                    for bit in fields["features"]
                    if isinstance(bit, int) and not isinstance(bit, bool) and bit >= 0
                ]
                if bits:
                    node.features = sorted(set(bits))
            if stamp:
                node.enriched_at = time.time()
            if pubkey in self.derived or pubkey in self.by_node:
                self._recompute_one(pubkey)

    def _recompute_one(self, pubkey: str) -> None:
        self.derived[pubkey] = self._derived_record(pubkey)

    def set_channel_capacity(self, scid: int, capacity: int, recompute: bool = True) -> None:
        with self._lock:
            self._set_capacity_unlocked(scid, capacity, recompute)

    def set_channel_capacities(self, updates: dict[int, int]) -> int:
        """Apply many channel capacities and refresh derived stats once."""
        with self._lock:
            changed = 0
            for scid, capacity in updates.items():
                if self._set_capacity_unlocked(scid, capacity, recompute=False):
                    changed += 1
            if changed:
                self._recompute_derived()
            return changed

    def _set_capacity_unlocked(self, scid: int, capacity: int, recompute: bool) -> bool:
        channel = self.channels.get(scid)
        if channel is None or capacity <= 0:
            return False
        if channel.capacity == capacity:
            return False
        channel.capacity = capacity
        if recompute:
            self._recompute_one(channel.node1)
            self._recompute_one(channel.node2)
        return True

    def reset_stale_capacity_cursors(self) -> int:
        """Forget cursors written by the scanner that stepped index by 1.

        That pass treated the offset as a page number, so consecutive requests
        overlapped by nine rows and a fluctuating X-Total-Count marked hubs
        finished. Channel capacities already stored are kept. The next pass
        rereads with a 1000-channel bulk page.
        """
        with self._lock:
            reset = 0
            for node in self.nodes.values():
                if node.capacity_scan >= 2:
                    continue
                if node.capacity_page or node.capacity_done:
                    reset += 1
                node.capacity_page = 0
                node.capacity_done = False
                node.capacity_scan = 2
            return reset

    def capacity_candidates(self) -> list[str]:
        """Highest-degree nodes whose channel pages have not been fully read."""
        with self._lock:
            ranked = sorted(
                self.by_node,
                key=lambda pubkey: len(self.by_node[pubkey]),
                reverse=True,
            )
            return [
                pubkey
                for pubkey in ranked
                if (node := self.nodes.get(pubkey)) is not None and not node.capacity_done
            ]

    def capacity_progress(self, pubkey: str, page: int, done: bool) -> None:
        with self._lock:
            node = self.nodes.get(pubkey)
            if node is None:
                return
            node.capacity_page = page
            node.capacity_done = done

    def adjacency(self) -> dict[str, list[str]]:
        """Undirected simple graph of channels that are not disabled both ways."""
        peers: dict[str, set[str]] = defaultdict(set)
        for channel in self.channels.values():
            disabled_both = True
            for policy in (channel.policy1, channel.policy2):
                if policy is None or not policy.disabled:
                    disabled_both = False
                    break
            if disabled_both and (channel.policy1 or channel.policy2):
                continue
            if channel.node1 == channel.node2:
                continue
            peers[channel.node1].add(channel.node2)
            peers[channel.node2].add(channel.node1)
        return {node: sorted(values) for node, values in peers.items() if values}

    def capacity_coverage(self) -> float:
        if not self.channels:
            return 0.0
        known = sum(1 for channel in self.channels.values() if channel.capacity)
        return known / len(self.channels)

    def edge_distance(self):
        """Positive distance that prefers larger channels. Requires coverage."""
        best: dict[tuple[str, str], int] = {}
        for channel in self.channels.values():
            if not channel.capacity:
                continue
            key = tuple(sorted((channel.node1, channel.node2)))
            best[key] = max(best.get(key, 0), channel.capacity)

        def weight(left: str, right: str) -> float:
            key = (left, right) if left < right else (right, left)
            capacity = best.get(key, 0)
            # Same preference as the original router: larger capacity is shorter.
            return 1.0 + 1.0 / (1.0 + capacity)

        return weight

    def recompute_metrics(self, samples: int = 64) -> None:
        with self._lock:
            adjacency = self.adjacency()
            coverage = self.capacity_coverage()
            weight = self.edge_distance() if coverage >= 0.3 else None
            seed = len(self.channels) ^ len(self.nodes) ^ self.graph_timestamp
        logger.info(
            "Computing metrics for %s linked nodes (%s samples, capacity coverage %.0f%%)",
            len(adjacency),
            samples,
            coverage * 100,
        )
        started = time.time()
        computed = compute_metrics(
            adjacency,
            samples=samples,
            capacity_weight=weight,
            seed=seed or 1,
        )
        with self._lock:
            self.metrics = computed["nodes"]
            self.metrics_meta = {
                "ready": True,
                "samples": computed["samples"],
                "capacity_weighted": computed["capacity_weighted"],
            }
        logger.info("Metrics ready in %.1fs", time.time() - started)

    def remember_network_stats(self, stats: dict) -> None:
        """Keep the freshest 'latest' row. mempool's backends disagree on it."""
        with self._lock:
            old = str(self.network_stats.get("added") or "")
            new = str(stats.get("added") or "")
            if not stats or (old and new and new < old):
                return
            self.network_stats = stats

    def _channel_aggregates(self) -> dict:
        """Channel and directed-policy aggregates shared by snapshots and stats.

        A channel counts as enabled unless both announced policies are
        disabled (the same rule as adjacency()). Fee statistics cover every
        non-disabled directed policy; each carries its channel capacity as a
        weight so a capacity-weighted mean can drop far-out values first.
        """
        enabled = disabled = known = 0
        capacities: list[float] = []
        rates: list[float] = []
        rate_weights: list[float] = []
        bases: list[float] = []
        base_weights: list[float] = []
        gossip_capacity = 0
        for channel in self.channels.values():
            first, second = channel.policy1, channel.policy2
            if (
                first is not None
                and second is not None
                and first.disabled
                and second.disabled
            ):
                disabled += 1
            else:
                enabled += 1
            capacity = float(channel.capacity) if channel.capacity else 0.0
            if capacity:
                known += 1
                capacities.append(capacity)
                gossip_capacity += int(capacity)
            for policy in (first, second):
                if policy is None or policy.disabled:
                    continue
                rates.append(float(policy.ppm))
                rate_weights.append(capacity)
                bases.append(float(policy.base_msat))
                base_weights.append(capacity)
        return {
            "enabled_channels": enabled,
            "disabled_channels": disabled,
            "capacity_known_channels": known,
            "gossip_capacity": gossip_capacity,
            "avg_channel_capacity": _mean(capacities) if capacities else None,
            "med_channel_capacity": _median(capacities) if capacities else None,
            "fee_rate": fees.summarize(rates, rate_weights),
            "base_fee": fees.summarize(bases, base_weights),
        }

    def record_local_snapshot(self) -> dict:
        """Persist one aggregate row for the current graph (once per refresh)."""
        return self._record_local_snapshot()

    def _record_local_snapshot(self) -> dict:
        assert self._conn is not None
        aggregates = self._channel_aggregates()
        # Our own measurement only: mempool's reported total froze on 2026-08-30,
        # so copying it would draw a flat line that is not ours.
        total = aggregates["gossip_capacity"]
        row = {
            "ts": int(time.time()),
            "node_count": len(self.by_node),
            "channel_count": len(self.channels),
            "total_capacity": int(total or 0),
            "med_base_fee": int(aggregates["base_fee"]["median"] or 0),
            "med_fee_rate": int(aggregates["fee_rate"]["median"] or 0),
            "source": self.source or "local",
            "enabled_channels": aggregates["enabled_channels"],
            "disabled_channels": aggregates["disabled_channels"],
            "capacity_known_channels": aggregates["capacity_known_channels"],
            "gossip_capacity": aggregates["gossip_capacity"],
            "avg_channel_capacity": aggregates["avg_channel_capacity"],
            "med_channel_capacity": aggregates["med_channel_capacity"],
        }
        for key, value in aggregates["fee_rate"].items():
            row[f"fee_rate_{key}"] = value
        for key, value in aggregates["base_fee"].items():
            row[f"base_fee_{key}"] = value
        with self._lock:
            columns = ", ".join(row)
            placeholders = ", ".join(f":{name}" for name in row)
            self._conn.execute(
                f"INSERT OR REPLACE INTO snapshots ({columns}) VALUES ({placeholders})", row
            )
            self._conn.execute(
                "DELETE FROM snapshots WHERE ts < ?",
                (int(time.time() - SNAPSHOT_RETENTION_SECONDS),),
            )
            self._conn.commit()
            self.local_snapshots = [
                dict(snapshot)
                for snapshot in self._conn.execute(
                    "SELECT * FROM snapshots ORDER BY ts ASC"
                )
            ]
        return row

    def external_until(self) -> int | None:
        """Newest timestamp in mempool's series, or None when there is none."""
        if not self.external_history:
            return None
        return int(self.external_history[-1]["ts"])

    def external_is_stale(self, now: float | None = None) -> bool:
        """True when the external series stopped more than three days ago."""
        until = self.external_until()
        if until is None:
            return False
        return (now or time.time()) - until > STALE_AFTER_SECONDS

    def local_since(self) -> int | None:
        if not self.local_snapshots:
            return None
        return int(self.local_snapshots[0]["ts"])

    def history_payload(self, range_name: str = "all", max_points: int = HISTORY_MAX_POINTS) -> dict:
        """Merged, time-ordered history for /api/history.

        Mempool rows cover everything up to external_until; local snapshot
        rows continue the series strictly after it. Local counts come from the
        rapid gossip sync snapshot and are not directly comparable with
        mempool's totals, so the two series stay separate.
        """
        now = time.time()
        window = HISTORY_RANGES.get(range_name)
        cutoff = now - window if window else 0
        until = self.external_until()
        points = [
            self._history_point(row, "mempool")
            for row in self.external_history
            if row["ts"] >= cutoff
        ]
        points.extend(
            self._history_point(row, "local")
            for row in self.local_snapshots
            if row["ts"] >= cutoff
        )
        points.sort(key=lambda point: point["ts"])
        points = _downsample(points, max_points)
        stale = self.external_is_stale(now)
        return {
            "points": points,
            "external_until": until,
            "external_stale": stale,
            "local_since": self.local_since(),
            "currency_rates": dict(self.current_prices),
            "notes": _history_note(until, stale),
        }

    def _history_point(self, row: dict, source: str) -> dict:
        ts = int(row["ts"])
        capacity = row.get("total_capacity")
        usd = self._usd_for_day(ts)
        capacity_usd = None
        if usd is not None and capacity:
            capacity_usd = capacity / 1e8 * usd
        return {
            "ts": ts,
            "source": source,
            "node_count": row.get("node_count"),
            "channel_count": row.get("channel_count"),
            "total_capacity": capacity,
            "med_fee_rate": row.get("med_fee_rate"),
            "med_base_fee": row.get("med_base_fee"),
            "usd_price": usd,
            "capacity_usd": capacity_usd,
        }

    def _usd_for_day(self, ts: int) -> float | None:
        pair = self.daily_prices.get(ts - ts % 86400)
        return pair[0] if pair else None

    def raw_snapshots(self, limit: int = 200) -> list[dict]:
        """Raw local aggregate rows, newest last."""
        assert self._conn is not None
        with self._lock:
            rows = list(
                self._conn.execute(
                    "SELECT * FROM snapshots ORDER BY ts DESC LIMIT ?", (limit,)
                )
            )
        rows.reverse()
        return [dict(row) for row in rows]

    def price_payload(self) -> dict:
        latest = None
        if self.daily_prices:
            day = max(self.daily_prices)
            usd, eur = self.daily_prices[day]
            latest = {"day": day, "usd": usd, "eur": eur}
        return {"current": dict(self.current_prices), "latest_daily": latest}

    def nodes_to_enrich(self, limit: int, max_age: float = 86400) -> list[str]:
        now = time.time()
        with self._lock:
            ranked = sorted(
                self.by_node,
                key=lambda pubkey: self.derived.get(pubkey, {}).get("num_channels", 0),
                reverse=True,
            )
            stale = []
            for pubkey in ranked:
                node = self.nodes.get(pubkey)
                if node is None:
                    continue
                if node.alias and node.enriched_at and now - node.enriched_at < max_age:
                    continue
                stale.append(pubkey)
                if len(stale) >= limit:
                    break
            return stale

    def enrich_fraction(self) -> float:
        with self._lock:
            linked = [pubkey for pubkey in self.by_node if pubkey in self.nodes]
            if not linked:
                return 0.0
            named = sum(1 for pubkey in linked if self.nodes[pubkey].alias)
            return named / len(linked)

    def save(self) -> None:
        assert self._conn is not None
        with self._lock:
            conn = self._conn
            # Enrichment events buffered during the refresh land here.
            self._flush_events()
            conn.execute("DELETE FROM channels")
            conn.executemany(
                """INSERT INTO channels (
                    scid, node1, node2, capacity,
                    n1_base, n1_ppm, n1_cltv, n1_min, n1_max, n1_disabled,
                    n2_base, n2_ppm, n2_cltv, n2_min, n2_max, n2_disabled
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                [
                    (
                        channel.scid,
                        channel.node1,
                        channel.node2,
                        channel.capacity,
                        *_policy_blob(channel.policy1),
                        *_policy_blob(channel.policy2),
                    )
                    for channel in self.channels.values()
                ],
            )
            conn.execute("DELETE FROM nodes")
            conn.executemany(
                """INSERT INTO nodes (
                    pubkey, alias, color, addresses, country, city, first_seen, capacity,
                    enriched_at, capacity_page, capacity_done, capacity_scan, features
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                [
                    (
                        node.pubkey,
                        node.alias,
                        node.color,
                        json.dumps(node.addresses),
                        node.country,
                        node.city,
                        node.first_seen,
                        node.capacity,
                        node.enriched_at,
                        node.capacity_page,
                        1 if node.capacity_done else 0,
                        node.capacity_scan,
                        json.dumps(node.features) if node.features else None,
                    )
                    for node in self.nodes.values()
                ],
            )
            conn.execute("DELETE FROM metrics")
            conn.executemany(
                """INSERT INTO metrics (
                    pubkey, betweenness, betweenness_weighted, closeness, closeness_weighted,
                    eigenvector, eigenvector_weighted, betweenness_rank,
                    betweenness_weighted_rank, closeness_rank, closeness_weighted_rank,
                    eigenvector_rank, eigenvector_weighted_rank
                ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                [
                    (
                        pubkey,
                        row.get("betweenness"),
                        row.get("betweenness_weighted"),
                        row.get("closeness"),
                        row.get("closeness_weighted"),
                        row.get("eigenvector"),
                        row.get("eigenvector_weighted"),
                        row.get("betweenness_rank"),
                        row.get("betweenness_weighted_rank"),
                        row.get("closeness_rank"),
                        row.get("closeness_weighted_rank"),
                        row.get("eigenvector_rank"),
                        row.get("eigenvector_weighted_rank"),
                    )
                    for pubkey, row in self.metrics.items()
                ],
            )
            meta = {
                "updated_at": str(self.updated_at),
                "graph_timestamp": str(self.graph_timestamp),
                "source": self.source,
                "source_detail": self.source_detail,
                "network_stats": json.dumps(self.network_stats),
                "metrics_meta": json.dumps(self.metrics_meta),
            }
            conn.executemany(
                "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)",
                list(meta.items()),
            )
            conn.commit()
        logger.info("Saved graph cache to %s", self.db_path)

    def node_view(self, pubkey: str, distance: int | None = None) -> dict | None:
        node = self.nodes.get(pubkey)
        if node is None:
            return None
        info = self.derived.get(pubkey, {})
        metrics = self.metrics.get(pubkey, {})
        return {
            "pubkey": pubkey,
            "alias": node.alias,
            "color": node.color,
            "addresses": node.addresses,
            "country": node.country,
            "city": node.city,
            "first_seen": node.first_seen,
            "ipv4": info.get("ipv4", False),
            "ipv6": info.get("ipv6", False),
            "tor": info.get("tor", False),
            "num_channels": info.get("num_channels", 0),
            "active_channels": info.get("active_channels", 0),
            "total_capacity": info.get("total_capacity", 0),
            "capacity_source": info.get("capacity_source", "unknown"),
            "avg_capacity": info.get("avg_capacity", 0),
            "med_capacity": info.get("med_capacity", 0),
            "max_capacity": info.get("max_capacity", 0),
            "avg_out_base": info.get("avg_out_base", 0),
            "med_out_base": info.get("med_out_base", 0),
            "max_out_base": info.get("max_out_base", 0),
            "avg_out_ppm": info.get("avg_out_ppm", 0),
            "med_out_ppm": info.get("med_out_ppm", 0),
            "max_out_ppm": info.get("max_out_ppm", 0),
            "avg_in_base": info.get("avg_in_base", 0),
            "med_in_base": info.get("med_in_base", 0),
            "avg_in_ppm": info.get("avg_in_ppm", 0),
            "med_in_ppm": info.get("med_in_ppm", 0),
            "betweenness_rank": metrics.get("betweenness_rank"),
            "betweenness_weighted_rank": metrics.get("betweenness_weighted_rank"),
            "closeness_rank": metrics.get("closeness_rank"),
            "closeness_weighted_rank": metrics.get("closeness_weighted_rank"),
            "eigenvector_rank": metrics.get("eigenvector_rank"),
            "eigenvector_weighted_rank": metrics.get("eigenvector_weighted_rank"),
            "shortest_path": distance,
            "metrics_ready": self.metrics_meta.get("ready", False),
            # Feature bits decoded to {bit, name, required}; booleans are None
            # when this node's features are unknown (v1 gossip, no profile yet).
            "features": features.describe(node.features) if node.features else [],
            "wumbo": features.has(node.features, "wumbo") if node.features else None,
            "anchors": features.has(node.features, "anchors") if node.features else None,
            "dual_fund": features.has(node.features, "dual_fund") if node.features else None,
            "onion_messages": (
                features.has(node.features, "onion_messages") if node.features else None
            ),
            "route_blinding": (
                features.has(node.features, "route_blinding") if node.features else None
            ),
        }

    def channel_view(self, scid: int) -> dict | None:
        channel = self.channels.get(scid)
        if channel is None:
            return None

        def side(pubkey: str, policy: Policy | None) -> dict:
            node = self.nodes.get(pubkey)
            return {
                "pubkey": pubkey,
                "alias": node.alias if node else "",
                "color": node.color if node else "",
                "policy": None
                if policy is None
                else {
                    "base_fee_msat": policy.base_msat,
                    "fee_rate_ppm": policy.ppm,
                    "cltv_delta": policy.cltv,
                    "min_htlc_msat": policy.min_htlc_msat,
                    "max_htlc_msat": policy.max_htlc_msat,
                    "disabled": policy.disabled,
                },
            }

        return {
            "scid": str(channel.scid),
            "short_id": channel.short_id(),
            "capacity": channel.capacity,
            "node1": side(channel.node1, channel.policy1),
            "node2": side(channel.node2, channel.policy2),
        }

    def channels_for(self, pubkey: str, page: int, page_size: int) -> dict:
        scids = self.by_node.get(pubkey, [])

        def sort_key(scid: int):
            channel = self.channels[scid]
            return (-(channel.capacity or 0), scid)

        ordered = sorted(scids, key=sort_key)
        start = max(0, (page - 1) * page_size)
        rows = []
        for scid in ordered[start : start + page_size]:
            channel = self.channels[scid]
            peer = channel.other(pubkey)
            peer_node = self.nodes.get(peer)
            outgoing = channel.policy_for(pubkey)
            incoming = channel.peer_policy(pubkey)
            rows.append(
                {
                    "scid": str(scid),
                    "short_id": channel.short_id(),
                    "capacity": channel.capacity,
                    "peer_pubkey": peer,
                    "peer_alias": peer_node.alias if peer_node else "",
                    "outgoing": None
                    if outgoing is None
                    else {
                        "base_fee_msat": outgoing.base_msat,
                        "fee_rate_ppm": outgoing.ppm,
                        "disabled": outgoing.disabled,
                        "cltv_delta": outgoing.cltv,
                    },
                    "incoming": None
                    if incoming is None
                    else {
                        "base_fee_msat": incoming.base_msat,
                        "fee_rate_ppm": incoming.ppm,
                        "disabled": incoming.disabled,
                        "cltv_delta": incoming.cltv,
                    },
                }
            )
        total = len(ordered)
        pages = max(1, (total + page_size - 1) // page_size) if total else 1
        return {
            "objects": rows,
            "page": page,
            "pages": pages,
            "page_size": page_size,
            "total_count": total,
        }

    def shortest_paths(self, source: str) -> dict[str, int]:
        adjacency = self.adjacency()
        if source not in adjacency:
            return {source: 0} if source in self.nodes else {}
        distance = {source: 0}
        queue = [source]
        index = 0
        while index < len(queue):
            current = queue[index]
            index += 1
            for peer in adjacency[current]:
                if peer not in distance:
                    distance[peer] = distance[current] + 1
                    queue.append(peer)
        return distance

    def query_nodes(
        self,
        text: str = "",
        protocols: list[str] | None = None,
        quantifier: str = "all",
        conditions: list[tuple[str, str, float]] | None = None,
        sort: str = "total_capacity",
        direction: str = "desc",
        page: int = 1,
        page_size: int = 30,
        reference: str | None = None,
        reachable_only: bool = False,
        feature: str | None = None,
    ) -> dict:
        protocols = protocols or []
        conditions = conditions or []
        if sort not in SORT_FIELDS:
            sort = "total_capacity"
        if feature not in features.FILTER_NAMES:
            feature = None
        distances = self.shortest_paths(reference) if reference else {}
        words = [word.casefold() for word in text.split() if word.strip()]
        matched = []
        for pubkey, node in self.nodes.items():
            info = self.derived.get(pubkey)
            if not info or not info["num_channels"]:
                continue
            if words:
                haystack = f"{node.alias} {pubkey}".casefold()
                if not all(word in haystack for word in words):
                    continue
            if protocols and not all(info.get(protocol) for protocol in protocols):
                continue
            if feature and not features.has(node.features, feature):
                continue
            metrics = self.metrics.get(pubkey, {})
            record = {**info, **{k: metrics.get(k) for k in (
                "betweenness_rank",
                "betweenness_weighted_rank",
                "closeness_rank",
                "closeness_weighted_rank",
                "eigenvector_rank",
                "eigenvector_weighted_rank",
            )}}
            record["alias"] = node.alias
            record["shortest_path"] = distances.get(pubkey) if reference else None
            if reference and reachable_only and pubkey not in distances:
                continue
            if conditions and not self._match(record, conditions, quantifier):
                continue
            matched.append((pubkey, record))

        reverse = direction != "asc"

        def sort_value(item):
            pubkey, record = item
            value = record.get(sort)
            missing = value is None or value == ""
            if isinstance(value, str):
                comparable = value.casefold()
            else:
                comparable = float(value or 0)
            # Present values always sort before missing ones.
            return (missing, _Directed(comparable, reverse), pubkey)

        matched.sort(key=sort_value)
        total = len(matched)
        pages = max(1, (total + page_size - 1) // page_size) if total else 1
        page = min(max(1, page), pages)
        start = (page - 1) * page_size
        objects = []
        for pubkey, _record in matched[start : start + page_size]:
            objects.append(
                self.node_view(pubkey, distances.get(pubkey) if reference else None)
            )
        return {
            "objects": objects,
            "page": page,
            "pages": pages,
            "page_size": page_size,
            "total_count": total,
        }

    def _match(self, record: dict, conditions: list[tuple[str, str, float]], quantifier: str) -> bool:
        results = []
        for field_name, relation, raw in conditions:
            if field_name not in SORT_FIELDS and field_name != "shortest_path":
                continue
            current = record.get(field_name)
            if current is None:
                results.append(False)
                continue
            try:
                value = float(current)
            except (TypeError, ValueError):
                results.append(False)
                continue
            if relation == "gt":
                results.append(value > raw)
            elif relation == "lt":
                results.append(value < raw)
            elif relation == "eq":
                results.append(value == raw)
            else:
                results.append(False)
        if not results:
            return True
        if quantifier == "any":
            return any(results)
        if quantifier == "none":
            return not any(results)
        return all(results)

    def autocomplete(self, text: str, limit: int = 8) -> list[dict]:
        """Lightweight node lookup for the reference/search inputs.

        Local store only, no mempool call, at least two characters.
        """
        needle = text.strip().casefold()
        if len(needle) < 2:
            return []
        matches = []
        for pubkey, node in self.nodes.items():
            if needle in node.alias.casefold() or needle in pubkey:
                info = self.derived.get(pubkey) or {}
                matches.append((info.get("num_channels", 0), pubkey, node.alias))
        matches.sort(key=lambda item: (-item[0], item[1]))
        return [
            {"pubkey": pubkey, "alias": alias, "num_channels": channels}
            for channels, pubkey, alias in matches[: max(1, min(int(limit), 20))]
        ]

    def search(self, text: str, limit: int = 20) -> dict:
        needle = text.strip()
        if not needle:
            return {"nodes": [], "channels": []}
        from explorer.rgs import parse_scid

        scid = parse_scid(needle)
        channels = []
        if scid is not None and scid in self.channels:
            channels.append(self.channel_view(scid))
        lowered = needle.casefold()
        nodes = []
        if len(lowered) == 66 and lowered in self.nodes:
            view = self.node_view(lowered)
            if view:
                nodes.append(view)
        else:
            for pubkey, node in self.nodes.items():
                if lowered in node.alias.casefold() or lowered in pubkey:
                    view = self.node_view(pubkey)
                    if view and view["num_channels"]:
                        nodes.append(view)
            nodes.sort(key=lambda item: item["num_channels"], reverse=True)
        return {"nodes": nodes[:limit], "channels": channels[:limit]}

    def graph_slice(self, limit: int = 1200, min_channels: int | None = None) -> dict:
        linked = [
            pubkey
            for pubkey, info in self.derived.items()
            if info["num_channels"] > 0
        ]
        linked.sort(key=lambda pubkey: self.derived[pubkey]["num_channels"], reverse=True)
        if min_channels is None:
            chosen = 1
            for threshold in (1, 2, 3, 5, 8, 10, 15, 20, 30, 50):
                count = sum(1 for pubkey in linked if self.derived[pubkey]["num_channels"] >= threshold)
                chosen = threshold
                if count <= limit:
                    break
            min_channels = chosen
        selected = [
            pubkey
            for pubkey in linked
            if self.derived[pubkey]["num_channels"] >= min_channels
        ][:limit]
        selected_set = set(selected)
        max_channels = max((self.derived[pubkey]["num_channels"] for pubkey in selected), default=1)
        nodes = []
        for index, pubkey in enumerate(selected):
            node = self.nodes[pubkey]
            info = self.derived[pubkey]
            size = 2.2 + 14.0 * (info["num_channels"] / max_channels) ** 0.5
            nodes.append(
                {
                    "pubkey": pubkey,
                    "alias": node.alias or pubkey[:10],
                    "color": node.color or "",
                    "channels": info["num_channels"],
                    "capacity": info["total_capacity"],
                    "size": round(size, 2),
                    "betweenness_rank": (self.metrics.get(pubkey) or {}).get("betweenness_rank"),
                }
            )
        seen = {}
        for channel in self.channels.values():
            if channel.node1 not in selected_set or channel.node2 not in selected_set:
                continue
            key = (channel.node1, channel.node2)
            bucket = seen.get(key)
            if bucket is None:
                seen[key] = {
                    "scid": str(channel.scid),
                    "a": channel.node1,
                    "b": channel.node2,
                    "capacity": channel.capacity or 0,
                    "count": 1,
                }
            else:
                bucket["count"] += 1
                if (channel.capacity or 0) > bucket["capacity"]:
                    bucket["capacity"] = channel.capacity or 0
                    bucket["scid"] = str(channel.scid)
        edges = list(seen.values())
        return {
            "nodes": nodes,
            "edges": edges,
            "min_channels": min_channels,
            "limit": limit,
            "shown_nodes": len(nodes),
            "shown_edges": len(edges),
            "total_nodes": len(linked),
            "total_channels": len(self.channels),
        }

    def status(self) -> dict:
        named = sum(1 for node in self.nodes.values() if node.alias)
        linked = [pubkey for pubkey in self.by_node if pubkey in self.nodes]
        known_features = sum(
            1 for pubkey in linked if self.nodes[pubkey].features
        )
        return {
            "ready": bool(self.channels),
            "nodes": len(self.by_node),
            "channels": len(self.channels),
            "named_nodes": named,
            "features_known": known_features,
            "updated_at": self.updated_at,
            "graph_timestamp": self.graph_timestamp,
            "source": self.source,
            "source_detail": self.source_detail,
            "metrics_ready": bool(self.metrics_meta.get("ready")),
            "metrics_samples": self.metrics_meta.get("samples", 0),
            "capacity_weighted": bool(self.metrics_meta.get("capacity_weighted")),
            "capacity_coverage": self.capacity_coverage(),
            "last_error": self.last_error,
        }

    def stats(self) -> dict:
        aggregates = self._channel_aggregates()
        rate = aggregates["fee_rate"]
        base = aggregates["base_fee"]
        gossip_capacity = aggregates["gossip_capacity"]
        reported = dict(self.network_stats)
        latest = self.external_history[-1] if self.external_history else None
        return {
            "network_latest": None
            if latest is None
            else {
                "ts": latest["ts"],
                "node_count": latest.get("node_count"),
                "channel_count": latest.get("channel_count"),
                "total_capacity": latest.get("total_capacity"),
            },
            "gossip_nodes": len(self.by_node),
            "gossip_channels": len(self.channels),
            "enabled_channels": aggregates["enabled_channels"],
            "disabled_channels": aggregates["disabled_channels"],
            "gossip_capacity": gossip_capacity,
            "capacity_coverage": self.capacity_coverage(),
            "median_base_fee_msat": base["median"],
            "median_fee_rate_ppm": rate["median"],
            # The plain averages are outlier-filtered; the raw ones sit next to them.
            "average_base_fee_msat": base["mean_filtered"],
            "average_fee_rate_ppm": rate["mean_filtered"],
            "raw_average_base_fee_msat": base["mean"],
            "raw_average_fee_rate_ppm": rate["mean"],
            "fees": {
                "rate": rate,
                "base": base,
                "enabled_channels": aggregates["enabled_channels"],
                "disabled_channels": aggregates["disabled_channels"],
            },
            "reported": reported,
            "flows_7d": self.flows_7d(),
            "source": self.source,
            "updated_at": self.updated_at,
            "graph_timestamp": self.graph_timestamp,
            "metrics_ready": bool(self.metrics_meta.get("ready")),
        }

    def top(self, field: str, limit: int = 10) -> list[dict]:
        if field not in SORT_FIELDS:
            field = "total_capacity"
        rows = self.query_nodes(sort=field, direction="desc", page=1, page_size=limit)
        return rows["objects"]
