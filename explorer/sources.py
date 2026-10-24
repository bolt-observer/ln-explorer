"""External graph sources: rapid gossip sync, mempool.space, and optional LND."""

from __future__ import annotations

import json
import logging
import ssl
import time
import urllib.error
import urllib.request
from dataclasses import dataclass

from explorer.rgs import ParsedChannel, ParsedGraph, ParsedNode, Policy, parse_snapshot

logger = logging.getLogger(__name__)

USER_AGENT = "bolt-observer-explorer/1.0"


class SourceError(RuntimeError):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class FetchResult:
    graph: ParsedGraph
    source: str
    detail: str


def _request(
    url: str, timeout: float, headers: dict | None = None, insecure: bool = False
) -> tuple[bytes, dict]:
    req_headers = {"User-Agent": USER_AGENT, "Accept": "*/*"}
    if headers:
        req_headers.update(headers)
    request = urllib.request.Request(url, headers=req_headers)
    context = ssl._create_unverified_context() if insecure else None
    try:
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            header_map = {key: value for key, value in response.headers.items()}
            return response.read(), header_map
    except urllib.error.HTTPError as exc:
        raise SourceError(f"HTTP {exc.code} from {url}", status=exc.code) from exc
    except urllib.error.URLError as exc:
        raise SourceError(f"request failed for {url}: {exc.reason}") from exc


def fetch_json(url: str, timeout: float = 20, headers: dict | None = None, insecure: bool = False):
    body, _headers = _request(url, timeout=timeout, headers=headers, insecure=insecure)
    try:
        return json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise SourceError(f"invalid JSON from {url}") from exc


def fetch_rgs(url: str, timeout: float = 60) -> FetchResult:
    logger.info("Downloading rapid gossip sync snapshot %s", url)
    started = time.time()
    payload, _headers = _request(url, timeout=timeout)
    graph = parse_snapshot(payload)
    elapsed = time.time() - started
    detail = (
        f"rgs v{graph.version} {graph.node_count} nodes, "
        f"{graph.channel_count} channels in {elapsed:.1f}s"
    )
    logger.info("Parsed %s", detail)
    return FetchResult(graph=graph, source="rgs", detail=detail)


def _as_int(value) -> int | None:
    if value is None or value == "":
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _policy_from_lnd(raw: dict | None) -> Policy | None:
    if not raw:
        return None
    base = _as_int(raw.get("fee_base_msat"))
    ppm = _as_int(raw.get("fee_rate_milli_msat"))
    if base is None and ppm is None:
        return None
    return Policy(
        base_msat=base or 0,
        ppm=ppm or 0,
        cltv=_as_int(raw.get("time_lock_delta")) or 0,
        min_htlc_msat=_as_int(raw.get("min_htlc")) or 0,
        max_htlc_msat=_as_int(raw.get("max_htlc_msat")) or 0,
        disabled=bool(raw.get("disabled")),
    )


def _addresses_from_lnd(node: dict) -> list[str]:
    addresses = []
    for item in node.get("addresses") or []:
        if isinstance(item, str):
            addresses.append(item)
        elif isinstance(item, dict) and item.get("addr"):
            addresses.append(str(item["addr"]))
    return addresses


def graph_from_describegraph(payload: dict) -> ParsedGraph:
    """Build a parsed graph from LND ``DescribeGraph`` / ``GET /v1/graph`` JSON."""
    nodes: dict[str, ParsedNode] = {}
    for node in payload.get("nodes") or []:
        pubkey = str(node.get("pub_key") or node.get("pubKey") or "").lower()
        if len(pubkey) != 66:
            continue
        nodes[pubkey] = ParsedNode(pubkey=pubkey, addresses=_addresses_from_lnd(node))
        # Alias and color travel alongside the node via a side channel the
        # store understands: stash them on the object dynamically.
        nodes[pubkey].alias = str(node.get("alias") or "")  # type: ignore[attr-defined]
        nodes[pubkey].color = str(node.get("color") or "")  # type: ignore[attr-defined]

    channels: dict[int, ParsedChannel] = {}
    for edge in payload.get("edges") or []:
        scid = _as_int(edge.get("channel_id") or edge.get("channelId"))
        left = str(edge.get("node1_pub") or edge.get("node1Pub") or "").lower()
        right = str(edge.get("node2_pub") or edge.get("node2Pub") or "").lower()
        if scid is None or len(left) != 66 or len(right) != 66:
            continue
        if left > right:
            left, right = right, left
            policy1 = _policy_from_lnd(edge.get("node2_policy") or edge.get("node2Policy"))
            policy2 = _policy_from_lnd(edge.get("node1_policy") or edge.get("node1Policy"))
        else:
            policy1 = _policy_from_lnd(edge.get("node1_policy") or edge.get("node1Policy"))
            policy2 = _policy_from_lnd(edge.get("node2_policy") or edge.get("node2Policy"))
        nodes.setdefault(left, ParsedNode(pubkey=left))
        nodes.setdefault(right, ParsedNode(pubkey=right))
        channels[scid] = ParsedChannel(
            scid=scid,
            node1=left,
            node2=right,
            capacity=_as_int(edge.get("capacity")),
            policy1=policy1,
            policy2=policy2,
        )
    return ParsedGraph(
        version=0,
        chain_hash=b"",
        timestamp=int(time.time()),
        nodes=nodes,
        channels=channels,
    )


def fetch_lnd(rest_url: str, macaroon_hex: str, insecure: bool = True, timeout: float = 180) -> FetchResult:
    base = rest_url.rstrip("/")
    url = f"{base}/v1/graph"
    logger.info("Downloading describegraph from %s", base)
    started = time.time()
    payload = fetch_json(
        url,
        timeout=timeout,
        headers={"Grpc-Metadata-macaroon": macaroon_hex},
        insecure=insecure,
    )
    graph = graph_from_describegraph(payload)
    detail = (
        f"lnd describegraph {graph.node_count} nodes, "
        f"{graph.channel_count} channels in {time.time() - started:.1f}s"
    )
    logger.info("Parsed %s", detail)
    return FetchResult(graph=graph, source="lnd", detail=detail)


def load_graph_file(path: str) -> FetchResult:
    with open(path, "rb") as handle:
        blob = handle.read()
    if path.endswith(".json") or blob[:1] in (b"{", b"["):
        graph = graph_from_describegraph(json.loads(blob.decode("utf-8")))
        return FetchResult(graph=graph, source="file", detail=f"describegraph file {path}")
    graph = parse_snapshot(blob)
    return FetchResult(graph=graph, source="file", detail=f"rgs file {path}")


class Mempool:
    """Read-only client for mempool.space's public Lightning API."""

    def __init__(self, base_url: str, min_interval: float = 0.3):
        self.base_url = base_url.rstrip("/")
        self.min_interval = min_interval
        self._last = 0.0

    @property
    def enabled(self) -> bool:
        return bool(self.base_url)

    def _get(self, path: str, timeout: float = 20):
        body, _headers = self._open(path, timeout)
        return body

    def _open(self, path: str, timeout: float) -> tuple[object, dict]:
        if not self.enabled:
            raise SourceError("mempool API is disabled")
        url = f"{self.base_url}{path}"
        delay = 2.0
        for attempt in range(4):
            wait = self.min_interval - (time.time() - self._last)
            if wait > 0:
                time.sleep(wait)
            self._last = time.time()
            try:
                payload, headers = _request(url, timeout=timeout)
            except SourceError as exc:
                if exc.status != 429 or attempt == 3:
                    raise
                logger.info("Mempool returned 429 for %s; sleeping %.0fs", path, delay)
                time.sleep(delay)
                delay = min(delay * 2, 20)
                continue
            try:
                return json.loads(payload.decode("utf-8")), headers
            except json.JSONDecodeError as exc:
                raise SourceError(f"invalid JSON from {url}") from exc
        raise SourceError(f"HTTP 429 from {url}", status=429)

    def statistics(self, interval: str = "latest"):
        return self._get(f"/v1/lightning/statistics/{interval}", timeout=30)

    def statistics_all(self):
        """Full network history back to March 2018, newest row first."""
        return self._get("/v1/lightning/statistics/all", timeout=60)

    def prices(self):
        """Current exchange rates: {"time", "USD", "EUR", "GBP", ...}."""
        return self._get("/v1/prices", timeout=20)

    def historical_prices(self):
        """~26k rows of {"time", "USD", "EUR", ...}; -1 marks unknown rates."""
        return self._get("/v1/historical-price", timeout=60)

    def rankings(self, kind: str = "liquidity"):
        path = "/v1/lightning/nodes/rankings"
        if kind:
            path += f"/{kind}"
        return self._get(path, timeout=30)

    def node(self, pubkey: str):
        return self._get(f"/v1/lightning/nodes/{pubkey}", timeout=20)

    def world_nodes(self) -> list:
        """Geolocated nodes. Each row is lat, lon, pubkey, alias, capacity, channels, country, iso."""
        payload = self._get("/v1/lightning/nodes/world", timeout=60)
        if isinstance(payload, dict):
            return payload.get("nodes") or []
        return []

    def countries(self) -> list:
        payload = self._get("/v1/lightning/nodes/countries", timeout=30)
        return payload if isinstance(payload, list) else []

    def country_nodes(self, iso: str) -> list:
        payload = self._get(f"/v1/lightning/nodes/country/{iso}", timeout=60)
        if isinstance(payload, dict):
            return payload.get("nodes") or []
        return []

    def node_channels(self, pubkey: str, index: int = 0, status: str = "active") -> tuple[list, int | None]:
        from urllib.parse import quote

        path = (
            f"/v1/lightning/channels?public_key={quote(pubkey)}"
            f"&status={quote(status)}&index={int(index)}"
        )
        payload, headers = self._open(path, timeout=30)
        rows = payload if isinstance(payload, list) else []
        total_raw = headers.get("X-Total-Count") or headers.get("x-total-count")
        total = int(total_raw) if total_raw and str(total_raw).isdigit() else None
        return rows, total

    def channel(self, scid: int):
        return self._get(f"/v1/lightning/channels/{scid}", timeout=20)

    def search(self, text: str):
        from urllib.parse import quote

        return self._get(f"/v1/lightning/search?searchText={quote(text)}", timeout=20)
