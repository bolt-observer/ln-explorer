"""Periodic graph refresh.

Runs inside the web process: one download of the gossip snapshot, mempool
statistics and rankings, metric computation, then a paced pass that fills in
aliases for the best-connected nodes. The HTTP server stays up the whole time
and keeps serving the previous snapshot if a refresh fails.
"""

from __future__ import annotations

import datetime
import logging
import threading
import time

from explorer.config import Settings
from explorer.features import bits_from_mempool
from explorer.rgs import parse_scid
from explorer.sources import Mempool, SourceError, fetch_lnd, fetch_rgs, load_graph_file
from explorer.store import CLOSE_MAX_LOOKUPS, Store

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


def _number(value) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _history_all_rows(payload) -> list[dict]:
    """Rows from /v1/lightning/statistics/all (newest first), oldest first out.

    That response has no node_count; the announced node classes sum to it:
    tor + clearnet + clearnet_tor + unannounced. It reaches back to March 2018.
    """
    if isinstance(payload, dict):
        payload = payload.get("statistics") or payload.get("values") or []
    rows: list[dict] = []
    if not isinstance(payload, list):
        return rows
    for item in payload:
        if not isinstance(item, dict):
            continue
        ts = _number(item.get("added"))
        if not ts:
            continue
        tor = _number(item.get("tor_nodes"))
        clearnet = _number(item.get("clearnet_nodes"))
        both = _number(item.get("clearnet_tor_nodes"))
        unannounced = _number(item.get("unannounced_nodes"))
        parts = [value for value in (tor, clearnet, both, unannounced) if value is not None]
        node_count = sum(parts) if parts else None
        if _number(item.get("channel_count")) is None and _number(item.get("total_capacity")) is None:
            continue
        rows.append(
            {
                "ts": ts,
                "node_count": node_count,
                "channel_count": _number(item.get("channel_count")),
                "total_capacity": _number(item.get("total_capacity")),
                "tor_nodes": tor,
                "clearnet_nodes": clearnet,
                "clearnet_tor_nodes": both,
                "unannounced_nodes": unannounced,
            }
        )
    rows.sort(key=lambda row: row["ts"])
    return rows


def daily_prices(payload) -> dict[int, tuple[float | None, float | None]]:
    """Downsample mempool's historical-price rows to one value per UTC day.

    Rows run roughly hourly (daily for older dates), so the last valid value
    of each day wins. Mempool reports -1 for unknown rates; those are skipped.
    """
    rows = []
    if isinstance(payload, dict):
        rows = payload.get("prices") or []
    elif isinstance(payload, list):
        rows = payload
    daily: dict[int, list] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        stamp = _number(row.get("time"))
        if not stamp:
            continue
        slot = daily.setdefault(stamp - stamp % 86400, [None, None])
        usd = row.get("USD")
        eur = row.get("EUR")
        if isinstance(usd, (int, float)) and not isinstance(usd, bool) and usd > 0:
            slot[0] = float(usd)
        if isinstance(eur, (int, float)) and not isinstance(eur, bool) and eur > 0:
            slot[1] = float(eur)
    return {
        day: (usd, eur)
        for day, (usd, eur) in daily.items()
        if usd is not None or eur is not None
    }


# statistics/all is a large response and changes once a day at most.
EXTERNAL_FETCH_INTERVAL = 86400.0
HISTORY_SAMPLES = 3


def refresh_history(store: Store, mempool: Mempool) -> None:
    """Pull the multi-year series from mempool at most once per 24h."""
    if not mempool.enabled:
        return
    if time.time() - store.last_history_fetch < EXTERNAL_FETCH_INTERVAL:
        return
    try:
        # mempool.space answers from several backends whose Lightning
        # statistics have different gaps (one stopped on 2026-08-30, another
        # is current). Union a few responses; rows merge by timestamp.
        rows: list[dict] = []
        for _attempt in range(HISTORY_SAMPLES):
            rows.extend(_history_all_rows(mempool.statistics_all()))
        rows.extend(_history_all_rows(mempool.statistics("1y")))
        stored = store.record_external_history(rows)
        store.mark_history_fetched()
        logger.info("Recorded %s external history rows from mempool", stored)
    except Exception as exc:
        logger.warning("Mempool history refresh failed, keeping cache: %s", exc)


def refresh_prices(store: Store, mempool: Mempool) -> None:
    """Current BTC price every refresh, the daily series once per 24h."""
    if not mempool.enabled:
        return
    try:
        payload = mempool.prices()
        if isinstance(payload, dict) and payload.get("USD"):
            store.set_current_prices(payload)
    except Exception as exc:
        logger.warning("Mempool price fetch failed, keeping cache: %s", exc)
    if time.time() - store.last_price_fetch < EXTERNAL_FETCH_INTERVAL:
        return
    try:
        daily = daily_prices(mempool.historical_prices())
        stored = store.record_prices(daily)
        store.mark_prices_fetched()
        logger.info("Recorded %s daily BTC prices from mempool", stored)
    except Exception as exc:
        logger.warning("Mempool historical price refresh failed, keeping cache: %s", exc)


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
    fields = {
        "alias": payload.get("alias") or "",
        "color": payload.get("color") or "",
        "addresses": _sockets(payload.get("sockets")),
        "capacity": payload.get("capacity") or 0,
        "country": _country_name(payload.get("country")),
        "city": _country_name(payload.get("city")),
        "first_seen": payload.get("first_seen"),
    }
    # No extra call: the same profile also answers feature bits, as a list of
    # {bit, ...} objects in recent mempool versions or as a hex string.
    bits = bits_from_mempool(payload)
    if bits:
        fields["features"] = bits
    store.apply_node_enrichment(pubkey, fields)


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


def _closure_date(value) -> str | None:
    """mempool reports an ISO string (older versions a unix timestamp)."""
    if isinstance(value, str) and "T" in value:
        return value
    stamp = _number(value)
    if not stamp:
        return None
    return datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc).strftime(
        "%Y-%m-%d %H:%M UTC"
    )


def _closure_fields(payload) -> dict:
    """Fields mempool's GET /v1/lightning/channels/<id> carries for a close."""
    if not isinstance(payload, dict):
        return {}
    reason = payload.get("closing_reason")
    status = payload.get("status")
    return {
        "closing_reason": int(reason) if isinstance(reason, (int, float)) else None,
        "closing_date": _closure_date(payload.get("closing_date")),
        "closing_txid": str(payload.get("closing_transaction_id") or "") or None,
        "mempool_status": int(status) if isinstance(status, (int, float)) else None,
    }


def resolve_closures(store: Store, mempool: Mempool, budget: int) -> int:
    """Look up unresolved channel closes at mempool.space.

    A row is resolved once mempool names a closing reason. Unresolved rows
    retry at most once per 12h and at most 6 times in total; a 404 marks the
    lookup given up. HTTP 429 stops the batch. mempool's Lightning indexer
    stopped around 2026-08-30, so later closes usually stay unknown.
    """
    if budget <= 0 or not mempool.enabled:
        return 0
    resolved = 0
    for row in store.closure_candidates(budget):
        scid = row["scid"]
        try:
            payload = mempool.channel(scid)
        except SourceError as exc:
            if exc.status == 429:
                logger.warning("Mempool rate limited during close lookups; stopping batch")
                return resolved
            if exc.status == 404:
                store.update_closure(scid, {"lookups": CLOSE_MAX_LOOKUPS, "last_lookup": time.time()})
                continue
            store.update_closure(
                scid, {"lookups": row["lookups"] + 1, "last_lookup": time.time()}
            )
            continue
        fields = _closure_fields(payload)
        attempt = {"lookups": row["lookups"] + 1, "last_lookup": time.time(), **fields}
        store.update_closure(scid, attempt)
        if fields.get("closing_reason") is not None:
            resolved += 1
    return resolved


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
            store.remember_network_stats(_stats_from_mempool(mempool.statistics("latest")))
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
            refresh_history(store, mempool)
            refresh_prices(store, mempool)
        except Exception as exc:
            logger.warning("Mempool history and prices failed: %s", exc)

    if mempool.enabled:
        try:
            bulk_aliases(store, mempool)
        except SourceError as exc:
            logger.warning("Bulk alias fetch stopped: %s", exc)
        except Exception:
            logger.exception("Bulk alias fetch failed")
        try:
            resolved = resolve_closures(store, mempool, settings.close_lookups_per_refresh)
            if resolved:
                logger.info("Resolved %s channel closures from mempool", resolved)
        except Exception:
            logger.exception("Closure lookups failed")
        try:
            fill_capacities(store, mempool, settings.capacity_pages_per_refresh)
        except Exception:
            logger.exception("Capacity fill failed")
        if settings.enrich_per_refresh > 0:
            targets = store.nodes_to_enrich(settings.enrich_per_refresh)
            logger.info("Enriching %s node profiles from mempool", len(targets))
            enrich_profiles(store, mempool, targets)

    try:
        store.record_local_snapshot()
    except Exception:
        logger.exception("Recording the local snapshot failed")

    try:
        store.recompute_metrics(samples=settings.metrics_samples)
    except Exception:
        logger.exception("Metric computation failed")

    try:
        stored_ranks = store.record_rank_history(settings.rank_history_top)
        if stored_ranks:
            logger.info("Stored %s rank history rows for today", stored_ranks)
    except Exception:
        logger.exception("Rank history write failed")

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
