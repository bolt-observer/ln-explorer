"""Pass 1: lnresearch .gsp.bz2 -> npz of channel_update fields (ts, scid, dir, disabled, base_msat, ppm)."""
import bz2, sys, numpy as np
from array import array
f = bz2.open(sys.argv[1], 'rb'); assert f.read(4) == b'GSP\x01'
TS, SC, FL, BA, PP = array('I'), array('Q'), array('B'), array('I'), array('I')
n = 0
rd = f.read
while True:
    b = rd(1)
    if not b: break
    x = b[0]
    if x < 0xfd: l = x
    else: l = int.from_bytes(rd({0xfd: 2, 0xfe: 4, 0xff: 8}[x]), 'big')
    m = rd(l); n += 1
    if m[0] == 1 and m[1] == 2 and len(m) >= 130:  # type 258
        TS.append(int.from_bytes(m[106:110], 'big')); SC.append(int.from_bytes(m[98:106], 'big'))
        FL.append(m[111]); BA.append(int.from_bytes(m[122:126], 'big')); PP.append(int.from_bytes(m[126:130], 'big'))
np.savez(sys.argv[2], ts=np.frombuffer(TS, np.uint32), scid=np.frombuffer(SC, np.uint64), flags=np.frombuffer(FL, np.uint8),
         base=np.frombuffer(BA, np.uint32), ppm=np.frombuffer(PP, np.uint32))
print('messages', n, 'updates', len(TS), file=sys.stderr)
