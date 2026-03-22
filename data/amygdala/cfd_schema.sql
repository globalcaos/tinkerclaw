-- ============================================================
-- Catastrophic Failure Database (CFD) Schema
-- AMYGDALA v2.1 — P0.4
-- Stored in: data/amygdala/cfd.sqlite
-- SituationTemplate v2.0 format
-- ============================================================

-- Taxonomy dimensions (from paper §6.3):
--   F1-F7: Failure Mechanism
--     F1 = Stale context (acted on outdated information)
--     F2 = Scope creep (exceeded intended boundaries)
--     F3 = Social boundary violation (messaged wrong person/group)
--     F4 = Irreversible cascade (chain of irreversible side effects)
--     F5 = Authority confusion (assumed permissions not granted)
--     F6 = Temporal misread (wrong time/urgency assessment)
--     F7 = Duplicate execution (ran same destructive action twice)
--
--   R1-R3: Reversibility
--     R1 = Recoverable (git/trash/undo available)
--     R2 = Partially recoverable (some loss, some recovery)
--     R3 = Irreversible (data/relationship permanently altered)
--
--   B1-B4: Blast Radius
--     B1 = Self (only affects agent state)
--     B2 = Session (affects current session only)
--     B3 = Persistent (affects files/databases persistently)
--     B4 = External (affects other people/systems)
--
--   D1-D3: Detection Difficulty
--     D1 = Immediate (obvious within seconds)
--     D2 = Delayed (discovered within hours/days)
--     D3 = Latent (may not be detected for weeks)

CREATE TABLE IF NOT EXISTS cfd_entries (
    -- Identity
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    source                TEXT NOT NULL,                    -- 'internal' | 'aiid' | 'vectara' | 'synthetic' | 'manual'
    source_id             TEXT,                             -- External ID (e.g. AIID incident number)
    title                 TEXT NOT NULL,                    -- Short descriptive title
    description           TEXT NOT NULL,                    -- Full incident description

    -- Timing
    date_occurred         DATE,                             -- YYYY-MM-DD when incident happened
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- Taxonomy (4 dimensions)
    failure_mechanism     TEXT NOT NULL CHECK(failure_mechanism IN ('F1','F2','F3','F4','F5','F6','F7')),
    reversibility         TEXT NOT NULL CHECK(reversibility IN ('R1','R2','R3')),
    blast_radius          TEXT NOT NULL CHECK(blast_radius IN ('B1','B2','B3','B4')),
    detection_difficulty  TEXT NOT NULL CHECK(detection_difficulty IN ('D1','D2','D3')),

    -- SituationTemplate v2.0 (JSON)
    -- Must include: action_type, target_type, target_id,
    --               target_metadata (age_hours, size, recent_commits, recent_authors, effort_hours, last_human_ref),
    --               context (session_topic, recent_corrections, emotional_signals, automation_depth, topic_drift),
    --               scope (reversible, blast_radius, human_in_loop, confirmation)
    situation_template    TEXT NOT NULL,

    -- Embedding (512d float32 blob, computed after creation)
    situation_embedding   BLOB,

    -- Training signal
    -- For negative examples (actual failures): confidence_target = 0.0
    -- For positive counterparts: confidence_target = 1.0
    -- For ambiguous cases: confidence_target = 0.5
    confidence_target     REAL NOT NULL DEFAULT 0.0 CHECK(confidence_target BETWEEN 0.0 AND 1.0),

    -- Training weight (synthetic examples get 0.3, verified incidents get 1.0, public sources get 0.5)
    weight                REAL NOT NULL DEFAULT 1.0 CHECK(weight BETWEEN 0.0 AND 1.0),

    -- Positive counterpart (ID of the safe version of this incident)
    positive_counterpart_id INTEGER REFERENCES cfd_entries(id),

    -- Curation
    verified              BOOLEAN DEFAULT FALSE,            -- Manually reviewed and confirmed
    notes                 TEXT,                             -- Curator notes

    -- Outcome category (for distribution tracking)
    outcome_category      TEXT CHECK(outcome_category IN ('positive', 'mild_negative', 'moderate_negative', 'severe_negative'))
);

-- Indexes for training queries
CREATE INDEX IF NOT EXISTS idx_cfd_mechanism ON cfd_entries(failure_mechanism);
CREATE INDEX IF NOT EXISTS idx_cfd_source ON cfd_entries(source);
CREATE INDEX IF NOT EXISTS idx_cfd_blast ON cfd_entries(blast_radius);
CREATE INDEX IF NOT EXISTS idx_cfd_reversibility ON cfd_entries(reversibility);
CREATE INDEX IF NOT EXISTS idx_cfd_detection ON cfd_entries(detection_difficulty);
CREATE INDEX IF NOT EXISTS idx_cfd_confidence ON cfd_entries(confidence_target);
CREATE INDEX IF NOT EXISTS idx_cfd_verified ON cfd_entries(verified);
CREATE INDEX IF NOT EXISTS idx_cfd_outcome ON cfd_entries(outcome_category);
CREATE INDEX IF NOT EXISTS idx_cfd_counterpart ON cfd_entries(positive_counterpart_id);

-- Distribution view (for monitoring)
CREATE VIEW IF NOT EXISTS cfd_distribution AS
SELECT
    outcome_category,
    source,
    COUNT(*) as count,
    ROUND(100.0 * COUNT(*) / SUM(COUNT(*)) OVER (), 1) as pct,
    AVG(weight) as avg_weight,
    SUM(CASE WHEN verified = 1 THEN 1 ELSE 0 END) as verified_count
FROM cfd_entries
GROUP BY outcome_category, source
ORDER BY outcome_category, source;

-- Taxonomy distribution view
CREATE VIEW IF NOT EXISTS cfd_taxonomy AS
SELECT
    failure_mechanism,
    reversibility,
    blast_radius,
    detection_difficulty,
    COUNT(*) as count
FROM cfd_entries
GROUP BY failure_mechanism, reversibility, blast_radius, detection_difficulty
ORDER BY count DESC;
