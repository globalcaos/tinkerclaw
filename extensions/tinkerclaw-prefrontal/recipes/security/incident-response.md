---
schema: recipe/1.0
id: incident-response
title: Incident Response
category: security
summary: Contain, assess, remediate, communicate — structured response to security incidents
triggers: [incident, breach, compromised, leak, "security incident", "unauthorized access"]
effort: critical
tools: [exec, read, grep, glob, edit]
children: []
---

## Goal

Respond to a security incident systematically -- contain the damage first, then investigate and remediate.

## When to Use

- Suspected credential compromise
- Unauthorized access detected
- Data leak or exposure
- Malicious activity in logs
- Dependency supply chain attack

## Steps

### 1. Contain

**Tools:** exec
**Done when:** Threat is isolated, no further damage possible

Act immediately:

- Revoke compromised credentials (API keys, OAuth tokens)
- Block suspicious access (firewall rules, auth changes)
- Isolate affected systems if needed
- Do NOT restart services yet -- preserve evidence in memory/logs

### 2. Assess

**Tools:** read, grep, exec
**Done when:** Scope of impact understood

Determine:

- What was compromised? (credentials, data, code)
- When did it start? (check logs, git history, file timestamps)
- What was accessed? (API call logs, file access logs)
- Is it ongoing? (active sessions, persistent backdoors)
- What's the blast radius? (other systems using same credentials)

### 3. Remediate

**Tools:** edit, exec
**Done when:** Vulnerability closed, clean credentials deployed

Fix the root cause:

- Rotate ALL credentials that may have been exposed
- Patch the vulnerability that allowed the incident
- Update affected systems with new credentials
- Remove any backdoors or unauthorized changes
- Clear caches that may contain compromised tokens

### 4. Communicate

**Done when:** Stakeholders informed with structured report

Prepare incident report:

- **Timeline:** When detected, when contained, when resolved
- **Impact:** What was affected, what data was exposed
- **Root cause:** How it happened
- **Remediation:** What was done to fix it
- **Prevention:** What changes prevent recurrence

### 5. Postmortem

**Done when:** Lessons learned documented, preventive measures planned

After the dust settles:

- What detection mechanisms failed or were slow?
- What could have prevented this?
- What monitoring should be added?
- Update security audit checklist with new checks

## Constraints

- CONTAIN FIRST -- don't investigate while the threat is active
- Preserve evidence -- don't restart or clear logs before assessment
- Don't use compromised credentials to remediate
- Communicate early even if incomplete -- update as you learn more

## Safety Notes

- OAuth token rotation: Claude Code is single-writer for .credentials.json -- coordinate
- API keys may be shared across services -- rotating one key affects all consumers
- After rotating credentials, verify all services reconnect successfully
- Check git history for unauthorized commits

## Failures Overcome

- **Investigate before contain:** Agent spends time understanding the breach while attacker is still active. Contain step is explicitly first.
- **Incomplete rotation:** Agent rotates one credential but the same key was used in 3 places. Assessment step maps all consumers before remediation.
- **Evidence destroyed:** Agent restarts the service to "fix" it, losing in-memory evidence. Containment explicitly says don't restart yet.
