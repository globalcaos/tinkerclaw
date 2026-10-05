#!/usr/bin/env python3
"""BEP 15 UDP tracker scrape — multi-infohash popularity oracle.
Usage: udp_scrape.py host:port hex_infohash [hex_infohash ...]"""
import socket, struct, random, sys, binascii

PROTOCOL_ID = 0x41727101980
ACTION_CONNECT, ACTION_SCRAPE, ACTION_ERROR = 0, 2, 3

def scrape(host, port, hashes, timeout=6):
    addr = (host, port)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(timeout)
    try:
        # 1) connect handshake
        tid = random.randint(0, 0xFFFFFFFF)
        s.sendto(struct.pack(">QII", PROTOCOL_ID, ACTION_CONNECT, tid), addr)
        buf, _ = s.recvfrom(2048)
        if len(buf) < 16: return ("SHORT_CONNECT", None)
        act, rtid, cid = struct.unpack(">IIQ", buf[:16])
        if act == ACTION_ERROR: return ("ERROR:" + buf[8:].decode('utf8','replace'), None)
        if act != ACTION_CONNECT or rtid != tid: return ("BAD_CONNECT", None)
        # 2) scrape — up to 74 infohashes in one datagram (BEP 15)
        tid2 = random.randint(0, 0xFFFFFFFF)
        pkt = struct.pack(">QII", cid, ACTION_SCRAPE, tid2) + b"".join(binascii.unhexlify(h) for h in hashes)
        s.sendto(pkt, addr)
        buf, _ = s.recvfrom(2048)
        act, rtid = struct.unpack(">II", buf[:8])
        if act == ACTION_ERROR: return ("ERROR:" + buf[8:].decode('utf8','replace'), None)
        if act != ACTION_SCRAPE: return ("BAD_SCRAPE_ACTION:%d" % act, None)
        body = buf[8:]
        out = []
        for i, h in enumerate(hashes):
            chunk = body[i*12:(i+1)*12]
            if len(chunk) < 12: break
            seeders, completed, leechers = struct.unpack(">III", chunk)
            out.append((h, seeders, completed, leechers))
        return ("OK", out)
    except socket.timeout:
        return ("TIMEOUT", None)
    except Exception as e:
        return ("EXC:%s" % e, None)
    finally:
        s.close()

if __name__ == "__main__":
    hp = sys.argv[1]; host, port = hp.rsplit(":", 1)
    st, res = scrape(host, int(port), sys.argv[2:])
    print(f"{hp:42s} {st}")
    for h, s_, c, l in (res or []):
        print(f"    {h}  seeders={s_:<6} completed={c:<8} leechers={l}")
