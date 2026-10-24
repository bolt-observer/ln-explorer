"""HTTP API and the single-page explorer."""

from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_from_directory

from explorer.config import Settings
from explorer.features import FILTER_NAMES
from explorer.refresh import enrich_channel, enrich_node, start_refresh
from explorer.rgs import parse_scid
from explorer.routing import (
    DEFAULT_K,
    DEFAULT_TIME_BUDGET_SECONDS,
    HARD_AMOUNT_SAT,
    MAX_AMOUNT_SAT,
    MAX_K,
    find_routes,
)
from explorer.sources import Mempool
from explorer.store import (
    CHANNEL_SORT_FIELDS,
    CHANNEL_STATES,
    FILTER_FIELDS,
    FILTER_RELATIONS,
    SORT_FIELDS,
    FilterError,
    Store,
    filter_fields_payload,
    validate_filter_tree,
)

logger = logging.getLogger(__name__)

PUBKEY_RE = re.compile(r"^[0-9a-fA-F]{66}$")
DOMAIN_RE = re.compile(r"^[a-z0-9.-]+$")
PAGE_ROUTES = {"", "nodes", "stats", "search", "node", "channel", "rankings", "route"}
PROTOCOLS = frozenset({"ipv4", "ipv6", "tor"})


def _bounded_int(name: str, default: int, lowest: int, highest: int) -> int:
    try:
        value = int(request.args.get(name, str(default)))
    except ValueError:
        value = default
    return max(lowest, min(value, highest))


def _page_args() -> tuple[int, int]:
    try:
        page = max(1, int(request.args.get("page", "1")))
    except ValueError:
        page = 1
    try:
        page_size = int(request.args.get("page_size", "30"))
    except ValueError:
        page_size = 30
    return page, max(1, min(page_size, 100))


def _conditions() -> list[tuple[str, str, float]]:
    """Parse repeated condition=field|rel|value params, strictly."""
    parsed = []
    for raw in request.args.getlist("condition"):
        parts = raw.split("|")
        if len(parts) != 3:
            raise FilterError(f"condition must be field|relation|value (got {raw!r})")
        field_name, relation, value = parts
        if field_name not in FILTER_FIELDS:
            raise FilterError(f"unknown filter field: {field_name!r}")
        if relation not in FILTER_RELATIONS:
            raise FilterError(
                "unknown relation: "
                f"{relation!r} (use one of {', '.join(sorted(FILTER_RELATIONS))})"
            )
        try:
            number = float(value)
        except ValueError:
            raise FilterError(f"condition value must be a number (got {value!r})")
        parsed.append((field_name, relation, number))
    return parsed


def _filter_tree() -> dict | None:
    """Parse and validate the optional filter= JSON (nested and/or/not)."""
    raw = request.args.get("filter", "").strip()
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise FilterError(f"filter must be valid JSON ({exc.msg})")
    return validate_filter_tree(parsed)


def create_app(settings: Settings | None = None, store: Store | None = None, start_background: bool | None = None) -> Flask:
    settings = settings or Settings.from_env()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    if store is None:
        store = Store(settings.db_path)
        store.open()
    if start_background is None:
        start_background = not settings.disable_refresh
    if start_background:
        start_refresh(store, settings)

    web_dir = Path(settings.web_dir)
    app = Flask(__name__, static_folder=None)
    app.url_map.strict_slashes = False
    app.config["STORE"] = store
    app.config["SETTINGS"] = settings
    mempool = Mempool(settings.mempool_api, min_interval=0.25)
    lookups = threading.Lock()
    profiled: set[str] = set()

    def maybe_enrich_node(pubkey: str) -> None:
        """Rankings carry alias and capacity. A node page still wants sockets and color."""
        node = store.nodes.get(pubkey)
        if not mempool.enabled or node is None or pubkey in profiled:
            return
        if node.alias and node.addresses and node.color:
            return
        with lookups:
            if pubkey in profiled:
                return
            profiled.add(pubkey)
            try:
                enrich_node(store, mempool, pubkey)
            except Exception as exc:
                logger.info("On-demand node lookup failed: %s", exc)

    @app.after_request
    def cors(response):
        if request.path.startswith("/api/"):
            response.headers["Access-Control-Allow-Origin"] = "*"
            response.headers["Cache-Control"] = "no-cache"
        return response

    @app.errorhandler(404)
    def api_not_found(err):
        if request.path.startswith("/api/"):
            return jsonify({"error": "not found"}), 404
        return err

    @app.get("/api/health")
    def health():
        status = store.status()
        return jsonify({"status": "ok", "ready": status["ready"], "service": "explorer"})

    @app.get("/api/status")
    def status():
        body = store.status()
        body["refresh_seconds"] = settings.refresh_seconds
        body["graph_source"] = settings.graph_source
        body["mempool"] = bool(settings.mempool_api)
        body["named_fraction"] = store.enrich_fraction()
        return jsonify(body)

    @app.get("/api/stats")
    def stats():
        body = store.stats()
        body["top_capacity"] = store.top("total_capacity", 8)
        body["top_channels"] = store.top("num_channels", 8)
        if store.metrics_meta.get("ready"):
            # Rank 1 is the most central node.
            body["top_betweenness"] = store.query_nodes(
                sort="betweenness_rank", direction="asc", page=1, page_size=8
            )["objects"]
        else:
            body["top_betweenness"] = []
        return jsonify(body)

    @app.get("/api/history")
    def history():
        range_name = request.args.get("range", "all")
        if range_name not in {"1y", "3y", "all"}:
            range_name = "all"
        return jsonify(store.history_payload(range_name))

    @app.get("/api/snapshots")
    def snapshots():
        try:
            limit = int(request.args.get("limit", "200"))
        except ValueError:
            limit = 200
        limit = max(1, min(limit, 2000))
        return jsonify({"snapshots": store.raw_snapshots(limit)})

    @app.get("/api/prices")
    def prices():
        return jsonify(store.price_payload())

    @app.get("/api/events")
    def events():
        kind = (request.args.get("kind") or "").strip() or None
        pubkey = (request.args.get("pubkey") or "").strip().lower() or None
        if pubkey and not PUBKEY_RE.match(pubkey):
            return jsonify({"error": "pubkey must be a node pubkey"}), 400
        raw_scid = (request.args.get("scid") or "").strip()
        scid = parse_scid(raw_scid) if raw_scid else None
        if raw_scid and scid is None:
            return jsonify({"error": "invalid channel id"}), 400
        try:
            before = int(request.args.get("before", "0"))
        except ValueError:
            before = 0
        return jsonify(
            {
                "events": store.query_events(
                    kind=kind,
                    pubkey=pubkey,
                    scid=scid,
                    limit=_bounded_int("limit", 100, 1, 500),
                    before=before or None,
                )
            }
        )

    @app.get("/api/flows")
    def flows():
        return jsonify(store.flows_payload(days=_bounded_int("days", 90, 1, 365)))

    @app.get("/api/rankings")
    def rankings():
        metric = (request.args.get("metric") or "total_capacity").strip()
        return jsonify(store.rankings_payload(metric, _bounded_int("limit", 100, 1, 500)))

    @app.get("/api/rankings/movers")
    def ranking_movers():
        metric = (request.args.get("metric") or "total_capacity").strip()
        return jsonify(
            store.ranking_movers(
                metric,
                days=_bounded_int("days", 7, 1, 365),
                limit=_bounded_int("limit", 20, 1, 100),
            )
        )

    @app.get("/api/graph")
    def graph():
        try:
            limit = int(request.args.get("limit", "400"))
        except ValueError:
            limit = 400
        # The full slice is about 3 MB. Keep the default, and any request, on the hub core.
        limit = max(50, min(limit, 800))
        raw_min = request.args.get("min_channels")
        min_channels = None
        if raw_min not in (None, "", "auto"):
            try:
                min_channels = max(1, int(raw_min))
            except ValueError:
                min_channels = None
        return jsonify(store.graph_slice(limit=limit, min_channels=min_channels))

    @app.get("/api/nodes")
    def nodes():
        page, page_size = _page_args()
        sort = request.args.get("sort", "total_capacity")
        if sort not in SORT_FIELDS:
            sort = "total_capacity"
        direction = request.args.get("dir", "desc")
        if direction not in {"asc", "desc"}:
            direction = "desc"
        reference = (request.args.get("reference") or "").strip().lower()
        if reference and not PUBKEY_RE.match(reference):
            return jsonify({"error": "reference must be a node pubkey"}), 400
        protocols = []
        for item in request.args.get("protocol", "").split(","):
            token = item.strip()
            if not token:
                continue
            if token not in PROTOCOLS:
                return jsonify(
                    {"error": f"unknown protocol: {token!r} (use ipv4, ipv6 or tor)"}
                ), 400
            if token not in protocols:
                protocols.append(token)
        protocol_match = request.args.get("protocol_match", "any")
        if protocol_match not in {"any", "all"}:
            return jsonify({"error": "protocol_match must be any or all"}), 400
        quantifier = request.args.get("quantifier", "all")
        if quantifier not in {"all", "any", "none"}:
            quantifier = "all"
        feature = (request.args.get("feature") or "").strip()
        if feature and feature not in FILTER_NAMES:
            return jsonify({"error": "unknown feature filter"}), 400
        try:
            conditions = _conditions()
            condition_filter = _filter_tree()
        except FilterError as exc:
            return jsonify({"error": str(exc)}), 400
        result = store.query_nodes(
            text=request.args.get("q", "")[:200],
            protocols=protocols,
            quantifier=quantifier,
            conditions=conditions,
            sort=sort,
            direction=direction,
            page=page,
            page_size=page_size,
            reference=reference or None,
            reachable_only=request.args.get("reachable") == "1",
            feature=feature or None,
            condition_filter=condition_filter,
            protocol_match=protocol_match,
        )
        return jsonify(result)

    @app.get("/api/filter-fields")
    def filter_fields():
        """The condition whitelist (labels live here, not in the UI)."""
        return jsonify(filter_fields_payload())

    @app.get("/api/autocomplete")
    def autocomplete():
        """Local node suggestions for the reference and search inputs."""
        text = (request.args.get("q") or "").strip()[:200]
        return jsonify(store.autocomplete(text, _bounded_int("limit", 8, 1, 20)))

    @app.get("/api/nodes/<pubkey>")
    def one_node(pubkey: str):
        pubkey = pubkey.lower()
        if not PUBKEY_RE.match(pubkey):
            return jsonify({"error": "invalid pubkey"}), 400
        if pubkey not in store.nodes:
            return jsonify({"error": "node not found"}), 404
        maybe_enrich_node(pubkey)
        reference = (request.args.get("reference") or "").strip().lower()
        distance = None
        if reference and PUBKEY_RE.match(reference):
            distance = store.shortest_paths(reference).get(pubkey)
        view = store.node_view(pubkey, distance)
        if view is None:
            return jsonify({"error": "node not found"}), 404
        return jsonify(view)

    @app.get("/api/nodes/<pubkey>/channels")
    def node_channels(pubkey: str):
        pubkey = pubkey.lower()
        if not PUBKEY_RE.match(pubkey) or pubkey not in store.nodes:
            return jsonify({"error": "node not found"}), 404
        page, page_size = _page_args()
        sort = (request.args.get("sort") or "capacity").strip()
        if sort not in CHANNEL_SORT_FIELDS:
            return jsonify(
                {
                    "error": "unknown sort field: "
                    f"{sort!r} (use one of {', '.join(sorted(CHANNEL_SORT_FIELDS))})"
                }
            ), 400
        direction = request.args.get("dir", "desc")
        if direction not in {"asc", "desc"}:
            return jsonify({"error": "dir must be asc or desc"}), 400
        state = (request.args.get("state") or "all").strip()
        if state not in CHANNEL_STATES:
            return jsonify(
                {"error": "state must be one of all, active, disabled"}
            ), 400
        result = store.channels_for(
            pubkey,
            page,
            page_size,
            sort=sort,
            direction=direction,
            q=request.args.get("q", "")[:200],
            state=state,
        )
        # Current BTC prices for the fiat column; null when unknown.
        result["price"] = store.price_block()
        return jsonify(result)

    @app.get("/api/nodes/<pubkey>/events")
    def node_events(pubkey: str):
        pubkey = pubkey.lower()
        if not PUBKEY_RE.match(pubkey):
            return jsonify({"error": "invalid pubkey"}), 400
        # Events survive the node leaving the graph, so no 404 here.
        return jsonify(
            {
                "events": store.query_events(
                    pubkey=pubkey, limit=_bounded_int("limit", 100, 1, 500)
                )
            }
        )

    @app.get("/api/nodes/<pubkey>/ranks")
    def node_ranks(pubkey: str):
        pubkey = pubkey.lower()
        if not PUBKEY_RE.match(pubkey):
            return jsonify({"error": "invalid pubkey"}), 400
        return jsonify(store.node_rank_history(pubkey, days=_bounded_int("days", 180, 1, 730)))

    @app.get("/api/channels/<channel_id>")
    def one_channel(channel_id: str):
        scid = parse_scid(channel_id)
        if scid is None:
            return jsonify({"error": "invalid channel id"}), 400
        if scid not in store.channels:
            return jsonify({"error": "channel not found"}), 404
        channel = store.channels[scid]
        if mempool.enabled and not channel.capacity:
            with lookups:
                if not store.channels[scid].capacity:
                    try:
                        enrich_channel(store, mempool, scid)
                    except Exception as exc:
                        logger.info("On-demand channel lookup failed: %s", exc)
        view = store.channel_view(scid)
        return jsonify(view)

    @app.get("/api/search")
    def search():
        text = request.args.get("q", "").strip()[:200]
        local = store.search(text)
        if mempool.enabled and text and len(local["nodes"]) < 5:
            try:
                remote = mempool.search(text)
            except Exception as exc:
                logger.info("Mempool search failed: %s", exc)
                remote = None
            if isinstance(remote, dict):
                seen = {item["pubkey"] for item in local["nodes"]}
                for row in remote.get("nodes") or []:
                    pubkey = str(row.get("public_key") or "").lower()
                    if len(pubkey) != 66 or pubkey in seen:
                        continue
                    if pubkey in store.nodes:
                        store.apply_node_enrichment(
                            pubkey,
                            {
                                "alias": row.get("alias") or "",
                                "capacity": row.get("capacity") or 0,
                            },
                        )
                        view = store.node_view(pubkey)
                        if view:
                            local["nodes"].append(view)
                            seen.add(pubkey)
                for row in remote.get("channels") or []:
                    scid = parse_scid(str(row.get("id") or row.get("short_id") or ""))
                    if scid and scid in store.channels:
                        view = store.channel_view(scid)
                        if view and view not in local["channels"]:
                            local["channels"].append(view)
        return jsonify(local)

    @app.get("/api/path")
    def path():
        source = (request.args.get("source") or "").strip().lower()
        target = (request.args.get("target") or "").strip().lower()
        if not PUBKEY_RE.match(source) or not PUBKEY_RE.match(target):
            return jsonify({"error": "source and target must be node pubkeys"}), 400
        if source not in store.nodes or target not in store.nodes:
            return jsonify({"error": "node not found"}), 404
        # Reconstruct one shortest path with a parent pointer.
        adjacency = store.adjacency()
        parent = {source: None}
        queue = [source]
        index = 0
        while index < len(queue) and target not in parent:
            current = queue[index]
            index += 1
            for peer in adjacency.get(current, []):
                if peer not in parent:
                    parent[peer] = current
                    queue.append(peer)
        if target not in parent:
            return jsonify({"source": source, "target": target, "hops": None, "path": []})
        hops = []
        cursor = target
        while cursor is not None:
            hops.append(cursor)
            cursor = parent[cursor]
        hops.reverse()
        described = []
        for pubkey in hops:
            node = store.nodes.get(pubkey)
            described.append({"pubkey": pubkey, "alias": node.alias if node else ""})
        return jsonify(
            {
                "source": source,
                "target": target,
                "hops": len(hops) - 1,
                "path": described,
            }
        )

    @app.get("/api/route")
    def route():
        """Cheapest routes for an amount: k shortest simple paths with fees."""
        source = (request.args.get("from") or "").strip().lower()
        target = (request.args.get("to") or "").strip().lower()
        if not PUBKEY_RE.match(source) or not PUBKEY_RE.match(target):
            return jsonify({"error": "from and to must be node pubkeys"}), 400
        if source == target:
            return jsonify({"error": "from and to must differ"}), 400
        if source not in store.nodes or target not in store.nodes:
            return jsonify({"error": "node not found"}), 404
        raw_amount = (request.args.get("amount_sat") or "").strip()
        try:
            amount_sat = int(raw_amount)
        except ValueError:
            return jsonify(
                {"error": "amount_sat must be an integer number of satoshis"}
            ), 400
        if not 1 <= amount_sat <= HARD_AMOUNT_SAT:
            return jsonify(
                {"error": f"amount_sat must be between 1 and {HARD_AMOUNT_SAT}"}
            ), 400
        # Anything above 1 BTC cannot cross a non-wumbo channel anyway; cap
        # the search there instead of returning nothing for huge inputs.
        amount_sat = min(amount_sat, MAX_AMOUNT_SAT)
        try:
            k = int((request.args.get("k") or str(DEFAULT_K)).strip())
        except ValueError:
            return jsonify({"error": "k must be an integer"}), 400
        k = max(1, min(k, MAX_K))
        result = find_routes(
            store,
            source,
            target,
            amount_sat * 1000,
            k=k,
            time_budget=DEFAULT_TIME_BUDGET_SECONDS,
        )
        return jsonify(
            {
                "from": source,
                "to": target,
                "amount_sat": amount_sat,
                "amount_msat": amount_sat * 1000,
                "k": k,
                "paths": result["paths"],
                "reason": result["reason"],
                "timed_out": result["timed_out"],
                "elapsed_ms": result["elapsed_ms"],
            }
        )

    def index_html() -> str:
        html = (web_dir / "index.html").read_text(encoding="utf-8")
        domain = settings.plausible_domain
        snippet = ""
        src = settings.plausible_src
        if domain and DOMAIN_RE.match(domain) and src.startswith("https://") and '"' not in src:
            snippet = (
                f'<script defer data-domain="{domain}" src="{src}"></script>'
            )
        return html.replace("<!--PLAUSIBLE-->", snippet)

    @app.get("/")
    def home():
        return index_html()

    @app.get("/<path:subpath>")
    def spa(subpath: str):
        relative = (web_dir / subpath).resolve()
        if relative.is_file() and web_dir.resolve() in relative.parents:
            return send_from_directory(web_dir, subpath)
        head = subpath.split("/", 1)[0]
        if head in PAGE_ROUTES:
            return index_html()
        abort(404)

    return app
