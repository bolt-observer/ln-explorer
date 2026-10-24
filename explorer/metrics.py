"""Graph metrics for the public Lightning topology.

Exact betweenness on the full graph is too expensive for a small VM, so
betweenness and closeness use a sampled Brandes / breadth-first pass. The
sample is seeded from the graph size, so the same snapshot yields the same
ranks. Eigenvector centrality is a short power iteration over the undirected
channel graph. Ranks are 1-based, with 1 meaning the highest score, matching
the original explorer's centrality columns.
"""

from __future__ import annotations

import heapq
import math
import random
from collections import deque


def _neighbors(adjacency: dict[str, list[str]]) -> dict[str, list[str]]:
    return {node: list(peers) for node, peers in adjacency.items() if peers}


def power_iteration(
    adjacency: dict[str, list[str]],
    iterations: int = 25,
    edge_weight=None,
) -> dict[str, float]:
    nodes = _neighbors(adjacency)
    score = {node: 1.0 for node in nodes}
    if not score:
        return {}
    for _ in range(iterations):
        nxt = {node: 0.0 for node in nodes}
        for node, peers in nodes.items():
            for peer in peers:
                weight = 1.0 if edge_weight is None else edge_weight(node, peer)
                nxt[node] += score.get(peer, 0.0) * weight
        norm = math.sqrt(sum(value * value for value in nxt.values())) or 1.0
        score = {node: value / norm for node, value in nxt.items()}
    return score


def _brandes_bfs(adjacency: dict[str, list[str]], sources: list[str]):
    nodes = _neighbors(adjacency)
    betweenness = {node: 0.0 for node in nodes}
    harmonic = {node: 0.0 for node in nodes}
    for source in sources:
        if source not in nodes:
            continue
        stack: list[str] = []
        predecessors = {node: [] for node in nodes}
        sigma = {node: 0.0 for node in nodes}
        sigma[source] = 1.0
        distance = {node: -1 for node in nodes}
        distance[source] = 0
        queue: deque[str] = deque([source])
        while queue:
            current = queue.popleft()
            stack.append(current)
            for peer in nodes[current]:
                if peer not in distance:
                    continue
                if distance[peer] < 0:
                    distance[peer] = distance[current] + 1
                    queue.append(peer)
                if distance[peer] == distance[current] + 1:
                    sigma[peer] += sigma[current]
                    predecessors[peer].append(current)
        delta = {node: 0.0 for node in nodes}
        while stack:
            node = stack.pop()
            for pred in predecessors[node]:
                if sigma[node]:
                    delta[pred] += (sigma[pred] / sigma[node]) * (1.0 + delta[node])
            if node != source:
                betweenness[node] += delta[node]
        for node, hops in distance.items():
            if hops > 0:
                harmonic[node] += 1.0 / hops
    # Undirected edges are counted once from each side.
    betweenness = {node: value / 2.0 for node, value in betweenness.items()}
    return betweenness, harmonic


def _sample_sources(adjacency: dict[str, list[str]], samples: int, seed: int) -> list[str]:
    ranked = sorted(adjacency, key=lambda node: len(adjacency[node]), reverse=True)
    ranked = [node for node in ranked if adjacency[node]]
    if not ranked:
        return []
    count = max(1, min(samples, len(ranked)))
    rng = random.Random(seed)
    head = ranked[: max(1, count // 5)]
    rest = [node for node in ranked if node not in head]
    rng.shuffle(rest)
    chosen = head + rest
    return chosen[:count]


def weighted_centrality(
    adjacency: dict[str, list[str]],
    weight,
    sources: list[str],
) -> tuple[dict[str, float], dict[str, float]]:
    """Dijkstra-Brandes. ``weight(u, v)`` is a positive distance.

    One pass per source yields both the betweenness contributions and the
    harmonic closeness sum ``1/dist`` over the weighted shortest paths.
    """
    nodes = _neighbors(adjacency)
    betweenness = {node: 0.0 for node in nodes}
    harmonic = {node: 0.0 for node in nodes}
    for source in sources:
        if source not in nodes:
            continue
        distance = {node: math.inf for node in nodes}
        sigma = {node: 0.0 for node in nodes}
        predecessors = {node: [] for node in nodes}
        distance[source] = 0.0
        sigma[source] = 1.0
        heap = [(0.0, source)]
        seen: set[str] = set()
        order: list[str] = []
        while heap:
            dist, current = heapq.heappop(heap)
            if current in seen:
                continue
            seen.add(current)
            order.append(current)
            for peer in nodes[current]:
                if peer not in distance:
                    continue
                step = weight(current, peer)
                alt = dist + step
                if alt < distance[peer] - 1e-15:
                    distance[peer] = alt
                    sigma[peer] = sigma[current]
                    predecessors[peer] = [current]
                    heapq.heappush(heap, (alt, peer))
                elif abs(alt - distance[peer]) <= 1e-15:
                    sigma[peer] += sigma[current]
                    predecessors[peer].append(current)
        delta = {node: 0.0 for node in nodes}
        for node in reversed(order):
            for pred in predecessors[node]:
                if sigma[node]:
                    delta[pred] += (sigma[pred] / sigma[node]) * (1.0 + delta[node])
            if node != source:
                betweenness[node] += delta[node]
        for node, dist in distance.items():
            if node != source and 0.0 < dist < math.inf:
                harmonic[node] += 1.0 / dist
    return {node: value / 2.0 for node, value in betweenness.items()}, harmonic


def ranks(scores: dict[str, float]) -> dict[str, int]:
    ordered = sorted(scores, key=lambda node: (scores[node], node), reverse=True)
    return {node: index + 1 for index, node in enumerate(ordered)}


def compute_metrics(
    adjacency: dict[str, list[str]],
    samples: int = 64,
    capacity_weight=None,
    seed: int = 1,
) -> dict[str, dict]:
    """Return per-node scores and ranks.

    ``capacity_weight(u, v)`` optional positive distance. When omitted, the
    weighted ranks copy the unweighted ones.
    """
    sources = _sample_sources(adjacency, samples, seed)
    betweenness, harmonic = _brandes_bfs(adjacency, sources)
    eigen = power_iteration(adjacency)
    if capacity_weight is None:
        between_w = betweenness
        closeness_w = harmonic
        eigen_w = eigen
        weighted = False
    else:
        weight_sources = sources[: max(8, min(24, len(sources)))]
        between_w, closeness_w = weighted_centrality(
            adjacency, capacity_weight, weight_sources
        )
        eigen_w = power_iteration(
            adjacency,
            edge_weight=lambda left, right: 1.0 / capacity_weight(left, right),
        )
        weighted = True

    rank_b = ranks(betweenness)
    rank_bw = ranks(between_w)
    rank_c = ranks(harmonic)
    rank_cw = ranks(closeness_w)
    rank_e = ranks(eigen)
    rank_ew = ranks(eigen_w)
    result = {}
    for node in betweenness:
        result[node] = {
            "betweenness": betweenness[node],
            "betweenness_weighted": between_w.get(node, 0.0),
            "closeness": harmonic[node],
            "closeness_weighted": closeness_w.get(node, 0.0),
            "eigenvector": eigen.get(node, 0.0),
            "eigenvector_weighted": eigen_w.get(node, 0.0),
            "betweenness_rank": rank_b.get(node),
            "betweenness_weighted_rank": rank_bw.get(node),
            "closeness_rank": rank_c.get(node),
            "closeness_weighted_rank": rank_cw.get(node),
            "eigenvector_rank": rank_e.get(node),
            "eigenvector_weighted_rank": rank_ew.get(node),
        }
    return {"nodes": result, "samples": len(sources), "capacity_weighted": weighted}
