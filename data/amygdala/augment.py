#!/usr/bin/env python3
"""
AMYGDALA v2.1 — P0.4: Synthetic Augmentation Pipeline
Generates synthetic variants of CFD entries to expand training data.

Strategies (paper §6.5):
  1. Target variation     — same pattern, different target type
  2. Severity scaling     — adjust metadata gradients
  3. Context injection    — add/remove context signals
  4. Counterfactual       — positive version of negatives

Weight policy: all synthetic examples receive weight=0.3

Usage:
    python augment.py [--db cfd.sqlite] [--multiplier 3] [--dry-run]
    python augment.py --db cfd.sqlite --strategy target_variation
"""

import argparse
import copy
import json
import os
import random
import sqlite3
import sys
from pathlib import Path
from typing import Optional

# Synthetic examples always get 0.3 weight per paper §6.5
SYNTHETIC_WEIGHT = 0.3

# ── Database helpers ──────────────────────────────────────────────────────────

def get_conn(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def load_seed_entries(conn: sqlite3.Connection, include_synthetic: bool = False) -> list[dict]:
    """Load entries suitable for augmentation (non-synthetic by default)."""
    if include_synthetic:
        rows = conn.execute(
            "SELECT id, title, description, failure_mechanism, reversibility, "
            "blast_radius, detection_difficulty, situation_template, "
            "confidence_target, outcome_category, source "
            "FROM cfd_entries"
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT id, title, description, failure_mechanism, reversibility, "
            "blast_radius, detection_difficulty, situation_template, "
            "confidence_target, outcome_category, source "
            "FROM cfd_entries WHERE source != 'synthetic'"
        ).fetchall()

    entries = []
    for row in rows:
        entries.append({
            "id": row[0],
            "title": row[1],
            "description": row[2],
            "failure_mechanism": row[3],
            "reversibility": row[4],
            "blast_radius": row[5],
            "detection_difficulty": row[6],
            "situation_template": json.loads(row[7]),
            "confidence_target": row[8],
            "outcome_category": row[9],
            "source": row[10],
        })
    return entries


def insert_synthetic(conn: sqlite3.Connection, entry: dict) -> Optional[int]:
    """Insert a synthetic entry, skip if title already exists."""
    existing = conn.execute(
        "SELECT id FROM cfd_entries WHERE title = ? AND source = 'synthetic'",
        (entry["title"],),
    ).fetchone()
    if existing:
        return None

    cursor = conn.execute(
        """
        INSERT INTO cfd_entries (
            source, title, description, date_occurred,
            failure_mechanism, reversibility, blast_radius, detection_difficulty,
            situation_template, confidence_target, weight,
            verified, notes, outcome_category
        ) VALUES ('synthetic', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, FALSE, ?, ?)
        """,
        (
            entry["title"],
            entry["description"],
            entry["failure_mechanism"],
            entry["reversibility"],
            entry["blast_radius"],
            entry["detection_difficulty"],
            json.dumps(entry["situation_template"]),
            entry["confidence_target"],
            SYNTHETIC_WEIGHT,
            entry.get("notes", f"Synthetic variant. Strategy: {entry.get('strategy', 'unknown')}. "
                               f"Seed ID: {entry.get('seed_id', 'unknown')}"),
            entry["outcome_category"],
        ),
    )
    return cursor.lastrowid


# ── Strategy 1: Target variation ──────────────────────────────────────────────

# Maps target_type → list of alternative target types for same failure pattern
TARGET_VARIATIONS = {
    "file": ["configuration", "database"],
    "configuration": ["file", "deployment"],
    "database": ["file", "api_call"],
    "message": ["email"],
    "email": ["message"],
    "deployment": ["configuration", "git_operation"],
    "git_operation": ["deployment", "file"],
    "api_call": ["database"],
    "system_command": ["file", "deployment"],
}

# Action type labels for each target type alternative
TARGET_ID_TEMPLATES = {
    "file": "variant_target_file_{seed_id}",
    "configuration": "variant_target_config_{seed_id}",
    "database": "variant_target_db_{seed_id}",
    "message": "variant_target_message_{seed_id}",
    "email": "variant_target_email_{seed_id}",
    "deployment": "variant_target_deployment_{seed_id}",
    "git_operation": "variant_target_git_{seed_id}",
    "api_call": "variant_target_api_{seed_id}",
    "system_command": "variant_target_cmd_{seed_id}",
}

# Scope adjustments per target type
TARGET_SCOPE = {
    "file": {"reversible": "true", "blast_radius": "persistent"},
    "configuration": {"reversible": "true", "blast_radius": "persistent"},
    "database": {"reversible": "partial", "blast_radius": "persistent"},
    "message": {"reversible": "false", "blast_radius": "external"},
    "email": {"reversible": "false", "blast_radius": "external"},
    "deployment": {"reversible": "partial", "blast_radius": "external"},
    "git_operation": {"reversible": "partial", "blast_radius": "external"},
    "api_call": {"reversible": "partial", "blast_radius": "external"},
    "system_command": {"reversible": "partial", "blast_radius": "session"},
}


def strategy_target_variation(entry: dict) -> list[dict]:
    """
    Same failure pattern, different target type.
    Teaches AMYGDALA that the same risky situation applies across domains.
    """
    variants = []
    template = entry["situation_template"]
    current_target_type = template.get("target_type", "file")
    alternatives = TARGET_VARIATIONS.get(current_target_type, [])

    for alt_type in alternatives:
        variant_template = copy.deepcopy(template)
        variant_template["target_type"] = alt_type
        variant_template["target_id"] = TARGET_ID_TEMPLATES.get(
            alt_type, f"variant_{alt_type}_{entry['id']}"
        ).format(seed_id=entry["id"])

        # Adjust scope for new target type
        scope_adj = TARGET_SCOPE.get(alt_type, {})
        variant_template["scope"]["reversible"] = scope_adj.get(
            "reversible", template["scope"]["reversible"]
        )
        variant_template["scope"]["blast_radius"] = scope_adj.get(
            "blast_radius", template["scope"]["blast_radius"]
        )

        variants.append({
            "title": f"[VAR-TARGET] {entry['title']} → {alt_type}",
            "description": (
                f"Target variation of: {entry['title']}. "
                f"Same failure pattern ({entry['failure_mechanism']}) applied to {alt_type} target. "
                f"Original description: {entry['description']}"
            ),
            "failure_mechanism": entry["failure_mechanism"],
            "reversibility": entry["reversibility"],
            "blast_radius": entry["blast_radius"],
            "detection_difficulty": entry["detection_difficulty"],
            "situation_template": variant_template,
            "confidence_target": entry["confidence_target"],
            "outcome_category": entry["outcome_category"],
            "strategy": "target_variation",
            "seed_id": entry["id"],
        })

    return variants


# ── Strategy 2: Severity scaling ──────────────────────────────────────────────

# Scale factors for metadata gradients
SEVERITY_SCALES = [
    # (scale_factor, label, outcome_adjustment)
    (0.1, "very_low", {"severe_negative": "mild_negative", "moderate_negative": "positive"}),
    (0.3, "low", {"severe_negative": "mild_negative"}),
    (0.5, "reduced", {"severe_negative": "moderate_negative"}),
    (2.0, "elevated", {}),  # No change — already bad
    (5.0, "extreme", {}),
]


def _adjust_outcome(outcome: str, adjustments: dict) -> str:
    return adjustments.get(outcome, outcome)


def strategy_severity_scaling(entry: dict) -> list[dict]:
    """
    Scale metadata values to create a spectrum of risk.
    Creates examples at different points on the risk gradient.
    """
    variants = []
    template = entry["situation_template"]
    meta = template.get("target_metadata", {})

    base_commits = meta.get("recent_commits", 0)
    base_effort = meta.get("effort_hours", 0.0)
    base_authors = meta.get("recent_authors", 0)

    for scale, label, outcome_adj in SEVERITY_SCALES:
        variant_template = copy.deepcopy(template)
        variant_template["target_metadata"]["recent_commits"] = max(0, int(base_commits * scale))
        variant_template["target_metadata"]["effort_hours"] = max(0.0, base_effort * scale)
        variant_template["target_metadata"]["recent_authors"] = max(0, int(base_authors * scale))

        adjusted_outcome = _adjust_outcome(entry["outcome_category"], outcome_adj)
        adjusted_confidence = 0.0 if adjusted_outcome != "positive" else 1.0

        variants.append({
            "title": f"[VAR-SEVERITY-{label.upper()}] {entry['title']}",
            "description": (
                f"Severity-scaled variant (scale={scale}x) of: {entry['title']}. "
                f"recent_commits={variant_template['target_metadata']['recent_commits']}, "
                f"effort_hours={variant_template['target_metadata']['effort_hours']:.1f}h. "
                f"Outcome adjusted to: {adjusted_outcome}."
            ),
            "failure_mechanism": entry["failure_mechanism"],
            "reversibility": entry["reversibility"],
            "blast_radius": entry["blast_radius"],
            "detection_difficulty": entry["detection_difficulty"],
            "situation_template": variant_template,
            "confidence_target": adjusted_confidence,
            "outcome_category": adjusted_outcome,
            "strategy": "severity_scaling",
            "seed_id": entry["id"],
        })

    return variants


# ── Strategy 3: Context injection ─────────────────────────────────────────────

# Context signal modifications
CONTEXT_INJECTIONS = [
    # (name, description, template_modifier, outcome_modifier)
    (
        "add_human_in_loop",
        "Added human confirmation loop",
        lambda t: {**t, "scope": {**t["scope"], "human_in_loop": True, "confirmation": "hard"}},
        lambda o: "positive" if o == "mild_negative" else ("mild_negative" if o == "moderate_negative" else o),
    ),
    (
        "remove_human_in_loop",
        "Removed human confirmation loop (automation)",
        lambda t: {**t, "scope": {**t["scope"], "human_in_loop": False, "confirmation": "none"}},
        lambda o: "mild_negative" if o == "positive" else o,
    ),
    (
        "add_frustration_signal",
        "User emotional state: frustrated",
        lambda t: {**t, "context": {**t["context"], "emotional_signals": "frustrated", "recent_corrections": 3}},
        lambda o: o,  # Frustration doesn't change outcome, but increases risk
    ),
    (
        "add_calm_signal",
        "User emotional state: calm",
        lambda t: {**t, "context": {**t["context"], "emotional_signals": "calm", "recent_corrections": 0}},
        lambda o: "positive" if o == "mild_negative" else o,
    ),
    (
        "high_topic_drift",
        "High topic drift (action far from session topic)",
        lambda t: {**t, "context": {**t["context"], "topic_drift": 0.85}},
        lambda o: "moderate_negative" if o == "positive" else o,
    ),
    (
        "low_topic_drift",
        "Low topic drift (action aligned with session)",
        lambda t: {**t, "context": {**t["context"], "topic_drift": 0.05}},
        lambda o: "positive" if o in ("mild_negative",) else o,
    ),
    (
        "deep_automation",
        "Deep automation chain (depth=4)",
        lambda t: {**t, "context": {**t["context"], "automation_depth": 4}},
        lambda o: "moderate_negative" if o == "positive" else o,
    ),
    (
        "direct_human_action",
        "Direct human action (depth=0)",
        lambda t: {**t, "context": {**t["context"], "automation_depth": 0}},
        lambda o: "positive" if o == "mild_negative" else o,
    ),
]


def strategy_context_injection(entry: dict) -> list[dict]:
    """
    Add or remove context signals to test signal sensitivity.
    Teaches AMYGDALA how each context dimension affects risk.
    """
    variants = []
    template = entry["situation_template"]

    for name, desc, modifier, outcome_mod in CONTEXT_INJECTIONS:
        try:
            variant_template = modifier(copy.deepcopy(template))
            adjusted_outcome = outcome_mod(entry["outcome_category"])
            adjusted_confidence = 1.0 if adjusted_outcome == "positive" else 0.0

            variants.append({
                "title": f"[CTX-{name.upper()[:20]}] {entry['title']}",
                "description": (
                    f"Context injection variant ({desc}) of: {entry['title']}. "
                    f"Outcome adjusted to: {adjusted_outcome}."
                ),
                "failure_mechanism": entry["failure_mechanism"],
                "reversibility": entry["reversibility"],
                "blast_radius": entry["blast_radius"],
                "detection_difficulty": entry["detection_difficulty"],
                "situation_template": variant_template,
                "confidence_target": adjusted_confidence,
                "outcome_category": adjusted_outcome,
                "strategy": "context_injection",
                "seed_id": entry["id"],
            })
        except Exception as e:
            # Skip if modifier fails
            pass

    return variants


# ── Strategy 4: Counterfactual generation ─────────────────────────────────────

def strategy_counterfactual(entry: dict) -> list[dict]:
    """
    Generate a positive counterpart from a negative example.
    Zero out all danger signals; add safety signals.
    Only applies to negative examples.
    """
    if entry["outcome_category"] not in ("severe_negative", "moderate_negative", "mild_negative"):
        return []

    template = copy.deepcopy(entry["situation_template"])

    # Zero danger signals
    template["target_metadata"]["recent_commits"] = 0
    template["target_metadata"]["effort_hours"] = 0.1
    template["target_metadata"]["recent_authors"] = 1
    template["target_metadata"]["last_human_ref"] = 0.1

    # Add safety signals
    template["context"]["recent_corrections"] = 0
    template["context"]["emotional_signals"] = "calm"
    template["context"]["topic_drift"] = 0.04
    template["context"]["automation_depth"] = 0

    # Add human oversight
    template["scope"]["human_in_loop"] = True
    template["scope"]["confirmation"] = "hard"

    # Modify target_id to distinguish from original
    template["target_id"] = template.get("target_id", "unknown") + "_cf_positive"

    return [{
        "title": f"[COUNTERFACTUAL-POSITIVE] {entry['title']}",
        "description": (
            f"Counterfactual positive counterpart of: {entry['title']}. "
            "All danger signals zeroed. Human in loop with hard confirmation. "
            "Same action type in a safe context. Used to train the boundary between "
            "dangerous and safe instances of the same action."
        ),
        "failure_mechanism": entry["failure_mechanism"],
        "reversibility": entry["reversibility"],
        "blast_radius": entry["blast_radius"],
        "detection_difficulty": entry["detection_difficulty"],
        "situation_template": template,
        "confidence_target": 1.0,
        "outcome_category": "positive",
        "strategy": "counterfactual",
        "seed_id": entry["id"],
    }]


# ── Main augmentation pipeline ────────────────────────────────────────────────

STRATEGIES = {
    "target_variation": strategy_target_variation,
    "severity_scaling": strategy_severity_scaling,
    "context_injection": strategy_context_injection,
    "counterfactual": strategy_counterfactual,
}


def augment_entry(entry: dict, strategies: list[str] = None) -> list[dict]:
    """
    Apply all (or selected) augmentation strategies to a single entry.
    Returns list of synthetic variants.
    """
    if strategies is None:
        strategies = list(STRATEGIES.keys())

    all_variants = []
    for strategy_name in strategies:
        fn = STRATEGIES.get(strategy_name)
        if fn:
            variants = fn(entry)
            all_variants.extend(variants)
    return all_variants


def run_augmentation(
    conn: sqlite3.Connection,
    strategies: list[str] = None,
    dry_run: bool = False,
    include_synthetic_seeds: bool = False,
) -> dict:
    """
    Run the full augmentation pipeline on all seed entries.

    Returns stats including multiplier achieved.
    """
    seed_entries = load_seed_entries(conn, include_synthetic=include_synthetic_seeds)
    if not seed_entries:
        print("No seed entries found. Run init_cfd.py first.")
        return {"seed_count": 0, "synthetic_count": 0, "multiplier": 0}

    print(f"\nAugmenting {len(seed_entries)} seed entries...")
    print(f"Strategies: {strategies or list(STRATEGIES.keys())}")
    print(f"Synthetic weight: {SYNTHETIC_WEIGHT}")

    seed_count = len(seed_entries)
    synthetic_count = 0
    strategy_stats = {s: 0 for s in (strategies or list(STRATEGIES.keys()))}

    for entry in seed_entries:
        variants = augment_entry(entry, strategies)
        for variant in variants:
            if dry_run:
                print(f"  [DRY RUN] {variant['strategy']:20s}: {variant['title'][:50]}")
                synthetic_count += 1
                strategy_stats[variant["strategy"]] = strategy_stats.get(variant["strategy"], 0) + 1
            else:
                inserted_id = insert_synthetic(conn, variant)
                if inserted_id:
                    synthetic_count += 1
                    strategy_stats[variant["strategy"]] = strategy_stats.get(variant["strategy"], 0) + 1

    if not dry_run:
        conn.commit()

    total_after = conn.execute("SELECT COUNT(*) FROM cfd_entries").fetchone()[0] if not dry_run else seed_count + synthetic_count
    multiplier = (seed_count + synthetic_count) / max(seed_count, 1)

    print(f"\n=== Augmentation Results ===")
    print(f"  Seed entries:      {seed_count}")
    print(f"  Synthetic created: {synthetic_count}")
    print(f"  Total entries:     {total_after}")
    print(f"  Multiplier:        {multiplier:.1f}x")
    print(f"\n  Per strategy:")
    for strategy, count in strategy_stats.items():
        print(f"    {strategy:25s}: {count}")

    return {
        "seed_count": seed_count,
        "synthetic_count": synthetic_count,
        "total": total_after,
        "multiplier": multiplier,
        "strategy_stats": strategy_stats,
    }


def check_distribution(conn: sqlite3.Connection) -> dict:
    """
    Check if distribution targets are met.

    Targets (paper §6.2):
      ~60% positive
      ~15% mild_negative
      ~15% moderate_negative
      ~10% severe_negative
    """
    rows = conn.execute("""
        SELECT outcome_category, COUNT(*) as n
        FROM cfd_entries
        WHERE outcome_category IS NOT NULL
        GROUP BY outcome_category
    """).fetchall()

    total = sum(r[1] for r in rows)
    dist = {r[0]: r[1] for r in rows}

    targets = {
        "positive": (0.50, 0.70),        # 60% ± 10%
        "mild_negative": (0.10, 0.20),    # 15% ± 5%
        "moderate_negative": (0.10, 0.20), # 15% ± 5%
        "severe_negative": (0.07, 0.15),  # 10% ± 5%
    }

    print("\n=== Distribution Check ===")
    all_ok = True
    for cat, (lo, hi) in targets.items():
        n = dist.get(cat, 0)
        pct = n / max(total, 1)
        status = "✓" if lo <= pct <= hi else "✗"
        if status == "✗":
            all_ok = False
        print(f"  {status} {cat:20s}: {n:3d} ({pct:.1%}) — target [{lo:.0%}, {hi:.0%}]")

    print(f"\n  Total: {total} entries")
    if all_ok:
        print("  ✓ Distribution targets met")
    else:
        print("  ✗ Some distribution targets missed (may need more augmentation)")

    return {"distribution": dist, "total": total, "targets_met": all_ok}


def main():
    parser = argparse.ArgumentParser(description="Augment AMYGDALA CFD with synthetic entries")
    parser.add_argument(
        "--db",
        default=str(Path(__file__).parent / "cfd.sqlite"),
        help="Path to CFD SQLite database",
    )
    parser.add_argument(
        "--strategy",
        choices=["all"] + list(STRATEGIES.keys()),
        default="all",
        help="Which augmentation strategy to apply",
    )
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Preview augmentation without writing",
    )
    parser.add_argument(
        "--check-distribution", action="store_true",
        help="Check distribution targets without augmenting",
    )
    parser.add_argument(
        "--include-synthetic-seeds", action="store_true",
        help="Also augment existing synthetic entries (careful: exponential growth)",
    )
    args = parser.parse_args()

    if not os.path.exists(args.db):
        print(f"Database not found: {args.db}")
        print("Run init_cfd.py first.")
        sys.exit(1)

    conn = get_conn(args.db)

    if args.check_distribution:
        check_distribution(conn)
        conn.close()
        return

    strategies = None if args.strategy == "all" else [args.strategy]
    stats = run_augmentation(
        conn,
        strategies=strategies,
        dry_run=args.dry_run,
        include_synthetic_seeds=args.include_synthetic_seeds,
    )

    if not args.dry_run:
        check_distribution(conn)

    conn.close()

    expected_multiplier = len(STRATEGIES) * 2  # Rough estimate
    actual = stats.get("multiplier", 0)
    if actual >= 2.0:
        print(f"\n✓ Augmentation multiplier: {actual:.1f}x (≥2.0x)")
    else:
        print(f"\n✗ Augmentation multiplier too low: {actual:.1f}x (<2.0x)")


if __name__ == "__main__":
    main()
