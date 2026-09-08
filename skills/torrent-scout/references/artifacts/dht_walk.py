#!/usr/bin/env python3
"""Bounded iterative DHT get_peers walk (BEP 5) — proves the DHT alone yields peers."""
import socket, os, sys, binascii, struct, time
sys.path.insert(0,'/tmp/nets')
from dht_probe import benc, bdec

def dist(a,b): return int.from_bytes(bytes(x^y for x,y in zip(a,b)),'big')

def walk(ih_hex, budget_s=25, max_q=60):
    ih = binascii.unhexlify(ih_hex); nid = os.urandom(20)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
    seen=set(); peers=set(); queried=0
    cand=[]
    for h,p in [("dht.transmissionbt.com",6881),("dht.libtorrent.org",25401),("router.bittorrent.com",6881)]:
        try: cand.append((0,(socket.gethostbyname(h),p)))
        except Exception: pass
    t0=time.time()
    while cand and queried<max_q and time.time()-t0<budget_s:
        cand.sort(key=lambda x:x[0]); _,addr = cand.pop(0)
        if addr in seen: continue
        seen.add(addr); queried+=1
        try:
            s.sendto(benc({b't':b'aa',b'y':b'q',b'q':b'get_peers',
                           b'a':{b'id':nid,b'info_hash':ih}}), addr)
            buf,_ = s.recvfrom(4096)
            r = bdec(buf)[0].get(b'r')
            if not r: continue
            for v in r.get(b'values',[]) or []:
                if len(v)==6:
                    peers.add((socket.inet_ntoa(v[:4]), struct.unpack(">H",v[4:6])[0]))
            nodes = r.get(b'nodes',b'')
            for i in range(0,len(nodes)-25,26):
                blob=nodes[i:i+26]
                cand.append((dist(blob[:20],ih),
                             (socket.inet_ntoa(blob[20:24]), struct.unpack(">H",blob[24:26])[0])))
        except Exception:
            continue
    s.close()
    return queried, peers

q,p = walk(sys.argv[1])
print(f"infohash {sys.argv[1]}")
print(f"  nodes queried: {q}")
print(f"  DISTINCT PEERS FOUND VIA DHT ALONE: {len(p)}")
for x in list(p)[:8]: print("   ", x[0]+":"+str(x[1]))
