"""Pass 1: stream bitcoin.ninja channel_updates.bin (stdin) -> npz.
Record: u64 LE receive-ts, u16 LE len, raw channel_update (no type prefix). Offsets walked in Python, fields gathered with numpy."""
import sys, numpy as np
from array import array
f = sys.stdin.buffer; out = {k: [] for k in ('recv', 'ts', 'scid', 'flags', 'base', 'ppm')}
buf = b''; total = 0
def gather(a, offs, start, n, dt):
    idx = offs[:, None] + start + np.arange(n)
    return a[idx].copy().view(dt).ravel()
while True:
    chunk = f.read(1 << 26)
    if not chunk: break
    buf += chunk; L = len(buf); i = 0; offs = array('Q'); ap = offs.append; fb = int.from_bytes
    while i + 10 <= L:
        l = buf[i + 8] | (buf[i + 9] << 8)
        if i + 10 + l > L: break
        if l >= 128: ap(i)
        i += 10 + l
    a = np.frombuffer(buf, np.uint8); o = np.frombuffer(offs, np.uint64).astype(np.int64)
    p = 10 + 96
    out['recv'].append(gather(a, o, 0, 8, '<u8').astype(np.uint32))
    out['scid'].append(gather(a, o, p, 8, '>u8')); out['ts'].append(gather(a, o, p + 8, 4, '>u4'))
    out['flags'].append(a[o + p + 13].copy()); out['base'].append(gather(a, o, p + 24, 4, '>u4')); out['ppm'].append(gather(a, o, p + 28, 4, '>u4'))
    total += len(o); buf = buf[i:]
np.savez(sys.argv[1], **{k: np.concatenate(v) for k, v in out.items()})
print('updates', total, file=sys.stderr)
