#!/usr/bin/env python3
"""WebTorrent WSS tracker probe: JSON announce + scrape over WebSocket (py3.10 safe)."""
import asyncio, json, sys, binascii, random, string
import websockets

async def _session(url, ih, peer_id):
    async with websockets.connect(url, additional_headers={
            "Origin": "https://instant.io",
            "User-Agent": "Mozilla/5.0"}) as ws:
        await ws.send(json.dumps({"action": "scrape", "info_hash": [ih]}))
        await ws.send(json.dumps({
            "action": "announce", "info_hash": ih, "peer_id": peer_id,
            "numwant": 0, "uploaded": 0, "downloaded": 0, "left": 1,
            "event": "started", "offers": []}))
        msgs = []
        async def collect():
            while len(msgs) < 3:
                msgs.append(json.loads(await ws.recv()))
        try:
            await asyncio.wait_for(collect(), 8)
        except (asyncio.TimeoutError, TimeoutError):
            pass
        return msgs

async def probe(url, hexhash, timeout=14):
    ih = binascii.unhexlify(hexhash).decode('latin-1')
    peer_id = ''.join(random.choice(string.ascii_letters + string.digits) for _ in range(20))
    try:
        return ("OK", await asyncio.wait_for(_session(url, ih, peer_id), timeout))
    except Exception as e:
        return (f"{type(e).__name__}: {str(e)[:90]}", None)

async def main():
    hexhash, urls = sys.argv[1], sys.argv[2:]
    for u in urls:
        st, msgs = await probe(u, hexhash)
        print(f"{u:44s} {st}")
        for m in (msgs or []):
            m.pop('offer', None)
            s = json.dumps(m)
            print("    " + (s[:230] + ("..." if len(s) > 230 else "")))
asyncio.run(main())
