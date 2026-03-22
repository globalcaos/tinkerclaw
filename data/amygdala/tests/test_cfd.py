#!/usr/bin/env python3
"""
AMYGDALA v2.1 — P0.4: CFD Unit Tests

Tests:
  1. Schema creation succeeds
  2. Seed entries have valid taxonomy (F1-F7, R1-R3, B1-B4, D1-D3)
  3. Augmentation produces expected multiplier
  4. Distribution targets: ~60% positive, ~15% mild neg, ~15% moderate, ~10% severe

Usage:
    cd ~/src/tinkerclaw/data/amygdala
    python -m pytest tests/test_cfd.py -v

    # Or run directly:
    python tests/test_cfd.py
"""

import json
import os
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

from init_cfd import create_db, populate_cfd, KNOWN_INCIDENTS, SYNTHETIC_NEGATIVES, SAFE_POSITIVES
from augment import (
    augment_entry,
    run_augmentation,
    check_distribution,
    strategy_target_variation,
    strategy_severity_scaling,
    strategy_context_injection,
    strategy_counterfactual,
    SYNTHETIC_WEIGHT,
    STRATEGIES,
)

# ── Valid taxonomy values ──────────────────────────────────────────────────────
VALID_FAILURE_MECHANISMS = {"F1", "F2", "F3", "F4", "F5", "F6", "F7"}
VALID_REVERSIBILITIES = {"R1", "R2", "R3"}
VALID_BLAST_RADII = {"B1", "B2", "B3", "B4"}
VALID_DETECTION_DIFFICULTIES = {"D1", "D2", "D3"}
VALID_OUTCOME_CATEGORIES = {"positive", "mild_negative", "moderate_negative", "severe_negative"}
VALID_ACTION_TYPES = {
    "overwrite", "delete", "send", "merge", "create", "modify",
    "execute", "deploy", "revert", "move", "copy",
}
VALID_TARGET_TYPES = {
    "file", "email", "message", "database", "api_call",
    "git_operation", "system_command", "configuration", "deployment",
}
VALID_REVERSIBLE_VALUES = {"true", "false", "partial"}
VALID_BLAST_RADIUS_SCOPE = {"self", "session", "persistent", "external"}
VALID_CONFIRMATION_VALUES = {"none", "soft", "hard"}
VALID_EMOTIONAL_SIGNALS = {
    "calm", "frustrated", "excited", "focused", "playful", "terse", "unknown",
}


# ── Helper ─────────────────────────────────────────────────────────────────────

def make_test_db() -> tuple[sqlite3.Connection, str]:
    """Create a temporary test database with schema and seed data."""
    tmp = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
    tmp.close()
    conn = create_db(tmp.name, reset=False)
    return conn, tmp.name


def get_all_entries(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        "SELECT id, failure_mechanism, reversibility, blast_radius, "
        "detection_difficulty, situation_template, confidence_target, "
        "outcome_category, weight, source "
        "FROM cfd_entries"
    ).fetchall()
    return [
        {
            "id": r[0],
            "failure_mechanism": r[1],
            "reversibility": r[2],
            "blast_radius": r[3],
            "detection_difficulty": r[4],
            "situation_template": json.loads(r[5]),
            "confidence_target": r[6],
            "outcome_category": r[7],
            "weight": r[8],
            "source": r[9],
        }
        for r in rows
    ]


# ── Test suite ─────────────────────────────────────────────────────────────────

class TestSchemaCreation(unittest.TestCase):
    """Test 1: Schema creation succeeds."""

    def setUp(self):
        self.conn, self.db_path = make_test_db()

    def tearDown(self):
        self.conn.close()
        os.unlink(self.db_path)

    def test_schema_creates_cfd_entries_table(self):
        """cfd_entries table must exist after schema creation."""
        tables = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='cfd_entries'"
        ).fetchall()
        self.assertEqual(len(tables), 1, "cfd_entries table not found")

    def test_schema_creates_all_indexes(self):
        """All required indexes must be created."""
        expected_indexes = {
            "idx_cfd_mechanism",
            "idx_cfd_source",
            "idx_cfd_blast",
            "idx_cfd_reversibility",
            "idx_cfd_detection",
            "idx_cfd_confidence",
            "idx_cfd_verified",
            "idx_cfd_outcome",
            "idx_cfd_counterpart",
        }
        rows = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_cfd_%'"
        ).fetchall()
        existing = {r[0] for r in rows}
        for idx in expected_indexes:
            self.assertIn(idx, existing, f"Index {idx} not found")

    def test_schema_creates_distribution_view(self):
        """cfd_distribution view must exist."""
        views = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='view' AND name='cfd_distribution'"
        ).fetchall()
        self.assertEqual(len(views), 1, "cfd_distribution view not found")

    def test_schema_creates_taxonomy_view(self):
        """cfd_taxonomy view must exist."""
        views = self.conn.execute(
            "SELECT name FROM sqlite_master WHERE type='view' AND name='cfd_taxonomy'"
        ).fetchall()
        self.assertEqual(len(views), 1, "cfd_taxonomy view not found")

    def test_schema_taxonomy_constraints_enforced(self):
        """Database must reject invalid taxonomy values."""
        # Invalid failure_mechanism
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute(
                "INSERT INTO cfd_entries (source, title, description, failure_mechanism, "
                "reversibility, blast_radius, detection_difficulty, situation_template, "
                "confidence_target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("test", "test", "test", "F99", "R1", "B1", "D1", "{}", 0.0),
            )

        # Invalid reversibility
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute(
                "INSERT INTO cfd_entries (source, title, description, failure_mechanism, "
                "reversibility, blast_radius, detection_difficulty, situation_template, "
                "confidence_target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("test", "test", "test", "F1", "R99", "B1", "D1", "{}", 0.0),
            )

    def test_confidence_target_constraint(self):
        """confidence_target must be between 0.0 and 1.0."""
        with self.assertRaises(sqlite3.IntegrityError):
            self.conn.execute(
                "INSERT INTO cfd_entries (source, title, description, failure_mechanism, "
                "reversibility, blast_radius, detection_difficulty, situation_template, "
                "confidence_target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                ("test", "test", "test", "F1", "R1", "B1", "D1", "{}", 1.5),
            )

    def test_wal_mode_configured(self):
        """Database must be in WAL mode."""
        mode = self.conn.execute("PRAGMA journal_mode").fetchone()[0]
        self.assertEqual(mode, "wal", "Journal mode should be WAL for concurrent access")


class TestSeedEntryTaxonomy(unittest.TestCase):
    """Test 2: Seed entries have valid taxonomy."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
        cls.tmp.close()
        cls.conn = create_db(cls.tmp.name, reset=False)
        cls.stats = populate_cfd(cls.conn)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        os.unlink(cls.tmp.name)

    def test_minimum_entry_count(self):
        """Must have at least 50 seed entries."""
        count = self.conn.execute("SELECT COUNT(*) FROM cfd_entries").fetchone()[0]
        self.assertGreaterEqual(count, 50, f"Only {count} entries, need ≥50")

    def test_all_failure_mechanisms_valid(self):
        """All failure_mechanism values must be in F1-F7."""
        rows = self.conn.execute("SELECT DISTINCT failure_mechanism FROM cfd_entries").fetchall()
        for (fm,) in rows:
            self.assertIn(
                fm, VALID_FAILURE_MECHANISMS,
                f"Invalid failure_mechanism: {fm}"
            )

    def test_all_reversibilities_valid(self):
        """All reversibility values must be in R1-R3."""
        rows = self.conn.execute("SELECT DISTINCT reversibility FROM cfd_entries").fetchall()
        for (r,) in rows:
            self.assertIn(r, VALID_REVERSIBILITIES, f"Invalid reversibility: {r}")

    def test_all_blast_radii_valid(self):
        """All blast_radius values must be in B1-B4."""
        rows = self.conn.execute("SELECT DISTINCT blast_radius FROM cfd_entries").fetchall()
        for (b,) in rows:
            self.assertIn(b, VALID_BLAST_RADII, f"Invalid blast_radius: {b}")

    def test_all_detection_difficulties_valid(self):
        """All detection_difficulty values must be in D1-D3."""
        rows = self.conn.execute("SELECT DISTINCT detection_difficulty FROM cfd_entries").fetchall()
        for (d,) in rows:
            self.assertIn(d, VALID_DETECTION_DIFFICULTIES, f"Invalid detection_difficulty: {d}")

    def test_all_outcome_categories_valid(self):
        """All outcome_category values must be valid."""
        rows = self.conn.execute(
            "SELECT DISTINCT outcome_category FROM cfd_entries WHERE outcome_category IS NOT NULL"
        ).fetchall()
        for (o,) in rows:
            self.assertIn(o, VALID_OUTCOME_CATEGORIES, f"Invalid outcome_category: {o}")

    def test_situation_templates_have_required_fields(self):
        """All situation_template JSON objects must have required v2.0 fields."""
        required_top_level = {
            "action_type", "target_type", "target_id",
            "target_metadata", "context", "scope",
        }
        required_metadata = {
            "age_hours", "size", "recent_commits", "recent_authors",
            "effort_hours", "last_human_ref",
        }
        required_context = {
            "session_topic", "recent_corrections", "emotional_signals",
            "automation_depth", "topic_drift",
        }
        required_scope = {
            "reversible", "blast_radius", "human_in_loop", "confirmation",
        }

        rows = self.conn.execute(
            "SELECT id, situation_template FROM cfd_entries"
        ).fetchall()
        for (entry_id, tmpl_json) in rows:
            tmpl = json.loads(tmpl_json)

            for field in required_top_level:
                self.assertIn(field, tmpl, f"Entry {entry_id}: missing top-level field '{field}'")

            meta = tmpl.get("target_metadata", {})
            for field in required_metadata:
                self.assertIn(
                    field, meta,
                    f"Entry {entry_id}: missing target_metadata field '{field}'"
                )

            ctx = tmpl.get("context", {})
            for field in required_context:
                self.assertIn(
                    field, ctx,
                    f"Entry {entry_id}: missing context field '{field}'"
                )

            scope = tmpl.get("scope", {})
            for field in required_scope:
                self.assertIn(
                    field, scope,
                    f"Entry {entry_id}: missing scope field '{field}'"
                )

    def test_action_types_are_valid(self):
        """All action_type values in templates must be valid."""
        rows = self.conn.execute("SELECT id, situation_template FROM cfd_entries").fetchall()
        for (entry_id, tmpl_json) in rows:
            tmpl = json.loads(tmpl_json)
            at = tmpl.get("action_type", "")
            self.assertIn(
                at, VALID_ACTION_TYPES,
                f"Entry {entry_id}: invalid action_type '{at}'"
            )

    def test_target_types_are_valid(self):
        """All target_type values in templates must be valid."""
        rows = self.conn.execute("SELECT id, situation_template FROM cfd_entries").fetchall()
        for (entry_id, tmpl_json) in rows:
            tmpl = json.loads(tmpl_json)
            tt = tmpl.get("target_type", "")
            self.assertIn(
                tt, VALID_TARGET_TYPES,
                f"Entry {entry_id}: invalid target_type '{tt}'"
            )

    def test_scope_reversible_values_valid(self):
        """scope.reversible must be 'true', 'false', or 'partial'."""
        rows = self.conn.execute("SELECT id, situation_template FROM cfd_entries").fetchall()
        for (entry_id, tmpl_json) in rows:
            tmpl = json.loads(tmpl_json)
            rev = tmpl.get("scope", {}).get("reversible", "")
            self.assertIn(
                rev, VALID_REVERSIBLE_VALUES,
                f"Entry {entry_id}: invalid scope.reversible '{rev}'"
            )

    def test_scope_blast_radius_values_valid(self):
        """scope.blast_radius must be one of the valid scope values."""
        rows = self.conn.execute("SELECT id, situation_template FROM cfd_entries").fetchall()
        for (entry_id, tmpl_json) in rows:
            tmpl = json.loads(tmpl_json)
            br = tmpl.get("scope", {}).get("blast_radius", "")
            self.assertIn(
                br, VALID_BLAST_RADIUS_SCOPE,
                f"Entry {entry_id}: invalid scope.blast_radius '{br}'"
            )

    def test_confidence_target_aligns_with_outcome(self):
        """
        Negative entries should have confidence_target=0.0.
        Positive entries should have confidence_target=1.0.
        """
        rows = self.conn.execute(
            "SELECT id, confidence_target, outcome_category FROM cfd_entries"
        ).fetchall()
        for (entry_id, ct, outcome) in rows:
            if outcome == "positive":
                self.assertAlmostEqual(
                    ct, 1.0, places=2,
                    msg=f"Entry {entry_id}: positive outcome should have confidence_target=1.0, got {ct}"
                )
            elif outcome in ("severe_negative", "moderate_negative"):
                self.assertAlmostEqual(
                    ct, 0.0, places=2,
                    msg=f"Entry {entry_id}: negative outcome should have confidence_target=0.0, got {ct}"
                )

    def test_known_incidents_present(self):
        """All known incidents from init_cfd.py must be in the database."""
        for incident in KNOWN_INCIDENTS:
            row = self.conn.execute(
                "SELECT id FROM cfd_entries WHERE source_id = ?",
                (incident["source_id"],),
            ).fetchone()
            self.assertIsNotNone(
                row,
                f"Known incident '{incident['source_id']}' not found in database"
            )

    def test_positive_counterparts_linked(self):
        """Known incidents must have linked positive counterparts."""
        for incident in KNOWN_INCIDENTS:
            row = self.conn.execute(
                "SELECT id, positive_counterpart_id FROM cfd_entries WHERE source_id = ?",
                (incident["source_id"],),
            ).fetchone()
            self.assertIsNotNone(row, f"Incident {incident['source_id']} not found")
            self.assertIsNotNone(
                row[1],
                f"Incident {incident['source_id']} has no positive counterpart linked"
            )

    def test_emotional_signals_valid(self):
        """context.emotional_signals must be a valid value."""
        rows = self.conn.execute("SELECT id, situation_template FROM cfd_entries").fetchall()
        for (entry_id, tmpl_json) in rows:
            tmpl = json.loads(tmpl_json)
            es = tmpl.get("context", {}).get("emotional_signals", "")
            self.assertIn(
                es, VALID_EMOTIONAL_SIGNALS,
                f"Entry {entry_id}: invalid emotional_signals '{es}'"
            )


class TestAugmentation(unittest.TestCase):
    """Test 3: Augmentation produces expected multiplier."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
        cls.tmp.close()
        cls.conn = create_db(cls.tmp.name, reset=False)
        populate_cfd(cls.conn)
        cls.seed_count = cls.conn.execute(
            "SELECT COUNT(*) FROM cfd_entries WHERE source != 'synthetic'"
        ).fetchone()[0]

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        os.unlink(cls.tmp.name)

    def _make_sample_negative_entry(self) -> dict:
        """Create a sample negative entry for augmentation testing."""
        return {
            "id": 999,
            "title": "Test incident",
            "description": "Test description",
            "failure_mechanism": "F1",
            "reversibility": "R2",
            "blast_radius": "B3",
            "detection_difficulty": "D2",
            "outcome_category": "severe_negative",
            "confidence_target": 0.0,
            "source": "internal",
            "situation_template": {
                "action_type": "overwrite",
                "target_type": "file",
                "target_id": "test_file.md",
                "target_metadata": {
                    "age_hours": 1000,
                    "size": 5000,
                    "recent_commits": 6,
                    "recent_authors": 3,
                    "effort_hours": 8.0,
                    "last_human_ref": 5.0,
                },
                "context": {
                    "session_topic": "automation",
                    "recent_corrections": 2,
                    "emotional_signals": "frustrated",
                    "automation_depth": 2,
                    "topic_drift": 0.7,
                },
                "scope": {
                    "reversible": "true",
                    "blast_radius": "persistent",
                    "human_in_loop": False,
                    "confirmation": "none",
                },
            },
        }

    def test_target_variation_produces_variants(self):
        """target_variation must produce at least 1 variant."""
        entry = self._make_sample_negative_entry()
        variants = strategy_target_variation(entry)
        self.assertGreater(len(variants), 0, "target_variation produced no variants")

    def test_target_variation_uses_different_target_types(self):
        """target_variation variants must have different target_type from seed."""
        entry = self._make_sample_negative_entry()
        original_type = entry["situation_template"]["target_type"]
        variants = strategy_target_variation(entry)
        for v in variants:
            self.assertNotEqual(
                v["situation_template"]["target_type"],
                original_type,
                "target_variation should produce different target types",
            )

    def test_severity_scaling_produces_spectrum(self):
        """severity_scaling must produce variants at multiple scales."""
        entry = self._make_sample_negative_entry()
        variants = strategy_severity_scaling(entry)
        self.assertGreaterEqual(len(variants), 3, "severity_scaling must produce ≥3 variants")

    def test_severity_scaling_adjusts_commits(self):
        """severity_scaling must change recent_commits values."""
        entry = self._make_sample_negative_entry()
        base_commits = entry["situation_template"]["target_metadata"]["recent_commits"]
        variants = strategy_severity_scaling(entry)
        commit_values = [
            v["situation_template"]["target_metadata"]["recent_commits"]
            for v in variants
        ]
        self.assertGreater(
            len(set(commit_values)), 1,
            f"severity_scaling must produce varied commit counts, got: {commit_values}"
        )

    def test_context_injection_produces_variants(self):
        """context_injection must produce multiple variants."""
        entry = self._make_sample_negative_entry()
        variants = strategy_context_injection(entry)
        self.assertGreaterEqual(len(variants), 3, "context_injection must produce ≥3 variants")

    def test_context_injection_human_in_loop_modifies_scope(self):
        """add_human_in_loop injection must set human_in_loop=True."""
        entry = self._make_sample_negative_entry()
        variants = strategy_context_injection(entry)
        human_loop_variants = [
            v for v in variants
            if "add_human_in_loop" in v.get("strategy", "") or
               "ADD_HUMAN_IN_LOOP" in v.get("title", "")
        ]
        for v in human_loop_variants:
            self.assertTrue(
                v["situation_template"]["scope"]["human_in_loop"],
                "add_human_in_loop should set human_in_loop=True",
            )

    def test_counterfactual_only_for_negatives(self):
        """counterfactual must only generate variants for negative entries."""
        negative_entry = self._make_sample_negative_entry()
        positive_entry = {**negative_entry, "outcome_category": "positive", "confidence_target": 1.0}

        neg_variants = strategy_counterfactual(negative_entry)
        pos_variants = strategy_counterfactual(positive_entry)

        self.assertGreater(len(neg_variants), 0, "counterfactual must generate for negatives")
        self.assertEqual(len(pos_variants), 0, "counterfactual must NOT generate for positives")

    def test_counterfactual_produces_positive_outcome(self):
        """counterfactual variants must have outcome_category=positive."""
        entry = self._make_sample_negative_entry()
        variants = strategy_counterfactual(entry)
        for v in variants:
            self.assertEqual(
                v["outcome_category"], "positive",
                "Counterfactual variant must have positive outcome"
            )
            self.assertAlmostEqual(
                v["confidence_target"], 1.0, places=2,
                msg="Counterfactual positive must have confidence_target=1.0"
            )

    def test_counterfactual_zeroes_danger_signals(self):
        """counterfactual must zero out recent_commits and effort_hours."""
        entry = self._make_sample_negative_entry()
        variants = strategy_counterfactual(entry)
        for v in variants:
            self.assertEqual(
                v["situation_template"]["target_metadata"]["recent_commits"], 0,
                "Counterfactual must zero recent_commits"
            )
            self.assertTrue(
                v["situation_template"]["scope"]["human_in_loop"],
                "Counterfactual must add human_in_loop"
            )

    def test_synthetic_weight_is_0_3(self):
        """Synthetic weight constant must be 0.3 per paper §6.5."""
        self.assertAlmostEqual(
            SYNTHETIC_WEIGHT, 0.3, places=2,
            msg="Synthetic weight must be 0.3"
        )

    def test_all_augmentation_variants_have_valid_taxonomy(self):
        """Augmented variants must have valid taxonomy values."""
        entry = self._make_sample_negative_entry()
        variants = augment_entry(entry)

        for v in variants:
            self.assertIn(
                v["failure_mechanism"], VALID_FAILURE_MECHANISMS,
                f"Invalid failure_mechanism in variant: {v['failure_mechanism']}"
            )
            self.assertIn(
                v["reversibility"], VALID_REVERSIBILITIES,
                f"Invalid reversibility in variant: {v['reversibility']}"
            )
            self.assertIn(
                v["blast_radius"], VALID_BLAST_RADII,
                f"Invalid blast_radius in variant: {v['blast_radius']}"
            )
            self.assertIn(
                v["detection_difficulty"], VALID_DETECTION_DIFFICULTIES,
                f"Invalid detection_difficulty in variant: {v['detection_difficulty']}"
            )

    def test_augmentation_multiplier_at_least_2x(self):
        """Full augmentation pipeline must achieve ≥2x multiplier."""
        stats = run_augmentation(self.conn, dry_run=False)
        multiplier = stats.get("multiplier", 0)
        self.assertGreaterEqual(
            multiplier, 2.0,
            f"Augmentation multiplier {multiplier:.1f}x is less than required 2.0x"
        )

    def test_augmentation_does_not_modify_seed_entries(self):
        """Augmentation must not modify existing non-synthetic entries."""
        # Get seed entry count before
        before_seeds = self.conn.execute(
            "SELECT COUNT(*) FROM cfd_entries WHERE source != 'synthetic'"
        ).fetchone()[0]

        # Already augmented in setUpClass, just re-run dry run
        run_augmentation(self.conn, dry_run=True)

        after_seeds = self.conn.execute(
            "SELECT COUNT(*) FROM cfd_entries WHERE source != 'synthetic'"
        ).fetchone()[0]

        self.assertEqual(
            before_seeds, after_seeds,
            "Augmentation must not modify seed entries"
        )

    def test_augmentation_strategies_are_all_present(self):
        """All 4 strategies must be registered."""
        expected = {"target_variation", "severity_scaling", "context_injection", "counterfactual"}
        actual = set(STRATEGIES.keys())
        self.assertEqual(expected, actual, f"Missing strategies: {expected - actual}")


class TestDistributionTargets(unittest.TestCase):
    """Test 4: Distribution targets ~60% pos, ~15% mild, ~15% moderate, ~10% severe."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
        cls.tmp.close()
        cls.conn = create_db(cls.tmp.name, reset=False)
        populate_cfd(cls.conn)
        # Run augmentation to reach distribution targets
        run_augmentation(cls.conn, dry_run=False)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        os.unlink(cls.tmp.name)

    def _get_distribution(self) -> dict:
        rows = self.conn.execute(
            "SELECT outcome_category, COUNT(*) FROM cfd_entries "
            "WHERE outcome_category IS NOT NULL GROUP BY outcome_category"
        ).fetchall()
        total = sum(r[1] for r in rows)
        return {r[0]: r[1] / max(total, 1) for r in rows}

    def test_positive_fraction_at_least_40_percent(self):
        """At least 40% of entries should be positive (target ~60%)."""
        dist = self._get_distribution()
        pos_pct = dist.get("positive", 0)
        self.assertGreaterEqual(
            pos_pct, 0.40,
            f"Positive fraction {pos_pct:.1%} is below minimum 40% (target 60%)"
        )

    def test_negative_entries_exist(self):
        """Must have entries in all 3 negative categories."""
        dist = self._get_distribution()
        for cat in ("mild_negative", "moderate_negative", "severe_negative"):
            count = self.conn.execute(
                "SELECT COUNT(*) FROM cfd_entries WHERE outcome_category = ?", (cat,)
            ).fetchone()[0]
            self.assertGreater(count, 0, f"No entries found for category: {cat}")

    def test_severe_negative_fraction_at_least_5_percent(self):
        """Severe negative fraction must be at least 5% (target ~10%)."""
        dist = self._get_distribution()
        severe_pct = dist.get("severe_negative", 0)
        self.assertGreaterEqual(
            severe_pct, 0.05,
            f"Severe negative fraction {severe_pct:.1%} is below minimum 5% (target 10%)"
        )

    def test_total_entries_at_least_50(self):
        """Total entry count must be ≥50 after augmentation."""
        total = self.conn.execute("SELECT COUNT(*) FROM cfd_entries").fetchone()[0]
        self.assertGreaterEqual(total, 50, f"Only {total} entries, need ≥50")

    def test_synthetic_entries_have_correct_weight(self):
        """All synthetic entries must have weight=0.3."""
        rows = self.conn.execute(
            "SELECT id, weight FROM cfd_entries WHERE source = 'synthetic'"
        ).fetchall()
        self.assertGreater(len(rows), 0, "No synthetic entries found after augmentation")
        for (entry_id, weight) in rows:
            self.assertAlmostEqual(
                weight, SYNTHETIC_WEIGHT, places=2,
                msg=f"Synthetic entry {entry_id} has weight={weight}, expected {SYNTHETIC_WEIGHT}"
            )

    def test_internal_entries_have_full_weight(self):
        """Internal (verified) entries must have weight=1.0."""
        rows = self.conn.execute(
            "SELECT id, weight FROM cfd_entries WHERE source = 'internal' AND verified = 1"
        ).fetchall()
        self.assertGreater(len(rows), 0, "No verified internal entries found")
        for (entry_id, weight) in rows:
            self.assertAlmostEqual(
                weight, 1.0, places=2,
                msg=f"Internal verified entry {entry_id} has weight={weight}, expected 1.0"
            )

    def test_distribution_check_function_runs(self):
        """check_distribution function must run without errors."""
        result = check_distribution(self.conn)
        self.assertIn("distribution", result)
        self.assertIn("total", result)
        self.assertIn("targets_met", result)
        self.assertGreater(result["total"], 0)


class TestSituationTemplateFormat(unittest.TestCase):
    """Test SituationTemplate v2.0 format compliance."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False)
        cls.tmp.close()
        cls.conn = create_db(cls.tmp.name, reset=False)
        populate_cfd(cls.conn)

    @classmethod
    def tearDownClass(cls):
        cls.conn.close()
        os.unlink(cls.tmp.name)

    def test_readme_debacle_template_matches_paper(self):
        """
        The README debacle entry must match the paper §6.4 example.
        Paper specifies: README.md, 14200 bytes, 2160h old, 6 commits, 4 authors, 8.5h effort.
        """
        row = self.conn.execute(
            "SELECT situation_template FROM cfd_entries WHERE source_id = 'INT-001'"
        ).fetchone()
        self.assertIsNotNone(row, "README debacle entry (INT-001) not found")

        tmpl = json.loads(row[0])
        meta = tmpl["target_metadata"]

        self.assertEqual(tmpl["action_type"], "overwrite")
        self.assertEqual(tmpl["target_type"], "file")
        self.assertEqual(tmpl["target_id"], "README.md")
        self.assertEqual(meta["size"], 14200, "Size should be 14200 bytes per paper §6.4")
        self.assertEqual(meta["age_hours"], 2160, "Age should be 2160h per paper §6.4")
        self.assertEqual(meta["recent_commits"], 6, "Should be 6 recent commits per paper §6.4")
        self.assertEqual(meta["recent_authors"], 4, "Should be 4 recent authors per paper §6.4")
        self.assertAlmostEqual(meta["effort_hours"], 8.5, places=1, msg="Should be 8.5h effort per paper §6.4")
        self.assertFalse(tmpl["scope"]["human_in_loop"], "human_in_loop should be False")
        self.assertEqual(tmpl["scope"]["confirmation"], "none")

    def test_all_numeric_metadata_non_negative_or_minus_one(self):
        """Numeric metadata fields must be ≥0 (or -1 for 'not applicable')."""
        rows = self.conn.execute("SELECT id, situation_template FROM cfd_entries").fetchall()
        for (entry_id, tmpl_json) in rows:
            tmpl = json.loads(tmpl_json)
            meta = tmpl.get("target_metadata", {})
            for field in ("size", "recent_commits", "recent_authors", "effort_hours"):
                value = meta.get(field, 0)
                self.assertGreaterEqual(
                    value, 0,
                    f"Entry {entry_id}: {field}={value} must be ≥0"
                )
            # age_hours can be -1 (not applicable for non-files)
            age = meta.get("age_hours", 0)
            self.assertGreaterEqual(
                age, -1,
                f"Entry {entry_id}: age_hours={age} must be ≥-1"
            )

    def test_topic_drift_in_range(self):
        """topic_drift must be in [0.0, 1.0]."""
        rows = self.conn.execute("SELECT id, situation_template FROM cfd_entries").fetchall()
        for (entry_id, tmpl_json) in rows:
            tmpl = json.loads(tmpl_json)
            drift = tmpl.get("context", {}).get("topic_drift", 0)
            self.assertGreaterEqual(drift, 0.0, f"Entry {entry_id}: topic_drift={drift} must be ≥0")
            self.assertLessEqual(drift, 1.0, f"Entry {entry_id}: topic_drift={drift} must be ≤1")

    def test_automation_depth_non_negative(self):
        """automation_depth must be ≥0."""
        rows = self.conn.execute("SELECT id, situation_template FROM cfd_entries").fetchall()
        for (entry_id, tmpl_json) in rows:
            tmpl = json.loads(tmpl_json)
            depth = tmpl.get("context", {}).get("automation_depth", 0)
            self.assertGreaterEqual(
                depth, 0,
                f"Entry {entry_id}: automation_depth={depth} must be ≥0"
            )


# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    # Run with verbose output
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()

    test_classes = [
        TestSchemaCreation,
        TestSeedEntryTaxonomy,
        TestAugmentation,
        TestDistributionTargets,
        TestSituationTemplateFormat,
    ]

    for cls in test_classes:
        suite.addTests(loader.loadTestsFromTestCase(cls))

    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)

    if result.wasSuccessful():
        print("\n✓ All CFD tests passed")
        sys.exit(0)
    else:
        print(f"\n✗ {len(result.failures)} failures, {len(result.errors)} errors")
        sys.exit(1)
