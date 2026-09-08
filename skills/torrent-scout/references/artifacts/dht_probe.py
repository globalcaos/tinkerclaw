#!/usr/bin/env python3
"""Minimal BEP-5 DHT probe: ping bootstrap nodes, then get_peers for an infohash."""
import socket, os, sys, binascii

def benc(o):
    if isinstance(o, int): return b"i%de" % o
    if isinstance(o, bytes): return b"%d:%s" % (len(o), o)
    if isinstance(o, list): return b"l" + b"".join(map(benc, o)) + b"e"
    if isinstance(o, dict): return b"d" + b"".join(benc(k)+benc(v) for k, v in sorted(o.items())) + b"e"
    raise TypeError(o)

def bdec(b, i=0):
    c = b[i:i+1]
    if c == b'i':
        j = b.index(b'e', i); return int(b[i+1:j]), j+1
    if c == b'l':
        i += 1; out = []
        while b[i:i+1] != b'e':
            v, i = bdec(b, i); out.append(v)
        return out, i+1
    if c == b'd':
        i += 1; out = {}
        while b[i:i+1] != b'e':
            k, i = bdec(b, i); v, i = bdec(b, i); out[k] = v
        return out, i+1
    j = b.index(b':', i); n = int(b[i:j]); return b[j+1:j+1+n], j+1+n

def query(host, port, q, args, timeout=6):
    nid = os.urandom(20)
    args = dict(args); args[b'id'] = nid
    pkt = benc({b't': b'aa', b'y': b'q', b'q': q, b'a': args})
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(timeout)
    try:
        s.sendto(pkt, (host, port))
        buf, _ = s.recvfrom(4096)
        return bdec(buf)[0]
    except Exception as e:
        return {"ERR": f"{type(e).__name__}: {e}"}
    finally:
        s.close()

BOOT = [("router.bittorrent.com",6881),("dht.transmissionbt.com",6881),
        ("router.utorrent.com",6881),("dht.libtorrent.org",25401),
        ("dht.aelitis.com",6881),("router.bitcomet.com",6881)]
print("=== DHT ping (BEP 5) ===")
alive=[]
for h,p in BOOT:
    r = query(h,p,b'ping',{})
    if b'r' in r:
        print(f"  {h+':'+str(p):34s} PONG  node_id={binascii.hexlify(r[b'r'][b'id']).decode()[:16]}...")
        alive.append((h,p))
    else:
        print(f"  {h+':'+str(p):34s} {r.get('ERR', r)}")
if len(sys.argv)>1 and alive:
    ih = binascii.unhexlify(sys.argv[1])
    print(f"\n=== DHT get_peers for {sys.argv[1]} ===")
    for h,p in alive[:3]:
        r = query(h,p,b'get_peers',{b'info_hash': ih})
        if b'r' in r:
            rr=r[b'r']
            peers = rr.get(b'values')
            nodes = rr.get(b'nodes', b'')
            print(f"  {h:28s} token={'yes' if b'token' in rr else 'no'} "
                  f"values(peers)={len(peers) if peers else 0} closer_nodes={len(nodes)//26}")
        else:
            print(f"  {h:28s} {r.get('ERR', r)}")
