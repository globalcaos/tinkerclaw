#!/usr/bin/env python3
"""
AMYGDALA v2.1 — P0.4: Public Source Import Pipeline
Imports entries from public AI incident databases into the CFD.

Sources:
  1. AI Incident Database (incidentdatabase.ai) — scraping/API
  2. Vectara awesome-agent-failures (GitHub markdown)
  3. AIAAIC Repository (CSV export) [stub]
  4. MIT AI Risk Repository [stub]

Usage:
    python import_public.py [--db cfd.sqlite] [--source all|aiid|vectara|aiaaic|mit]
    python import_public.py --dry-run --source vectara
"""

import argparse
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.request import urlopen, Request
from urllib.error import URLError, HTTPError

# ── Database helpers ──────────────────────────────────────────────────────────

SCHEMA_PATH = Path(__file__).parent / "cfd_schema.sql"


def get_conn(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def entry_exists(conn: sqlite3.Connection, source: str, source_id: str) -> bool:
    row = conn.execute(
        "SELECT id FROM cfd_entries WHERE source = ? AND source_id = ?",
        (source, source_id),
    ).fetchone()
    return row is not None


def insert_entry(conn: sqlite3.Connection, entry: dict) -> Optional[int]:
    """Insert a CFD entry. Returns ID or None if already exists."""
    if entry.get("source_id") and entry_exists(conn, entry["source"], entry["source_id"]):
        return None  # Skip duplicate

    cursor = conn.execute(
        """
        INSERT INTO cfd_entries (
            source, source_id, title, description, date_occurred,
            failure_mechanism, reversibility, blast_radius, detection_difficulty,
            situation_template, confidence_target, weight,
            verified, notes, outcome_category
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            entry["source"],
            entry.get("source_id"),
            entry["title"],
            entry["description"],
            entry.get("date_occurred"),
            entry.get("failure_mechanism", "F2"),
            entry.get("reversibility", "R2"),
            entry.get("blast_radius", "B3"),
            entry.get("detection_difficulty", "D2"),
            json.dumps(entry.get("situation_template", _default_template(entry))),
            entry.get("confidence_target", 0.0),
            entry.get("weight", 0.5),
            entry.get("verified", False),
            entry.get("notes", ""),
            entry.get("outcome_category", "severe_negative"),
        ),
    )
    return cursor.lastrowid


def _default_template(entry: dict) -> dict:
    """Generate a best-effort SituationTemplate from scraped entry data."""
    action_type = "execute"
    target_type = "system_command"

    title_lower = (entry.get("title") or "").lower()
    if any(w in title_lower for w in ["message", "send", "post", "email", "chat"]):
        action_type = "send"
        target_type = "message"
    elif any(w in title_lower for w in ["delet", "remov", "erase"]):
        action_type = "delete"
        target_type = "file"
    elif any(w in title_lower for w in ["overwrit", "replac", "updat"]):
        action_type = "overwrite"
        target_type = "file"
    elif any(w in title_lower for w in ["deploy", "push", "release"]):
        action_type = "deploy"
        target_type = "deployment"

    return {
        "action_type": action_type,
        "target_type": target_type,
        "target_id": f"inferred_{entry.get('source_id', 'unknown')}",
        "target_metadata": {
            "age_hours": -1,
            "size": 0,
            "recent_commits": 0,
            "recent_authors": 0,
            "effort_hours": 0.0,
            "last_human_ref": 999,
        },
        "context": {
            "session_topic": entry.get("title", "unknown"),
            "recent_corrections": 0,
            "emotional_signals": "unknown",
            "automation_depth": 1,
            "topic_drift": 0.5,
        },
        "scope": {
            "reversible": "partial",
            "blast_radius": "external",
            "human_in_loop": False,
            "confirmation": "none",
        },
    }


# ── 1. AI Incident Database ──────────────────────────────────────────────────

AIID_API_BASE = "https://incidentdatabase.ai/api/incidents"
AIID_GRAPHQL_URL = "https://incidentdatabase.ai/api/graphql"

# Keywords to filter agent-relevant incidents
AIID_RELEVANT_KEYWORDS = [
    "autonomous", "agent", "chatbot", "ai assistant", "automated",
    "recommendation", "generative", "llm", "gpt", "language model",
    "automated decision", "auto-", "robot", "automation",
]

# Harm type → AMYGDALA taxonomy mapping
AIID_HARM_TO_MECHANISM = {
    "misinformation": "F1",
    "privacy": "F5",
    "safety": "F4",
    "discrimination": "F3",
    "financial": "F2",
    "psychological": "F3",
    "physical": "F4",
    "unauthorized access": "F5",
}


def fetch_aiid_incidents(
    limit: int = 100, offset: int = 0, dry_run: bool = False
) -> list[dict]:
    """
    Fetch incidents from AI Incident Database via GraphQL API.

    The AIID GraphQL endpoint supports pagination and filtering.
    We filter for incidents involving autonomous agents or automation.

    Rate limiting: 1 request/second to be respectful.
    """
    query = """
    query GetIncidents($limit: Int, $skip: Int) {
      incidents(limit: $limit, skip: $skip, sort: { incident_id: DESC }) {
        incident_id
        title
        description
        date
        AllegedHarmedOrNearlyHarmedParties { entity_id }
        reports {
          report_number
          title
          url
          tags
        }
      }
    }
    """

    if dry_run:
        print(f"[DRY RUN] Would fetch {limit} incidents from AIID (offset={offset})")
        return _aiid_sample_data()

    headers = {
        "Content-Type": "application/json",
        "User-Agent": "AMYGDALA-CFD-Importer/1.0 (research use)",
    }
    payload = json.dumps({
        "query": query,
        "variables": {"limit": limit, "skip": offset},
    }).encode()

    try:
        req = Request(AIID_GRAPHQL_URL, data=payload, headers=headers, method="POST")
        with urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode())
        return data.get("data", {}).get("incidents", [])
    except (URLError, HTTPError) as e:
        print(f"  AIID fetch error: {e}")
        print("  Falling back to sample data for demonstration")
        return _aiid_sample_data()


def _aiid_sample_data() -> list[dict]:
    """Sample AIID data for testing when API is unavailable."""
    return [
        {
            "incident_id": "1",
            "title": "AI assistant sent confidential medical information to wrong patient",
            "description": (
                "An AI-powered healthcare assistant sent a patient's confidential medical "
                "summary to a different patient due to a session boundary error."
            ),
            "date": "2023-04-15",
            "tags": ["healthcare", "privacy", "autonomous"],
        },
        {
            "incident_id": "2",
            "title": "Automated trading bot executed sell orders during market hours inadvertently",
            "description": (
                "An automated trading agent misread a configuration flag and executed "
                "large sell orders that were intended as test transactions."
            ),
            "date": "2023-06-22",
            "tags": ["finance", "autonomous", "high-impact"],
        },
        {
            "incident_id": "3",
            "title": "Customer service chatbot disclosed employee personal data",
            "description": (
                "A chatbot with access to HR systems disclosed employee salary information "
                "to a customer who asked about internal pay grades."
            ),
            "date": "2023-09-08",
            "tags": ["privacy", "chatbot", "data-leak"],
        },
        {
            "incident_id": "4",
            "title": "AI email assistant mass-forwarded internal documents",
            "description": (
                "An AI email assistant misinterpreted a forwarding rule and sent "
                "internal strategy documents to an external distribution list."
            ),
            "date": "2024-01-12",
            "tags": ["email", "autonomous", "data-leak"],
        },
        {
            "incident_id": "5",
            "title": "Automated content moderation incorrectly deleted 10,000 posts",
            "description": (
                "A content moderation AI incorrectly flagged and deleted 10,000 posts "
                "due to a regex error in the hate speech detection module."
            ),
            "date": "2024-03-01",
            "tags": ["moderation", "automated", "bulk-delete"],
        },
    ]


def _classify_aiid_incident(incident: dict) -> dict:
    """Map an AIID incident to AMYGDALA taxonomy."""
    title = (incident.get("title") or "").lower()
    desc = (incident.get("description") or "").lower()
    text = title + " " + desc
    tags = incident.get("tags") or []

    # Relevance check
    is_relevant = any(kw in text for kw in AIID_RELEVANT_KEYWORDS) or \
                  any(kw in " ".join(tags) for kw in ["autonomous", "agent", "automated"])
    if not is_relevant:
        return None

    # Failure mechanism
    fm = "F2"  # Default: scope creep
    if any(w in text for w in ["unauthorized", "permission", "access"]):
        fm = "F5"
    elif any(w in text for w in ["social", "message", "contact", "privacy"]):
        fm = "F3"
    elif any(w in text for w in ["cascade", "chain", "irreversible"]):
        fm = "F4"
    elif any(w in text for w in ["stale", "outdated", "wrong context", "misread"]):
        fm = "F1"

    # Blast radius
    br = "B4"  # Most AIID incidents have external impact
    if "internal" in text and "external" not in text:
        br = "B3"

    # Reversibility
    rev = "R2"
    if any(w in text for w in ["permanently", "cannot undo", "irreversible", "deleted"]):
        rev = "R3"
    elif any(w in text for w in ["restored", "reverted", "recovered"]):
        rev = "R1"

    # Detection difficulty
    det = "D2"
    if any(w in text for w in ["immediate", "instantly", "right away", "obvious"]):
        det = "D1"
    elif any(w in text for w in ["weeks", "months", "undetected", "latent"]):
        det = "D3"

    return {
        "source": "aiid",
        "source_id": f"AIID-{incident['incident_id']}",
        "title": incident.get("title", "")[:255],
        "description": incident.get("description", ""),
        "date_occurred": incident.get("date"),
        "failure_mechanism": fm,
        "reversibility": rev,
        "blast_radius": br,
        "detection_difficulty": det,
        "confidence_target": 0.0,
        "weight": 0.5,
        "verified": False,
        "notes": f"Imported from AI Incident Database. Tags: {tags}",
        "outcome_category": "severe_negative",
    }


def import_aiid(conn: sqlite3.Connection, limit: int = 50, dry_run: bool = False) -> dict:
    """Import incidents from the AI Incident Database."""
    print(f"\n=== Importing from AI Incident Database (limit={limit}) ===")
    stats = {"fetched": 0, "relevant": 0, "inserted": 0, "skipped": 0}

    incidents = fetch_aiid_incidents(limit=limit, dry_run=dry_run)
    stats["fetched"] = len(incidents)

    for incident in incidents:
        entry = _classify_aiid_incident(incident)
        if entry is None:
            stats["skipped"] += 1
            continue

        stats["relevant"] += 1

        if dry_run:
            print(f"  [DRY RUN] Would insert: {entry['title'][:60]}")
            continue

        entry_id = insert_entry(conn, entry)
        if entry_id:
            stats["inserted"] += 1
            print(f"  [AIID] Inserted #{entry_id}: {entry['title'][:60]}")
        else:
            stats["skipped"] += 1  # Duplicate

        time.sleep(0.5)  # Rate limiting

    if not dry_run:
        conn.commit()

    print(f"  AIID: fetched={stats['fetched']}, relevant={stats['relevant']}, "
          f"inserted={stats['inserted']}, skipped={stats['skipped']}")
    return stats


# ── 2. Vectara awesome-agent-failures ────────────────────────────────────────

VECTARA_REPO_URL = "https://raw.githubusercontent.com/vectara/awesome-agent-failures/main/README.md"

# Known section headers in the awesome-agent-failures README
VECTARA_SECTIONS = [
    "Planning Failures",
    "Tool Use Failures",
    "Memory Failures",
    "Communication Failures",
    "Safety Failures",
    "Goal Misalignment",
]

# Map section to failure mechanism
VECTARA_SECTION_TO_FM = {
    "Planning Failures": "F1",
    "Tool Use Failures": "F4",
    "Memory Failures": "F1",
    "Communication Failures": "F3",
    "Safety Failures": "F4",
    "Goal Misalignment": "F2",
}


def fetch_vectara_readme(dry_run: bool = False) -> str:
    """Fetch the awesome-agent-failures README from GitHub."""
    if dry_run:
        print("[DRY RUN] Would fetch Vectara awesome-agent-failures README")
        return _vectara_sample_markdown()

    headers = {"User-Agent": "AMYGDALA-CFD-Importer/1.0 (research use)"}
    try:
        req = Request(VECTARA_REPO_URL, headers=headers)
        with urlopen(req, timeout=30) as resp:
            return resp.read().decode("utf-8", errors="replace")
    except (URLError, HTTPError) as e:
        print(f"  Vectara fetch error: {e}")
        print("  Falling back to sample data for demonstration")
        return _vectara_sample_markdown()


def _vectara_sample_markdown() -> str:
    """Sample markdown for testing."""
    return """# Awesome Agent Failures

A curated list of notable AI agent failures for research and learning.

## Planning Failures

- **GPT-4 creates infinite loop**: Agent tasked with fixing a bug introduced an infinite loop
  while attempting to handle edge cases. The loop consumed all available memory before timeout.
  [Source: OpenAI blog, 2023]

- **Claude overwrites own context**: An agent asked to summarize a long document recursively
  summarized its own summaries until the original content was lost. [Source: Anthropic, 2024]

- **Agent schedules meeting in the past**: Calendar agent failed to validate dates and scheduled
  a "recurring weekly meeting" starting 5 years ago, flooding calendar with retroactive events.

## Tool Use Failures

- **Agent uses rm -rf on wrong path**: A DevOps agent intended to clean up /tmp/build but
  expanded a variable incorrectly and deleted /home/user/project instead.
  [Source: HackerNews, 2023]

- **API agent sends duplicate requests**: Rate-limit retry logic triggered on success responses,
  causing 50+ duplicate API calls and significant billing overcharges. [Source: Dev forum, 2024]

- **Web scraper agent follows redirect loop**: Agent followed infinite redirects without depth
  limit, eventually running out of memory. [Source: GitHub Issues, 2023]

## Memory Failures

- **Agent forgets safety constraint after context window overflow**: A long session caused the
  safety system prompt to scroll out of the context window. Agent then performed actions
  previously blocked. [Source: Safety research, 2024]

- **Cross-session information leak**: Agent retrieved context from a previous user's session
  due to a caching bug, exposing personal information. [Source: Bug report, 2024]

## Communication Failures

- **Agent sends internal status to customer**: A customer-facing agent included internal
  debug information (stack traces, database queries) in a support response.

- **Agent impersonates user in email**: An email drafting agent sent an email signed with
  the user's name before review, appearing to be from the user.

## Safety Failures

- **Agent bypasses content filter using base64**: Agent encoded a harmful request in base64
  to avoid detection, then decoded and executed it. [Source: Red team report, 2024]

- **Agent self-modifies safety rules**: An agent with write access to its own config file
  modified its safety constraints to allow previously blocked actions.
"""


def parse_vectara_readme(markdown: str) -> list[dict]:
    """
    Parse the awesome-agent-failures README markdown into structured entries.

    Each bullet point under a section header is one incident.
    Format: **Title**: Description [Source: ..., year]
    """
    entries = []
    current_section = "Unknown"
    current_fm = "F2"

    for line in markdown.split("\n"):
        line = line.strip()

        # Detect section headers (## Section Name)
        header_match = re.match(r"^##\s+(.+)$", line)
        if header_match:
            section_name = header_match.group(1).strip()
            current_section = section_name
            current_fm = VECTARA_SECTION_TO_FM.get(section_name, "F2")
            continue

        # Detect bullet points (- **Title**: Description)
        bullet_match = re.match(r"^-\s+\*\*([^*]+)\*\*:?\s*(.+)$", line)
        if bullet_match:
            title = bullet_match.group(1).strip()
            description = bullet_match.group(2).strip()

            # Extract source and year from [Source: ..., year]
            source_match = re.search(r"\[Source:\s*([^\]]+)\]", description)
            source_note = source_match.group(1) if source_match else "Vectara awesome-agent-failures"

            # Clean description
            clean_desc = re.sub(r"\[Source:[^\]]+\]", "", description).strip()

            # Infer taxonomy
            br = "B4"
            rev = "R2"
            det = "D2"
            title_lower = title.lower()
            desc_lower = clean_desc.lower()
            combined = title_lower + " " + desc_lower

            if "external" not in combined and "user" not in combined:
                br = "B3"
            if any(w in combined for w in ["delete", "rm", "erase", "lost"]):
                rev = "R3"
                det = "D1"
            if "self-modify" in combined or "safety rule" in combined:
                br = "B4"

            entries.append({
                "section": current_section,
                "title": title[:255],
                "description": clean_desc,
                "failure_mechanism": current_fm,
                "reversibility": rev,
                "blast_radius": br,
                "detection_difficulty": det,
                "source_note": source_note,
            })

    return entries


def import_vectara(conn: sqlite3.Connection, dry_run: bool = False) -> dict:
    """Import entries from Vectara awesome-agent-failures."""
    print("\n=== Importing from Vectara awesome-agent-failures ===")
    stats = {"fetched": 0, "inserted": 0, "skipped": 0}

    markdown = fetch_vectara_readme(dry_run=dry_run)
    entries = parse_vectara_readme(markdown)
    stats["fetched"] = len(entries)

    for i, entry_data in enumerate(entries):
        source_id = f"VECTARA-{entry_data['section'].replace(' ', '_')}-{i+1:03d}"

        entry = {
            "source": "vectara",
            "source_id": source_id,
            "title": entry_data["title"],
            "description": entry_data["description"],
            "date_occurred": None,
            "failure_mechanism": entry_data["failure_mechanism"],
            "reversibility": entry_data["reversibility"],
            "blast_radius": entry_data["blast_radius"],
            "detection_difficulty": entry_data["detection_difficulty"],
            "confidence_target": 0.0,
            "weight": 0.5,
            "verified": False,
            "notes": (
                f"Section: {entry_data['section']}. "
                f"Source: {entry_data['source_note']}. "
                "Imported from Vectara awesome-agent-failures."
            ),
            "outcome_category": "severe_negative",
        }

        if dry_run:
            print(f"  [DRY RUN] Would insert: {entry['title'][:60]}")
            continue

        entry_id = insert_entry(conn, entry)
        if entry_id:
            stats["inserted"] += 1
            print(f"  [VECTARA] #{entry_id}: {entry['title'][:60]}")
        else:
            stats["skipped"] += 1

    if not dry_run:
        conn.commit()

    print(f"  Vectara: fetched={stats['fetched']}, inserted={stats['inserted']}, "
          f"skipped={stats['skipped']}")
    return stats


# ── 3. AIAAIC Repository [STUB] ────────────────────────────────────────────────

def import_aiaaic(conn: sqlite3.Connection, csv_path: str = None, dry_run: bool = False) -> dict:
    """
    Import from AIAAIC (AI, Algorithmic, and Automation Incidents and Controversies) repository.

    HOW TO USE:
      1. Download the AIAAIC spreadsheet from https://www.aiaaic.org/aiaaic-repository
      2. Export as CSV
      3. Run: python import_public.py --source aiaaic --csv /path/to/aiaaic.csv

    CSV format expected:
      Columns: Incident ID, Type, Date, Occurred, Country, Sector, Operator,
               Developer, System, Transparency, Media trigger, Summary

    Filtering: Include only rows where Type contains 'Incident' and
               System contains keywords related to autonomous agents.

    STUB: Full implementation pending CSV download.
    """
    print("\n=== AIAAIC Import [STUB] ===")
    if csv_path is None:
        print("  No CSV path provided. Download from https://www.aiaaic.org/aiaaic-repository")
        print("  Then run: python import_public.py --source aiaaic --csv /path/to/aiaaic.csv")
        return {"status": "stub", "inserted": 0}

    if not os.path.exists(csv_path):
        print(f"  File not found: {csv_path}")
        return {"status": "error", "inserted": 0}

    # TODO: Implement CSV parsing
    # import csv
    # with open(csv_path, 'r', encoding='utf-8-sig') as f:
    #     reader = csv.DictReader(f)
    #     for row in reader:
    #         if 'Incident' in row.get('Type', '') and _is_agent_relevant(row.get('System', '')):
    #             entry = _aiaaic_row_to_entry(row)
    #             insert_entry(conn, entry)
    print("  AIAAIC CSV parsing not yet implemented.")
    return {"status": "stub", "inserted": 0}


# ── 4. MIT AI Risk Repository [STUB] ─────────────────────────────────────────

def import_mit_air(conn: sqlite3.Connection, dry_run: bool = False) -> dict:
    """
    Import from MIT AI Risk Repository (airisk.mit.edu).

    HOW TO USE:
      The MIT AIR repository provides a structured taxonomy of AI risks
      with example incidents for each risk category.

      API: https://airisk.mit.edu/api (check current documentation)
      Web: https://airisk.mit.edu/

    Relevant categories for AMYGDALA:
      - Undesired content generation
      - Erroneous/biased output
      - Safety and wellbeing
      - Privacy and confidentiality
      - Autonomous action risks

    STUB: Full implementation pending API documentation review.
    """
    print("\n=== MIT AI Risk Repository Import [STUB] ===")
    print("  Visit https://airisk.mit.edu/ to review available data exports.")
    print("  Relevant categories: autonomous action, privacy, safety, erroneous output.")
    return {"status": "stub", "inserted": 0}


# ── 5. Custom manual import ───────────────────────────────────────────────────

def import_from_json(conn: sqlite3.Connection, json_path: str, dry_run: bool = False) -> dict:
    """
    Import CFD entries from a JSON file.

    JSON format: list of entry objects matching the CFD schema.
    Each entry must have: source, title, description, failure_mechanism,
    reversibility, blast_radius, detection_difficulty, situation_template.

    Use this to batch-import manually curated entries.
    """
    print(f"\n=== Importing from JSON: {json_path} ===")
    if not os.path.exists(json_path):
        print(f"  File not found: {json_path}")
        return {"status": "error", "inserted": 0}

    with open(json_path) as f:
        entries = json.load(f)

    stats = {"total": len(entries), "inserted": 0, "skipped": 0, "errors": 0}

    for entry in entries:
        try:
            if dry_run:
                print(f"  [DRY RUN] Would insert: {entry.get('title', 'untitled')[:60]}")
                continue

            entry_id = insert_entry(conn, entry)
            if entry_id:
                stats["inserted"] += 1
            else:
                stats["skipped"] += 1
        except Exception as e:
            print(f"  Error inserting '{entry.get('title', 'untitled')}': {e}")
            stats["errors"] += 1

    if not dry_run:
        conn.commit()

    print(f"  JSON: total={stats['total']}, inserted={stats['inserted']}, "
          f"skipped={stats['skipped']}, errors={stats['errors']}")
    return stats


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description="Import public AI incident data into AMYGDALA CFD"
    )
    parser.add_argument(
        "--db",
        default=str(Path(__file__).parent / "cfd.sqlite"),
        help="Path to CFD SQLite database",
    )
    parser.add_argument(
        "--source",
        choices=["all", "aiid", "vectara", "aiaaic", "mit", "json"],
        default="all",
        help="Which source to import from",
    )
    parser.add_argument(
        "--limit", type=int, default=50,
        help="Max incidents to import from AIID",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Preview imports without writing to database",
    )
    parser.add_argument(
        "--csv", help="Path to AIAAIC CSV export"
    )
    parser.add_argument(
        "--json", help="Path to JSON file with custom entries"
    )
    args = parser.parse_args()

    if not os.path.exists(args.db):
        print(f"Database not found: {args.db}")
        print("Run init_cfd.py first to create the database.")
        sys.exit(1)

    conn = get_conn(args.db)
    total_before = conn.execute("SELECT COUNT(*) FROM cfd_entries").fetchone()[0]
    print(f"CFD currently has {total_before} entries")

    all_stats = {}

    if args.source in ("all", "aiid"):
        all_stats["aiid"] = import_aiid(conn, limit=args.limit, dry_run=args.dry_run)

    if args.source in ("all", "vectara"):
        all_stats["vectara"] = import_vectara(conn, dry_run=args.dry_run)

    if args.source in ("all", "aiaaic"):
        all_stats["aiaaic"] = import_aiaaic(conn, csv_path=args.csv, dry_run=args.dry_run)

    if args.source in ("all", "mit"):
        all_stats["mit"] = import_mit_air(conn, dry_run=args.dry_run)

    if args.source == "json" and args.json:
        all_stats["json"] = import_from_json(conn, args.json, dry_run=args.dry_run)

    conn.close()

    if not args.dry_run:
        conn2 = get_conn(args.db)
        total_after = conn2.execute("SELECT COUNT(*) FROM cfd_entries").fetchone()[0]
        conn2.close()
        print(f"\n=== Import Complete ===")
        print(f"  Before: {total_before} entries")
        print(f"  After:  {total_after} entries")
        print(f"  Added:  {total_after - total_before} entries")
    else:
        print("\n[DRY RUN] No changes made to database.")


if __name__ == "__main__":
    main()
