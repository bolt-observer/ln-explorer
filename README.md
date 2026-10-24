# ln-explorer

The standalone Bolt Observer Lightning Network explorer: a public explorer for the Lightning Network with an interactive graph of the network. It brings back the explorer part of the original bolt.observer platform without the rest of the platform. One container, no accounts, no billing, and no Bitcoin or Lightning node required for the default setup.

Live instance: https://bolt-explorer.exe.xyz

The site is a dark graph of the public network, plus node pages, channel pages, search, and network stats. Centrality ranks (betweenness, closeness, eigenvector, and weighted variants) follow the columns the original bolt.observer node explorer exposed.

## Quick start

```bash
git clone https://github.com/bolt-observer/ln-explorer.git
cd ln-explorer
docker compose up -d --build
```

Open http://localhost:8000. The first snapshot is a couple of megabytes and is usually parsed within a few seconds. Aliases for the big nodes follow from the public mempool API, and centrality ranks fill in shortly after that.

## How the data gets in

| Source | What it provides | When |
| --- | --- | --- |
| [Rapid gossip sync](https://github.com/lightningdevkit/rust-lightning/tree/main/lightning-rapid-gossip-sync) snapshot (`RGS_URL`) | Live public topology and fee policies | Default. Works immediately |
| [mempool.space Lightning API](https://mempool.space/docs/api/rest) | Aliases, capacity, sockets, search, multi-year totals, BTC prices | Default enrichment. Disable with `MEMPOOL_API=` |
| Your LND `GET /v1/graph` | Aliases, capacity, and policies from your own node | `GRAPH_SOURCE=lnd` |
| A describegraph JSON or `.bin` snapshot on disk | Same shapes as the two sources above | `GRAPH_SOURCE=file` |

Gossip does not include channel capacity or, on the version-1 snapshots the public LDK server publishes today, node aliases. Those come from mempool (or from LND, if you point the explorer at one). The graph itself does not wait on either.

Network history comes from mempool's `/v1/lightning/statistics/all` (daily rows back to March 2018; `node_count` is computed as tor + clearnet + clearnet_tor + unannounced nodes) plus `/v1/lightning/statistics/1y`, fetched at most once per 24h and cached in sqlite. mempool.space answers from several backends whose Lightning statistics have different gaps (some stopped updating on 2026-08-30, others are current), so each daily fetch samples `statistics/all` three times and merges the rows by timestamp; the chart breaks lines across gaps longer than 10 days. The explorer's own gossip snapshots are drawn as a separate dashed line because the two counts are not directly comparable. BTC prices (`/v1/prices` every refresh, `/v1/historical-price` downsampled to one row per UTC day, once per 24h) add a USD view of network capacity.

The refresh job is a thread inside the web process. It re-downloads the snapshot every `REFRESH_SECONDS` (default 3 hours), then pulls mempool totals, the world map and per-country node lists, a paced run of channel lists (the first request for a node returns up to 1000 capacities; longer lists continue in pages of 10, saved in sqlite and continued next time), and individual profiles for nodes that are still unnamed. A failed profile is skipped. HTTP 429 backs off and stops that batch. Metrics run after those fills. `docker compose logs -f` shows each pass. Nothing else has to be cron'd.

Betweenness and closeness are sampled (seeded from the snapshot, so a given graph yields the same ranks). The capacity-weighted variants share one Dijkstra pass per source node (larger channels are shorter edges); when channel capacities are mostly unknown the weighted ranks copy the unweighted ones. Eigenvector centrality is a power iteration. Exact betweenness on the full graph is the wrong trade for a small VM; the original platform precomputed it offline for the same reason.

Node features (BOLT 9 bits) come from RGS v2 snapshots or from the same mempool profile the enrichment already fetches, and turn into badges on the node page (wumbo highlighted) plus a Features filter on `/nodes` (`/api/nodes?feature=wumbo|anchors|dual_fund|onion_messages|route_blinding`); `/api/status` reports how many nodes have known features. Per-node fee averages drop far-out outliers (Tukey fences), so placeholder fees do not distort them; maxima stay raw. Reference-node inputs (the `/nodes` reference box, the node page path and peer-overlap boxes, and the header search) autocomplete aliases and pubkeys from a local `/api/autocomplete` endpoint.

`/api/route?from=<pk>&to=<pk>&amount_sat=<sat>&k=5` is a route explorer over the live channel graph: the `k` (at most 5) cheapest simple paths (Yen over Dijkstra, max 20 hops, 3 s time budget that returns what it found). Disabled directions are pruned, parallel channels collapse to the cheapest eligible one for the amount, and a hop is eligible only when its max HTLC (when announced) and known capacity cover the amount and its min HTLC does not exceed it. Each hop costs its fee plus a per-hop risk factor (1 ppm of the amount + 1000 msat) so the ranking does not return absurd fee-saving detours. Every returned path carries exact backward-computed fees per hop - walking from the receiver, each hop pays the fee of the hop after it; the sender's own first channel charges nothing - plus totals (fee in msat and ppm, CLTV), the bottleneck capacity (null if any hop's capacity is unknown), and the path's min/max HTLC. Bad input is a 400, an unknown node a 404, and a disconnected pair a 200 with `paths: []` and a reason. `/api/path` (hop count only) is unchanged.

Peer analysis sits next to the routing helpers. `/api/overlap?a=<pk>&b=<pk>` compares two nodes' peer sets over the same adjacency the router uses (channels disabled both ways do not make peers): shared-peer count, both sides' peer counts, Jaccard over the union, the share of `a`'s peers that `b` also shares (the original explorer's get_overlap number), and the top 50 shared peers with aliases. `/api/suggest?pubkey=<pk>&min_hops=2&sort=betweenness|capacity|eigenvector&limit=20` answers "who to open a channel to": nodes at `min_hops` or more BFS hops from the node, skipping nodes with fewer than 5 channels, ranked by the chosen centrality rank (best first; nodes whose ranks are not computed yet sort last) or by capacity. Each suggestion carries its hop distance, capacity, channel count, all six centrality ranks, and "new peers": how many of its peers are currently two or more hops away or not reachable at all, i.e. the reach a channel to it would add. Only the top 300 candidates by the chosen metric get their per-node attributes computed, so the call stays cheap on the full graph.

The `/nodes` page has a multi-condition filter builder: "+ Add condition" rows over every numeric column (channels, capacities, fee averages/medians/maxima, the six centrality ranks, hops to the reference node, first seen) plus the ipv4/ipv6/tor and feature booleans, combined with a match all/any/none quantifier, multiple protocols with an any/all toggle, removable summary chips, and shareable URLs. The state lives in the URL as `filter=`, a JSON tree of `{"op":"and"|"or"|"not","items":[{"field","rel","value"} | nested group]}` (relations gt/lt/eq/gte/lte/neq, max 3 levels, max 20 conditions; "not" negates the OR of its items). Bad input is a 400; the whitelist with UI labels is served by `/api/filter-fields`. The old `condition=field|rel|value&quantifier=all|any|none` links keep working. Table headers sort (ranks ascending first), rows-per-page is 10/30/50/100, and a "Column groups" toggle switches to the original nested headers (channel capacity, outgoing fees, incoming fees, centrality). On a node page, the channel table sorts by capacity, peer, fees, CLTV, age (approximate, from the funding block), or short id, filters by text (peer alias words AND, pubkey substring, short/numeric id) and state, and shows min/max HTLC plus a fiat capacity column (USD/EUR, from the current mempool price; hidden when no price is known); missing values sort last.

Change history comes from diffing consecutive snapshots: channel opens (a channel whose funding block is within 4032 blocks of the newest one in the snapshot) are separated from re-announced old channels, closes ("closed or pruned from gossip", keeping capacity and both nodes), per-policy fee changes, and alias/color/address changes from mempool enrichment. Events live in sqlite (fee changes 30 days, everything else a year, hard cap 400k rows) plus a daily aggregate kept for five years so the charts survive pruning. Closes are looked up at mempool.space (`CLOSE_LOOKUPS_PER_REFRESH` per refresh; a close retries at most 6 times, once per 12h; 429 stops the batch) for the closing reason, date, and transaction. mempool's Lightning indexer stopped around 2026-08-30, so closes after that usually show "unknown / not yet indexed". Every refresh also records one aggregate row of the live graph (channel counts, capacity, and the full fee distribution with Tukey far-out outlier filtering, because a few nodes still announce placeholder fees such as 2147483647 ppm) into sqlite; rows older than three years are pruned. Once per UTC day the top `RANK_HISTORY_TOP` (default 200) nodes per metric are snapshotted into a 365-day rank history, which feeds the /rankings page (rank changes over 1/7/30 days, movers, and sparklines).

## Pages

- `/` interactive WebGL graph (sigma.js). Click a node or an edge.
- `/nodes` filterable node table: capacity, fees, protocols, centrality ranks, optional reference node, multi-condition filter builder.
- `/route?from=&to=&amount=` cheapest routes for an amount (up to five cards with per-hop fees and a mini-graph of the paths).
- `/node/<pubkey>` channels (sortable, text/state filter, fiat column), policies, a shortest-path lookup, a peer-overlap comparison, and who-to-connect suggestions.
- `/channel/<scid>` both directions. `blockxindexxoutput` and the numeric id both work.
- `/stats` gossip totals, fee distribution, opens/closes from snapshot diffs, multi-year history chart (mempool.space plus own snapshots), top nodes.
- `/rankings` top nodes per metric with rank changes over 1/7/30 days and the biggest movers.
- `/search?q=` alias, pubkey, or channel id.

API lives under `/api/` (`/api/health`, `/api/status`, `/api/stats`, `/api/history?range=1y|3y|all`, `/api/snapshots`, `/api/prices`, `/api/flows?days=90`, `/api/events?kind=&pubkey=&scid=&limit=&before=`, `/api/rankings?metric=&limit=`, `/api/rankings/movers?metric=&days=`, `/api/nodes/<pubkey>/events`, `/api/nodes/<pubkey>/ranks`, `/api/graph`, `/api/nodes`, `/api/nodes/<pubkey>/channels?sort=&dir=&q=&state=`, `/api/filter-fields`, `/api/nodes/<pubkey>`, `/api/channels/<id>`, `/api/search`, `/api/path`, `/api/route?from=&to=&amount_sat=&k=`, `/api/overlap?a=&b=`, `/api/suggest?pubkey=&min_hops=&sort=&limit=`, `/api/autocomplete?q=&limit=`).

## Configuration

See `.env.example`. Interesting switches:

```bash
# Use your own LND once it has the graph. The public snapshot remains the fallback
# when GRAPH_SOURCE=rgs and the snapshot URL fails but LND is configured.
GRAPH_SOURCE=lnd
LND_REST_URL=https://127.0.0.1:8080
LND_MACAROON_PATH=/data/admin.macaroon
LND_INSECURE=1

# Cookieless analytics. Unset means no third-party script is loaded.
PLAUSIBLE_DOMAIN=explorer.example.com
```

There is no cookie banner and no Google Analytics.

## Development

```bash
pip install -r requirements.txt
python -m unittest discover -s explorer/tests -t .

# Frontend bundle (committed as web/static/app.js)
cd web && npm install && npm run build

DATA_DIR=./data python -m explorer
```

Deployment on a fresh Ubuntu VM is in [DEPLOYMENT.md](DEPLOYMENT.md).

## Background

This repo replaces the explorer part of the original bolt.observer platform (Nuxt frontend, GraphQL API, Postgres analytics and a bokeh graph service). The graph logic is a lighter rewrite of the platform's NetworkX code, and the data now comes from public gossip and the mempool.space API instead of the platform's own nodes and database.
