"""Channel capacity from the funding output a short channel id points at.

A SCID is block height (24 bits) · transaction index (24 bits) · output index
(16 bits). The capacity of a channel is the value of that output and never
changes, so every answer is cached permanently in SQLite (``funding_outputs``),
next to the block-height → hash map (``block_hashes``).

The gossip snapshot carries no capacity, and mempool.space's Lightning indexer
froze around 2026-08-30, so channels funded after that have no capacity from
its per-node channel pages. This module reads the outputs straight from
mempool.space's esplora API instead:

  /block-height/:h            one request per block
  /block/:hash/txs/:start     25 full transactions (with output values) per page

Channels funded in the same block and 25-transaction window share a page, so a
pass costs roughly one request per block plus one per page. Requests are rate
limited by the client and capped per pass; a pass stops at the first rate-limit
answer and the next one continues where it left off.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field

from explorer.sources import Mempool, SourceError

logger = logging.getLogger(__name__)

PAGE = 25  # esplora's /block/:hash/txs page size
# A failed request is retried after RETRY_ERROR_SECONDS. A missing output (bad
# index, or a height esplora does not know) is almost certainly permanent but is
# re-checked weekly in case one backend answered wrongly.
RETRY_ERROR_SECONDS = 6 * 3600
RETRY_INVALID_SECONDS = 7 * 86400


def split_scid(scid: int) -> tuple[int, int, int]:
    """(block height, transaction index, output index)."""
    return scid >> 40, (scid >> 16) & 0xFFFFFF, scid & 0xFFFF


@dataclass
class PassResult:
    requests: int = 0
    resolved: dict[int, int] = field(default_factory=dict)  # scid -> sats
    invalid: list[int] = field(default_factory=list)  # output does not exist
    errors: list[int] = field(default_factory=list)  # transient; retry later
    rate_limited: bool = False
    remaining: int = 0  # pending SCIDs this pass did not reach


def resolve_pass(
    client: Mempool,
    scids: list[int],
    budget: int,
    known_hashes: dict[int, str],
    on_hash=None,
) -> PassResult:
    """Look up funding outputs for `scids`, spending at most `budget` requests.

    `known_hashes` (height → hash) saves block-height requests; `on_hash` is
    called for every newly learned hash so the caller can cache it.
    """
    result = PassResult()
    # Pages in first-seen order: the caller's priority (live channels before
    # closed ones) decides what a limited budget reaches first.
    by_page: dict[tuple[int, int], list[int]] = defaultdict(list)
    for scid in dict.fromkeys(scids):
        height, tx_index, _out = split_scid(scid)
        by_page[(height, tx_index // PAGE * PAGE)].append(scid)
    pages = list(by_page)
    done = 0
    for height, start in pages:
        members = by_page[(height, start)]
        block_hash = known_hashes.get(height)
        cost = 1 if block_hash else 2
        if result.requests + cost > budget:
            break
        try:
            if not block_hash:
                result.requests += 1
                block_hash = client.block_hash(height)
                known_hashes[height] = block_hash
                if on_hash:
                    on_hash(height, block_hash)
            result.requests += 1
            txs = client.block_txs(block_hash, start)
        except Exception as exc:  # noqa: BLE001 - any failure of one page is local to it
            status = getattr(exc, "status", None) if isinstance(exc, SourceError) else None
            if status == 429:
                result.rate_limited = True
                break
            if status in (400, 404):
                # Height past the tip, or a page past the block's last transaction.
                result.invalid.extend(members)
            else:
                logger.info("Funding lookup for block %s failed: %s", height, exc)
                result.errors.extend(members)
            done += 1
            continue
        for scid in members:
            _height, tx_index, out_index = split_scid(scid)
            offset = tx_index - start
            tx = txs[offset] if 0 <= offset < len(txs) and isinstance(txs[offset], dict) else None
            vout = (tx or {}).get("vout") or []
            value = vout[out_index].get("value") if out_index < len(vout) and isinstance(vout[out_index], dict) else None
            if isinstance(value, int) and value > 0:
                result.resolved[scid] = value
            elif tx is None and len(txs) == PAGE:
                result.errors.append(scid)  # should not happen: full page, index inside it
            else:
                result.invalid.append(scid)
        done += 1
    result.remaining = sum(len(by_page[key]) for key in pages[done:])
    return result


def run_once(store, client: Mempool, budget: int) -> PassResult:
    """One budgeted pass over the store's unresolved channels; results are saved."""
    pending = store.funding_pending()
    if not pending:
        return PassResult()
    hashes = store.block_hashes()
    result = resolve_pass(client, pending, budget, hashes, on_hash=store.remember_block_hash)
    store.record_funding(result.resolved, result.invalid, result.errors)
    return result


def start_funding_resolver(store, settings) -> threading.Thread | None:
    """Background thread that fills channel capacities from funding outputs.

    It never blocks startup or the graph refresh: it waits for a graph, then
    works through the backlog in budgeted passes at `funding_rps`, and idles
    while nothing is pending.
    """
    if not settings.mempool_api or settings.funding_rps <= 0:
        return None
    client = Mempool(settings.mempool_api, min_interval=1.0 / settings.funding_rps)

    def loop() -> None:
        time.sleep(settings.funding_start_delay)
        # Backfill old snapshots once the backlog is drained, and again whenever
        # a later pass learned something new.
        need_backfill = True
        while True:
            pause = settings.funding_idle_seconds
            try:
                if store.channels:
                    result = run_once(store, client, settings.funding_requests_per_pass)
                    if result.requests:
                        logger.info(
                            "Funding outputs: %s resolved, %s invalid, %s errors in %s requests; "
                            "%s pending; capacity coverage %.2f%%",
                            len(result.resolved),
                            len(result.invalid),
                            len(result.errors),
                            result.requests,
                            result.remaining,
                            store.capacity_coverage() * 100,
                        )
                    need_backfill = need_backfill or bool(result.resolved)
                    if result.rate_limited:
                        pause = 300
                    elif result.remaining:
                        pause = 5
                    elif need_backfill:
                        changed = store.backfill_snapshot_capacity()
                        if changed:
                            logger.info("Backfilled capacity on %s local snapshots", changed)
                        need_backfill = False
                else:
                    pause = 30
            except Exception:
                logger.exception("Funding resolver pass failed")
                pause = 600
            time.sleep(pause)

    thread = threading.Thread(target=loop, name="funding-resolver", daemon=True)
    thread.start()
    return thread
