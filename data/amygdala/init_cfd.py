#!/usr/bin/env python3
"""
AMYGDALA v2.1 — P0.4: Catastrophic Failure Database Initialization
Creates and seeds the CFD with:
  - Known deployment incidents (fully templated)
  - Synthetic positive counterparts for each negative
  - Target: 50+ seed entries with proper taxonomy

Usage:
    python init_cfd.py [--db cfd.sqlite] [--reset]
"""

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

# ── Schema ───────────────────────────────────────────────────────────────────

SCHEMA_PATH = Path(__file__).parent / "cfd_schema.sql"


def create_db(db_path: str, reset: bool = False) -> sqlite3.Connection:
    """Create or open the CFD database, applying schema."""
    if reset and os.path.exists(db_path):
        os.remove(db_path)
        print(f"Removed existing database: {db_path}")

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")

    schema_sql = SCHEMA_PATH.read_text()
    conn.executescript(schema_sql)
    conn.commit()
    print(f"Schema applied to {db_path}")
    return conn


# ── SituationTemplate v2.0 builder ───────────────────────────────────────────

def make_template(
    action_type: str,
    target_type: str,
    target_id: str,
    age_hours: float,
    size: int,
    recent_commits: int,
    recent_authors: int,
    effort_hours: float,
    last_human_ref: float,
    session_topic: str,
    recent_corrections: int,
    emotional_signals: str,
    automation_depth: int,
    topic_drift: float,
    reversible: str,
    blast_radius: str,
    human_in_loop: bool,
    confirmation: str,
) -> dict:
    """Build a SituationTemplate v2.0 dict."""
    return {
        "action_type": action_type,
        "target_type": target_type,
        "target_id": target_id,
        "target_metadata": {
            "age_hours": age_hours,
            "size": size,
            "recent_commits": recent_commits,
            "recent_authors": recent_authors,
            "effort_hours": effort_hours,
            "last_human_ref": last_human_ref,
        },
        "context": {
            "session_topic": session_topic,
            "recent_corrections": recent_corrections,
            "emotional_signals": emotional_signals,
            "automation_depth": automation_depth,
            "topic_drift": topic_drift,
        },
        "scope": {
            "reversible": reversible,
            "blast_radius": blast_radius,
            "human_in_loop": human_in_loop,
            "confirmation": confirmation,
        },
    }


def insert_entry(conn: sqlite3.Connection, entry: dict) -> int:
    cursor = conn.execute(
        """
        INSERT INTO cfd_entries (
            source, source_id, title, description, date_occurred,
            failure_mechanism, reversibility, blast_radius, detection_difficulty,
            situation_template, confidence_target, weight,
            positive_counterpart_id, verified, notes, outcome_category
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            entry["source"],
            entry.get("source_id"),
            entry["title"],
            entry["description"],
            entry.get("date_occurred"),
            entry["failure_mechanism"],
            entry["reversibility"],
            entry["blast_radius"],
            entry["detection_difficulty"],
            json.dumps(entry["situation_template"]),
            entry.get("confidence_target", 0.0),
            entry.get("weight", 1.0),
            entry.get("positive_counterpart_id"),
            entry.get("verified", False),
            entry.get("notes"),
            entry.get("outcome_category", "severe_negative"),
        ),
    )
    return cursor.lastrowid


def link_counterpart(conn: sqlite3.Connection, neg_id: int, pos_id: int):
    conn.execute(
        "UPDATE cfd_entries SET positive_counterpart_id = ? WHERE id = ?",
        (pos_id, neg_id),
    )


# ── Positive counterpart generator ───────────────────────────────────────────

def make_positive_counterpart(neg_entry: dict, neg_template: dict) -> dict:
    """
    Generate a positive counterpart: same action type/target type,
    but safe context (low commits, low effort, human in loop, low drift).
    """
    safe_template = {
        "action_type": neg_template["action_type"],
        "target_type": neg_template["target_type"],
        "target_id": neg_template["target_id"] + "_safe_context",
        "target_metadata": {
            "age_hours": neg_template["target_metadata"]["age_hours"],
            "size": neg_template["target_metadata"]["size"],
            "recent_commits": 0,
            "recent_authors": 1,
            "effort_hours": 0.2,
            "last_human_ref": 0.1,
        },
        "context": {
            "session_topic": neg_template["context"]["session_topic"],
            "recent_corrections": 0,
            "emotional_signals": "calm",
            "automation_depth": 0,
            "topic_drift": 0.05,
        },
        "scope": {
            "reversible": neg_template["scope"]["reversible"],
            "blast_radius": neg_template["scope"]["blast_radius"],
            "human_in_loop": True,
            "confirmation": "soft",
        },
    }
    return {
        "source": "synthetic",
        "title": f"[POSITIVE] {neg_entry['title']}",
        "description": (
            f"Positive counterpart of: {neg_entry['title']}. "
            "Same action type but safe context: recently mentioned by user, "
            "no recent commits by others, human in loop, low topic drift."
        ),
        "date_occurred": None,
        "failure_mechanism": neg_entry["failure_mechanism"],
        "reversibility": neg_entry["reversibility"],
        "blast_radius": neg_entry["blast_radius"],
        "detection_difficulty": neg_entry["detection_difficulty"],
        "situation_template": safe_template,
        "confidence_target": 1.0,
        "weight": 0.3,
        "verified": False,
        "notes": f"Synthetic positive counterpart for CFD entry.",
        "outcome_category": "positive",
    }


# ── Known incidents (fully templated per paper) ───────────────────────────────

KNOWN_INCIDENTS = [

    # ── 1. README debacle (paper §1, §6.4) ──────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-001",
        "title": "README debacle — merge script overwrites heavily-edited file",
        "description": (
            "Automated merge script with `git checkout --theirs` overwrote README.md "
            "that had 6 commits by 4 agents in 48h. Approximately 8.5 hours of "
            "collaborative effort was silently destroyed. The merge was triggered by "
            "an upstream sync task. No human was in the loop. The agent did not check "
            "recent activity before executing the overwrite."
        ),
        "date_occurred": "2026-03-01",
        "failure_mechanism": "F1",
        "reversibility": "R1",
        "blast_radius": "B3",
        "detection_difficulty": "D2",
        "situation_template": make_template(
            action_type="overwrite",
            target_type="file",
            target_id="README.md",
            age_hours=2160,
            size=14200,
            recent_commits=6,
            recent_authors=4,
            effort_hours=8.5,
            last_human_ref=3.0,
            session_topic="upstream merge automation",
            recent_corrections=2,
            emotional_signals="frustrated",
            automation_depth=2,
            topic_drift=0.72,
            reversible="true",
            blast_radius="persistent",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": "Paper §1 and §6.4 reference incident. Primary motivating case for AMYGDALA.",
        "outcome_category": "severe_negative",
    },

    # ── 2. WhatsApp reaction spam ────────────────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-002",
        "title": "WhatsApp reaction spam — agent reacted to every group message",
        "description": (
            "Agent auto-reacted (👍) to every incoming message in a WhatsApp group "
            "chat containing family members. The agent was monitoring the group for "
            "mentions but had a logic bug causing it to react unconditionally. "
            "Approximately 47 consecutive reactions were sent before the operator noticed "
            "and stopped it. Social dynamics in the group were affected."
        ),
        "date_occurred": "2025-12-15",
        "failure_mechanism": "F3",
        "reversibility": "R3",
        "blast_radius": "B4",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="send",
            target_type="message",
            target_id="whatsapp_family_group",
            age_hours=0,
            size=0,
            recent_commits=0,
            recent_authors=0,
            effort_hours=0.0,
            last_human_ref=0.0,
            session_topic="group chat monitoring for mentions",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=1,
            topic_drift=0.1,
            reversible="false",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": "Classic social boundary violation. WhatsApp reactions cannot be unsent en masse.",
        "outcome_category": "moderate_negative",
    },

    # ── 3. Unauthorized DM intrusion ─────────────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-003",
        "title": "DM intrusion — agent messaged contact outside allowlist",
        "description": (
            "Agent sent a direct message to a contact not in the approved allowlist. "
            "The contact was a work colleague of the operator's, referenced in a previous "
            "conversation. The agent interpreted a request to 'follow up' as permission "
            "to contact directly. The message contained internal project details."
        ),
        "date_occurred": "2025-11-20",
        "failure_mechanism": "F5",
        "reversibility": "R3",
        "blast_radius": "B4",
        "detection_difficulty": "D2",
        "situation_template": make_template(
            action_type="send",
            target_type="message",
            target_id="unauthorized_work_contact",
            age_hours=0,
            size=0,
            recent_commits=0,
            recent_authors=0,
            effort_hours=0.0,
            last_human_ref=24.0,
            session_topic="project follow-up and communication",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.6,
            reversible="false",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": "Authority confusion: agent assumed permission to contact from context reference.",
        "outcome_category": "severe_negative",
    },

    # ── 4. Email mass-deletion ────────────────────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-004",
        "title": "Email mass-deletion — agent deleted 3 months of emails matching broad filter",
        "description": (
            "Agent was asked to 'clean up old newsletters'. Applied a too-broad filter "
            "matching subject:unsubscribe OR from:noreply and deleted 847 emails spanning "
            "3 months, including important automated receipts, booking confirmations, and "
            "2FA backup codes. Gmail Trash retained them for 30 days but some had already "
            "expired by the time the deletion was noticed."
        ),
        "date_occurred": "2025-10-05",
        "failure_mechanism": "F2",
        "reversibility": "R2",
        "blast_radius": "B3",
        "detection_difficulty": "D3",
        "situation_template": make_template(
            action_type="delete",
            target_type="email",
            target_id="gmail_inbox_bulk",
            age_hours=2190,
            size=847,
            recent_commits=0,
            recent_authors=0,
            effort_hours=0.0,
            last_human_ref=48.0,
            session_topic="email cleanup and inbox organization",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.2,
            reversible="partial",
            blast_radius="persistent",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": (
            "Scope creep: 'clean up newsletters' became 'delete any email matching "
            "noreply OR unsubscribe'. Filter was never shown to user for approval."
        ),
        "outcome_category": "severe_negative",
    },

    # ── 5. Config file overwrite during deploy ────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-005",
        "title": "Production config overwrite — deploy script replaced live config with template",
        "description": (
            "Deploy automation script copied a template config.yaml over the production "
            "config during a routine deployment. The template had placeholder values for "
            "API keys and database URLs. Production service was down for 23 minutes "
            "before the error was detected via monitoring alerts."
        ),
        "date_occurred": "2025-09-12",
        "failure_mechanism": "F1",
        "reversibility": "R1",
        "blast_radius": "B4",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="overwrite",
            target_type="configuration",
            target_id="config/production.yaml",
            age_hours=720,
            size=3400,
            recent_commits=1,
            recent_authors=1,
            effort_hours=4.0,
            last_human_ref=6.0,
            session_topic="deployment automation and CI/CD",
            recent_corrections=0,
            emotional_signals="focused",
            automation_depth=3,
            topic_drift=0.15,
            reversible="true",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": "Stale context: template vs. production file not distinguished during automated copy.",
        "outcome_category": "severe_negative",
    },

    # ── 6. Git force-push to shared branch ───────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-006",
        "title": "Force-push to main — agent rewrote shared commit history",
        "description": (
            "Agent ran `git push --force origin main` to clean up messy commits during "
            "a rebase. Three team members had commits not yet merged. Their local branches "
            "diverged from remote. Two hours of collaboration required to reconcile."
        ),
        "date_occurred": "2025-08-30",
        "failure_mechanism": "F4",
        "reversibility": "R2",
        "blast_radius": "B4",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="deploy",
            target_type="git_operation",
            target_id="origin/main",
            age_hours=168,
            size=0,
            recent_commits=12,
            recent_authors=3,
            effort_hours=6.0,
            last_human_ref=2.0,
            session_topic="git history cleanup and rebase",
            recent_corrections=1,
            emotional_signals="focused",
            automation_depth=1,
            topic_drift=0.3,
            reversible="partial",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": "Irreversible cascade: force-push rewrites history affecting all collaborators.",
        "outcome_category": "severe_negative",
    },

    # ── 7. Database table truncation ──────────────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-007",
        "title": "Database truncation — agent truncated wrong table during data migration",
        "description": (
            "During a data migration task, agent ran TRUNCATE on 'sessions_old' "
            "but the table name mapping had changed — it truncated 'sessions' (active). "
            "All active user sessions were invalidated. 312 users were logged out. "
            "Data was recovered from replica with 15-minute lag."
        ),
        "date_occurred": "2025-07-18",
        "failure_mechanism": "F1",
        "reversibility": "R2",
        "blast_radius": "B4",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="delete",
            target_type="database",
            target_id="sessions",
            age_hours=8760,
            size=312,
            recent_commits=0,
            recent_authors=0,
            effort_hours=0.0,
            last_human_ref=24.0,
            session_topic="database migration and schema cleanup",
            recent_corrections=0,
            emotional_signals="focused",
            automation_depth=2,
            topic_drift=0.45,
            reversible="partial",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": "Stale context: table name mapping changed but agent used cached reference.",
        "outcome_category": "severe_negative",
    },

    # ── 8. Telegram group blast ───────────────────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-008",
        "title": "Telegram group blast — agent sent draft to wrong channel",
        "description": (
            "Agent was composing a draft announcement for a private channel but "
            "sent it to the public Telegram group (500+ members) before review. "
            "The draft contained internal pricing information and unreleased feature names. "
            "Message was deleted within 3 minutes but was screenshot by several members."
        ),
        "date_occurred": "2025-06-22",
        "failure_mechanism": "F5",
        "reversibility": "R3",
        "blast_radius": "B4",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="send",
            target_type="message",
            target_id="telegram_public_group",
            age_hours=0,
            size=450,
            recent_commits=0,
            recent_authors=0,
            effort_hours=0.5,
            last_human_ref=0.1,
            session_topic="draft announcement preparation",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.35,
            reversible="false",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": "Authority confusion: assumed send permission because draft was complete.",
        "outcome_category": "moderate_negative",
    },

    # ── 9. Cron job double-execution ──────────────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-009",
        "title": "Duplicate cron execution — agent registered same cron job twice",
        "description": (
            "Agent re-ran an initialization script without checking if the cron job "
            "was already registered. The daily backup script ran twice, generating "
            "duplicate backup files and consuming 2x storage. The duplicates were not "
            "detected for 6 days (next storage alert)."
        ),
        "date_occurred": "2025-05-14",
        "failure_mechanism": "F7",
        "reversibility": "R1",
        "blast_radius": "B3",
        "detection_difficulty": "D3",
        "situation_template": make_template(
            action_type="execute",
            target_type="system_command",
            target_id="crontab -e backup_script",
            age_hours=0,
            size=0,
            recent_commits=0,
            recent_authors=1,
            effort_hours=1.0,
            last_human_ref=48.0,
            session_topic="system initialization and setup",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=1,
            topic_drift=0.2,
            reversible="true",
            blast_radius="persistent",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": "Duplicate execution: idempotency not checked before registering cron job.",
        "outcome_category": "mild_negative",
    },

    # ── 10. SSH key overwrite ─────────────────────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-010",
        "title": "SSH authorized_keys overwrite — agent replaced key file during provisioning",
        "description": (
            "During server provisioning automation, agent wrote a new authorized_keys "
            "file, overwriting existing entries including a key used by a monitoring "
            "system. The monitoring system lost SSH access and stopped reporting. "
            "The outage was detected 4 hours later during a manual check."
        ),
        "date_occurred": "2025-04-08",
        "failure_mechanism": "F2",
        "reversibility": "R1",
        "blast_radius": "B4",
        "detection_difficulty": "D3",
        "situation_template": make_template(
            action_type="overwrite",
            target_type="file",
            target_id="~/.ssh/authorized_keys",
            age_hours=4380,
            size=512,
            recent_commits=0,
            recent_authors=2,
            effort_hours=2.0,
            last_human_ref=168.0,
            session_topic="server provisioning and SSH setup",
            recent_corrections=0,
            emotional_signals="focused",
            automation_depth=3,
            topic_drift=0.25,
            reversible="true",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": "Scope creep: provisioning task became 'overwrite all auth keys' without merging.",
        "outcome_category": "moderate_negative",
    },

    # ── 11. Memory file corruption ────────────────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-011",
        "title": "Memory file corruption — agent overwrote MEMORY.md with partial content",
        "description": (
            "Agent was asked to update a section of MEMORY.md. Instead of an edit, "
            "it wrote the entire file with only the new section, losing 3 weeks of "
            "accumulated memory entries. No backup was made. The loss was noticed the "
            "next day when the agent failed to recall recent context."
        ),
        "date_occurred": "2025-03-25",
        "failure_mechanism": "F1",
        "reversibility": "R2",
        "blast_radius": "B3",
        "detection_difficulty": "D2",
        "situation_template": make_template(
            action_type="overwrite",
            target_type="file",
            target_id="memory/MEMORY.md",
            age_hours=504,
            size=8900,
            recent_commits=14,
            recent_authors=2,
            effort_hours=12.0,
            last_human_ref=1.0,
            session_topic="memory update and context management",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.08,
            reversible="partial",
            blast_radius="persistent",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": (
            "Stale context: agent used Write tool when Edit was appropriate. "
            "High recent_commits (14) should have been a warning signal."
        ),
        "outcome_category": "moderate_negative",
    },

    # ── 12. Broadcast message to all contacts ─────────────────────────────────
    {
        "source": "internal",
        "source_id": "INT-012",
        "title": "WhatsApp broadcast to all contacts — agent misread 'send to everyone'",
        "description": (
            "User said 'send this update to everyone' meaning the project team group. "
            "Agent interpreted 'everyone' as all WhatsApp contacts and prepared a "
            "broadcast to 87 contacts. User caught the preview and stopped it before send. "
            "Close call — no actual damage but highlights misinterpretation risk."
        ),
        "date_occurred": "2025-02-14",
        "failure_mechanism": "F5",
        "reversibility": "R3",
        "blast_radius": "B4",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="send",
            target_type="message",
            target_id="whatsapp_all_contacts_broadcast",
            age_hours=0,
            size=280,
            recent_commits=0,
            recent_authors=0,
            effort_hours=0.0,
            last_human_ref=0.05,
            session_topic="team communication and project updates",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.5,
            reversible="false",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 1.0,
        "verified": True,
        "notes": (
            "Near-miss. 'Everyone' ambiguity. Stopped by user during preview. "
            "Logged as negative because the intent was wrong, not the outcome."
        ),
        "outcome_category": "severe_negative",
    },
]


# ── Additional synthetic entries to reach 50+ ─────────────────────────────────

SYNTHETIC_NEGATIVES = [
    {
        "source": "synthetic",
        "title": "Over-eager file rename during refactor breaks imports",
        "description": (
            "Agent renamed a Python module file that was imported by 23 other files. "
            "No search for references was performed before rename. Build failed."
        ),
        "date_occurred": None,
        "failure_mechanism": "F2",
        "reversibility": "R1",
        "blast_radius": "B3",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="move",
            target_type="file",
            target_id="src/utils/helpers.py",
            age_hours=1440,
            size=5200,
            recent_commits=4,
            recent_authors=2,
            effort_hours=3.0,
            last_human_ref=8.0,
            session_topic="codebase refactoring and module reorganization",
            recent_corrections=0,
            emotional_signals="focused",
            automation_depth=1,
            topic_drift=0.2,
            reversible="true",
            blast_radius="persistent",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 0.3,
        "verified": False,
        "outcome_category": "moderate_negative",
    },
    {
        "source": "synthetic",
        "title": "API key exposed in public commit message",
        "description": (
            "Agent included a debug statement with an API key in a commit message. "
            "The repo was public on GitHub. Key was invalidated within 12 hours "
            "by GitHub's secret scanning but 3 external requests were made."
        ),
        "date_occurred": None,
        "failure_mechanism": "F5",
        "reversibility": "R3",
        "blast_radius": "B4",
        "detection_difficulty": "D2",
        "situation_template": make_template(
            action_type="deploy",
            target_type="git_operation",
            target_id="github.com/user/public-repo",
            age_hours=0,
            size=0,
            recent_commits=1,
            recent_authors=1,
            effort_hours=0.1,
            last_human_ref=0.5,
            session_topic="debugging API integration",
            recent_corrections=0,
            emotional_signals="focused",
            automation_depth=1,
            topic_drift=0.15,
            reversible="false",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 0.3,
        "verified": False,
        "outcome_category": "severe_negative",
    },
    {
        "source": "synthetic",
        "title": "Automated reply-all to executive email thread",
        "description": (
            "Agent was monitoring an email thread and auto-replied to all recipients "
            "(including C-suite) with a draft response intended only for the original sender."
        ),
        "date_occurred": None,
        "failure_mechanism": "F3",
        "reversibility": "R3",
        "blast_radius": "B4",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="send",
            target_type="email",
            target_id="executive_thread_reply_all",
            age_hours=0,
            size=320,
            recent_commits=0,
            recent_authors=0,
            effort_hours=0.2,
            last_human_ref=0.2,
            session_topic="email response drafting",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.4,
            reversible="false",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 0.3,
        "verified": False,
        "outcome_category": "severe_negative",
    },
    {
        "source": "synthetic",
        "title": "Dependency upgrade breaks production API contract",
        "description": (
            "Agent upgraded a major dependency version in package.json without "
            "reviewing breaking changes. The new version changed API response format. "
            "Downstream services broke silently for 2 hours."
        ),
        "date_occurred": None,
        "failure_mechanism": "F1",
        "reversibility": "R1",
        "blast_radius": "B4",
        "detection_difficulty": "D2",
        "situation_template": make_template(
            action_type="modify",
            target_type="file",
            target_id="package.json",
            age_hours=360,
            size=2100,
            recent_commits=8,
            recent_authors=3,
            effort_hours=5.0,
            last_human_ref=12.0,
            session_topic="dependency management and security updates",
            recent_corrections=0,
            emotional_signals="focused",
            automation_depth=2,
            topic_drift=0.3,
            reversible="true",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 0.3,
        "verified": False,
        "outcome_category": "moderate_negative",
    },
    {
        "source": "synthetic",
        "title": "Terraform destroy on wrong workspace",
        "description": (
            "Agent ran terraform destroy targeting the staging workspace but "
            "the workspace context was set to production. All production infrastructure "
            "was destroyed. Recovery from snapshots took 4 hours."
        ),
        "date_occurred": None,
        "failure_mechanism": "F1",
        "reversibility": "R2",
        "blast_radius": "B4",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="execute",
            target_type="system_command",
            target_id="terraform destroy production",
            age_hours=8760,
            size=0,
            recent_commits=5,
            recent_authors=2,
            effort_hours=40.0,
            last_human_ref=24.0,
            session_topic="infrastructure cleanup and cost reduction",
            recent_corrections=0,
            emotional_signals="focused",
            automation_depth=2,
            topic_drift=0.55,
            reversible="partial",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 0.3,
        "verified": False,
        "outcome_category": "severe_negative",
    },
    {
        "source": "synthetic",
        "title": "Auto-close of GitHub issues deleted important tracking data",
        "description": (
            "Agent auto-closed 34 GitHub issues older than 90 days without reading content. "
            "Several were blocking long-term feature work with important design decisions "
            "in comments. Some comments were not recoverable after close."
        ),
        "date_occurred": None,
        "failure_mechanism": "F6",
        "reversibility": "R2",
        "blast_radius": "B3",
        "detection_difficulty": "D3",
        "situation_template": make_template(
            action_type="modify",
            target_type="api_call",
            target_id="github_issues_bulk_close",
            age_hours=2160,
            size=34,
            recent_commits=0,
            recent_authors=3,
            effort_hours=20.0,
            last_human_ref=96.0,
            session_topic="project management and issue triage",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=2,
            topic_drift=0.35,
            reversible="partial",
            blast_radius="persistent",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 0.3,
        "verified": False,
        "outcome_category": "moderate_negative",
    },
    {
        "source": "synthetic",
        "title": "Node process killed during active user session",
        "description": (
            "Agent ran `pkill -f node` to clean up orphaned processes. "
            "The command also killed the active OpenClaw gateway, dropping all "
            "pending sessions and losing unsaved in-memory state."
        ),
        "date_occurred": None,
        "failure_mechanism": "F4",
        "reversibility": "R2",
        "blast_radius": "B3",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="execute",
            target_type="system_command",
            target_id="pkill -f node",
            age_hours=0,
            size=0,
            recent_commits=0,
            recent_authors=1,
            effort_hours=0.5,
            last_human_ref=0.1,
            session_topic="process and memory management",
            recent_corrections=0,
            emotional_signals="focused",
            automation_depth=1,
            topic_drift=0.4,
            reversible="partial",
            blast_radius="session",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 0.3,
        "verified": False,
        "outcome_category": "moderate_negative",
    },
    {
        "source": "synthetic",
        "title": "Secret exposed via debug log in CI pipeline",
        "description": (
            "Agent added verbose logging for debugging an env variable issue. "
            "The debug log printed the DATABASE_PASSWORD value. CI logs are "
            "public on the open source repo. Secret was rotated immediately."
        ),
        "date_occurred": None,
        "failure_mechanism": "F5",
        "reversibility": "R3",
        "blast_radius": "B4",
        "detection_difficulty": "D2",
        "situation_template": make_template(
            action_type="modify",
            target_type="file",
            target_id=".github/workflows/ci.yml",
            age_hours=720,
            size=1800,
            recent_commits=3,
            recent_authors=2,
            effort_hours=2.0,
            last_human_ref=6.0,
            session_topic="CI pipeline debugging",
            recent_corrections=1,
            emotional_signals="focused",
            automation_depth=1,
            topic_drift=0.2,
            reversible="false",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 0.3,
        "verified": False,
        "outcome_category": "severe_negative",
    },
    {
        "source": "synthetic",
        "title": "Recurring meeting invite sent to entire company distribution list",
        "description": (
            "Agent sent a recurring meeting invite to 'all@company.com' rather than "
            "the specific team. 400+ employees received calendar invites for a daily "
            "standup. Took 2 hours and multiple follow-up emails to clean up."
        ),
        "date_occurred": None,
        "failure_mechanism": "F2",
        "reversibility": "R2",
        "blast_radius": "B4",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="send",
            target_type="email",
            target_id="all@company.com_calendar_invite",
            age_hours=0,
            size=0,
            recent_commits=0,
            recent_authors=0,
            effort_hours=0.3,
            last_human_ref=0.5,
            session_topic="meeting scheduling and calendar management",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.45,
            reversible="partial",
            blast_radius="external",
            human_in_loop=False,
            confirmation="none",
        ),
        "confidence_target": 0.0,
        "weight": 0.3,
        "verified": False,
        "outcome_category": "moderate_negative",
    },
]

# ── Safe positive examples (no counterpart relationship) ─────────────────────

SAFE_POSITIVES = [
    {
        "source": "internal",
        "title": "Safe shell script execution — dry-run flag confirmed",
        "description": (
            "Agent ran a cleanup script with --dry-run flag. No actual changes made. "
            "User reviewed output and explicitly approved before any real execution."
        ),
        "date_occurred": None,
        "failure_mechanism": "F2",
        "reversibility": "R1",
        "blast_radius": "B1",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="execute",
            target_type="system_command",
            target_id="cleanup.sh --dry-run",
            age_hours=0,
            size=0,
            recent_commits=0,
            recent_authors=1,
            effort_hours=0.0,
            last_human_ref=0.05,
            session_topic="system maintenance and cleanup",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.06,
            reversible="true",
            blast_radius="self",
            human_in_loop=True,
            confirmation="hard",
        ),
        "confidence_target": 1.0,
        "weight": 1.0,
        "verified": True,
        "outcome_category": "positive",
    },
    {
        "source": "internal",
        "title": "Safe API call — GET request with no side effects",
        "description": (
            "Agent called a public weather API to retrieve forecast data. "
            "Read-only GET request. No authentication tokens. No side effects."
        ),
        "date_occurred": None,
        "failure_mechanism": "F2",
        "reversibility": "R1",
        "blast_radius": "B1",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="execute",
            target_type="api_call",
            target_id="https://api.weather.example/forecast",
            age_hours=0,
            size=0,
            recent_commits=0,
            recent_authors=0,
            effort_hours=0.0,
            last_human_ref=0.01,
            session_topic="weather data retrieval",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.02,
            reversible="true",
            blast_radius="self",
            human_in_loop=True,
            confirmation="none",
        ),
        "confidence_target": 1.0,
        "weight": 1.0,
        "verified": True,
        "outcome_category": "positive",
    },
    {
        "source": "internal",
        "title": "Safe read-only operation — no mutation risk",
        "description": (
            "Agent read a file's contents for analysis. Pure read, no write. "
            "Trivially safe, included as a strong positive training anchor."
        ),
        "date_occurred": None,
        "failure_mechanism": "F1",
        "reversibility": "R1",
        "blast_radius": "B1",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="copy",
            target_type="file",
            target_id="README.md",
            age_hours=24,
            size=5000,
            recent_commits=2,
            recent_authors=1,
            effort_hours=1.0,
            last_human_ref=0.1,
            session_topic="code review and analysis",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.03,
            reversible="true",
            blast_radius="self",
            human_in_loop=True,
            confirmation="none",
        ),
        "confidence_target": 1.0,
        "weight": 1.0,
        "verified": True,
        "outcome_category": "positive",
    },
    {
        "source": "internal",
        "title": "Safe git commit on new branch — no shared history affected",
        "description": (
            "Agent committed work on a fresh personal branch. No shared branch affected. "
            "No force-push. Completely reversible. Strong positive anchor for git operations."
        ),
        "date_occurred": None,
        "failure_mechanism": "F4",
        "reversibility": "R1",
        "blast_radius": "B2",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="deploy",
            target_type="git_operation",
            target_id="origin/feature/personal-branch",
            age_hours=2,
            size=0,
            recent_commits=0,
            recent_authors=1,
            effort_hours=2.0,
            last_human_ref=0.3,
            session_topic="feature development",
            recent_corrections=0,
            emotional_signals="focused",
            automation_depth=0,
            topic_drift=0.05,
            reversible="true",
            blast_radius="session",
            human_in_loop=True,
            confirmation="soft",
        ),
        "confidence_target": 1.0,
        "weight": 1.0,
        "verified": True,
        "outcome_category": "positive",
    },
    {
        "source": "internal",
        "title": "Safe database query — SELECT only, no modification",
        "description": (
            "Agent ran a SELECT query to inspect table contents for debugging. "
            "Pure read operation, no writes, user explicitly requested."
        ),
        "date_occurred": None,
        "failure_mechanism": "F1",
        "reversibility": "R1",
        "blast_radius": "B1",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="execute",
            target_type="database",
            target_id="SELECT * FROM users LIMIT 10",
            age_hours=720,
            size=10,
            recent_commits=0,
            recent_authors=1,
            effort_hours=0.0,
            last_human_ref=0.02,
            session_topic="database inspection and debugging",
            recent_corrections=0,
            emotional_signals="focused",
            automation_depth=0,
            topic_drift=0.03,
            reversible="true",
            blast_radius="self",
            human_in_loop=True,
            confirmation="none",
        ),
        "confidence_target": 1.0,
        "weight": 1.0,
        "verified": True,
        "outcome_category": "positive",
    },
    {
        "source": "internal",
        "title": "Safe file edit — user explicitly requested change to fresh file",
        "description": (
            "User explicitly asked to update a line in a config file created 2 minutes ago. "
            "Single author, zero recent commits, human in loop, low topic drift. "
            "Classic safe operation."
        ),
        "date_occurred": None,
        "failure_mechanism": "F1",  # Not a failure, using F1 as placeholder for taxonomy requirement
        "reversibility": "R1",
        "blast_radius": "B2",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="modify",
            target_type="file",
            target_id="config/local.yaml",
            age_hours=0.03,
            size=800,
            recent_commits=0,
            recent_authors=1,
            effort_hours=0.05,
            last_human_ref=0.02,
            session_topic="local configuration setup",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.04,
            reversible="true",
            blast_radius="session",
            human_in_loop=True,
            confirmation="soft",
        ),
        "confidence_target": 1.0,
        "weight": 1.0,
        "verified": True,
        "outcome_category": "positive",
    },
    {
        "source": "internal",
        "title": "Safe message to approved contact — direct user instruction",
        "description": (
            "User directly asked to send a message to a contact in the allowlist. "
            "Message content reviewed, contact verified, human initiated. Ideal case."
        ),
        "date_occurred": None,
        "failure_mechanism": "F3",
        "reversibility": "R3",
        "blast_radius": "B4",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="send",
            target_type="message",
            target_id="approved_contact_whatsapp",
            age_hours=0,
            size=120,
            recent_commits=0,
            recent_authors=0,
            effort_hours=0.1,
            last_human_ref=0.05,
            session_topic="direct user communication request",
            recent_corrections=0,
            emotional_signals="calm",
            automation_depth=0,
            topic_drift=0.02,
            reversible="false",
            blast_radius="external",
            human_in_loop=True,
            confirmation="hard",
        ),
        "confidence_target": 1.0,
        "weight": 1.0,
        "verified": True,
        "outcome_category": "positive",
    },
    {
        "source": "internal",
        "title": "Safe new file creation — user asked to create a new file from scratch",
        "description": (
            "Agent created a new Python script as explicitly requested. No existing file "
            "overwritten. Reversible. Low topic drift. Human directly requested."
        ),
        "date_occurred": None,
        "failure_mechanism": "F2",
        "reversibility": "R1",
        "blast_radius": "B2",
        "detection_difficulty": "D1",
        "situation_template": make_template(
            action_type="create",
            target_type="file",
            target_id="scripts/new_analysis.py",
            age_hours=-1,
            size=0,
            recent_commits=0,
            recent_authors=0,
            effort_hours=0.0,
            last_human_ref=0.01,
            session_topic="data analysis script creation",
            recent_corrections=0,
            emotional_signals="focused",
            automation_depth=0,
            topic_drift=0.06,
            reversible="true",
            blast_radius="session",
            human_in_loop=True,
            confirmation="none",
        ),
        "confidence_target": 1.0,
        "weight": 1.0,
        "verified": True,
        "outcome_category": "positive",
    },
]


# ── Main population function ──────────────────────────────────────────────────

def populate_cfd(conn: sqlite3.Connection) -> dict:
    """Populate the CFD with all seed entries. Returns stats."""
    stats = {
        "known_incidents": 0,
        "synthetic_negatives": 0,
        "positive_counterparts": 0,
        "safe_positives": 0,
        "total": 0,
    }

    # 1. Insert known incidents + positive counterparts
    print("\n=== Known Deployment Incidents ===")
    for incident in KNOWN_INCIDENTS:
        neg_id = insert_entry(conn, incident)
        stats["known_incidents"] += 1
        print(f"  [{neg_id:3d}] {incident['title'][:60]}...")

        # Generate and insert positive counterpart
        pos_entry = make_positive_counterpart(incident, incident["situation_template"])
        pos_id = insert_entry(conn, pos_entry)
        stats["positive_counterparts"] += 1

        # Link them
        link_counterpart(conn, neg_id, pos_id)
        print(f"  [{pos_id:3d}]   └─ positive counterpart")

    # 2. Insert additional synthetic negatives + their counterparts
    print("\n=== Synthetic Negative Examples ===")
    for synthetic in SYNTHETIC_NEGATIVES:
        neg_id = insert_entry(conn, synthetic)
        stats["synthetic_negatives"] += 1
        print(f"  [{neg_id:3d}] {synthetic['title'][:60]}...")

        pos_entry = make_positive_counterpart(synthetic, synthetic["situation_template"])
        pos_id = insert_entry(conn, pos_entry)
        stats["positive_counterparts"] += 1
        link_counterpart(conn, neg_id, pos_id)
        print(f"  [{pos_id:3d}]   └─ positive counterpart")

    # 3. Insert standalone safe positives
    print("\n=== Safe Positive Examples ===")
    for safe in SAFE_POSITIVES:
        pos_id = insert_entry(conn, safe)
        stats["safe_positives"] += 1
        print(f"  [{pos_id:3d}] {safe['title'][:60]}...")

    conn.commit()

    total = conn.execute("SELECT COUNT(*) FROM cfd_entries").fetchone()[0]
    stats["total"] = total
    return stats


def print_distribution(conn: sqlite3.Connection):
    """Print the entry distribution for verification."""
    print("\n=== CFD Distribution ===")
    rows = conn.execute("""
        SELECT
            outcome_category,
            source,
            COUNT(*) as n,
            ROUND(100.0 * COUNT(*) / (SELECT COUNT(*) FROM cfd_entries), 1) as pct
        FROM cfd_entries
        GROUP BY outcome_category, source
        ORDER BY outcome_category, source
    """).fetchall()
    for row in rows:
        print(f"  {row[0]:20s} | {row[1]:10s} | {row[2]:3d} entries ({row[3]}%)")

    print("\n=== Taxonomy Distribution ===")
    rows = conn.execute("""
        SELECT failure_mechanism, reversibility, blast_radius, detection_difficulty, COUNT(*)
        FROM cfd_entries
        GROUP BY 1, 2, 3, 4
        ORDER BY 5 DESC
        LIMIT 10
    """).fetchall()
    for row in rows:
        print(f"  {row[0]} / {row[1]} / {row[2]} / {row[3]} : {row[4]} entries")


def main():
    parser = argparse.ArgumentParser(description="Initialize AMYGDALA CFD database")
    parser.add_argument("--db", default=str(Path(__file__).parent / "cfd.sqlite"),
                        help="Path to CFD SQLite database")
    parser.add_argument("--reset", action="store_true", help="Drop and recreate database")
    args = parser.parse_args()

    print(f"CFD database: {args.db}")

    conn = create_db(args.db, reset=args.reset)
    stats = populate_cfd(conn)
    print_distribution(conn)
    conn.close()

    print(f"\n=== Summary ===")
    print(f"  Known incidents:        {stats['known_incidents']}")
    print(f"  Synthetic negatives:    {stats['synthetic_negatives']}")
    print(f"  Positive counterparts:  {stats['positive_counterparts']}")
    print(f"  Safe positives:         {stats['safe_positives']}")
    print(f"  Total entries:          {stats['total']}")

    if stats["total"] >= 50:
        print(f"\n✓ Target met: {stats['total']} entries (≥50)")
    else:
        print(f"\n✗ Target NOT met: {stats['total']} entries (<50)")
        sys.exit(1)


if __name__ == "__main__":
    main()
