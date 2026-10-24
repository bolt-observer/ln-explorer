# Deploying the explorer

One container. HTTP on port **8000**. Put exe.dev's HTTPS proxy in front of it; the process does not terminate TLS.

## What you need

- Ubuntu with Docker Engine and the Docker Compose plugin
- About **1 GB of RAM** (2 GB is comfortable). The public graph is ~5k nodes and ~25k channels; the process sits well under 1 GB after startup
- Under **1 GB of disk** for the image plus the sqlite cache in the `explorer-data` volume. This does not download a Bitcoin block chain
- Outbound HTTPS to the rapid gossip sync host and, unless you disable it, to `mempool.space`

No paid API, no domain, and no Lightning node are required for the default boot.

## Fresh VM

```bash
sudo apt-get update
sudo apt-get install -y docker.io docker-compose-v2
sudo usermod -aG docker "$USER"
# log out and back in so the group applies, or run the compose commands with sudo

git clone https://github.com/bolt-observer/ln-explorer.git
cd ln-explorer

docker compose up -d --build
docker compose ps
docker compose logs -f explorer
```

`docker compose up` is enough. An `.env` file is optional; see `.env.example` when you want a different snapshot URL, your own LND, or Plausible.

The site is http://THE_VM:8000/. On an exe.dev VM, leave the process on port 8000 and point the exe.dev HTTPS proxy at that port. Do not put another reverse proxy in front unless you already have one.

Check that data arrived:

```bash
curl -sS http://127.0.0.1:8000/api/health
curl -sS http://127.0.0.1:8000/api/status
curl -sS http://127.0.0.1:8000/api/stats
```

`ready` flips to true after the snapshot parses. `metrics_ready` follows once centrality finishes. `named_fraction` should already be most nodes after the first refresh. `capacity_coverage` starts low and climbs as channel pages are cached.

## How the refresh job runs

It is not cron and not a second container. Gunicorn starts one worker (`explorer.wsgi:app`), and that process starts a daemon thread named `graph-refresh`:

1. Download `RGS_URL` (default `https://rapidsync.lightningdevkit.org/snapshot/0`) and replace the topology. Previously learned aliases, channel capacities, and capacity-scan progress are kept.
2. Pull mempool network totals, a year of history, and the liquidity / connectivity / age rankings.
3. Apply bulk aliases from `/v1/lightning/nodes/world` and each `/v1/lightning/nodes/country/:iso` list.
4. Read up to `CAPACITY_PAGES_PER_REFRESH` mempool channel-list requests (default 800) for the highest-degree nodes that are not finished yet. The first request uses `index=-1` and returns up to 1000 channels with capacity and the peer alias. A longer list continues at offset 1000 in pages of 10. The next offset is stored on the node. HTTP 429 stops the batch. Any other error skips that node for this pass and leaves it unfinished. A cursor saved by the older one-row-at-a-time scan is discarded once, and the channels already cached are kept.
5. Fetch up to `ENRICH_PER_REFRESH` individual profiles (default 6000) for nodes that still have no alias, at `ENRICH_RPS` requests per second. HTTP 500 and other errors skip that node. HTTP 429 sleeps and retries, then stops the batch so the rest of the refresh can save.
6. Recompute degree, fee summaries, eigenvector centrality, and sampled betweenness and closeness. Weighted ranks turn on once at least 30% of channels have a capacity.
7. Write `/data/explorer.sqlite`.
8. Sleep until `REFRESH_SECONDS` have passed since the pass started (default 10800, three hours), then repeat.

`REFRESH_SECONDS=0` runs a single pass at startup and then stops refreshing. A failed download keeps the previous snapshot in memory and logs the error on `/api/status`.

Watch it with:

```bash
docker compose logs -f explorer
```

The sqlite file lives in the `explorer-data` volume, so a container recreate does not re-download before it can serve.

## Switching the data source

Default (`GRAPH_SOURCE=rgs`) is the right one for a small VM. The public snapshot is the bootstrap: the UI works as soon as it lands, which is seconds, not a node sync.

**Your own LND** once `lncli getinfo` shows the graph is synced. Neutrino or a full Bitcoin backend is what takes the time; the explorer does not need to wait for that on first boot.

```bash
# /etc or the compose environment
GRAPH_SOURCE=lnd
LND_REST_URL=https://127.0.0.1:8080
LND_MACAROON_PATH=/data/admin.macaroon
LND_INSECURE=1
```

Mount the macaroon into the container, for example by adding this under `explorer.volumes` in `docker-compose.yml`:

```yaml
- /home/ubuntu/.lnd/data/chain/bitcoin/mainnet/admin.macaroon:/data/admin.macaroon:ro
```

If `GRAPH_SOURCE` stays `rgs` and `LND_REST_URL` plus a macaroon are set, LND is used only when the snapshot URL fails.

**A file**, for an air-gapped box or a `lncli describegraph` dump:

```bash
GRAPH_SOURCE=file
GRAPH_FILE=/data/describegraph.json
```

Mount the file the same way. A `.bin` file is read as a rapid gossip sync snapshot; JSON is read as LND describegraph.

**Mempool off** (topology and fees only, pubkeys instead of aliases until you provide another source):

```bash
MEMPOOL_API=
```

## Operations

```bash
docker compose logs -f explorer
docker compose restart explorer
docker compose up -d --build          # after a git pull
docker compose exec explorer python -c "import urllib.request; print(urllib.request.urlopen('http://127.0.0.1:8000/api/status').read().decode())"
```

Copy the database off the volume if you want a backup:

```bash
docker compose cp explorer:/data/explorer.sqlite ./explorer.sqlite
```

## What this VM should not run

A Bitcoin full node, LND, Postgres, Redis, and a separate gossip server are all optional. An earlier extraction of this explorer tried to build Lightning Dev Kit's rapid-gossip-sync-server, which wants peers and a Bitcoin REST backend and does not serve the explorer by itself. This explorer does not need it.
