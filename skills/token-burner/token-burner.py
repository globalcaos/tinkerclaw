#!/usr/bin/env python3
"""token-burner: spend a Claude subscription's weekly quota on your own job queue before it resets.
Run with python3 -I (this script adds its own folder to the path).
  token-burner.py init --seat main=~/.claude [--seat work=~/.claude-work]
  token-burner.py simulate [--days 7]      a week on a fake clock; needs no account
  token-burner.py meter                    read each seat's usage meter once (read-only)
  token-burner.py plan                     what the next tick would do; starts nothing
  token-burner.py run --live [--once]      the live loop; also needs TOKEN_BURNER_ALLOW_LIVE=1
  token-burner.py status
Data: TOKEN_BURNER_HOME (default ~/.local/share/token-burner): config.json, queue.jsonl, state.db."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from token_burner.cli import main  # noqa: E402

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
