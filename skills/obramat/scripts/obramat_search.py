#!/usr/bin/env python3
"""Obramat search via DataDome cookie replay (no browser needed).

Usage:
  python3 obramat_search.py "tablero OSB" [--page 2] [--limit 30] [--store "Obramat <Town>"]

Requires the cookie jar written by refresh_cookies.js (session cookies captured
from the user's real Chrome via CDP — see SKILL.md, Mode 2). If DataDome
rejects the replay (cookies expired/invalidated), exits with DATADOME_BLOCKED
so the caller knows to refresh cookies.

Stock is reported for the store selected in the captured session. --store (or
OBRAMAT_STORE) only asserts which store that must be; see obramat_common.py.
"""
import argparse
import json
import os
import re
import sys
from urllib.parse import quote_plus

sys.path.insert(0, os.path.dirname(__file__))
from obramat_common import BASE, fetch, load_jar, resolve_store, stock_regex  # noqa: E402

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")
SCRIPT_RE = re.compile(r"<script[^>]*>.*?</script>", re.S)
# Spanish price: optional thousands dots, decimal comma ("1.013,50"); SSR may pad
# separators with spaces ("13 ,85"). Never start mid-number.
NUM = r"(?<![\d.,])(\d{1,3}(?:\s*\.\s*\d{3})+(?:\s*,\s*\d+)?|\d+(?:\s*[.,]\s*\d+)?)"


def strip_tags(html):
    return WS_RE.sub(" ", TAG_RE.sub(" ", html)).strip()


def _price(text, unit):
    m = re.search(NUM + r"\s*€\s*IVA\s*/\s*" + re.escape(unit), text)
    if not m:
        return None
    s = re.sub(r"\s", "", m.group(1))
    if "," in s:
        s = s.replace(".", "").replace(",", ".")
    elif re.fullmatch(r"\d{1,3}(?:\.\d{3})+", s):
        s = s.replace(".", "")
    return float(s)


def parse_products(html, store_name):
    """Parse SSR product cards: designation link (name+url), stock labels, prices."""
    html = SCRIPT_RE.sub(" ", html)  # drop embedded JSON (dataTms etc.)
    stock_re = stock_regex(store_name)
    out = []
    chunks = re.split(r'class="product-thumbnail product-thumbnail-item', html)[1:]
    for ch in chunks:
        m = re.search(r'<a href="(/productos/[^"]+)" title="([^"]+)"', ch)
        if not m:
            continue
        url, name = m.group(1), m.group(2)
        text = strip_tags(ch)[:1200]
        stock = None
        sm = stock_re.search(text)
        if sm:
            stock = {"status": "in_stock", "qty": sm.group(1), "store": sm.group(2).strip()}
        elif "Disponible bajo pedido" in text:
            stock = {"status": "under_order", "store": store_name}
        elif "Disponible próximamente" in text:
            stock = {"status": "coming_soon", "store": store_name}
        prices = {}
        for key, unit in (("unit_eur_iva", "Unidad"), ("m2_eur_iva", "m²"), ("box_eur_iva", "cajas")):
            v = _price(text, unit)
            if v is not None:
                prices[key] = v
        out.append({
            "name": name,
            "url": BASE + url,
            "stock": stock,
            "prices": prices,
        })
    return out


def parse_total(html):
    m = re.search(r"(\d+)\s+resultados?", html)
    return int(m.group(1)) if m else None


def main():
    ap = argparse.ArgumentParser(description="Search the Obramat catalog (cookie replay).")
    ap.add_argument("query")
    ap.add_argument("--page", type=int, default=1)
    ap.add_argument("--limit", type=int, default=30)
    ap.add_argument("--store", default=None,
                    help='expected store, e.g. "Obramat Alcorcón" (default: $OBRAMAT_STORE, '
                         "else whatever store the cookies carry)")
    a = ap.parse_args()
    jar = load_jar()
    store = resolve_store(jar, a.store)
    url = f"{BASE}/search?q={quote_plus(a.query)}" + (f"&page={a.page}" if a.page > 1 else "")
    html = fetch(url, jar).text
    prods = parse_products(html, store["name"])[:a.limit]
    detected = next((p["stock"]["store"] for p in prods if p["stock"] and p["stock"].get("store")), None)
    print(json.dumps({
        "query": a.query,
        "page": a.page,
        "total_results": parse_total(html),
        "store": store["name"] or detected,
        "store_id": store["id"],
        "count": len(prods),
        "products": prods,
    }, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
