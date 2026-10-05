"""One owner-only JSON writer, shared by every usage fetcher.

There used to be four write paths and they had drifted: claude- and manus-usage-fetch
opened with an explicit 0o600, while chatgpt- and gemini-usage-fetch used a plain
`open(path, 'w')` and inherited whatever umask the shell or systemd unit happened to
carry — so two of the four files that report your plan, spend and rate limits could be
born group- or world-readable. None of the four refused a symlink, so a link planted at
the output path was written straight through.

One writer means a fix cannot miss a caller.
"""

import json
import os
from pathlib import Path


def write_private_json(path, obj) -> Path:
    """Write `obj` as JSON to `path`, owner-only, never through a symlink.

    The parent directory is created if missing but its mode is left alone: these files
    live under ~/.openclaw/workspace/memory/ alongside unrelated content, and silently
    tightening a shared directory is a side effect the caller did not ask for. The FILE
    is what carries the secret-ish data, and the file is what we pin to 0600.
    """
    path = Path(path)
    parent = path.parent
    if parent.is_symlink():
        raise RuntimeError(
            f"refusing to write into {parent}: it is a symlink, so the real "
            f"destination is chosen by whoever created the link."
        )
    parent.mkdir(parents=True, exist_ok=True)

    if path.is_symlink():
        raise RuntimeError(
            f"refusing to write {path}: it is a symlink. Delete it and re-run — "
            f"writing through it would let anything that can create that link "
            f"choose which file this process overwrites."
        )

    # O_NOFOLLOW closes the gap between the is_symlink() check above and this open:
    # if a link is planted in between, the open fails instead of following it.
    fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as f:
        # An existing file keeps its old mode through O_CREAT, so pin it explicitly —
        # by descriptor, not by name, so it cannot be swapped underneath us.
        os.fchmod(f.fileno(), 0o600)
        json.dump(obj, f, indent=2)
        f.write("\n")
    return path
