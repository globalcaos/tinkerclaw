#!/usr/bin/env python3
"""Minimal, read-only IRC liveness probe: TCP/TLS connect, read the server's
unprompted banner, disconnect. No registration, no JOIN, no messages sent."""
import socket, ssl, sys
def probe(host, port, use_tls):
    try:
        s = socket.create_connection((host, port), timeout=8)
        if use_tls:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
            s = ctx.wrap_socket(s, server_hostname=host)
        s.settimeout(6)
        try:
            data = s.recv(400).decode('utf8','replace').strip().replace('\r\n',' | ')
        except socket.timeout:
            data = "(connected, no unprompted banner)"
        s.close()
        return "OPEN", data[:180]
    except Exception as e:
        return f"{type(e).__name__}", str(e)[:80]
for spec in sys.argv[1:]:
    host, port, tls = spec.split(":")
    st, d = probe(host, int(port), tls == "tls")
    print(f"{host+':'+port:36s} {st:20s} {d}")
