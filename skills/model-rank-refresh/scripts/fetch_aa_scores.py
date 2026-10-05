#!/usr/bin/env python3
"""Extract model Intelligence Index rows from Artificial Analysis' public page."""

from __future__ import annotations

import json
import re
import urllib.request
from datetime import datetime, timezone

URL = "https://artificialanalysis.ai/leaderboards/models"
MODEL_ROW = re.compile(
    r'\{"id":"[^"]+","name":"([^"]+)",'
    r'"shortName":"[^"]*","slug":"([^"]+)".{0,1800}?'
    r'"intelligenceIndex":(null|-?[0-9.]+)',
    re.DOTALL,
)


def main() -> None:
    request = urllib.request.Request(URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(request, timeout=60) as response:
        page = response.read().decode("utf-8", "replace").replace(r"\"", '"')

    rows = []
    seen: set[str] = set()
    for name, slug, raw_score in MODEL_ROW.findall(page):
        if slug in seen:
            continue
        seen.add(slug)
        rows.append(
            {
                "slug": slug,
                "name": name,
                "intelligenceIndex": None if raw_score == "null" else float(raw_score),
            }
        )

    scored = sum(row["intelligenceIndex"] is not None for row in rows)
    if len(rows) < 100 or scored < 50:
        raise RuntimeError(
            f"Artificial Analysis page shape check failed: rows={len(rows)} scored={scored}"
        )

    print(
        json.dumps(
            {
                "source": URL,
                "retrievedAt": datetime.now(timezone.utc).isoformat(),
                "rows": rows,
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
