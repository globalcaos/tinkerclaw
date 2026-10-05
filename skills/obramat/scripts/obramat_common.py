"""Shared helpers for the Obramat scripts: config, cookie jar, store context, fetch.

Configuration (all optional):
  OBRAMAT_COOKIE_FILE  cookie jar written by refresh_cookies.js
                       (default: <skill>/state/cookies.json)
  OBRAMAT_STORE        the store you expect answers for, as the site prints it,
                       e.g. "Obramat Alcorcón". Empty (default) = use whatever
                       store the captured session has selected. When set and the
                       session carries a different store, the scripts stop with
                       STORE_MISMATCH instead of quoting another store's stock.

The store itself is not a request parameter. Obramat keeps it in the
`customer_context` cookie, so the store is whatever was selected in the browser
when the cookies were captured. To change store: pick it in the site's store
chooser, then run refresh_cookies.js again.
"""
import json
import os
import pathlib
import re
import sys
import unicodedata
from urllib.parse import unquote

try:
    from curl_cffi import requests
except ImportError:
    sys.exit("MISSING_DEP: pip install --user curl_cffi")

SKILL_DIR = pathlib.Path(__file__).resolve().parent.parent
COOKIE_FILE = pathlib.Path(
    os.environ.get("OBRAMAT_COOKIE_FILE") or SKILL_DIR / "state" / "cookies.json"
).expanduser()
BASE = "https://www.obramat.es"
UA = ("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36")
HEADERS = {"Accept-Language": "es-ES,es;q=0.9", "Referer": BASE + "/", "User-Agent": UA}

# Fallback when the store name is unknown: "Obramat" + capitalised words and
# Spanish connectors ("Obramat Alcalá de Guadaíra").
_GENERIC_STORE = r"Obramat(?: (?:de|del|la|las|los|el|[A-ZÀ-Ý][\wÀ-ÿ'.-]*))+"


def load_jar():
    if not COOKIE_FILE.exists():
        sys.exit(f"NO_COOKIES: {COOKIE_FILE} missing — run cookie refresh (SKILL.md, Mode 2).")
    raw = json.loads(COOKIE_FILE.read_text())
    return {c["name"]: c["value"] for c in raw}


def session_store(jar):
    """Store selected in the captured session, read from `customer_context`.

    Returns {"id": "..", "name": "Obramat ..."} or None if the cookie is absent
    or its format changed.
    """
    raw = jar.get("customer_context")
    if not raw:
        return None
    try:
        ctx = json.loads(unquote(raw))
    except (ValueError, TypeError):
        return None
    sid = str(ctx.get("main_store") or "") or None
    name = None
    for s in ctx.get("stores_name") or []:
        if sid is None or str(s.get("id")) == sid:
            name = (s.get("name") or "").replace("+", " ").strip() or None
            sid = sid or (str(s.get("id")) if s.get("id") is not None else None)
            break
    if not sid and not name:
        return None
    return {"id": sid, "name": name}


def _fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    return "".join(ch for ch in s if not unicodedata.combining(ch)).casefold().strip()


def resolve_store(jar, expected=None):
    """Return the store the answers will be for; stop on a mismatch.

    `expected` comes from --store or OBRAMAT_STORE. Empty = accept the session's store.
    """
    expected = (expected if expected is not None else os.environ.get("OBRAMAT_STORE", "")).strip()
    got = session_store(jar)
    if expected and got and got.get("name") and _fold(got["name"]) != _fold(expected):
        sys.exit(f"STORE_MISMATCH: the cookies carry '{got['name']}' but '{expected}' was "
                 "requested — select that store on obramat.es and refresh cookies (SKILL.md, Mode 2).")
    if got and got.get("name"):
        return got
    if expected:
        return {"id": None, "name": expected}
    return {"id": got.get("id") if got else None, "name": None}


def stock_regex(store_name):
    """Regex for the stock badge "N en stock en <store>"; group 1 = qty, group 2 = store."""
    store = re.escape(store_name) if store_name else _GENERIC_STORE
    return re.compile(r"([\d.]+)\s+en stock en (" + store + r")")


def fetch(url, jar):
    r = requests.get(url, impersonate="chrome", cookies=jar, headers=HEADERS, timeout=40)
    head = r.text[:3000]
    if r.status_code in (401, 403) or "enable JS" in head or "captcha-delivery" in head:
        sys.exit("DATADOME_BLOCKED: cookies stale or invalidated — refresh cookies via the relay tab (SKILL.md, Mode 2).")
    return r
