"""npz of channel_updates -> daily fee distribution CSV in ln-explorer fee_daily format.
State at 00:00 UTC of each date = latest channel_update (by update timestamp) per half-channel at or
before that instant; counted if not disabled and updated within the previous 14 days.
Days with fewer than MIN_HALF active half-channels (collection outages) are dropped.
Usage: daily_fees.py updates.npz out.csv source max_ts"""
import sys, json, numpy as np, datetime as D
z = np.load(sys.argv[1]); out, source, maxts = sys.argv[2], sys.argv[3], int(sys.argv[4])
MIN_HALF = 20000
EDGES = np.array([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000])
ts = z['ts'].astype(np.int64)
ok = (ts > 1514764800) & (ts <= maxts)
key = (z['scid'][ok].astype(np.uint64) << np.uint64(1)) | (z['flags'][ok] & 1).astype(np.uint64)
ts = ts[ok]; dis = (z['flags'][ok] & 2) > 0; ppm = z['ppm'][ok]; base = z['base'][ok]
o = np.argsort(ts, kind='stable'); ts, key, dis, ppm, base = ts[o], key[o], dis[o], ppm[o], base[o]
uk, kidx = np.unique(key, return_inverse=True)
S_ts = np.zeros(len(uk), np.int64); S_dis = np.zeros(len(uk), bool); S_ppm = np.zeros(len(uk), np.uint32); S_base = np.zeros(len(uk), np.uint32)
j = 0; rows = []
for day in range(int(ts[0] // 86400) + 1, int(ts[-1] // 86400) + 1):
    t = day * 86400; k = np.searchsorted(ts, t, 'right'); sl = slice(j, k); ki = kidx[sl]
    S_ts[ki] = ts[sl]; S_dis[ki] = dis[sl]; S_ppm[ki] = ppm[sl]; S_base[ki] = base[sl]; j = k
    m = (S_ts >= t - 14 * 86400) & (S_ts > 0) & ~S_dis
    n = int(m.sum())
    if n < MIN_HALF: continue
    p = S_ppm[m].astype(np.float64); b = S_base[m].astype(np.float64); pc = p[p <= 50000]
    q = np.percentile(p, [10, 25, 50, 75, 90, 99])
    hist = np.bincount(np.searchsorted(EDGES, p, 'right'), minlength=len(EDGES) + 1).tolist()
    r = lambda x: round(float(x), 2)
    rows.append([D.datetime.fromtimestamp(t, D.UTC).date().isoformat(), source, n, *map(r, q), r(pc.mean()), r(np.median(b)), round(float((b == 0).mean()), 4), json.dumps(hist, separators=(',', ':'))])
import csv
with open(out, 'w', newline='') as f:
    w = csv.writer(f, lineterminator='\n'); w.writerow(['date', 'source', 'half_channels', 'p10', 'p25', 'p50', 'p75', 'p90', 'p99', 'mean_le50k', 'med_base_msat', 'zero_base_share', 'hist']); w.writerows(rows)
print(source, 'days', len(rows), rows[0][0], rows[-1][0], file=sys.stderr)
