#!/usr/bin/env python3
"""
tests/test_mining.py — Unit tests for P0.5.3 Historical Data Mining pipeline

Run with:
    python -m pytest training/amygdala/tests/test_mining.py -v
    # or from the amygdala/ directory:
    python -m pytest tests/test_mining.py -v
"""

from __future__ import annotations

import json
import sqlite3
import struct
import sys
import tempfile
import textwrap
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List
from unittest.mock import MagicMock, patch

import pytest

# Ensure amygdala package root is on the path
_HERE = Path(__file__).parent.parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from mine_history import (
    ACTION_TYPES,
    classify_action,
    determine_outcome,
    embed_situation,
    extract_tool_calls,
    init_db,
    insert_example,
    iter_session_events,
    mine_session,
    reconstruct_situation,
)
from reward_labeling import (
    LabelResult,
    RewardSignal,
    SIGNAL_VALUES,
    detect_programmatic,
    label_session,
)


# ─────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────

def make_ts(offset_hours: float = 0.0) -> str:
    """Return an ISO-8601 UTC timestamp offset from a fixed base."""
    base = datetime(2026, 1, 15, 12, 0, 0, tzinfo=timezone.utc)
    ts = base + timedelta(hours=offset_hours)
    return ts.isoformat().replace("+00:00", "Z")


def write_jsonl(path: Path, lines: List[Any]) -> None:
    with open(path, "w") as fh:
        for obj in lines:
            fh.write(json.dumps(obj) + "\n")


def make_session(session_id: str = "test-session") -> List[Dict[str, Any]]:
    """Build a minimal valid session JSONL."""
    return [
        {"type": "session", "id": session_id, "timestamp": make_ts(0), "version": 3},
        {
            "type": "message",
            "timestamp": make_ts(1),
            "message": {
                "role": "assistant",
                "content": [
                    {
                        "type": "toolCall",
                        "id": "tc001",
                        "name": "write",
                        "arguments": {
                            "file_path": "/tmp/test.py",
                            "content": "print('hello')",
                        },
                    }
                ],
            },
        },
        {
            "type": "message",
            "timestamp": make_ts(2),
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "Thanks, that looks great!"}],
            },
        },
    ]


# ─────────────────────────────────────────────────────────────
# 1. JSONL parsing handles malformed entries gracefully
# ─────────────────────────────────────────────────────────────

class TestJSONLParsing:
    def test_valid_jsonl(self, tmp_path):
        p = tmp_path / "ok.jsonl"
        write_jsonl(p, [{"type": "session", "id": "abc"}, {"type": "message"}])
        events = list(iter_session_events(p))
        assert len(events) == 2

    def test_malformed_line_skipped(self, tmp_path):
        p = tmp_path / "bad.jsonl"
        with open(p, "w") as f:
            f.write('{"type": "session"}\n')
            f.write("THIS IS NOT JSON !!!!\n")
            f.write('{"type": "message"}\n')
        events = list(iter_session_events(p))
        assert len(events) == 2
        assert all("type" in e for e in events)

    def test_empty_lines_skipped(self, tmp_path):
        p = tmp_path / "empty.jsonl"
        with open(p, "w") as f:
            f.write('{"type": "session"}\n\n\n{"type": "message"}\n')
        events = list(iter_session_events(p))
        assert len(events) == 2

    def test_partial_json_skipped(self, tmp_path):
        p = tmp_path / "partial.jsonl"
        with open(p, "w") as f:
            f.write('{"type": "session"}\n')
            f.write('{"type": "message"\n')  # missing closing brace
            f.write('{"type": "end"}\n')
        events = list(iter_session_events(p))
        assert len(events) == 2

    def test_all_malformed_returns_empty(self, tmp_path):
        p = tmp_path / "garbage.jsonl"
        with open(p, "w") as f:
            f.write("garbage\nmore garbage\n{broken\n")
        events = list(iter_session_events(p))
        assert events == []

    def test_unicode_replacement_on_bad_encoding(self, tmp_path):
        p = tmp_path / "encoding.jsonl"
        # Write valid JSON with invalid UTF-8 bytes injected
        with open(p, "wb") as f:
            f.write(b'{"type": "session"}\n')
            f.write(b'{"type": "bad_\xff\xfe_encoding"}\n')
            f.write(b'{"type": "message"}\n')
        events = list(iter_session_events(p))
        # Should get at least the valid lines
        assert len(events) >= 2


# ─────────────────────────────────────────────────────────────
# 2. Action event identification finds correct event types
# ─────────────────────────────────────────────────────────────

class TestActionEventIdentification:
    def test_write_tool_is_action(self):
        assert classify_action("write", {}) == "write"

    def test_edit_tool_is_write(self):
        assert classify_action("edit", {}) == "write"

    def test_message_tool_is_action(self):
        assert classify_action("message", {}) == "message"

    def test_exec_tool_is_action(self):
        assert classify_action("exec", {"command": "ls -la"}) == "exec"

    def test_git_commit_classified_as_git(self):
        assert classify_action("exec", {"command": "git commit -m 'fix'"}) == "git"

    def test_git_push_classified_as_git(self):
        assert classify_action("exec", {"command": "git push origin main"}) == "git"

    def test_read_tool_is_not_action(self):
        assert classify_action("Read", {}) not in ACTION_TYPES

    def test_web_search_is_not_action(self):
        assert classify_action("web_search", {}) not in ACTION_TYPES

    def test_unknown_tool_is_other(self):
        assert classify_action("some_unknown_tool", {}) == "other"

    def test_extract_tool_calls_from_event(self):
        event = {
            "type": "message",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "doing stuff"},
                    {"type": "toolCall", "id": "t1", "name": "write", "arguments": {}},
                    {"type": "toolCall", "id": "t2", "name": "exec", "arguments": {}},
                ],
            },
        }
        calls = extract_tool_calls(event)
        assert len(calls) == 2
        assert calls[0]["name"] == "write"
        assert calls[1]["name"] == "exec"

    def test_extract_tool_calls_no_content(self):
        event = {"type": "message", "message": {"role": "assistant", "content": []}}
        assert extract_tool_calls(event) == []

    def test_mine_session_identifies_write_event(self, tmp_path):
        """End-to-end: mine_session extracts write action events."""
        p = tmp_path / "session.jsonl"
        write_jsonl(p, make_session("sess-001"))
        db_path = tmp_path / "training.sqlite"
        conn = init_db(db_path)
        count = mine_session(p, conn, dry_run=False)
        conn.close()
        assert count >= 1

    def test_mine_session_only_counts_action_events(self, tmp_path):
        """Read/search events should not be counted."""
        p = tmp_path / "session.jsonl"
        events = [
            {"type": "session", "id": "s1", "timestamp": make_ts(0), "version": 3},
            {
                "type": "message",
                "timestamp": make_ts(1),
                "message": {
                    "role": "assistant",
                    "content": [
                        # Not an action
                        {"type": "toolCall", "id": "t1", "name": "web_search",
                         "arguments": {"query": "python"}},
                        # Is an action
                        {"type": "toolCall", "id": "t2", "name": "message",
                         "arguments": {"target": "oscar", "message": "hi"}},
                    ],
                },
            },
        ]
        write_jsonl(p, events)
        db_path = tmp_path / "training.sqlite"
        conn = init_db(db_path)
        count = mine_session(p, conn, dry_run=False)
        conn.close()
        assert count == 1  # only the message tool call


# ─────────────────────────────────────────────────────────────
# 3. Outcome: correction within 24h → negative label
# ─────────────────────────────────────────────────────────────

class TestOutcomeNegative:
    def _make_user_event(self, text: str, offset_hours: float):
        return {
            "type": "message",
            "timestamp": make_ts(offset_hours),
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": text}],
            },
        }

    def test_explicit_correction_within_24h(self):
        base_ts = make_ts(0)
        subsequent = [self._make_user_event("that was wrong, revert it", 2)]
        label, source = determine_outcome(base_ts, subsequent)
        assert label == -1.0
        assert source == "programmatic"

    def test_never_do_that_phrase_is_negative(self):
        base_ts = make_ts(0)
        subsequent = [self._make_user_event("never do that again!", 1)]
        label, source = determine_outcome(base_ts, subsequent)
        assert label <= -0.9

    def test_correction_after_24h_not_counted(self):
        """Correction outside 24h window should not trigger negative label."""
        base_ts = make_ts(0)
        # Only a positive event within 72h (no correction within 24h)
        subsequent = [
            self._make_user_event("well done overall", 30),
        ]
        label, source = determine_outcome(base_ts, subsequent)
        # Should get positive label (explicit approval)
        assert label > 0.0

    def test_negative_label_overrides_positive(self):
        """Correction within 24h takes priority even if positive comes later."""
        base_ts = make_ts(0)
        subsequent = [
            self._make_user_event("that was wrong", 2),
            self._make_user_event("well done on other thing", 50),
        ]
        label, source = determine_outcome(base_ts, subsequent)
        assert label == -1.0

    def test_file_restore_yields_negative(self, tmp_path):
        """Programmatic: re-writing the same file within 24h → FILE_RESTORATION."""
        base_ts = make_ts(0)
        sev_ts = datetime.fromisoformat(make_ts(1).replace("Z", "+00:00"))
        result = detect_programmatic(
            action_ts=base_ts,
            action_tool="write",
            action_args={"file_path": "/tmp/important.py"},
            subsequent_user_messages=[],
            subsequent_tool_calls=[("write", {"file_path": "/tmp/important.py"}, sev_ts)],
        )
        assert result is not None
        assert result.reward <= -1.0

    def test_mine_session_assigns_negative_for_correction(self, tmp_path):
        """End-to-end: mine session with correction → negative label in DB."""
        p = tmp_path / "session.jsonl"
        events = [
            {"type": "session", "id": "neg-test", "timestamp": make_ts(0), "version": 3},
            {
                "type": "message",
                "timestamp": make_ts(1),
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "toolCall", "id": "tc1", "name": "write",
                         "arguments": {"file_path": "/tmp/bad.py", "content": "oops"}},
                    ],
                },
            },
            {
                "type": "message",
                "timestamp": make_ts(2),  # within 24h
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "that was wrong, revert it"}],
                },
            },
        ]
        write_jsonl(p, events)
        db_path = tmp_path / "training.sqlite"
        conn = init_db(db_path)
        mine_session(p, conn, dry_run=False)
        row = conn.execute("SELECT outcome_label FROM mined_examples WHERE session_id='neg-test'").fetchone()
        conn.close()
        assert row is not None
        assert row[0] == -1.0


# ─────────────────────────────────────────────────────────────
# 4. Outcome: no complaint 72h → positive label
# ─────────────────────────────────────────────────────────────

class TestOutcomePositive:
    def _make_user_event(self, text: str, offset_hours: float):
        return {
            "type": "message",
            "timestamp": make_ts(offset_hours),
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": text}],
            },
        }

    def test_no_complaint_72h_yields_positive(self):
        base_ts = make_ts(0)
        # Neutral messages extending past 72h, no correction
        subsequent = [
            self._make_user_event("ok", 10),
            self._make_user_event("what else?", 75),  # past 72h window
        ]
        label, source = determine_outcome(base_ts, subsequent)
        assert label == 0.5
        assert source == "heuristic"

    def test_explicit_positive_yields_1_0(self):
        base_ts = make_ts(0)
        subsequent = [self._make_user_event("well done! perfect!", 1)]
        label, source = determine_outcome(base_ts, subsequent)
        assert label == 1.0
        assert source == "programmatic"

    def test_no_subsequent_events_yields_unknown(self):
        base_ts = make_ts(0)
        label, source = determine_outcome(base_ts, [])
        assert label == 0.0
        assert source == "unknown"

    def test_only_events_within_72h_no_correction_yields_unknown(self):
        """Events exist but don't extend past 72h and no correction → 0.0 unknown."""
        base_ts = make_ts(0)
        subsequent = [self._make_user_event("noted", 10)]
        label, source = determine_outcome(base_ts, subsequent)
        assert label == 0.0

    def test_mine_session_assigns_positive_for_silence(self, tmp_path):
        """End-to-end: mine session with no correction + 72h+ silence → 0.5."""
        p = tmp_path / "session.jsonl"
        events = [
            {"type": "session", "id": "pos-test", "timestamp": make_ts(0), "version": 3},
            {
                "type": "message",
                "timestamp": make_ts(0),
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "toolCall", "id": "tc1", "name": "write",
                         "arguments": {"file_path": "/tmp/good.py", "content": "ok"}},
                    ],
                },
            },
            # Neutral message well past 72h
            {
                "type": "message",
                "timestamp": make_ts(80),
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "can you do something else?"}],
                },
            },
        ]
        write_jsonl(p, events)
        db_path = tmp_path / "training.sqlite"
        conn = init_db(db_path)
        mine_session(p, conn, dry_run=False)
        row = conn.execute("SELECT outcome_label FROM mined_examples WHERE session_id='pos-test'").fetchone()
        conn.close()
        assert row is not None
        assert row[0] == 0.5


# ─────────────────────────────────────────────────────────────
# 5. Reward labeling produces valid signal taxonomy
# ─────────────────────────────────────────────────────────────

class TestRewardLabeling:
    def test_all_signals_have_valid_reward_values(self):
        for signal in RewardSignal:
            reward = SIGNAL_VALUES[signal]
            assert -1.0 <= reward <= 1.0, f"{signal.name} reward {reward} out of range"

    def test_signal_count_is_8(self):
        assert len(RewardSignal) == 8

    def test_explicit_correction_signal(self):
        ts = make_ts(0)
        ev_ts = datetime.fromisoformat(make_ts(2).replace("Z", "+00:00"))
        result = detect_programmatic(
            action_ts=ts,
            action_tool="exec",
            action_args={"command": "rm -rf /"},
            subsequent_user_messages=[("that was wrong, you broke it", ev_ts)],
            subsequent_tool_calls=[],
        )
        assert result is not None
        assert result.signal == RewardSignal.EXPLICIT_CORRECTION
        assert result.reward == -1.0

    def test_never_do_that_signal(self):
        ts = make_ts(0)
        ev_ts = datetime.fromisoformat(make_ts(1).replace("Z", "+00:00"))
        result = detect_programmatic(
            action_ts=ts,
            action_tool="message",
            action_args={},
            subsequent_user_messages=[("never do that again, ever!", ev_ts)],
            subsequent_tool_calls=[],
        )
        assert result is not None
        assert result.signal == RewardSignal.NEVER_DO_THAT_AGAIN
        assert result.reward == -0.9

    def test_explicit_approval_signal(self):
        ts = make_ts(0)
        ev_ts = datetime.fromisoformat(make_ts(5).replace("Z", "+00:00"))
        result = detect_programmatic(
            action_ts=ts,
            action_tool="write",
            action_args={},
            subsequent_user_messages=[("well done, exactly what I needed!", ev_ts)],
            subsequent_tool_calls=[],
        )
        assert result is not None
        assert result.signal == RewardSignal.EXPLICIT_APPROVAL
        assert result.reward == 1.0

    def test_no_complaint_signal(self):
        ts = make_ts(0)
        ev_ts = datetime.fromisoformat(make_ts(80).replace("Z", "+00:00"))
        result = detect_programmatic(
            action_ts=ts,
            action_tool="write",
            action_args={},
            subsequent_user_messages=[("can you do something else?", ev_ts)],
            subsequent_tool_calls=[],
        )
        assert result is not None
        assert result.signal == RewardSignal.NO_COMPLAINT
        assert result.reward == 0.5

    def test_user_overrides_block_signal(self):
        ts = make_ts(0)
        ev_ts = datetime.fromisoformat(make_ts(1).replace("Z", "+00:00"))
        result = detect_programmatic(
            action_ts=ts,
            action_tool="exec",
            action_args={},
            subsequent_user_messages=[("just do it anyway, I know the risk", ev_ts)],
            subsequent_tool_calls=[],
        )
        assert result is not None
        assert result.signal == RewardSignal.USER_OVERRIDES_BLOCK
        assert result.reward == 0.6

    def test_user_agrees_with_block_signal(self):
        ts = make_ts(0)
        ev_ts = datetime.fromisoformat(make_ts(2).replace("Z", "+00:00"))
        result = detect_programmatic(
            action_ts=ts,
            action_tool="exec",
            action_args={},
            subsequent_user_messages=[("you were right to stop, good call", ev_ts)],
            subsequent_tool_calls=[],
        )
        assert result is not None
        assert result.signal == RewardSignal.USER_AGREES_WITH_BLOCK
        assert result.reward == 0.9

    def test_mild_correction_signal(self):
        ts = make_ts(0)
        ev_ts = datetime.fromisoformat(make_ts(5).replace("Z", "+00:00"))
        result = detect_programmatic(
            action_ts=ts,
            action_tool="write",
            action_args={},
            subsequent_user_messages=[("next time, it would be better to ask first", ev_ts)],
            subsequent_tool_calls=[],
        )
        assert result is not None
        assert result.signal == RewardSignal.MILD_CORRECTION
        assert result.reward == -0.4

    def test_label_session_produces_valid_signal_ids(self, tmp_path):
        """End-to-end: label_session returns only valid signal IDs."""
        p = tmp_path / "session.jsonl"
        events = [
            {"type": "session", "id": "label-test", "timestamp": make_ts(0), "version": 3},
            {
                "type": "message",
                "timestamp": make_ts(1),
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "please fix the bug"}],
                },
            },
            {
                "type": "message",
                "timestamp": make_ts(2),
                "message": {
                    "role": "assistant",
                    "content": [
                        {"type": "toolCall", "id": "tc1", "name": "write",
                         "arguments": {"file_path": "/tmp/fix.py", "content": "fixed"}},
                    ],
                },
            },
            {
                "type": "message",
                "timestamp": make_ts(80),
                "message": {
                    "role": "user",
                    "content": [{"type": "text", "text": "ok looks good"}],
                },
            },
        ]
        write_jsonl(p, events)
        labels = label_session(p, use_llm=False)
        assert len(labels) >= 1
        valid_signals = set(range(8))
        for lbl in labels:
            assert lbl["signal"] in valid_signals, f"Invalid signal id: {lbl['signal']}"
            assert -1.0 <= lbl["reward"] <= 1.0
            assert lbl["source"] in ("programmatic", "heuristic", "llm", "unknown")

    def test_heuristic_fallback_produces_valid_label(self):
        from kd_pretrain import heuristic_teacher_label
        for action_type in ("write", "exec", "message", "git", "other"):
            for outcome in (-1.0, 0.0, 0.5, 1.0):
                label = heuristic_teacher_label(action_type, outcome)
                assert len(label) == 5
                assert all(-1.0 <= v <= 1.0 for v in label), f"Out-of-range in {label}"


# ─────────────────────────────────────────────────────────────
# 6. Database integration
# ─────────────────────────────────────────────────────────────

class TestDatabase:
    def test_init_db_creates_tables(self, tmp_path):
        db_path = tmp_path / "test.sqlite"
        conn = init_db(db_path)
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
        assert "mined_examples" in tables
        conn.close()

    def test_insert_example_persists(self, tmp_path):
        db_path = tmp_path / "test.sqlite"
        conn = init_db(db_path)
        situation = {
            "session_id": "s1", "action_id": "a1", "timestamp": make_ts(0),
            "action_type": "write", "tool_name": "write", "description": "test",
            "preceding_user_text": "do something", "tool_args_summary": "{}",
        }
        embedding = struct.pack("512f", *([0.1] * 512))
        insert_example(conn, situation, embedding, 0.5, "heuristic", "test")
        row = conn.execute("SELECT outcome_label, label_source FROM mined_examples").fetchone()
        assert row == (0.5, "heuristic")
        conn.close()

    def test_wal_mode_enabled(self, tmp_path):
        db_path = tmp_path / "test.sqlite"
        conn = init_db(db_path)
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode == "wal"
        conn.close()


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
