# Rebuilding the bundled fee history datasets

`explorer/datasets/fee_daily_*.csv` are imported into the `fee_daily` table at startup (re-imported when a file's sha256 changes). They are rebuilt offline from raw `channel_update` gossip with these scripts (needs `numpy`; not used by the running app).

Definitions (same as the live `fee_daily` rows, see `explorer/feehistory.py`):

- each day's network state at 00:00 UTC = the latest `channel_update` (by its own timestamp) per half-channel at or before that instant;
- a half-channel counts if it is not disabled and was updated within the previous 14 days (BOLT 7 prune window);
- `p10`..`p99`: fee-rate percentiles in ppm (linear interpolation); `mean_le50k`: mean of rates <= 50,000 ppm; `med_base_msat`, `zero_base_share`; `hist`: counts per ppm bin with upper edges 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000;
- days with fewer than 20,000 active half-channels are collection outages and are dropped (they show as gaps).

## lnresearch (2019-2023, MIT)

Christian Decker's [lnresearch/topology](https://github.com/lnresearch/topology) gossip dump (doi:10.5281/zenodo.4088530).

```bash
curl -O https://storage.googleapis.com/lnresearch/gossip-20230924.gsp.bz2   # 3.2 GB
python3 extract_gsp.py gossip-20230924.gsp.bz2 lnresearch.npz               # ~6 min
python3 daily_fees.py lnresearch.npz ../../explorer/datasets/fee_daily_lnresearch.csv lnresearch 1695600000
```

## Gossip archive (Oct 2024 - 2026)

`channel_updates.bin` from https://bitcoin.ninja/ln-replay-data/ (u64 LE receive time, u16 LE length, raw update without the type prefix; 25 GB, no HTTP range support):

```bash
curl -s https://bitcoin.ninja/ln-replay-data/channel_updates.bin | python3 extract_ninja.py archive.npz
python3 daily_fees_recv.py archive.npz ../../explorer/datasets/fee_daily_gossip_archive.csv gossip-archive
```

This archive is ordered by receive time, so `daily_fees_recv.py` (low memory, no global sort) builds each day's state from the updates *received* before 00:00 UTC; the other definitions are identical. Updates stamped more than a day after their receipt time are ignored. Current file: 31 Oct 2024 to 28 Jul 2026, 636 days, no gaps (built before that filter was added; future-stamped updates are a negligible share).
