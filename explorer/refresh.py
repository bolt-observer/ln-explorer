"""Periodic graph refresh.

Runs inside the web process: one download of the gossip snapshot, mempool
statistics and rankings, metric computation, then a paced pass that fills in
aliases for the best-connected nodes. The HTTP server stays up the whole time
and keeps serving the previous snapshot if a refresh fails.
"""

from __future__ import annotations

import logging
import threading
import time

from explorer.config import Settings
from explorer.rgs import parse_scid
from explorer.sources import Mempool, SourceError, fetch_lnd, fetch_rgs, load_graph_file
from explorer.store import Store

logger = logging.getLogger(__name__)


def _country_name(value) -> str:
    if isinstance(value, dict):
        return str(value.get("en") or next(iter(value.values()), ""))
    if isinstance(value, str):
        return value
    return ""


def _sockets(value) -> list[str]:
    if not value:
        return []
    if isinstance(value, list):
        return [str(item) for item in value if item]
    return [part.strip() for part in str(value).split(",") if part.strip()]


def _apply_ranking_row(store: Store, row: dict) -> None:
    pubkey = str(row.get("publicKey") or row.get("public_key") or "").lower()
    if len(pubkey) != 66:
        return
    city = row.get("city")
    store.apply_node_enrichment(
        pubkey,
        {
            "alias": row.get("alias") or "",
            "capacity": row.get("capacity") or 0,
            "country": _country_name(row.get("country")),
            "city": _country_name(city) if not isinstance(city, str) else city or "",
            "first_seen": row.get("firstSeen") or row.get("first_seen"),
        },
    )


def _history_from_mempool(payload) -> list[dict]:
    rows = []
    if isinstance(payload, dict):
        payload = payload.get("latest") or payload.get("values") or []
        if isinstance(payload, dict):
            payload = [payload]
    if not isinstance(payload, list):
        return rows
    for item in payload:
        if not isinstance(item, dict):
            continue
        added = item.get("added")
        if isinstance(added, str):
            continue
        rows.append(
            {
                "ts": int(added or 0),
                "node_count": item.get("node_count"),
                "channel_count": item.get("channel_count"),
                "total_capacity": item.get("total_capacity"),
                "med_base_fee": item.get("med_base_fee_mtokens"),
                "med_fee_rate": item.get("med_fee_rate"),
                "source": "mempool",
            }
        )
    rows.sort(key=lambda row: row["ts"])
    return rows


def _stats_from_mempool(payload) -> dict:
    latest = payload.get("latest", payload) if isinstance(payload, dict) else {}
    if not isinstance(latest, dict):
        return {}
    return {
        "node_count": latest.get("node_count"),
        "channel_count": latest.get("channel_count"),
        "total_capacity": latest.get("total_capacity"),
        "tor_nodes": latest.get("tor_nodes"),
        "clearnet_nodes": latest.get("clearnet_nodes"),
        "clearnet_tor_nodes": latest.get("clearnet_tor_nodes"),
        "unannounced_nodes": latest.get("unannounced_nodes"),
        "avg_capacity": latest.get("avg_capacity"),
        "avg_fee_rate": latest.get("avg_fee_rate"),
        "avg_base_fee_mtokens": latest.get("avg_base_fee_mtokens"),
        "med_capacity": latest.get("med_capacity"),
        "med_fee_rate": latest.get("med_fee_rate"),
        "med_base_fee_mtokens": latest.get("med_base_fee_mtokens"),
        "added": latest.get("added"),
    }


def load_graph(settings: Settings):
    source = settings.graph_source
    if source == "file":
        if not settings.graph_file:
            raise SourceError("GRAPH_FILE is required when GRAPH_SOURCE=file")
        return load_graph_file(settings.graph_file)
    if source == "lnd":
        macaroon = settings.macaroon_hex()
        if not settings.lnd_rest_url or not macaroon:
            raise SourceError("LND_REST_URL and a macaroon are required when GRAPH_SOURCE=lnd")
        return fetch_lnd(settings.lnd_rest_url, macaroon, insecure=settings.lnd_insecure)
    if source != "rgs":
        raise SourceError(f"unknown GRAPH_SOURCE {source}")
    try:
        return fetch_rgs(settings.rgs_url)
    except Exception as exc:
        if not settings.lnd_rest_url:
            raise
        logger.warning("RGS download failed (%s); trying LND", exc)
        macaroon = settings.macaroon_hex()
        if not macaroon:
            raise
        return fetch_lnd(settings.lnd_rest_url, macaroon, insecure=settings.lnd_insecure)


def _alias_fields(row: dict) -> dict:
    city = row.get("city")
    return {
        "alias": row.get("alias") or "",
        "capacity": row.get("capacity") or 0,
        "country": _country_name(row.get("country")),
        "city": city if isinstance(city, str) else _country_name(city),
        "first_seen": row.get("first_seen") or row.get("firstSeen"),
        "color": row.get("color") or "",
        "addresses": _sockets(row.get("sockets")),
    }


def _pubkey_of(row: dict) -> str:
    return str(row.get("public_key") or row.get("publicKey") or "").lower()


def apply_alias_row(store: Store, row: dict) -> bool:
    """Record an alias for a node that is already in the gossip graph."""
    if not isinstance(row, dict):
        return False
    pubkey = _pubkey_of(row)
    if len(pubkey) != 66 or pubkey not in store.nodes:
        return False
    fields = _alias_fields(row)
    alias = str(fields["alias"]).strip()
    if not alias and not fields["capacity"]:
        return False
    store.apply_node_enrichment(pubkey, fields, stamp=bool(alias))
    return bool(alias)


def apply_world_row(store: Store, row: list) -> bool:
    """World-map rows are [lat, lon, pubkey, alias, capacity, channels, country, iso]."""
    if not isinstance(row, list) or len(row) < 4:
        return False
    country = row[6] if len(row) > 6 else None
    return apply_alias_row(
        store,
        {
            "public_key": row[2],
            "alias": row[3],
            "capacity": row[4] if len(row) > 4 else 0,
            "country": country,
        },
    )


def apply_channel_page(store: Store, rows: list) -> int:
    """Store capacities and the peer alias carried on each channel row."""
    updates: dict[int, int] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        scid = parse_scid(str(row.get("id") or row.get("short_id") or ""))
        capacity = row.get("capacity")
        if scid is not None and capacity:
            try:
                updates[scid] = int(capacity)
            except (TypeError, ValueError):
                pass
        peer = row.get("node")
        if isinstance(peer, dict):
            apply_alias_row(store, peer)
    if not updates:
        return 0
    return store.set_channel_capacities(updates)


def bulk_aliases(store: Store, mempool: Mempool) -> int:
    """Name as many gossip nodes as the public bulk lists cover.

    A 429 stops the sweep after retries inside the client. Any other error
    skips that one list and continues.
    """
    named = 0
    try:
        for row in mempool.world_nodes():
            if apply_world_row(store, row):
                named += 1
        logger.info("World map matched %s node aliases", named)
    except SourceError as exc:
        if exc.status == 429:
            raise
        logger.warning("World node list failed: %s", exc)

    try:
        countries = mempool.countries()
    except SourceError as exc:
        if exc.status == 429:
            raise
        logger.warning("Country list failed: %s", exc)
        countries = []
    if not isinstance(countries, list):
        return named
    for country in countries:
        if not isinstance(country, dict):
            continue
        iso = str(country.get("iso") or "")
        if len(iso) != 2 or not iso.isalpha():
            continue
        try:
            rows = mempool.country_nodes(iso)
        except SourceError as exc:
            if exc.status == 429:
                raise
            logger.info("Skipping country %s: %s", iso, exc)
            continue
        for row in rows:
            if apply_alias_row(store, row):
                named += 1
    logger.info("Bulk alias lists applied, running named total %s", named)
    return named


def enrich_profiles(store: Store, mempool: Mempool, pubkeys: list[str]) -> int:
    """Fetch individual profiles. Skip failures. Stop only when rate limited."""
    done = 0
    for pubkey in pubkeys:
        try:
            enrich_node(store, mempool, pubkey)
            done += 1
        except SourceError as exc:
            if exc.status == 429:
                logger.warning("Mempool rate limited; stopping profile batch after %s", done)
                break
            logger.info("Skipping enrichment for %s: %s", pubkey[:12], exc)
        except Exception as exc:
            logger.info("Skipping enrichment for %s: %s", pubkey[:12], exc)
        if done and done % 200 == 0:
            logger.info("Enriched %s node profiles", done)
    return done


# mempool's channel list treats `index` as a row offset. index=-1 returns the
# first 1000 channels in one response. A positive index returns 10 rows.
# X-Total-Count moves between requests, so it is a high-water hint only.
_BULK_INDEX = -1
_BULK_LIMIT = 1000
_PAGE_SIZE = 10
_ERROR_STREAK = 3


def _advance_capacity_offset(offset: int, nrows: int, seen_total: int) -> tuple[int, bool]:
    """Next offset, and whether this response already ends the node."""
    if offset == 0:
        if nrows < _BULK_LIMIT:
            return nrows, True
        return _BULK_LIMIT, False
    nxt = offset + max(nrows, _PAGE_SIZE)
    # Only the highest total seen can end the walk, and only once the offset
    # is past it. A single low X-Total-Count used to mark hubs finished.
    if seen_total and nxt > seen_total + _PAGE_SIZE:
        return nxt, True
    return nxt, False


def fill_capacities(store: Store, mempool: Mempool, page_budget: int) -> int:
    """Read mempool channel lists for the best-connected nodes still unscanned.

    The first request for a node uses index=-1 (up to 1000 channels, each with
    capacity and the peer alias). A node with more channels continues at
    offset 1000 in steps of 10. Progress is kept on the node so the next
    refresh continues down the degree list. A short tail page is fetched
    twice before the node is marked finished. HTTP 429 stops the batch.
    Other errors skip that node for this refresh and leave it unfinished.
    """
    if page_budget <= 0:
        return 0
    reset = store.reset_stale_capacity_cursors()
    if reset:
        logger.info("Reset %s capacity cursors from the overlapping page scan", reset)
    used = 0
    for pubkey in store.capacity_candidates():
        if used >= page_budget:
            break
        node = store.nodes.get(pubkey)
        offset = node.capacity_page if node else 0
        seen_total = 0
        errors = 0
        while used < page_budget:
            index = _BULK_INDEX if offset == 0 else offset
            try:
                rows, total = mempool.node_channels(pubkey, index)
            except SourceError as exc:
                if exc.status == 429:
                    logger.warning("Mempool rate limited during capacity fill after %s pages", used)
                    store.capacity_progress(pubkey, offset, False)
                    return used
                errors += 1
                used += 1
                logger.info("Skipping capacity page for %s index %s: %s", pubkey[:12], index, exc)
                if errors >= _ERROR_STREAK:
                    store.capacity_progress(pubkey, offset, False)
                    break
                continue
            except Exception as exc:
                errors += 1
                used += 1
                logger.info("Skipping capacity page for %s index %s: %s", pubkey[:12], index, exc)
                if errors >= _ERROR_STREAK:
                    store.capacity_progress(pubkey, offset, False)
                    break
                continue
            errors = 0
            if total:
                seen_total = max(seen_total, total)
            matched = apply_channel_page(store, rows)
            used += 1
            # A short tail page can be a shifting window. Confirm it once.
            if offset != 0 and len(rows) < _PAGE_SIZE:
                try:
                    rows, total = mempool.node_channels(pubkey, offset)
                except SourceError as exc:
                    if exc.status == 429:
                        logger.warning(
                            "Mempool rate limited during capacity fill after %s pages", used
                        )
                        store.capacity_progress(pubkey, offset, False)
                        return used
                    logger.info(
                        "Skipping capacity page for %s index %s: %s", pubkey[:12], offset, exc
                    )
                    store.capacity_progress(pubkey, offset, False)
                    used += 1
                    break
                except Exception as exc:
                    logger.info(
                        "Skipping capacity page for %s index %s: %s", pubkey[:12], offset, exc
                    )
                    store.capacity_progress(pubkey, offset, False)
                    used += 1
                    break
                used += 1
                if total:
                    seen_total = max(seen_total, total)
                matched += apply_channel_page(store, rows)
                if len(rows) < _PAGE_SIZE:
                    store.capacity_progress(pubkey, offset + len(rows), True)
                    logger.info(
                        "Capacity node %s finished at offset %s (%s rows, %s matched), coverage %.2f%%",
                        pubkey[:12],
                        offset,
                        len(rows),
                        matched,
                        store.capacity_coverage() * 100,
                    )
                    break
            nxt, finished = _advance_capacity_offset(offset, len(rows), seen_total)
            store.capacity_progress(pubkey, nxt, finished)
            offset = nxt
            if used % 25 == 0:
                logger.info(
                    "Capacity pages %s, coverage %.2f%%",
                    used,
                    store.capacity_coverage() * 100,
                )
            if finished:
                break
    logger.info("Fetched %s channel pages, coverage %.2f%%", used, store.capacity_coverage() * 100)
    return used


def enrich_node(store: Store, mempool: Mempool, pubkey: str) -> None:
    payload = mempool.node(pubkey)
    if not isinstance(payload, dict):
        return
    store.apply_node_enrichment(
        pubkey,
        {
            "alias": payload.get("alias") or "",
            "color": payload.get("color") or "",
            "addresses": _sockets(payload.get("sockets")),
            "capacity": payload.get("capacity") or 0,
            "country": _country_name(payload.get("country")),
            "city": _country_name(payload.get("city")),
            "first_seen": payload.get("first_seen"),
        },
    )


def enrich_channel(store: Store, mempool: Mempool, scid: int) -> dict | None:
    payload = mempool.channel(scid)
    if not isinstance(payload, dict):
        return None
    capacity = payload.get("capacity")
    if capacity:
        store.set_channel_capacity(scid, int(capacity))
    for side in ("node_left", "node_right"):
        node = payload.get(side) or {}
        pubkey = str(node.get("public_key") or "").lower()
        if len(pubkey) != 66:
            continue
        store.apply_node_enrichment(
            pubkey,
            {
                "alias": node.get("alias") or "",
                "capacity": node.get("capacity") or 0,
            },
        )
    return payload


def refresh_once(store: Store, settings: Settings) -> None:
    """Download a snapshot, recompute metrics, and enrich a batch of nodes."""
    mempool = Mempool(settings.mempool_api, min_interval=1.0 / max(settings.enrich_rps, 0.1))
    try:
        fetched = load_graph(settings)
        store.install_graph(fetched.graph, fetched.source, fetched.detail)
    except Exception as exc:
        store.last_error = str(exc)
        logger.exception("Graph refresh failed")
        if not store.channels:
            return
        logger.info("Continuing with the previous snapshot")

    if mempool.enabled:
        try:
            store.remember_network_stats(
                _stats_from_mempool(mempool.statistics("latest")),
                _history_from_mempool(mempool.statistics("1y")),
            )
            for kind in ("liquidity", "connectivity", "age"):
                rows = mempool.rankings(kind)
                if isinstance(rows, list):
                    for row in rows:
                        if isinstance(row, dict):
                            _apply_ranking_row(store, row)
        except Exception as exc:
            logger.warning("Mempool statistics/rankings failed: %s", exc)

    if mempool.enabled:
        try:
            bulk_aliases(store, mempool)
        except SourceError as exc:
            logger.warning("Bulk alias fetch stopped: %s", exc)
        except Exception:
            logger.exception("Bulk alias fetch failed")
        try:
            fill_capacities(store, mempool, settings.capacity_pages_per_refresh)
        except Exception:
            logger.exception("Capacity fill failed")
        if settings.enrich_per_refresh > 0:
            targets = store.nodes_to_enrich(settings.enrich_per_refresh)
            logger.info("Enriching %s node profiles from mempool", len(targets))
            enrich_profiles(store, mempool, targets)

    try:
        store.recompute_metrics(samples=settings.metrics_samples)
    except Exception:
        logger.exception("Metric computation failed")

    logger.info(
        "Refresh names %.1f%% of nodes, channel capacity coverage %.2f%%",
        store.enrich_fraction() * 100,
        store.capacity_coverage() * 100,
    )
    try:
        store.save()
    except Exception:
        logger.exception("Failed to persist graph cache")


def start_refresh(store: Store, settings: Settings) -> threading.Thread:
    def loop() -> None:
        while True:
            started = time.time()
            refresh_once(store, settings)
            interval = settings.refresh_seconds
            if interval <= 0:
                return
            elapsed = time.time() - started
            time.sleep(max(5.0, interval - elapsed))

    thread = threading.Thread(target=loop, name="graph-refresh", daemon=True)
    thread.start()
    return thread
