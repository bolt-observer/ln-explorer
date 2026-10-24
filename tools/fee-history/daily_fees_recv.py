"""Low-memory variant for receive-ordered archives (bitcoin.ninja): state at 00:00 UTC = latest
channel_update (by its own timestamp) per half-channel among those *received* before that instant;
counted if not disabled and its timestamp is within the previous 14 days. Same CSV as daily_fees.py."""
import sys, json, csv, gc, numpy as np, datetime as D
z = np.load(sys.argv[1]); out, source = sys.argv[2], sys.argv[3]
MIN_HALF = 20000
EDGES = np.array([1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000])
key = (z['scid'] << np.uint64(1)); fl = z['flags']; key |= (fl & 1).astype(np.uint64)
uk, kidx = np.unique(key, return_inverse=True); del key; gc.collect()
kidx = kidx.astype(np.int32); gc.collect()
recv = z['recv']; ts = z['ts']; ppm = z['ppm']; base = z['base']
print('half-channels', len(uk), 'recv monotonic share', float((np.diff(recv[:10_000_000].astype(np.int64)) >= 0).mean()), file=sys.stderr)
n = len(uk); S_ts = np.zeros(n, np.uint32); S_dis = np.zeros(n, bool); S_ppm = np.zeros(n, np.uint32); S_base = np.zeros(n, np.uint32)
rows = []; j = 0; N = len(recv)
day = int(recv[0]) // 86400 + 1
while j < N:
    t = day * 86400
    k = j
    # recv is (nearly) sorted: advance to first record received at/after t
    k = j + int(np.searchsorted(recv[j:], t, 'left'))
    if k > j:
        sl = slice(j, k); o = np.argsort(ts[sl], kind='stable')
        ki = kidx[sl][o]; tt = ts[sl][o]
        # Drop updates stamped more than a day after receipt (fast clocks): they would
        # otherwise block later valid updates for that half-channel.
        rr = recv[sl][o].astype(np.int64)
        m = (tt >= S_ts[ki]) & (tt.astype(np.int64) <= rr + 86400)
        ki = ki[m]; S_ts[ki] = tt[m]; S_dis[ki] = (fl[sl][o][m] & 2) > 0; S_ppm[ki] = ppm[sl][o][m]; S_base[ki] = base[sl][o][m]
        j = k
    act = (S_ts.astype(np.int64) >= t - 14 * 86400) & (S_ts > 0) & ~S_dis
    c = int(act.sum())
    if c >= MIN_HALF and k < N:
        p = S_ppm[act].astype(np.float64); b = S_base[act].astype(np.float64); pc = p[p <= 50000]
        q = np.percentile(p, [10, 25, 50, 75, 90, 99])
        hist = np.bincount(np.searchsorted(EDGES, p, 'right'), minlength=len(EDGES) + 1).tolist()
        r = lambda x: round(float(x), 2)
        rows.append([D.datetime.fromtimestamp(t, D.UTC).date().isoformat(), source, c, *map(r, q), r(pc.mean()), r(np.median(b)), round(float((b == 0).mean()), 4), json.dumps(hist, separators=(',', ':'))])
    day += 1
with open(out, 'w', newline='') as f:
    w = csv.writer(f, lineterminator='\n'); w.writerow(['date', 'source', 'half_channels', 'p10', 'p25', 'p50', 'p75', 'p90', 'p99', 'mean_le50k', 'med_base_msat', 'zero_base_share', 'hist']); w.writerows(rows)
print(source, 'days', len(rows), rows[0][0], rows[-1][0], file=sys.stderr)
