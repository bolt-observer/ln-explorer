"""Route search over the live channel graph (k-cheapest simple paths).

The router builds a directed graph from the Store's channels: one edge per
channel direction whose announced policy exists and is not disabled. Fees,
CLTV deltas and HTLC limits are the forwarding policy of the node the edge
starts from. Parallel channels between the same pair of nodes are all kept
as candidates, but for a search they collapse to the cheapest eligible one
for the requested amount.

Search weight. Dijkstra and Yen rank paths by the sum, over hops, of

    weight(hop) = base_msat + amount_msat * ppm / 1_000_000 + hop_penalty

with integer (floor) division for the proportional fee, exactly like an
onion-routing node computes it. The amount used during the search is the
destination amount everywhere (an LND-style approximation); once a path is
found the exact fees are recomputed backwards from the receiver, where every
hop pays the fee of the hop after it. The first hop is the sender's own
channel: it charges no fee and its cltv delta is not counted, so it only
carries the hop penalty in the search weight.

Hop penalty. Pure fee optimisation happily returns absurd 20-hop detours to
save a single millisatosho, so every hop costs an extra risk factor of

    hop_penalty_msat = amount_msat * 1e-6 + 1000  (default)

i.e. 1 ppm of the amount plus a flat 1000 msat per hop. That is roughly one
extra routing fee per hop and keeps returned paths short while still
preferring genuinely cheaper routes.

Paths are simple (no node repeats) and found with Yen's k-shortest-paths
algorithm over Dijkstra, capped at 20 hops. The whole search runs under a
time budget (default 3 s); when the budget runs out the paths found so far
are returned with ``timed_out`` set.
"""

from __future__ import annotations

import heapq
import time

from explorer.rgs import format_scid

# Hard limits of the search.
MAX_K = 5
DEFAULT_K = 5
MAX_HOPS = 20
DEFAULT_TIME_BUDGET_SECONDS = 3.0
# /api/route accepts up to 10 BTC in satoshis but caps the search at 1 BTC.
MAX_AMOUNT_SAT = 100_000_000
HARD_AMOUNT_SAT = 10_000_000_000

# Edge layout inside the adjacency lists (plain tuples for speed):
# (to, scid, capacity_sat|None, base_msat, ppm, cltv, min_htlc_msat, max_htlc_msat)
_TO = 0
_SCID = 1
_CAPACITY = 2
_BASE = 3
_PPM = 4
_CLTV = 5
_MIN_HTLC = 6
_MAX_HTLC = 7


def fee_msat(base_msat: int, ppm: int, amount_msat: int) -> int:
    """The fee a forwarding node charges, in integer millisatoshi."""
    return base_msat + (amount_msat * ppm) // 1_000_000


def _eligible(edge: tuple, amount_msat: int) -> bool:
    """Can ``amount_msat`` be forwarded over this directed channel?

    A max_htlc_msat of 0 means "not announced" and imposes no limit; a
    positive one must cover the amount. The minimum must not exceed the
    amount, and the channel capacity (when known) must cover it in msat.
    """
    max_htlc = edge[_MAX_HTLC]
    if max_htlc > 0 and max_htlc < amount_msat:
        return False
    if edge[_MIN_HTLC] > amount_msat:
        return False
    capacity = edge[_CAPACITY]
    if capacity is not None and capacity * 1000 < amount_msat:
        return False
    return True


def default_hop_penalty(amount_msat: int) -> float:
    """1 ppm of the amount plus 1000 msat, charged per hop (see module doc)."""
    return amount_msat * 1e-6 + 1000.0


class _BudgetExceeded(Exception):
    """Raised inside Dijkstra when the time budget runs out."""


class RoutingGraph:
    """Directed eligible-channel graph built once per installed snapshot.

    The graph is cached on the Store (see :func:`routing_graph`) and rebuilt
    lazily when a refresh installs a new snapshot. Channel capacities filled
    in by enrichment between refreshes are only picked up on the next
    rebuild; that staleness is bounded by one refresh interval and keeps the
    hot path allocation-free.
    """

    def __init__(self, store):
        # Grab the dicts once: a concurrent refresh swaps them atomically.
        nodes = store.nodes
        channels = store.channels
        adjacency: dict[str, list[tuple]] = {}
        edges = 0
        for channel in channels.values():
            if channel.node1 == channel.node2:
                continue
            for source, target, policy in (
                (channel.node1, channel.node2, channel.policy1),
                (channel.node2, channel.node1, channel.policy2),
            ):
                if policy is None or policy.disabled:
                    continue
                adjacency.setdefault(source, []).append(
                    (
                        target,
                        channel.scid,
                        channel.capacity,
                        policy.base_msat,
                        policy.ppm,
                        policy.cltv,
                        policy.min_htlc_msat,
                        policy.max_htlc_msat,
                    )
                )
                edges += 1
        self.updated_at = store.updated_at
        self.adjacency = adjacency
        self.node_count = len(adjacency)
        self.edge_count = edges
        self._aliases = {
            pubkey: (record.alias if (record := nodes.get(pubkey)) else "")
            for pubkey in adjacency
        }

    def alias(self, pubkey: str) -> str:
        return self._aliases.get(pubkey, "")

    def collapse(self, amount_msat: int, hop_penalty: float) -> tuple[dict, dict]:
        """Per-request simple digraph: cheapest eligible parallel channel only.

        Returns ``(lists, pairs)`` where ``lists[u]`` is a list of
        ``(to, fee_msat, edge)`` for Dijkstra and ``pairs[u][to]`` is the
        same ``(fee_msat, edge)`` for direct lookup by path reconstruction.
        ``fee_msat`` is the fee for ``amount_msat``; the hop penalty is added
        by the caller so that the first hop's fee can be waived.
        """
        lists: dict[str, list[tuple]] = {}
        pairs: dict[str, dict[str, tuple]] = {}
        for source, edges in self.adjacency.items():
            best: dict[str, tuple] = {}
            for edge in edges:
                if not _eligible(edge, amount_msat):
                    continue
                target = edge[_TO]
                fee = fee_msat(edge[_BASE], edge[_PPM], amount_msat)
                current = best.get(target)
                # Tie-break by scid so the same snapshot always collapses
                # the same way.
                if (
                    current is None
                    or fee < current[0]
                    or (fee == current[0] and edge[_SCID] < current[1])
                ):
                    best[target] = (fee, edge[_SCID], edge)
            if best:
                lists[source] = [
                    (target, entry[0], entry[2]) for target, entry in best.items()
                ]
                pairs[source] = {
                    target: (entry[0], entry[2]) for target, entry in best.items()
                }
        return lists, pairs


def routing_graph(store) -> RoutingGraph:
    """The Store's cached RoutingGraph, rebuilt when the snapshot moves."""
    cached = getattr(store, "_routing_graph_cache", None)
    if (
        cached is not None
        and cached[0] == store.updated_at
        and cached[1] is store.channels
    ):
        return cached[2]
    graph = RoutingGraph(store)
    store._routing_graph_cache = (store.updated_at, store.channels, graph)
    return graph


def _dijkstra(
    lists: dict,
    source: str,
    target: str,
    hop_penalty: float,
    banned_nodes: frozenset = frozenset(),
    banned_pairs: frozenset = frozenset(),
    max_hops: int = MAX_HOPS,
    waive_source_fee: bool = False,
    deadline: float | None = None,
) -> tuple[float, tuple[str, ...]] | None:
    """Cheapest simple path from ``source`` to ``target`` under the weight.

    ``banned_nodes``/``banned_pairs`` implement the Yen spur restrictions,
    ``waive_source_fee`` skips the fee of the hops leaving the search source
    (the sender does not pay its own policy). The hop count is bounded by
    ``max_hops``: nodes settled through paths already that deep are not
    expanded further. The target needs no outgoing edge of its own. Raises
    _BudgetExceeded when the deadline passes.
    """
    # The source must have an edge to leave on; the target is found through
    # whatever edges point at it.
    if source not in lists:
        return None
    infinity = float("inf")
    distance = {source: 0.0}
    depth = {source: 0}
    previous: dict[str, str] = {}
    settled: set[str] = set()
    heap: list[tuple[float, str]] = [(0.0, source)]
    pops = 0
    while heap:
        cost_u, node = heapq.heappop(heap)
        if node in settled:
            continue
        settled.add(node)
        if node == target:
            break
        hops_u = depth[node]
        if hops_u >= max_hops:
            continue
        first_hop = waive_source_fee and node == source
        for peer, fee, _edge in lists.get(node, ()):
            if peer in settled or peer in banned_nodes:
                continue
            if (node, peer) in banned_pairs:
                continue
            candidate = cost_u + hop_penalty + (0 if first_hop else fee)
            if candidate < distance.get(peer, infinity):
                distance[peer] = candidate
                depth[peer] = hops_u + 1
                previous[peer] = node
                heapq.heappush(heap, (candidate, peer))
        pops += 1
        if deadline is not None and not pops % 256 and time.monotonic() >= deadline:
            raise _BudgetExceeded()
    if target not in settled:
        return None
    path = [target]
    while path[-1] != source:
        path.append(previous[path[-1]])
    path.reverse()
    return distance[target], tuple(path)


def _path_cost(pairs: dict, path: tuple[str, ...], hop_penalty: float) -> float:
    """Search weight of a node path: fees of hops after the first + penalties."""
    total = 0.0
    for index in range(len(path) - 1):
        if index:
            total += pairs[path[index]][path[index + 1]][0]
        total += hop_penalty
    return total


def _spur_iteration(
    accepted: list,
    candidates: list,
    seen: set,
    lists: dict,
    pairs: dict,
    source: str,
    target: str,
    max_hops: int,
    hop_penalty: float,
    deadline: float | None,
) -> None:
    """One Yen round: branch off every hop of the newest accepted path."""
    previous = accepted[-1][1]
    banned_pairs: set = set()
    for spur_index in range(len(previous) - 1):
        root = previous[: spur_index + 1]
        banned_pairs.clear()
        for _cost, path in accepted:
            if len(path) > spur_index + 1 and path[: spur_index + 1] == root:
                banned_pairs.add((path[spur_index], path[spur_index + 1]))
        for _cost, path in candidates:
            if len(path) > spur_index + 1 and path[: spur_index + 1] == root:
                banned_pairs.add((path[spur_index], path[spur_index + 1]))
        spur = _dijkstra(
            lists,
            root[-1],
            target,
            hop_penalty,
            banned_nodes=frozenset(root[:-1]),
            banned_pairs=frozenset(banned_pairs),
            max_hops=max_hops - spur_index,
            waive_source_fee=root[-1] == source,
            deadline=deadline,
        )
        if spur is None:
            continue
        total = tuple(root[:-1] + spur[1])
        if total in seen:
            continue
        candidates.append((_path_cost(pairs, total, hop_penalty), total))
        seen.add(total)


def _yen(
    lists: dict,
    pairs: dict,
    source: str,
    target: str,
    k: int,
    max_hops: int,
    hop_penalty: float,
    deadline: float | None,
) -> tuple[list, bool]:
    """Up to ``k`` cheapest simple paths, cheapest first. The first path is
    always computed in full; later rounds stop when the deadline passes."""
    best = _dijkstra(
        lists, source, target, hop_penalty, max_hops=max_hops, waive_source_fee=True
    )
    if best is None:
        return [], False
    accepted = [best]
    seen = {best[1]}
    candidates: list[tuple[float, tuple]] = []
    timed_out = False
    while len(accepted) < k:
        if deadline is not None and time.monotonic() >= deadline:
            timed_out = True
            break
        try:
            _spur_iteration(
                accepted, candidates, seen, lists, pairs, source, target,
                max_hops, hop_penalty, deadline,
            )
        except _BudgetExceeded:
            timed_out = True
            break
        if not candidates:
            break
        candidates.sort(key=lambda item: (item[0], item[1]))
        chosen = candidates.pop(0)
        accepted.append(chosen)
        seen.add(chosen[1])
    return accepted, timed_out


def _describe_path(
    graph: RoutingGraph,
    pairs: dict,
    path: tuple[str, ...],
    search_cost: float,
    amount_msat: int,
    hop_penalty: float,
) -> dict:
    """Turn a node path into the API shape, with exact backward-computed fees.

    Walking from the last hop back, every hop's fee is computed from the
    amount it forwards (the next hop's amount plus that hop's fee), like
    LND does; the sender's own first hop charges no fee.
    """
    hops: list[dict] = []
    edges = []
    for index in range(len(path) - 1):
        _fee, edge = pairs[path[index]][path[index + 1]]
        edges.append(edge)
    count = len(edges)
    amounts = [0] * count
    fees = [0] * count
    amounts[count - 1] = amount_msat
    for index in range(count - 1, 0, -1):
        edge = edges[index]
        fees[index] = fee_msat(edge[_BASE], edge[_PPM], amounts[index])
        amounts[index - 1] = amounts[index] + fees[index]
    total_fee = sum(fees)
    bottleneck: int | None = None
    unknown_capacity_hops = 0
    min_htlc = 0
    max_htlc = 0
    for index, edge in enumerate(edges):
        source = path[index]
        target = path[index + 1]
        capacity = edge[_CAPACITY]
        if capacity is None:
            unknown_capacity_hops += 1
        elif bottleneck is None or capacity < bottleneck:
            bottleneck = capacity
        min_htlc = max(min_htlc, edge[_MIN_HTLC])
        if edge[_MAX_HTLC] > 0 and (max_htlc == 0 or edge[_MAX_HTLC] < max_htlc):
            max_htlc = edge[_MAX_HTLC]
        hops.append(
            {
                "from": source,
                "to": target,
                "from_alias": graph.alias(source),
                "to_alias": graph.alias(target),
                "scid": str(edge[_SCID]),
                "short_id": format_scid(edge[_SCID]),
                "capacity": capacity,
                "base_fee_msat": edge[_BASE],
                "fee_rate_ppm": edge[_PPM],
                "fee_msat": fees[index],
                "amount_msat": amounts[index],
                "cltv_delta": edge[_CLTV],
                "min_htlc_msat": edge[_MIN_HTLC],
                "max_htlc_msat": edge[_MAX_HTLC],
            }
        )
    # A hop with an unknown capacity makes the exact bottleneck unknowable.
    if unknown_capacity_hops:
        bottleneck = None
    return {
        "hops": hops,
        "hop_count": count,
        "total_fee_msat": total_fee,
        "total_fee_ppm": total_fee * 1_000_000 / amount_msat if amount_msat else 0.0,
        # CLTV the forwarding hops add; the sender's own channel adds none.
        "total_cltv": sum(edge[_CLTV] for edge in edges[1:]),
        "bottleneck_capacity": bottleneck,
        "unknown_capacity_hops": unknown_capacity_hops,
        "path_min_htlc": min_htlc,
        "path_max_htlc": max_htlc,
        "hop_penalty_msat": hop_penalty,
        "search_cost_msat": search_cost,
    }


def find_routes(
    store,
    source: str,
    target: str,
    amount_msat: int,
    k: int = DEFAULT_K,
    max_hops: int = MAX_HOPS,
    time_budget: float = DEFAULT_TIME_BUDGET_SECONDS,
    hop_penalty: float | None = None,
) -> dict:
    """Search up to ``k`` cheapest routes for ``amount_msat`` (millisatoshi).

    Returns ``{"paths": [...], "reason": str | None, "timed_out": bool,
    "elapsed_ms": int}``. ``reason`` is set only when no path was found; a
    run that hits the time budget returns the paths found so far with
    ``timed_out`` set.
    """
    started = time.monotonic()
    deadline = None if time_budget is None else started + max(0.0, time_budget)
    if hop_penalty is None:
        hop_penalty = default_hop_penalty(amount_msat)
    k = max(1, min(int(k), MAX_K))
    if amount_msat <= 0:
        return _result([], "amount must be positive", started)
    if source == target:
        return _result([], "source and target are the same node", started)
    if source not in store.nodes or target not in store.nodes:
        return _result([], "unknown node", started)
    graph = routing_graph(store)
    lists, pairs = graph.collapse(amount_msat, hop_penalty)
    if source not in lists:
        return _result([], "no route", started)
    ranked, timed_out = _yen(
        lists, pairs, source, target, k, max_hops, hop_penalty, deadline
    )
    if not ranked:
        return _result([], "no route", started)
    paths = [
        _describe_path(graph, pairs, path, cost, amount_msat, hop_penalty)
        for cost, path in ranked
    ]
    return _result(paths, None, started, timed_out)


def _result(paths: list, reason: str | None, started: float, timed_out: bool = False) -> dict:
    return {
        "paths": paths,
        "reason": reason,
        "timed_out": timed_out,
        "elapsed_ms": int((time.monotonic() - started) * 1000),
    }
