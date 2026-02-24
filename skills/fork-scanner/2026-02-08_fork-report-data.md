# Fork Sync Report Data — 2026-02-08

## VERIFIED METRICS (Source: git commands, GitHub API)

| Metric | Value | Source |
|--------|-------|--------|
| Commits Behind Upstream | 519 | `git rev-list --count HEAD..upstream/main` |
| Last Upstream Merge | 5 weeks ago | `git log --merges --grep="upstream"` |
| Our Version | 2026.2.1 | package.json |
| Total Forks Analyzed | 28,667 | GitHub API |
| Top Fork Stars | 972 (openclaw-cn) | GitHub API |

## LEAD STORY: 519 Commits Behind

**Headline:** FORK DRIFTS 519 COMMITS FROM UPSTREAM — MAJOR SYNC NEEDED

**Subhead:** Five weeks without merge puts us behind on security fixes, Telegram features, and Voyage AI support.

**Key findings:**
- **Telegram spoiler support** added upstream (feat #11543)
- **Context overflow handling** improved (#11664)
- **Agent CRUD methods** added to gateway (#11045)
- **Voyage AI embeddings** now native (#7078)
- **Cron scheduler reliability** fixes (#10776)

**Implementation assessment:**
- Difficulty: Medium (519 commits = careful merge)
- Time: 4-8 hours (review + resolve conflicts)
- Risk: Medium (test thoroughly)
- Priority: ★★★★★ URGENT

## TOP FORKS DISCOVERED (Real Data)

### 1. jiulingyun/openclaw-cn — 972★
**Headline:** CHINESE MEGA-FORK HAS 972 STARS, FEISHU INTEGRATION
- Feishu (飞书) native integration
- Chinese localization complete
- Active community
- **Value:** Feishu integration code could be extracted
- **Effort:** Medium (4-8h to adapt)

### 2. CrayBotAGI/OpenCray — 54★
**Headline:** CHINESE ECOSYSTEM FORK ADDS DINGTALK, QQ, WECHAT
- DingTalk integration
- QQ integration  
- WeChat integration
- **Value:** Three new channel integrations
- **Effort:** High (each integration 8-16h)

### 3. titanicprime/moltbot-safe — 12★
**Headline:** SECURITY-HARDENED FORK WORTH EXAMINING
- Security-focused changes
- Unknown specifics (needs deep scan)
- **Value:** Security patterns
- **Effort:** Low (2-4h to review)

### 4. shanselman/clawdbot — 17★
**Headline:** GITHUB STAFF MEMBER'S FORK
- Scott Hanselman (famous developer)
- Worth watching for insights
- **Value:** Visibility, potential advocacy
- **Effort:** None (watch only)

## UPSTREAM FEATURES WE'RE MISSING

| Feature | PR | Impact |
|---------|-----|--------|
| Telegram spoiler tags | #11543 | UX improvement |
| Context overflow fixes | #11664 | Stability |
| Agent CRUD gateway | #11045 | API capability |
| Voyage AI embeddings | #7078 | Memory enhancement |
| Cron reliability | #10776 | Stability |
| BlueBubbles cleanup | #11093 | iMessage support |

## SKILLS RADAR

(To be populated from ClawHub scan)

## EDITORIAL: WATCHMAN'S NOTES

**Priority this week:** Sync with upstream. 519 commits is dangerous drift.

**Observations:**
- Chinese market is dominant in fork ecosystem (3 of top 5 forks)
- Feishu integration appears in multiple forks — clear demand
- Security-focused forks exist — worth auditing

**Proposed improvements:**
1. Set up weekly upstream sync (not 5-week gaps)
2. Extract Feishu integration from openclaw-cn
3. Audit titanicprime/moltbot-safe for security patterns

**Looking ahead:**
- Monitor openclaw-cn for new features
- Consider reaching out to shanselman for visibility
