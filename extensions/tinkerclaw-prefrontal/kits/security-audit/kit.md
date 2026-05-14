---
schema: "kit/1.0"
slug: "security-audit"
title: "Security Audit"
summary: "Systematic security review — inventory, scan, analyze, report, remediate"
version: "1.0.0"
owner: "globalcaos"
license: "MIT"
tags: ["operations", "audit", "security", "vulnerabilities", "hardening", "security review", "CVE"]
tools: ["read", "grep", "glob", "exec"]
testedHarnesses: ["OpenClaw", "Claude Code"]
parallelism:
  groups:
    - [0, 1, 2]
    - [3]
    - [4]
  notes: |
    Inventory (0), Scan (1), and Analyze (2) are all read-only and act on
    independent data: attack-surface glob/grep, pnpm audit + secret grep, and
    severity categorization. They fan safely — no shared write target.
    Report (3) synthesises all three and is a serial barrier. Remediate (4)
    applies fixes post-approval; it must not run before Report is reviewed.
    Step index: 0=Inventory, 1=Scan, 2=Analyze, 3=Report, 4=Remediate.
model:
  provider: "anthropic"
  name: "claude-opus-4-7"
  hosting: "cloud API — requires ANTHROPIC_API_KEY"
resolverHints:
  [
    {
      "match": "audit | security | vulnerabilities | hardening | security review | CVE",
      "load": ["kit.md"],
      "purpose": "Pick this kit for: audit, security, vulnerabilities, hardening, security review, CVE",
    },
  ]
---

## Goal

Identify and address security vulnerabilities in the codebase, configuration, and dependencies.

## When to Use

- Periodic security review
- After major dependency updates
- Before deploying to production
- After a security incident
- When adding new external integrations

## Steps

### 1. Inventory

**Tools:** glob, grep, exec
**Done when:** Complete list of attack surface, deps, and secrets locations

Map the attack surface:

- External-facing endpoints (HTTP routes, WebSocket)
- Authentication mechanisms (OAuth, API keys, tokens)
- Secrets storage locations (.credentials.json, auth-profiles.json, .env)
- Third-party dependencies with known CVEs
- File permissions on sensitive files

### 2. Scan

**Tools:** exec, grep
**Done when:** Automated and manual scan results collected

Run `npm audit` / `pnpm audit` for dependency vulnerabilities. Grep for hardcoded secrets, API keys, tokens in source. Check file permissions on credential files. Review `.gitignore` for sensitive file coverage. Check for exposed debug endpoints.

### 3. Analyze

**Tools:** read, grep
**Done when:** Findings categorized by severity

For each finding, assess:

- **Severity:** Critical (actively exploitable), High (exploitable with effort), Medium (defense in depth), Low (theoretical)
- **Blast radius:** What's compromised if exploited?
- **Exploitability:** Network-accessible? Requires auth? Local only?
- **Existing mitigations:** Already partially addressed?

### 4. Report

**Done when:** Structured findings delivered

Format as structured report:

- Executive summary (1 paragraph)
- Critical findings (immediate action needed)
- High findings (address within 1 week)
- Medium/Low findings (backlog)
- Each finding: description, severity, evidence, remediation

### 5. Remediate

**Tools:** edit, exec
**Done when:** Critical and high findings addressed

Fix critical findings immediately. Create tickets for high findings. Document accepted risks for medium/low. Verify fixes don't break functionality.

## Constraints

- Never log or display actual secret values in findings
- Don't modify production credentials during audit
- Report findings before remediating (for approval)

## Safety Notes

- Credential files should be 600 permissions (owner read/write only)
- OAuth tokens in memory get cleared on restart -- check persistence files
- API keys may be shared across services -- rotating one affects all consumers

## Failures Overcome

- **Secret in report:** Agent included actual API key text in the security report. Always redact secrets, show only location and type.
- **False positive flood:** Agent reports every npm audit warning without assessing exploitability. Severity assessment step filters noise.
- **Remediation breaks auth:** Agent rotated a credential without updating all consumers. Inventory step maps all consumers before rotation.
