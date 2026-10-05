#!/usr/bin/env python3
"""Serve one design-review page and keep the reviewer's feedback on disk.

Copy this file next to a project's index.html and run it as a user service.
Stdlib only, loopback only. GET / -> index.html, GET /latest.json -> the last
save, POST /save -> feedback/feedback-<stamp>.json plus feedback/latest.json.

    python3 server.py --dir <folder with index.html> --port 18797
"""
import argparse, datetime, json, os, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MAX_BODY = 8 * 1024 * 1024
ap = argparse.ArgumentParser()
ap.add_argument("--dir", default=os.path.dirname(os.path.abspath(__file__)))
ap.add_argument("--port", type=int, default=18797)
ap.add_argument("--out", help="save folder (default <dir>/feedback); point a test run at a scratch folder")
args = ap.parse_args()
PAGE = os.path.join(args.dir, "index.html")
OUT = args.out or os.path.join(args.dir, "feedback")


class Handler(BaseHTTPRequestHandler):
    server_version = "DesignReview/1.0"

    def log_message(self, fmt, *a):
        sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % a))

    def _send(self, code, body, ctype="application/json; charset=utf-8"):
        body = body.encode("utf-8") if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            try:
                with open(PAGE, "rb") as fh:
                    self._send(200, fh.read(), "text/html; charset=utf-8")
            except OSError as err:
                print("[serve] cannot read index.html:", err, file=sys.stderr)
                self._send(500, "index.html missing", "text/plain; charset=utf-8")
            return
        if path == "/latest.json":
            p = os.path.join(OUT, "latest.json")
            if not os.path.exists(p):
                self._send(404, json.dumps({"error": "nothing saved yet"}))
                return
            with open(p, "rb") as fh:
                self._send(200, fh.read())
            return
        self._send(404, "not found", "text/plain; charset=utf-8")

    def do_POST(self):
        if self.path.split("?", 1)[0] != "/save":
            self._send(404, json.dumps({"error": "not found"}))
            return
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                raise ValueError("bad Content-Length %r" % n)
            data = json.loads(self.rfile.read(n).decode("utf-8"))
            if not isinstance(data, dict) or not isinstance(data.get("rows"), list):
                raise ValueError("payload needs a rows list")
            data.setdefault("saved_at", datetime.datetime.now().astimezone().isoformat())
            os.makedirs(OUT, exist_ok=True)
            stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
            path = os.path.join(OUT, "feedback-%s.json" % stamp)
            blob = json.dumps(data, ensure_ascii=False, indent=1)
            for p in (path, os.path.join(OUT, "latest.json")):
                with open(p, "w", encoding="utf-8") as fh:
                    fh.write(blob)
            print("[save] %d rows -> %s" % (len(data["rows"]), path), file=sys.stderr)
            self._send(200, json.dumps({"ok": True, "path": path, "rows": len(data["rows"])}))
        except Exception as err:
            print("[save] rejected:", err, file=sys.stderr)
            self._send(400, json.dumps({"ok": False, "error": str(err)}))


if __name__ == "__main__":
    print("[serve] %s on http://127.0.0.1:%d/ (saves -> %s)" % (args.dir, args.port, OUT), file=sys.stderr)
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
