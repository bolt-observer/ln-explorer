"""Long-term fee history: per-channel policy changes and daily fee distributions.

Two compact tables:

* ``policy_history`` keeps one row per directed policy whenever its base fee,
  fee rate or disabled flag changes between two refreshed graphs (plus one
  baseline row per policy the first time). Other policy fields are ignored, so
  periodic keep-alive re-announcements cost nothing.
* ``fee_daily`` keeps one fee-distribution row per UTC day and source. The
  live row is rewritten on every refresh, so the last refresh of a day wins.
  Imported datasets use the same columns with their own ``source``.

Metric definitions (shared by every source so the series line up):

* population: directed policies (half-channels) that are not disabled;
* ``p10`` .. ``p99``: percentiles of the fee rate in ppm, linear interpolation
  (numpy's default), over that population;
* ``mean_le50k``: mean fee rate after dropping rates above 50,000 ppm, which
  are placeholder "do not route" values (e.g. 2^31-1);
* ``med_base_msat``: median base fee; ``zero_base_share``: share with base 0;
* ``hist``: counts per fee-rate bin, see ``HIST_EDGES``.
"""

from __future__ import annotations

import calendar
import csv
import hashlib
import io
import json
import math
import sqlite3
import time
from pathlib import Path
from typing import Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS policy_history (
    scid INTEGER,
    dir INTEGER,
    ts INTEGER,
    base_msat INTEGER,
    ppm INTEGER,
    disabled INTEGER,
    PRIMARY KEY (scid, dir, ts)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS policy_history_ts ON policy_history (ts);
CREATE TABLE IF NOT EXISTS fee_daily (
    day INTEGER,
    source TEXT,
    ts INTEGER,
    half_channels INTEGER,
    p10 REAL,
    p25 REAL,
    p50 REAL,
    p75 REAL,
    p90 REAL,
    p99 REAL,
    mean_le50k REAL,
    med_base_msat REAL,
    zero_base_share REAL,
    hist TEXT,
    PRIMARY KEY (day, source)
) WITHOUT ROWID;
"""

# Fee-rate bin upper edges in ppm: bin 0 is rate < 1, bin i is
# [edges[i-1], edges[i]), the last bin is >= edges[-1].
HIST_EDGES = (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000)
PLACEHOLDER_PPM = 50_000
POLICY_HISTORY_RETENTION_SECONDS = int(3 * 365.25 * 86400)
LIVE_SOURCE = "live"

FEE_DAILY_COLUMNS = (
    "day", "source", "ts", "half_channels", "p10", "p25", "p50", "p75", "p90",
    "p99", "mean_le50k", "med_base_msat", "zero_base_share", "hist",
)


def percentile(sorted_values: list[float], q: float) -> float:
    """Linear-interpolated percentile (numpy's default) of sorted values."""
    if not sorted_values:
        raise ValueError("percentile of empty data")
    position = (len(sorted_values) - 1) * q / 100.0
    low = math.floor(position)
    high = min(low + 1, len(sorted_values) - 1)
    fraction = position - low
    return sorted_values[low] + (sorted_values[high] - sorted_values[low]) * fraction


def histogram(rates: Iterable[float]) -> list[int]:
    import bisect

    counts = [0] * (len(HIST_EDGES) + 1)
    for rate in rates:
        counts[bisect.bisect_right(HIST_EDGES, rate)] += 1
    return counts


def distribution(policies: Iterable) -> dict | None:
    """Fee distribution over enabled policies (objects with ppm/base_msat/disabled)."""
    rates: list[float] = []
    bases: list[float] = []
    for policy in policies:
        if policy is None or policy.disabled:
            continue
        rates.append(float(policy.ppm))
        bases.append(float(policy.base_msat))
    if not rates:
        return None
    rates.sort()
    bases.sort()
    capped = [rate for rate in rates if rate <= PLACEHOLDER_PPM]
    return {
        "half_channels": len(rates),
        "p10": percentile(rates, 10),
        "p25": percentile(rates, 25),
        "p50": percentile(rates, 50),
        "p75": percentile(rates, 75),
        "p90": percentile(rates, 90),
        "p99": percentile(rates, 99),
        "mean_le50k": sum(capped) / len(capped) if capped else None,
        "med_base_msat": percentile(bases, 50),
        "zero_base_share": sum(1 for base in bases if base == 0) / len(bases),
        "hist": histogram(rates),
    }


def _fee_key(policy) -> tuple[int, int, int] | None:
    if policy is None:
        return None
    return (int(policy.base_msat), int(policy.ppm), 1 if policy.disabled else 0)


def policy_changes(old_channels: dict, new_channels: dict, now: int, baseline: bool) -> list[tuple]:
    """Rows (scid, dir, ts, base_msat, ppm, disabled) for changed policies.

    ``old_channels``/``new_channels`` map scid -> object with policy1/policy2.
    With ``baseline`` every present policy is written once.
    """
    rows: list[tuple] = []
    for scid, channel in new_channels.items():
        old = None if baseline else old_channels.get(scid)
        for direction, after, before in (
            (0, channel.policy1, old.policy1 if old else None),
            (1, channel.policy2, old.policy2 if old else None),
        ):
            key = _fee_key(after)
            if key is None or key == _fee_key(before):
                continue
            rows.append((int(scid), direction, int(now), *key))
    return rows


def write_policy_changes(conn: sqlite3.Connection, rows: list[tuple], now: int) -> None:
    if rows:
        conn.executemany(
            "INSERT OR REPLACE INTO policy_history (scid, dir, ts, base_msat, ppm, disabled)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
    conn.execute(
        "DELETE FROM policy_history WHERE ts < ?", (int(now - POLICY_HISTORY_RETENTION_SECONDS),)
    )


def write_daily(conn: sqlite3.Connection, day: int, source: str, ts: int, dist: dict) -> None:
    row = dict(dist, day=int(day), source=source, ts=int(ts), hist=json.dumps(dist.get("hist")))
    conn.execute(
        f"INSERT OR REPLACE INTO fee_daily ({', '.join(FEE_DAILY_COLUMNS)})"
        f" VALUES ({', '.join(':' + name for name in FEE_DAILY_COLUMNS)})",
        {name: row.get(name) for name in FEE_DAILY_COLUMNS},
    )


def channel_policy_history(conn: sqlite3.Connection, scid: int) -> list[dict]:
    return [
        {"dir": row[0], "ts": row[1], "base_msat": row[2], "ppm": row[3], "disabled": bool(row[4])}
        for row in conn.execute(
            "SELECT dir, ts, base_msat, ppm, disabled FROM policy_history"
            " WHERE scid = ? ORDER BY ts, dir",
            (int(scid),),
        )
    ]


SOURCE_INFO = {
    "lnresearch": {
        "label": "lnresearch gossip archive",
        "note": "Rebuilt from the lnresearch/topology gossip dumps by Christian Decker "
        "(MIT, doi:10.5281/zenodo.4088530), 2019-2023. Gaps are collection outages.",
        "file": "fee_daily_lnresearch.csv",
    },
    "gossip-archive": {
        "label": "Gossip archive",
        "note": "Rebuilt from a public archive of received channel_update gossip, 2024-2026.",
        "file": "fee_daily_gossip_archive.csv",
    },
    LIVE_SOURCE: {
        "label": "This explorer",
        "note": "Enabled policies in the LDK rapid gossip sync snapshot, recorded every refresh.",
    },
}
DATASET_DIR = Path(__file__).with_name("datasets")
FLOAT_COLUMNS = (
    "p10", "p25", "p50", "p75", "p90", "p99", "mean_le50k", "med_base_msat", "zero_base_share",
)


def load_datasets(conn: sqlite3.Connection, directory: Path = DATASET_DIR) -> int:
    """(Re)import the bundled daily fee datasets whose content changed.

    Each file replaces only its own source's rows and is keyed by its sha256
    in ``meta``, so startup is a no-op once imported. Returns rows written.
    """
    written = 0
    for source, info in SOURCE_INFO.items():
        name = info.get("file")
        path = directory / name if name else None
        if path is None or not path.is_file():
            continue
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        meta_key = f"fee_dataset:{source}"
        found = conn.execute("SELECT value FROM meta WHERE key = ?", (meta_key,)).fetchone()
        if found and found[0] == digest:
            continue
        rows = []
        for record in csv.DictReader(io.StringIO(data.decode("utf-8"))):
            day = calendar.timegm(time.strptime(record["date"], "%Y-%m-%d"))
            row = {
                "day": day,
                "source": source,
                "ts": day,
                "half_channels": int(record["half_channels"]),
                "hist": record.get("hist") or None,
            }
            for column in FLOAT_COLUMNS:
                value = record.get(column)
                row[column] = float(value) if value not in (None, "") else None
            rows.append(row)
        conn.execute("DELETE FROM fee_daily WHERE source = ?", (source,))
        conn.executemany(
            f"INSERT OR REPLACE INTO fee_daily ({', '.join(FEE_DAILY_COLUMNS)})"
            f" VALUES ({', '.join(':' + column for column in FEE_DAILY_COLUMNS)})",
            rows,
        )
        conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (meta_key, digest))
        written += len(rows)
    conn.commit()
    return written

DEFINITIONS = (
    "Fee rate percentiles (ppm) over directed channel policies that are not disabled; "
    "median base fee over the same policies. Historical sources rebuild each day's "
    "network state at 00:00 UTC from raw channel_update gossip (latest update per "
    "half-channel, updated within the previous 14 days)."
)


def history_payload(conn: sqlite3.Connection, cutoff: int = 0) -> dict:
    """fee_daily grouped by source, oldest first, for /api/fees/history."""
    series: dict[str, list] = {}
    for row in conn.execute(
        "SELECT source, day, half_channels, p25, p50, p75, p90, med_base_msat, mean_le50k"
        " FROM fee_daily WHERE day >= ? ORDER BY day",
        (int(cutoff - cutoff % 86400),),
    ):
        series.setdefault(row[0], []).append(list(row[1:]))
    order = {name: index for index, name in enumerate(SOURCE_INFO)}
    return {
        "columns": ["ts", "half_channels", "p25", "p50", "p75", "p90", "med_base_msat", "mean_le50k"],
        "series": [
            {
                "source": source,
                "label": SOURCE_INFO.get(source, {}).get("label", source),
                "note": SOURCE_INFO.get(source, {}).get("note", ""),
                "first": points[0][0],
                "last": points[-1][0],
                "points": points,
            }
            for source, points in sorted(series.items(), key=lambda item: order.get(item[0], 99))
        ],
        "definitions": DEFINITIONS,
    }
