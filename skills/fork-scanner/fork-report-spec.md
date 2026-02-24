# Fork Sync Report Specification

**Format:** Daily newspaper-style intelligence briefing
**Audience:** Oscar (busy executive scan)
**Goal:** Keep fork updated, stay ahead of ecosystem

---

## Report Structure

### 🗞️ FRONT PAGE

#### Masthead
```
┌─────────────────────────────────────────────────────────┐
│  FORK SYNC DAILY                          [DATE]        │
│  Your OpenClaw Intelligence Briefing      Issue #XXX    │
└─────────────────────────────────────────────────────────┘
```

#### Lead Story (Most Important Finding)
```
┌─────────────────────────────────────────────────────────┐
│  HEADLINE: [Most significant discovery]                 │
│  ─────────────────────────────────────────────────────  │
│  SUBHEAD: [One-line explanation of impact]              │
│                                                         │
│  [Opening salient statement - the hook]                 │
│                                                         │
│  **Key Point 1** — Brief explanation                    │
│  **Key Point 2** — Brief explanation                    │
│                                                         │
│  [Implementation difficulty: Easy/Medium/Hard]          │
│  [Estimated effort: X hours/days]                       │
└─────────────────────────────────────────────────────────┘
```

#### Secondary Stories (2-3 other findings)
- Same format, smaller
- Each with headline + subhead + key points + effort estimate

---

### 📊 STATUS DASHBOARD (Grafana-style)

**Consistent across all issues — easy to scan trends**

```
┌─────────────────────────────────────────────────────────┐
│  SYNC STATUS                                            │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  COMMITS BEHIND    ██████████░░░░ 47 commits            │
│  [upstream]        Last sync: 2 days ago                │
│                                                         │
│  DAYS SINCE MERGE  ████░░░░░░░░░░ 4 days                │
│  [target: weekly]  ⚠️ Review needed                     │
│                                                         │
│  GEMS DISCOVERED   ███████████████ 23 total             │
│  [this scan]       +3 new today                         │
│                                                         │
│  FORK HEALTH       ████████████░░░ 85%                  │
│  [vs upstream]     ✅ Good standing                     │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  QUICK STATS                                            │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌─────────┐       │
│  │   47    │ │    3    │ │   2.1   │ │   85%   │       │
│  │ behind  │ │new gems │ │ days    │ │ health  │       │
│  └─────────┘ └─────────┘ └─────────┘ └─────────┘       │
└─────────────────────────────────────────────────────────┘
```

---

### 🔍 FINDINGS DETAIL

For each discovered gem:

```
┌─────────────────────────────────────────────────────────┐
│  [CATEGORY BADGE: Security/Feature/Fix/Optimization]    │
│                                                         │
│  HEADLINE: What It Does                                 │
│  SOURCE: fork-name/repo (★ stars)                       │
│                                                         │
│  > "Pull quote or key code snippet"                     │
│                                                         │
│  **What:** Description of the change                    │
│  **Why it matters:** Impact on our fork                 │
│  **Files affected:** list of files                      │
│                                                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ IMPLEMENTATION ASSESSMENT                        │   │
│  │ Difficulty: ██░░░ Easy                          │   │
│  │ Time: 2-4 hours                                 │   │
│  │ Risk: Low                                       │   │
│  │ Priority: ★★★★☆                                 │   │
│  └─────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

### 🧩 SKILLS RADAR

New/updated skills in the ecosystem:

```
┌─────────────────────────────────────────────────────────┐
│  SKILLS WORTH WATCHING                                  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  📦 skill-name v1.2.0                    [★★★★☆]       │
│     Brief description of what it does                   │
│     Relevance: Why we might want this                   │
│                                                         │
│  📦 another-skill v2.0.0                 [★★★☆☆]       │
│     Brief description                                   │
│     Relevance: How it fits our needs                    │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

### 📝 EDITORIAL: The Watchman's Notes

**Jarvis's recommendations and observations**

```
┌─────────────────────────────────────────────────────────┐
│  THE WATCHMAN'S NOTES                     [Jarvis]      │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  This Week's Priority: [Main recommendation]            │
│                                                         │
│  Observations:                                          │
│  • Pattern or trend noticed                             │
│  • Concern or opportunity                               │
│  • Process improvement suggestion                       │
│                                                         │
│  Proposed Improvements:                                 │
│  1. [Specific actionable improvement]                   │
│  2. [Another improvement]                               │
│                                                         │
│  Looking Ahead:                                         │
│  [What to watch for next week]                          │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## Metrics to Track (Consistent)

| Metric | Description | Target |
|--------|-------------|--------|
| Commits Behind | vs upstream main | < 20 |
| Days Since Merge | last upstream sync | < 7 |
| Gems Found | valuable changes discovered | ongoing |
| Fork Health | overall sync status | > 80% |
| Skills Radar | new skills tracked | 3-5/week |

---

## Newspaper Techniques

1. **Inverted Pyramid:** Most important info first
2. **Skim-friendly:** Bold key phrases in every paragraph
3. **Headlines:** Action verbs, specific numbers
4. **Subheads:** Explain the "so what?"
5. **Pull quotes:** Key insights boxed
6. **Consistent layout:** Same sections, same positions

---

## Data Sources

1. **GitHub API:** Upstream commits, fork comparisons
2. **Fork Scanner DB:** Analyzed forks, gems table
3. **ClawHub:** New/trending skills
4. **Git log:** Our commit history

---

## Cron Schedule

- **Daily scan:** 03:30 AM (light check)
- **Weekly deep scan:** Sunday 03:30 AM (full 3-tier analysis)
- **Report delivery:** → Jarvis News WhatsApp group

---

*Spec created: 2026-02-08*
