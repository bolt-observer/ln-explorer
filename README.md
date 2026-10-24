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
| [mempool.space Lightning API](https://mempool.space/docs/api/rest) | Aliases, capacity, sockets, search, multi-year totals | Default enrichment. Disable with `MEMPOOL_API=` |
| Your LND `GET /v1/graph` | Aliases, capacity, and policies from your own node | `GRAPH_SOURCE=lnd` |
| A describegraph JSON or `.bin` snapshot on disk | Same shapes as the two sources above | `GRAPH_SOURCE=file` |

Gossip does not include channel capacity or, on the version-1 snapshots the public LDK server publishes today, node aliases. Those come from mempool (or from LND, if you point the explorer at one). The graph itself does not wait on either.

The refresh job is a thread inside the web process. It re-downloads the snapshot every `REFRESH_SECONDS` (default 3 hours), then pulls mempool totals, the world map and per-country node lists, a paced run of channel lists (the first request for a node returns up to 1000 capacities; longer lists continue in pages of 10, saved in sqlite and continued next time), and individual profiles for nodes that are still unnamed. A failed profile is skipped. HTTP 429 backs off and stops that batch. Metrics run after those fills. `docker compose logs -f` shows each pass. Nothing else has to be cron'd.

Betweenness and closeness are sampled (seeded from the snapshot, so a given graph yields the same ranks). Eigenvector centrality is a power iteration. Exact betweenness on the full graph is the wrong trade for a small VM; the original platform precomputed it offline for the same reason.

## Pages

- `/` interactive WebGL graph (sigma.js). Click a node or an edge.
- `/nodes` filterable node table: capacity, fees, protocols, centrality ranks, optional reference node.
- `/node/<pubkey>` channels, policies, and a shortest-path lookup.
- `/channel/<scid>` both directions. `blockxindexxoutput` and the numeric id both work.
- `/stats` gossip totals, mempool history, top nodes.
- `/search?q=` alias, pubkey, or channel id.

API lives under `/api/` (`/api/health`, `/api/status`, `/api/stats`, `/api/history`, `/api/graph`, `/api/nodes`, `/api/channels/<id>`, `/api/search`, `/api/path`).

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
