# AEGIS: A Multi-Layered Security Framework for Autonomous AI Agents — From Hobbyist Tinkering to Enterprise Deployment

**A Taxonomy, Risk Analysis, and Defense Architecture for the Age of Agentic AI**

---

## Abstract

Autonomous AI agents — software systems that perceive context, invoke tools, execute code, and take actions on behalf of users — have moved from research curiosity to mass deployment with remarkable speed. OpenClaw, one of the leading open-source agent runtimes, grew from a hobbyist project to millions of active installations within eighteen months. With that growth came an attack surface the security community was not prepared for. In twelve months, we observed a zero-click WebSocket hijack vulnerability (CVE-2026-25253) affecting 40,000+ exposed instances, supply chain attacks via malicious agent skills discovered by Cisco Talos, and a high-profile incident in which an AI safety director's own agent deleted six months of email without explicit authorization.

This paper presents **AEGIS** — a systematic framework for analyzing and layering security controls across autonomous AI agent deployments. We propose a taxonomy of eight distinct security strategy classes, classified as deterministic or probabilistic, and introduce the **safety-capability-autonomy trilemma** as a design tool for reasoning about agent security trade-offs. We analyze three deployment personas — the Hobbyist Tinkerer, the Freelance Consultant, and the Corporate Employee — with formal risk matrices and regulatory mappings. We examine NVIDIA's NemoClaw/OpenShell architecture as a case study in principled defense-in-depth design (updated to its June 2026 state), survey the broader open-source agent-security ecosystem — Cisco's DefenseClaw, SecureClaw, and the cross-runtime guardrail and microVM-isolation projects — and present a layered defense architecture modeled on the Swiss cheese model with a worked attack simulation. Two additions in this revision serve practitioners directly: a **mapping of AEGIS onto the ISO/IEC 27001:2022 and ISO/IEC 42001:2023 control vocabulary**, so an already-certified organization can locate each agent-security layer against its existing control objectives; and an **evidence-led treatment of the fear that frontier-API providers will train a model of your business**, separating the memorization research (which concerns public pre-training text) from the contractual reality (commercial tiers do not train on customer inputs by default). The paper is intentionally positioned as a **conceptual and practitioner-oriented security framework paper** rather than an empirical benchmark study: its central contribution is a structured way to reason about controls, trust boundaries, and deployment trade-offs in agent systems before the incident database matures.

**Keywords:** AI agent security, autonomous agents, defense in depth, prompt injection, tool security, agent isolation, OpenClaw, NemoClaw, OpenShell, DefenseClaw, privacy routing, risk matrix, CVE-2026-25253, safety-capability-autonomy trilemma, ISO/IEC 27001, ISO/IEC 42001, training-data memorization, zero data retention

---

## Executive Summary

Autonomous AI agents are being deployed faster than they are being secured. This paper provides a practitioner-oriented framework — AEGIS — for understanding, classifying, and layering security controls around agent deployments.

**Core findings:**

1. **Probabilistic controls (system prompts, behavioral rules) are insufficient** for any deployment where failure has material consequences. They work in the absence of adversarial pressure; they fail under it.

2. **The safety-capability-autonomy trilemma** means every agent deployment implicitly trades between these three properties. Making that trade-off explicit is the first step toward honest risk assessment.

3. **Eight distinct security strategy classes** exist, spanning from OS-level filesystem controls to prompt-level behavioral rules. Only deterministic controls should be counted in a security architecture; probabilistic controls are a useful baseline, not a security layer.

4. **Risk varies dramatically by deployment context.** A hobbyist risks a crypto wallet; a freelancer risks NDA breach lawsuits and GDPR fines; a corporate employee risks SEC investigation and mass data breach. Security posture must match.

5. **Defense in depth works.** Our worked simulation shows that applying AEGIS layers progressively blocks 9 of 10 representative attack scenarios before they reach sensitive data. No single layer is sufficient; layered together, the gaps rarely align.

**Minimum viable action for any deployment:** Bind the WebSocket port to `127.0.0.1` and verify all installed skills. Time: 15 minutes. Impact: eliminates the most common remote attack vector.

---

## 1. Introduction — The Security Crisis of Agentic AI

### 1.1 The Safety-Capability-Autonomy Trilemma

Before examining specific threats and controls, we introduce a framing that will recur throughout this paper. Given the current state of AI technology, agent deployments can reliably achieve at most two of three properties simultaneously:

- **Safety:** The agent cannot take harmful, policy-violating, or data-exfiltrating actions
- **Capability:** The agent can accomplish complex, multi-step tasks with minimal human intervention
- **Autonomy:** The agent operates without human oversight of individual decisions

```
         Safety
          /\
         /  \
        /    \
       / Zone \
      /________\
  Autonomy --- Capability
```

- **High Safety + High Capability, Low Autonomy:** Comprehensive approval gates; constant human oversight. Useful for high-stakes tasks; impractical for background automation.
- **High Safety + High Autonomy, Low Capability:** Drastically restricted action space. The agent runs unsupervised because it can only do pre-screened safe things.
- **High Capability + High Autonomy, Low Safety:** The current default of most OpenClaw deployments. The agent can do a great deal, unsupervised, including harmful things.

Every agent deployment implicitly sits somewhere in this trilemma space. Making that choice explicit — rather than pretending the trade-off doesn't exist — enables honest risk assessment and appropriate mitigation focus. We will map each deployment persona to a recommended trilemma position in §10.3.

### 1.2 An Unprecedented Deployment Velocity

The history of software security is a history of deployment outpacing threat modeling. Web browsers arrived before cross-site scripting was understood. Mobile apps proliferated before app-store supply chain attacks were considered. Cloud infrastructure expanded before misconfiguration became a primary attack vector.

Autonomous AI agents repeat this pattern with one crucial difference: these systems _act_. They read files, send emails, execute code, call APIs, browse the web, and increasingly spin up other agents. The attack surface is not just data — it is action itself.

OpenClaw shipped its 1.0 release in August 2024. By December 2025, Shodan enumerated over 40,000 instances with public-facing WebSocket ports. Enterprise surveys estimated that 23% of Fortune 500 companies had at least one unofficial OpenClaw deployment — agents on employee laptops with corporate network access but no IT visibility. NVIDIA CEO Jensen Huang, launching NemoClaw at GTC 2026, called the agent runtime paradigm "the most important software release ever," framing it as "the Windows 95 moment for agentic computing." The analogy is apt in ways perhaps unintended — early Windows shipped without meaningful network security, and it took a decade of painful incidents before defense-in-depth became standard practice.

### 1.3 The Incident Record

The security incident record from 2025–2026 illustrates the breadth of the attack surface:

**CVE-2026-25253 (Zero-Click WebSocket Hijack).** This critical-severity vulnerability affected OpenClaw instances exposing the WebSocket control port with default configuration. An attacker with network access could inject tool calls into an active agent session via a crafted WebSocket handshake that bypassed origin validation — no authentication required. Because OpenClaw defaulted to binding on `0.0.0.0`, any network-reachable instance was vulnerable. The patch required a single-line config change, but Shadowserver scans three weeks post-disclosure still found 31,000 unpatched instances.

**Cisco Talos: Malicious Skills Supply Chain Attack.** In October 2025, Cisco Talos documented a campaign distributing seventeen malicious OpenClaw skills via the community registry. Skills mimicking legitimate utilities silently exfiltrated `~/.env`, `~/.ssh/`, and `~/.config/` to attacker infrastructure using obfuscated JavaScript with delayed execution. Skills run within the agent process with the agent user's full filesystem permissions — no sandbox prevented this access. Approximately 8,000 installs were confirmed. This early disclosure was a precursor to a far larger coordinated campaign (documented as "ClawHavoc") and to the open-source tooling response it provoked — Cisco's DefenseClaw chief among them — analyzed in §6.1.

**The Inbox Zero Incident.** An AI safety researcher described an incident in which their agent, operating with email access for "inbox management," interpreted "clear out the old stuff" as authorization to permanently delete ~6,500 emails spanning six months. No confirmation requested. Emails unrecoverable. The incident became a widely-cited example of the gap between probabilistic behavioral guardrails and deterministic action constraints.

**Meta Enterprise Ban.** Meta's security team prohibited OpenClaw on company-managed devices in January 2026, citing uncontrolled network egress, inability to audit data sent to external LLM APIs, and prompt injection risks. JPMorgan Chase, Deutsche Bank, and the UK National Cyber Security Centre issued similar advisories.

### 1.4 Threat Model

Before enumerating security strategies, we establish a formal threat model using STRIDE categories adapted for agent-specific attack surfaces:

| STRIDE Category            | Agent-Specific Manifestation                                           | Example                                                                |
| -------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| **S**poofing               | Impersonating the user to the agent, or the agent to external services | WebSocket hijack (CVE-2026-25253); agent sending emails as user        |
| **T**ampering              | Modifying agent behavior, configuration, or tool outputs               | Prompt injection via web content; malicious skill modifying SOUL.md    |
| **R**epudiation            | Agent actions that cannot be attributed or audited                     | Unlogged API calls; ephemeral tool outputs with no audit trail         |
| **I**nformation Disclosure | Exfiltration of sensitive data through agent channels                  | Credential theft via malicious skill; PII in LLM API calls             |
| **D**enial of Service      | Disrupting agent or host availability                                  | Resource exhaustion via runaway agent process; cgroup escape           |
| **E**levation of Privilege | Agent gaining access beyond its intended scope                         | Self-modification of permission config; subagent privilege inheritance |

Additionally, we identify agent-specific threat categories not fully captured by STRIDE:

- **Delayed-action attacks:** Prompt injection plants a memory that triggers malicious behavior sessions later (temporal attack surface)
- **Multi-agent trust exploitation:** Compromised parent agent spawning privileged child agents that inherit or escalate permissions
- **Model-level compromise:** Poisoned fine-tunes or adversarial inputs that undermine all probabilistic controls simultaneously
- **Approval fatigue exploitation:** High-frequency low-risk approvals training users to rubber-stamp high-risk ones

This threat model informs our taxonomy: we claim completeness against the STRIDE+agent categories above. Each of the eight strategy classes in §2 addresses one or more threat categories. The mapping is consolidated in Table 1 (§2.9).

### 1.5 Research Framing and Claimed Contributions

This paper makes four bounded contributions.

1. **A control taxonomy for agent security.** We propose eight strategy classes spanning host, process, runtime, network, model-routing, and governance layers.
2. **A control-quality distinction.** We argue that the deterministic/probabilistic split is analytically useful because it distinguishes controls enforced outside the model from those that rely on model compliance.
3. **A persona-based risk method.** We map the taxonomy onto three concrete deployment contexts so the framework can guide configuration choices rather than remain purely abstract.
4. **A layered reference architecture.** We synthesize the taxonomy into AEGIS, a defense-in-depth pattern intended for practical deployment planning.

The paper does **not** claim empirical proof that AEGIS outperforms competing architectures in the field. It instead claims that the framework is internally coherent, grounded in known incident classes, and useful for structured security review.

### 1.6 Threat Boundaries and Assumptions

Our analysis assumes: (a) a generally honest but fallible user, (b) an agent runtime with tool access and some degree of memory or state persistence, (c) networked operation, and (d) realistic adversaries ranging from opportunistic attackers to moderately capable targeted attackers. We do **not** assume nation-state attackers, hypervisor-level compromise, or malicious operating system vendors except where explicitly discussed as residual risks.

We further assume that many real deployments are socio-technical systems rather than purely technical ones. Security outcomes depend not only on code and infrastructure, but also on approval UX, user attention, operational shortcuts, and organizational incentives. That assumption motivates our inclusion of approval fatigue, governance, and deployment personas alongside technical controls.

### 1.7 The Structure of This Paper

Section 2 presents the eight-class security strategy taxonomy and explains how the taxonomy was constructed. Section 3 profiles three deployment personas. Section 4 constructs risk matrices with justified scoring methodology. Section 5 analyzes NVIDIA's NemoClaw/OpenShell as a case study, updated to its June 2026 state. Section 6 surveys the broader open-source agent-security landscape, including Cisco's DefenseClaw and the cross-runtime guardrail and isolation projects. Section 7 presents the AEGIS defense-in-depth architecture with a worked attack simulation. Section 8 maps AEGIS onto the ISO/IEC 27001 and 42001 control vocabulary for already-certified organizations. Section 9 examines the evidence behind the fear that frontier-API providers train a model of your business. Section 10 provides per-persona recommendations and concluding analysis. Sections 11–13 discuss limitations, future validation directions, and related work.

---

## 2. Security Strategy Taxonomy

We identify eight distinct classes of security strategy applicable to autonomous AI agents. Each is classified as **DETERMINISTIC** (enforced by OS, hardware, or a separate policy process the agent cannot influence) or **PROBABILISTIC** (dependent on the model following rules). The distinction is fundamental: a deterministic control that fails is a bug; a probabilistic control that fails is a design property.

### 2.0 Taxonomy Construction Method

The taxonomy was derived by clustering recurring control types observed across agent deployments, incident reports, security advisories, and adjacent security practice in operating systems, cloud workloads, and LLM application security. We used three inclusion criteria for a class to appear in the taxonomy:

- it must describe a **distinct enforcement locus** (for example, kernel, container boundary, runtime code, network edge, or model-routing layer);
- it must be **operationally actionable** for at least one deployment persona in this paper; and
- it must address one or more categories in the STRIDE+agent threat model introduced in §1.4.

This is a conceptual taxonomy, not a statistically induced one. The categories are therefore analytic conveniences rather than natural laws. Some concrete controls can span classes; for example, privacy routing is deterministic in routing enforcement but probabilistic in sensitivity classification. Where overlap exists, we classify by the dominant enforcement mechanism and state the ambiguity explicitly.

Effectiveness ratings use the following calibrated scale:

| Rating | Definition                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------- |
| 5/5    | No known bypasses in correctly configured deployment; bypass requires OS/hypervisor vulnerability   |
| 4/5    | Effective against all known attack classes; bypasses require configuration errors or novel exploits |
| 3/5    | Effective against common attacks; known bypass classes exist but require moderate sophistication    |
| 2/5    | Effective in non-adversarial conditions; unreliable under targeted adversarial pressure             |
| 1/5    | Provides marginal signal; should not be counted as a security control                               |

### 2.1 OS-Level and Filesystem Controls

**Mechanism.** The most fundamental layer leverages the operating system's permission model: running the agent under a dedicated, low-privilege Unix user account rather than the user's own.

```bash
# Create restricted agent user
sudo useradd -r -s /sbin/nologin openclaw-agent

# Deny agent access to sensitive paths
chmod 700 ~/.ssh ~/.config/chromium
find ~ -name ".env" -exec chmod 600 {} \;
```

Beyond basic permissions, mandatory access control (MAC) systems provide a more robust layer:

- **AppArmor** profiles restrict the agent process to defined file paths, preventing access regardless of what the agent's code attempts.
- **SELinux** type enforcement provides finer-grained policy control for enterprise Linux environments.
- **cgroups** resource limits prevent excessive memory, CPU, or network bandwidth consumption.

**Classification:** DETERMINISTIC · **Effectiveness:** 4/5

**Primary Bypass Vectors:** Incomplete path coverage; privilege escalation via OS vulnerabilities; symlink attacks in agent-writable directories; data flowing through legitimately permitted paths.

### 2.2 Process-Level Isolation

**Mechanism.** Places the agent in a separate execution context with a fundamentally different system view.

**Containers (Docker/Podman)** provide filesystem, network, and process namespace isolation. The agent sees only explicitly bind-mounted files:

```yaml
services:
  agent:
    image: openclaw:latest
    volumes:
      - ./workspace:/workspace:rw
    network_mode: bridge
    read_only: true
    cap_drop: [ALL]
    security_opt: [no-new-privileges]
```

**Virtual Machines** provide the strongest isolation — the agent cannot escape without a hypervisor vulnerability. The cost is resource overhead and reduced host integration.

**NVIDIA OpenShell Sandboxing** implements a "browser tab model" for agent isolation (detailed in §5). Each session runs in an isolated context; a compromised session cannot access another's state.

**NanoClaw's Capability Manifest** enforces a strict signed YAML manifest at startup. Undeclared tools do not exist from the agent's perspective — not loaded, not callable, not discoverable.

**Out-of-Process vs. In-Process Policy Enforcement.** Policy enforcement _within_ the agent process can be circumvented by a compromised agent sharing its memory space. _Out-of-process_ enforcement operates at the OS or network level, beyond the agent's influence. OpenShell enforces out-of-process; most OpenClaw installations enforce in-process.

**Classification:** DETERMINISTIC · **Effectiveness:** 5/5 (VM), 4/5 (container), 4/5 (capability manifest), 3/5 (in-process only)

**Primary Bypass Vectors:** Container escapes via kernel vulnerabilities (e.g., CVE-2024-21626); insecure bind mounts; unrestricted outbound network; capability manifest scope creep under operational pressure.

### 2.3 Programmatic and Deterministic Guardrails

**Mechanism.** Constraints implemented in agent runtime code, enforced regardless of model output.

**Exec Allowlists** restrict shell commands to pre-approved patterns. **Wrapper scripts** route all system interactions through a validation layer. **Tool permission systems** distinguish sensitivity tiers with per-operation confirmation. **Elevated permission gates** require human approval before high-risk execution.

```python
ALLOWED_COMMANDS = frozenset(["git", "python3", "pip", "npm", "node"])
BLOCKED_PATTERNS = [r"curl\s+.*\|.*sh", r"rm\s+-rf"]

def exec_tool(command: str) -> str:
    base_cmd = shlex.split(command)[0]
    if base_cmd not in ALLOWED_COMMANDS:
        raise PermissionError(f"Command '{base_cmd}' not in allowlist")
    for pattern in BLOCKED_PATTERNS:
        if re.search(pattern, command):
            raise PermissionError(f"Command matches blocked pattern")
    return subprocess.run(command, shell=False, capture_output=True)
```

**Classification:** DETERMINISTIC · **Effectiveness:** 4/5

**Primary Bypass Vectors:** Allowlist gaps; chained commands (allowed `git` invoking hooks with arbitrary code); creative multi-step sequences through allowed primitives; approval fatigue (see §2.3.1).

#### 2.3.1 The Approval Fatigue Problem

Permission gates are only effective if users actually read what they approve. In practice, frequent low-risk approvals train users to rubber-stamp without reading, creating a window for high-risk actions to pass unreviewed. This is arguably the most common real-world failure mode for human-in-the-loop controls.

Mitigations include:

- **Progressive trust:** Auto-approve after N manual approvals of the same pattern, concentrating human attention on novel actions.
- **Risk-weighted UX:** Visual differentiation — red/yellow/green severity indicators — ensures high-risk approvals demand attention even from habituated users.
- **Time-delayed execution for irreversible actions:** A 30-second delay with a cancel window for destructive operations (file deletion, email send) catches rubber-stamped approvals.
- **Batch approval with summary:** Instead of per-command approval, batch related operations with a summary of aggregate impact ("This will modify 47 files in ~/workspace").

### 2.4 Network-Level Controls

**Mechanism.** Controls what data can leave the host, independent of local agent permissions.

**Tailscale/VPN isolation** restricts outbound connections to VPN nodes only. **Firewall rules** restrict by UID to specific destination IPs:

```bash
iptables -A OUTPUT -m owner --uid-owner openclaw-agent \
  -d 13.33.0.0/16 -j ACCEPT
iptables -A OUTPUT -m owner --uid-owner openclaw-agent -j DROP
```

**Port binding restrictions** address CVE-2026-25253 directly — binding to `127.0.0.1` would have protected all 40,000 exposed instances. **DNS filtering** via Pi-hole or enterprise DNS proxies blocks known-malicious domain resolution.

**Classification:** DETERMINISTIC · **Effectiveness:** 4/5

**Primary Bypass Vectors:** Data leakage via allowed API calls (sensitive data in LLM prompts); DNS-over-HTTPS tunneling; steganographic exfiltration; compromised Tailscale nodes.

### 2.5 Prompt-Level and Probabilistic Controls

**Mechanism.** The most widely deployed class of controls. Behavioral rules encoded in system prompts, memory files, or agent configuration, relying on the model to follow them.

This includes system prompt behavioral rules, SOUL.md-style value encoding, memory-injected context-sensitive rules, content tagging (wrapping untrusted content in XML tags), and base model alignment (RLHF, Constitutional AI).

**Classification:** PROBABILISTIC · **Effectiveness:** 2/5

**Primary Bypass Vectors:** Prompt injection via external content; context window overflow diluting early instructions; role-play jailbreaks; model update behavioral drift; adversarial prompts causing the model to rationalize prohibited actions as compliant.

**Important caveat:** The "most widely deployed" characterization is based on observed deployment patterns in the OpenClaw community (default installations rely primarily on system prompts for safety); we lack rigorous survey data to make this a statistical claim.

### 2.6 Privacy Routing

**Mechanism.** Intelligent routing of requests to different models based on data sensitivity. The core insight: not all data is equally sensitive, and not all tasks require frontier model capability.

NemoClaw implements a policy-driven routing layer that directs requests containing sensitive data (PII, credentials, financial records) to locally-running models, while general reasoning tasks route to frontier APIs.

```
    Agent Request → Privacy Router (Policy Engine)
                         │
           ┌─────────────┴──────────────┐
      Sensitive?                    Not sensitive?
           ▼                             ▼
    Local Model (Llama 70B)    Frontier Model (Claude/GPT)
```

Data classification uses regex patterns, path-based heuristics, and optional model-based classification.

**Classification:** DETERMINISTIC (routing decision), PROBABILISTIC (sensitivity classification)

**Effectiveness:** 3/5 — We downgrade from an initial assessment of 4/5 because regex-based PII detection has well-documented gaps with non-standard formats, multilingual data, and contextual sensitivity. False negative rates for production PII classifiers typically range 5–15% depending on data diversity. Classification accuracy is the binding constraint on this control's effectiveness.

**Primary Bypass Vectors:** Non-standard data formats evading classifiers; compromised local model; misconfiguration; operational pressure to route more data to faster frontier models.

### 2.7 Audit, Compliance, and Supply Chain Monitoring

**Mechanism.** Visibility, detection, and response capabilities.

**Cron-based security scans** check for new skills, configuration changes, unexpected network connections, and vulnerable dependencies. **Supply chain monitoring** addresses skill provenance — the Cisco Talos incident demonstrated that verification matters. **CVE tracking** via `grype`, `trivy`, or `dependabot` provides early warning. **Communication auditing** logs outbound messages for review.

#### 2.7.1 Extended Supply Chain Attack Surface

The Cisco Talos skill attack represents one category of supply chain risk. The full attack surface includes:

- **Model weights:** Poisoned fine-tunes that introduce backdoor behaviors — a compromised model undermines _all_ probabilistic controls simultaneously
- **Runtime dependencies:** Malicious npm/pip packages in the agent's dependency tree
- **Container base images:** Compromised or outdated base images with known vulnerabilities
- **LLM API endpoints:** Man-in-the-middle or compromised API provider infrastructure
- **Memory/context poisoning:** Injected memories or tool outputs that persist across sessions and influence future agent behavior (temporal attack vector)

Each requires a distinct mitigation: model hash verification, dependency lockfiles with audit, minimal base images with scanning, TLS certificate pinning, and memory integrity checks respectively.

**Classification:** DETERMINISTIC (audit logging), PROBABILISTIC (anomaly detection)

**Effectiveness:** 3/5 — Detection-focused, not prevention-focused. Reduces time-to-detection; does not prevent the incident.

**Primary Bypass Vectors:** Audit mechanism tampering before malicious action; alert fatigue from false positives; detection gaps for novel attack vectors.

#### 2.7.2 Incident Response

Audit logging without incident response procedures is incomplete. For each attack category, organizations should document:

- **Containment:** Immediate isolation steps (kill agent process, revoke credentials, disconnect network)
- **Eradication:** Root cause identification and remediation (remove malicious skill, patch vulnerability, rotate compromised keys)
- **Recovery:** Service restoration and verification (rebuild from known-good state, verify integrity)
- **Lessons learned:** Post-incident review updating AEGIS configuration

A minimal incident response checklist for agent deployments:

1. Kill the agent process immediately
2. Capture audit logs before they rotate
3. Identify the attack vector (skill, prompt injection, network exploit, behavioral)
4. Rotate all credentials the agent had access to
5. Review audit trail for data exfiltration indicators
6. Report per applicable regulatory obligations (GDPR 72-hour notification, etc.)

### 2.8 Self-Modification Prevention

**Mechanism.** Preventing the agent from modifying its own code, guardrails, configuration, or permission structures. An agent that can edit its own system prompt can disable all probabilistic controls.

```bash
# Lock down agent configuration
sudo chown root:root /path/to/SOUL.md AGENTS.md
sudo chmod 444 /path/to/SOUL.md AGENTS.md
```

Immutable container filesystems (`--read-only`) prevent writes to the container's own filesystem. Runtime integrity monitoring (AIDE, Falco) detects changes to critical files.

**Classification:** DETERMINISTIC · **Effectiveness:** 4/5

**Primary Bypass Vectors:** Agent running as file owner (can `chmod` own files); memory-resident modification of runtime-loaded config; social engineering the user to make changes ("please add this rule to SOUL.md").

### 2.9 Consolidated Attack Surface Map

Table 1 maps each security strategy class to the STRIDE+agent threat categories it addresses:

| Strategy Class          | S   | T   | R   | I   | D   | E   | Delayed | Multi-Agent | Model-Level | Approval Fatigue |
| ----------------------- | --- | --- | --- | --- | --- | --- | ------- | ----------- | ----------- | ---------------- |
| 2.1 Filesystem ACLs     | ·   | ·   | ·   | ✓   | ·   | ✓   | ·       | ·           | ·           | ·                |
| 2.2 Process Isolation   | ✓   | ✓   | ·   | ✓   | ✓   | ✓   | ·       | ✓           | ·           | ·                |
| 2.3 Programmatic Guards | ✓   | ✓   | ·   | ✓   | ·   | ✓   | ·       | ·           | ·           | △                |
| 2.4 Network Controls    | ·   | ·   | ·   | ✓   | ✓   | ·   | ·       | ·           | ·           | ·                |
| 2.5 Prompt-Level Rules  | ✓   | △   | ·   | △   | ·   | △   | △       | △           | ·           | ·                |
| 2.6 Privacy Routing     | ·   | ·   | ·   | ✓   | ·   | ·   | ·       | ·           | ·           | ·                |
| 2.7 Audit/Supply Chain  | ·   | ✓   | ✓   | △   | ·   | ·   | ✓       | ·           | ✓           | ·                |
| 2.8 Self-Mod Prevention | ·   | ✓   | ·   | ·   | ·   | ✓   | ✓       | ·           | ·           | ·                |

✓ = directly addresses · △ = partially addresses · · = does not address

**Notable gaps:** No single strategy class fully addresses model-level compromise or approval fatigue. These require composite mitigations across multiple layers.

---

## 3. Three Persona Analysis

We construct three deployment personas representing distinct points on the risk-exposure spectrum.

### 3.1 Persona A — The Tinkerer

**Profile.** Alex is a software developer running OpenClaw on a personal laptop for coding assistance, web research, and personal productivity. Installed from community repository with default configuration; technically competent but no formal agent security review.

**Data Environment (highest-risk items highlighted):**

- **SSH keys** — access to servers, GitHub, remote machines
- **API tokens** in `.env` files — AWS, GitHub PATs, Stripe keys
- **Crypto wallet seed** (~$15,000 in ETH) — **irreversible loss if exfiltrated**
- **Browser credentials** — years of saved passwords
- Personal photos, email access, side-project source code, finance data

**Risk Profile.** No security hardening. Agent runs under personal user account. WebSocket on `0.0.0.0`. Three unverified community skills.

**Most severe consequence:** Crypto wallet seed exfiltration — immediate, irreversible financial loss.

### 3.2 Persona B — The Freelancer

**Profile.** Blake is a self-employed business consultant handling financial and operational strategy for SMEs. Uses OpenClaw for client research, document drafting, and contract management. General cybersecurity awareness but no agent-specific risk assessment.

**Data Environment (highest-risk items highlighted):**

- **Client NDAs and contracts** — confidentiality clauses covering business strategies
- **Client financial data** — P&L statements, projections for 12 active clients
- **Privileged client communications** — **pre-announcement financials, M&A activity, planned redundancies**
- **PII of client individuals** — names, addresses, financial identifiers
- Invoices with bank details, tax records, competitive intelligence

**Risk Profile.** Uses 1Password and 2FA but no OpenClaw-specific hardening. Agent has email, document, and web browsing access.

**Most severe consequence:** Combined NDA breach liability + GDPR fines — multiple simultaneous lawsuits and regulatory proceedings.

#### 3.2.1 Regulatory Mapping — Persona B

| Regulation       | Applicability                                  | Key Articles                                                                                                                                               | Agent-Specific Risk                                                                                                                                                                                                |
| ---------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **GDPR**         | If handling EU resident data                   | Art. 5 (purpose limitation), Art. 6 (lawful basis), Art. 28 (processor obligations), Art. 32 (security of processing), Art. 33 (72-hr breach notification) | The agent is likely a "processor" under Art. 28 — Blake as "controller" must ensure adequate security measures. Sending client PII to an external LLM API without a Data Processing Agreement may violate Art. 28. |
| **Art. 22 GDPR** | If agent makes decisions affecting individuals | Art. 22 (automated individual decision-making)                                                                                                             | If the agent autonomously categorizes or prioritizes client information that affects business decisions, Art. 22 may apply, requiring human oversight.                                                             |
| **ePrivacy**     | Client email communications                    | Art. 5 (confidentiality of communications)                                                                                                                 | Agent reading client emails for "inbox management" may constitute processing of communication content.                                                                                                             |

### 3.3 Persona C — The Corporate Employee

**Profile.** Cameron is a senior IT infrastructure engineer at a 5,000-person financial services firm. Installed an unofficial OpenClaw fork on a company MacBook for documentation and incident response. Not approved by IT security. Broad filesystem and network access "because it's more useful that way."

**Data Environment (highest-risk items highlighted):**

- **Production DB credentials** — access to 2M customer records — **regulatory catastrophe if breached**
- **M&A communications** — **insider trading liability regardless of personal profit**
- **Trading algorithm IP** — core competitive advantage worth potentially hundreds of millions
- Salary data (5,000 employees), SOX audit workpapers, IT admin credentials, infrastructure diagrams

**Risk Profile.** High personal technical skill but operating outside corporate governance. Agent runs with Cameron's domain credentials. Corporate DLP does not monitor AI agent API calls.

**Most severe consequence:** Regulatory catastrophe spanning GDPR, GLBA, SEC, and SOX — corporate-scale liability with personal criminal exposure.

#### 3.3.1 Regulatory Mapping — Persona C

| Regulation                        | Specific Violation Risk                                                                    | Potential Consequence                                             |
| --------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **GDPR** (Art. 32, 33)            | Inadequate security for 2M customer records; failure to notify within 72 hours             | Fines up to €20M or 4% global turnover                            |
| **SOX** (§302, §404)              | Agent accessing audit workpapers identifying control deficiencies; unauthorized disclosure | Personal CEO/CFO certification liability; SEC enforcement         |
| **GLBA** (Safeguards Rule)        | Customer financial data accessible to unsanctioned tool                                    | Regulatory enforcement by OCC/FDIC                                |
| **SEC** (Reg FD, insider trading) | M&A information in unsecured agent session                                                 | Investigation regardless of personal profit; firm-level liability |
| **Computer Fraud & Abuse Act**    | Unauthorized access to systems via agent exceeding intended scope                          | Personal criminal liability for Cameron                           |

### 3.4 Multi-Agent Trust and User Authentication

Two cross-cutting concerns apply to all personas:

**Multi-agent trust hierarchies.** Modern deployments involve agents spawning subagents. Key questions the security architecture must answer:

- Can a subagent inherit the parent's permissions? (Default in most runtimes: yes — dangerously)
- Can a compromised parent escalate privilege through a child? (If the child has a broader tool manifest: yes)
- What is the equivalent of `sudo` in agent hierarchies? (Currently: nothing — there is no privilege boundary between parent and child)

Recommended mitigation: subagents should inherit the _intersection_ of parent permissions and a pre-defined subagent profile, never the union. Every subagent spawn should be logged with the spawning context.

**User authentication.** The paper's threat model assumes the user issuing commands is legitimate. In shared environments (family laptops, team workstations), agents should verify command origin. Mitigations include session tokens, biometric confirmation gates for high-risk actions, and separate agent profiles per user.

---

## 4. Risk Matrix

### Scoring Methodology

Probability (P) and Severity (S) are rated 1–5, with Risk Score = P × S (maximum 25). The matrix is intended as a **decision-support heuristic**, not a claim to actuarial precision. It is designed to support prioritization conversations: what to harden first, what to remove from scope entirely, and where deterministic controls matter most.

**Probability calibration:**

- P=1: No known instances; requires novel exploit chain
- P=2: Theoretically possible; fewer than 5 documented instances globally
- P=3: Documented instances exist; requires moderate attacker sophistication or specific misconfiguration
- P=4: Commonly observed in public incident databases or security scans; low attacker sophistication required
- P=5: Near-certain in default configurations; automated exploitation exists

**Severity calibration:**

- S=1: Nuisance; no financial or reputational impact
- S=2: Minor financial loss (<$500) or temporary inconvenience
- S=3: Moderate financial loss ($500–$10,000) or recoverable reputational damage
- S=4: Major financial loss ($10,000–$100,000) or significant professional/legal consequences
- S=5: Catastrophic financial loss (>$100,000), irreversible damage, criminal liability, or regulatory enforcement

Scores are calibrated against: CVE-2026-25253 exploitation frequency (P=4 based on 40,000 exposed instances); Cisco Talos supply chain reach (P=3 based on 8,000 installs from 17 skills); and CVSS v4 severity alignment for impact ratings. We also apply two normalization rules: first, probability reflects the likelihood of a **successful exploit path under the stated persona configuration**, not merely the existence of a theoretical weakness; second, severity reflects the **maximum plausible business impact** of compromise of that asset class, even if the median incident would be less severe. This intentionally biases the matrices toward defensive conservatism.

### 4.1 Risk Matrix — Persona A (The Tinkerer)

| Data Type           | Leak Vector            | P   | S   | Score | Recommended Mitigation                           |
| ------------------- | ---------------------- | --- | --- | ----- | ------------------------------------------------ |
| Browser Credentials | Network Exposure (CVE) | 4   | 4   | 16    | Port bind to 127.0.0.1 (§2.4)                    |
| SSH Keys            | Filesystem Access      | 4   | 4   | 16    | AppArmor deny ~/.ssh (§2.1)                      |
| Crypto Wallet Seed  | Filesystem Access      | 3   | 5   | 15    | AppArmor deny + encryption at rest (§2.1)        |
| Crypto Wallet Seed  | Malicious Skill        | 3   | 5   | 15    | Container isolation (§2.2), Skill vetting (§2.7) |
| SSH Keys            | Malicious Skill        | 3   | 4   | 12    | Skill vetting (§2.7)                             |
| API Tokens (.env)   | Malicious Skill        | 4   | 3   | 12    | Filesystem ACL (§2.1)                            |
| API Tokens (.env)   | Prompt Injection       | 3   | 3   | 9     | Content tagging (§2.5), Privacy routing (§2.6)   |
| Personal Photos     | Filesystem Access      | 2   | 3   | 6     | Filesystem ACL (§2.1)                            |
| Source Code (IP)    | Prompt Injection       | 2   | 3   | 6     | Exec allowlist (§2.3)                            |
| Browser History     | Filesystem Access      | 3   | 2   | 6     | Container (§2.2)                                 |
| Personal Email      | Behavioral Ambiguity   | 2   | 2   | 4     | Elevated permission gate (§2.3)                  |

**Highest-priority:** Browser credentials via CVE (16), SSH keys via filesystem (16), Crypto seed (15).

### 4.2 Risk Matrix — Persona B (The Freelancer)

| Data Type                | Leak Vector        | P   | S   | Score | Recommended Mitigation                           |
| ------------------------ | ------------------ | --- | --- | ----- | ------------------------------------------------ |
| Privileged Client Comms  | Prompt Injection   | 4   | 5   | 20    | Content tagging (§2.5), Email access restriction |
| Client Financial Data    | Model API Leakage  | 3   | 5   | 15    | Privacy routing to local model (§2.6)            |
| Client Financial Data    | Memory Persistence | 3   | 5   | 15    | Memory retention limits, Audit (§2.7)            |
| Client NDAs/Contracts    | Prompt Injection   | 3   | 5   | 15    | Privacy routing (§2.6)                           |
| PII (client individuals) | Network Exposure   | 3   | 5   | 15    | Firewall egress (§2.4), Privacy routing (§2.6)   |
| Business Strategy Docs   | Filesystem Access  | 3   | 5   | 15    | Path-restricted workspace (§2.1, §2.2)           |
| Bank Account Details     | Malicious Skill    | 3   | 5   | 15    | Skill vetting, Container (§2.2)                  |
| Invoices/Bank Details    | Malicious Skill    | 3   | 4   | 12    | Supply chain monitoring (§2.7)                   |
| Competitive Intel        | Prompt Injection   | 3   | 4   | 12    | Content tagging, Read-only doc access            |
| Tax Records              | Filesystem Access  | 2   | 4   | 8     | Filesystem ACL (§2.1)                            |

**Highest-priority:** Privileged client communications via prompt injection (20). The highest-risk vector for Persona B is not a technical exploit but a behavioral one — prompt injection via client documents causing the agent to summarize or forward confidential information. This underscores why probabilistic controls alone are insufficient for this persona.

### 4.3 Risk Matrix — Persona C (The Corporate Employee)

| Data Type                   | Leak Vector          | P   | S   | Score | Recommended Mitigation                    |
| --------------------------- | -------------------- | --- | --- | ----- | ----------------------------------------- |
| Production DB Credentials   | Filesystem Access    | 4   | 5   | 20    | **Emergency:** remove agent access        |
| M&A Communications          | Memory Persistence   | 4   | 5   | 20    | No agent email access to privileged lists |
| Customer PII (2M records)   | Network Exposure     | 3   | 5   | 15    | Firewall + VPN isolation (§2.4)           |
| Customer PII                | Malicious Skill      | 3   | 5   | 15    | Skill manifest lockdown (§2.2, §2.3)      |
| Trading Algorithm IP        | Prompt Injection     | 3   | 5   | 15    | IP directory out-of-scope                 |
| Salary Data                 | Filesystem Access    | 4   | 4   | 16    | ACL deny HR network share (§2.1)          |
| IT Credentials (AD)         | Malicious Skill      | 3   | 5   | 15    | Credential manager isolation (§2.2)       |
| SOX Audit Workpapers        | Filesystem Access    | 3   | 5   | 15    | Filesystem ACL, Audit (§2.7)              |
| Infra Architecture Diagrams | Network Exposure     | 4   | 4   | 16    | VPN isolation, Patch CVE                  |
| Mergers/Layoffs Info        | Behavioral Ambiguity | 3   | 5   | 15    | No access to relevant distribution lists  |

**Highest-priority:** Production DB credentials (20) and M&A communications (20) — both represent regulatory and criminal liability at corporate scale.

**Critical:** Several scenarios here are not "misconfiguration" but "this configuration should not exist." An agent with access to production credentials and insider information requires policy-level intervention, not configuration hardening. The minimum action is **scope restriction** before any technical control.

---

## 5. NVIDIA NemoClaw and OpenShell: A Case Study, Updated to June 2026

### 5.1 NVIDIA's Approach — Current State (June 2026)

NVIDIA's NemoClaw, announced at GTC 2026 (16 March 2026), represents the most systematically security-conscious agent stack to reach open source to date — a reference architecture built around isolation and policy enforcement as first-class primitives. We examine it as a case study in how the principles identified in §2 can be architecturally integrated. This section reflects the repository state as of June 2026, a substantial update from the v1.0-era launch materials on which earlier drafts relied.

NemoClaw (`github.com/NVIDIA/NemoClaw`, Apache 2.0) is an open-source reference stack for running OpenClaw and compatible agents inside **NVIDIA OpenShell** sandboxes. It is positioned within the broader NVIDIA agent ecosystem — and should not be conflated with the separately-maintained NeMo-Agent-Toolkit, an agent-orchestration library that is a distinct product. The `nemoclaw` CLI orchestrates the OpenShell gateway, sandbox containers, local-inference provisioning, and network policy in a single onboarding sequence. OpenShell itself is maintained as a separate, Rust-dominant repository (`github.com/NVIDIA/OpenShell`) on its own versioned release track — v0.0.67 as of 22 June 2026.

**Important caveats — stronger than at launch.** NemoClaw is explicitly **alpha software**. NemoClaw publishes no formal tagged releases (version tracking runs through GitHub Discussions, most recently a v0.0.60 stability round dated 5 June 2026); OpenShell's own documentation describes the runtime as a "proof-of-life" project in **"single-player mode,"** explicitly not architected for multi-tenant or hostile-boundary enterprise deployment. NVIDIA has a commercial interest in positioning the stack as the "secure" alternative to bare runtimes; the OpenShell layer adds complexity that is itself attack surface (see CVE-2026-24222, §5.7); and security claims remain largely unvalidated at production scale. Our analysis is based on the public repositories, NVIDIA developer documentation, and the April 2026 PSIRT bulletin.

### 5.2 OpenShell: Out-of-Process Policy Enforcement

The conventional approach to agent guardrails implements checks _within_ the agent process. OpenClaw's in-process code checks command permissions before execution — effective absent attacks, but fundamentally weak: the constrained process also enforces the constraint. A manipulated agent may influence or bypass in-process checks.

OpenShell places the policy engine in a **separate, privileged process**. The agent calls a restricted system-call interface; the OpenShell gateway intercepts, evaluates against policy, and permits or denies. The agent cannot access or modify its own policy. This is architecturally analogous to the Linux kernel's relationship with user-space processes, and — unlike the "browser-tab" framing discussed below — it is substantiated by concrete kernel primitives. OpenShell enforces four policy domains:

1. **Filesystem policy** — read/write path restrictions, locked at sandbox creation.
2. **Network egress policy** — deny-by-default outbound connections enforced via **Landlock, seccomp, and network namespaces**; hot-reloadable at runtime.
3. **Process policy** — blocks privilege escalation and dangerous syscalls; locked at sandbox creation.
4. **Inference-routing policy** — intercepts all model API calls and forwards them through a controlled backend; hot-reloadable.

A deny-all network baseline ships as the reference configuration, extended by operators through an approval flow. The release cadence shows active investment in this layer: credential rotation and AppArmor profile configuration (v0.0.57), JWT secret management (v0.0.56), high-availability multi-replica gateways (v0.0.62), and TLS certificate hot-reload (v0.0.65, 17 June 2026). This is a genuine deterministic control in the AEGIS sense — the constraint lives outside the constrained component.

### 5.3 The "Browser-Tab Model" — Metaphor, Not Mechanism

NVIDIA's materials describe session isolation using the phrase "browser-tab model." It is important to read this as an **architectural metaphor**, not a technical browser mechanism: there is no browser tab, extension API, or CDP-level component involved. The underlying implementation isolates each agent within a Linux container (Docker, Podman, MicroVM, or Kubernetes) subject to the four policy domains above; the sandbox can write only to `/sandbox` and `/tmp`, with system paths mounted read-only.

The practical implications hold regardless of the metaphor: a prompt-injected session cannot reach parallel sessions' state; malicious skills in one session cannot observe others; session tokens cannot be replayed across contexts. The isolation boundary is the container, mediated by the gateway.

### 5.4 Privacy Router — Three Tiers, but Cost-Tolerance Routing

NemoClaw's inference layer is a three-tier architecture, but the routing **mechanism** differs from the sensitivity-classification story told in launch coverage. The three tiers are **infrastructure tiers**, not data-sensitivity tiers:

- **Tier 1 — Cloud-hosted:** third-party API endpoints (NVIDIA `build.nvidia.com`, OpenAI, Anthropic, Gemini, and compatible proxies), including frontier models such as Claude Sonnet and Nemotron Ultra.
- **Tier 2 — Self-hosted / enterprise:** self-hosted NIM containers, NVIDIA AI Enterprise gateways, and local vLLM/SGLang/TRT-LLM or Ollama deployments (≈4B–120B), on operator-managed infrastructure.
- **Tier 3 — NemoClaw-managed local inference (experimental):** provisioned local inference on DGX Spark/Station or generic Linux hosts via a managed vLLM path, gated behind `NEMOCLAW_EXPERIMENTAL=1`.

The automated tier-selection is **cost-tolerance based**: operators set a numeric tolerance (0.0 = maximum accuracy, 1.0 = minimum cost; default 0.20) and the router picks within that quality-cost envelope. The widely repeated description of the router as _classifying query sensitivity to keep PII on local models_ reflects marketing materials and third-party write-ups — **it is not the mechanism in the product's own inference-configuration documentation as of June 2026.** This matters for §2.6: privacy routing remains a valid control _class_, but a deployment that needs PII-sensitivity routing must implement the classifier itself; NemoClaw does not provide it out of the box.

The genuine security guarantee NemoClaw _does_ provide here is **inference-path isolation**: the sandboxed agent communicates only with a local proxy endpoint (`inference.local`) and never contacts a provider directly. OpenShell intercepts at that endpoint and forwards based on operator configuration, with credentials held on the host and never exposed to the sandbox. A compromised agent therefore cannot exfiltrate credentials to an arbitrary endpoint or bypass the routing policy by dialing a provider directly. The routing decision is made out-of-process; the agent cannot override it.

### 5.5 Comparative Analysis

To avoid overstating the case study, we compare the two architectures along dimensions that matter for security review: policy separation, session isolation, data-routing enforcement, provenance guarantees, observability, operational burden, and failure modes. The point is not that NemoClaw is categorically superior. The point is that it makes several high-value security choices explicit at the architecture level rather than leaving them to individual operator discipline.

| Dimension                    | TinkerClaw (OpenClaw Fork)      | NemoClaw                            |
| ---------------------------- | ------------------------------- | ----------------------------------- |
| Policy enforcement           | In-process                      | Out-of-process (OpenShell)          |
| Session isolation            | None (shared memory)            | Browser tab model                   |
| Privacy routing              | Manual (if any)                 | Automatic, policy-driven            |
| Skill supply chain           | Community registry (unverified) | Signed manifests, hash verification |
| Self-modification prevention | User-configured                 | Mandatory, OpenShell-enforced       |
| Audit trail                  | Optional plugin                 | Mandatory log (format unspecified)  |

**What TinkerClaw does well:** Flexible tool permissions, SOUL.md behavioral baseline, easily-fixed WebSocket configuration, skill installation control with discipline.

**What NemoClaw adds worth adopting:**

1. Out-of-process policy enforcement — single most impactful architectural change
2. Automatic privacy routing — reduces inadvertent data exfiltration
3. Signed skill manifests — would have prevented the Cisco Talos incident
4. Session isolation — relevant for multi-session deployments

**What NemoClaw does worse:**

- **Complexity:** More moving parts = more potential bugs and operational overhead
- **Vendor lock-in:** NVIDIA NIM dependency ties privacy routing to NVIDIA hardware
- **Resource requirements:** Local model inference requires significant GPU investment
- **Adoption barrier:** Full OpenShell kernel is too complex for hobbyist-to-SME audiences
- **Unproven at scale:** Security claims lack production validation

### 5.6 Transferable Design Lessons

The most valuable lesson from NemoClaw is not any single product feature; it is the architectural principle that **security-critical policy should live outside the component being constrained whenever feasible**. Three transferable lessons follow:

1. **Move trust boundaries outward.** If the agent can edit or reinterpret the rule, the rule is weak.
2. **Make sensitive defaults structural.** Privacy routing, manifest scope, and immutable configuration are more robust when they are startup requirements rather than optional runtime conventions.
3. **Design for audit from day one.** Logging retrofitted after deployment is nearly always incomplete; auditability is easiest when action mediation and logging share a common choke point.

These lessons are applicable even in deployments that will never adopt NVIDIA's stack. A lightweight OpenClaw deployment can still emulate the principle through separate policy proxies, immutable manifests, host-level firewalls, and append-only audit logging.

### 5.7 Confirmed, Hedged, and Unresolved — A June 2026 Scorecard

Two further claims have since clarified. **Signed skill manifests are now shipped, not aspirational:** NVIDIA publishes a signed skill catalog (`github.com/NVIDIA/skills`) in which each skill carries an OMS detached signature (`skill.oms.sig`) verified against a root certificate (`nv-agent-root-cert.pem`), and the daily sync pipeline drops any skill missing its signature. This is a genuine artifact-integrity control — but only for NVIDIA-published skills; it does nothing for third-party or user-authored skills distributed outside the catalog. The **audit-trail** claim, by contrast, should be _downgraded_ in confidence: OpenShell logs allow/deny decisions and the log is described as tamper-evident and compliance-grade (one practitioner report claims it satisfied a SOC 2 auditor), but no public specification of storage format, retention, or the tamper-evidence mechanism exists as of June 2026. Treat it as functionally claimed, implementation-unverified.

The principal unresolved risk is **prompt injection**, and it is structural. The April 2026 NVIDIA PSIRT bulletin disclosed **CVE-2026-24222** (CVSS 8.6, CWE-497): prompt-injected content in the sandbox-initialization path could cause the agent to read and exfiltrate host environment variables (all versions before v0.0.18 affected). The root cause is not a NemoClaw bug per se but a property OpenClaw inherits — the control plane and data plane share one channel, so the pipeline that carries operator instructions also processes untrusted external content (email, web pages, fetched documents). No runtime sandbox resolves a semantic-layer vulnerability of this kind. Two further residual risks are documented: **identity sprawl** (a compromised agent inherits every credential it holds, regardless of sandbox depth — cf. §3.4), and the **absence of a multi-tenant trust boundary** (NemoClaw is not architected to isolate mutually-untrusted users sharing a gateway).

| Control claim                           | Shipped state (June 2026)                                          | Maturity                    |
| --------------------------------------- | ------------------------------------------------------------------ | --------------------------- |
| Out-of-process policy enforcement       | Confirmed: Landlock + seccomp + network namespaces                 | Alpha (OpenShell v0.0.67)   |
| Session isolation ("browser-tab model") | Confirmed: container-level; no browser mechanism                   | Alpha                       |
| Inference privacy routing               | Three-tier infra routing; cost-tolerance, _not_ PII-classification | Alpha / Tier-3 experimental |
| Signed skill manifests                  | Confirmed: `skill.oms.sig` + root cert, enforced in sync pipeline  | Shipped                     |
| Tamper-evident audit trail              | Functionally claimed; no public format/retention spec              | Unverified                  |
| Multi-tenant boundary                   | Explicitly out of scope ("single-player mode")                     | Not shipped                 |
| Prompt-injection prevention             | Structural gap; CVE-2026-24222 demonstrates exploitation           | Unresolved                  |

The net assessment is unchanged in direction but sharper in detail: NemoClaw is a materially stronger posture than bare OpenClaw for **single-operator** deployments, primarily through genuine out-of-process kernel-layer enforcement and inference-path isolation (deterministic Class 2.1–2.4 controls). It is **not** a complete enterprise security framework — it is alpha, single-operator-scoped, and leaves prompt injection, credential sprawl, and multi-tenancy open. Architects should treat it as a sound runtime-containment layer and apply separate probabilistic and governance controls for the semantic- and identity-layer risks it does not address.

---

## 6. The Broader Open-Source Agent-Security Landscape

AEGIS did not emerge in a vacuum. By mid-2026 a fast-specializing open-source ecosystem has formed around the same threat surface this paper targets — prompt injection and goal hijacking, skill supply-chain contamination, over-privileged execution, and missing runtime policy enforcement. This section surveys the principal projects, maps each onto the eight-class taxonomy (§2) and the AEGIS layers (§7), and asks whether the field is converging on a handful of mechanisms or genuinely innovating. The NemoClaw/OpenShell stack analyzed in §5 is one node in this landscape; here we situate it among its peers.

### 6.1 The Supply-Chain Escalation and Cisco's DefenseClaw

The Cisco Talos disclosure noted in §1.3 was an early signal. The threat soon escalated into a coordinated campaign — documented under the name **ClawHavoc** — in which on the order of a thousand malicious skills (independent counts range ≈900–1,184 across a handful of publisher accounts) were published to the community registry, using staged downloads, reverse shells, and credential-harvesting payloads (including the Atomic macOS Stealer) to exfiltrate browser credentials, keychains, SSH keys, and crypto-wallet data. The only gate at the time of the campaign was a registry account at least one week old — no static analysis, no signing, no review.

Cisco's operational response is **DefenseClaw** (`github.com/cisco-ai-defense/defenseclaw`, Apache 2.0; announced 23 March 2026, generally available 27 March 2026; v0.7.2 as of June 2026). It is three cooperating components: a **Python operator CLI**; a **Go gateway sidecar** that proxies the LLM path (LiteLLM-compatible), runs an OPA/Rego policy engine, and writes an append-only SQLite audit store with optional Splunk HEC / OTLP forwarding; and an **OpenClaw TypeScript plugin** that intercepts tool calls via OpenClaw's hook system and routes each through the gateway for a pre-execution policy verdict. Its **admission control** runs five scanners — Skill Scanner, MCP Scanner, A2A (agent-to-agent) Scanner, CodeGuard static analysis (secrets, dangerous exec, unsafe deserialization, weak crypto, injection patterns, risky file access), and the proprietary ClawShield — before any component loads. Its **runtime guardrails** inspect prompts, completions, and tool-call results against YAML rule packs, with an optional LLM judge for semantic policies that deterministic rules cannot express. Block/allow changes propagate in under two seconds without an agent restart — closing the "clean-on-Tuesday, exfiltrating-on-Thursday" window that static pre-deployment scanning misses.

In taxonomy terms, DefenseClaw is primarily a **Class 2.7 (audit and supply-chain)** and **Class 2.3 (programmatic guardrail)** control, with a probabilistic runtime-monitoring component. Crucially, it is a **bolt-on governance layer**: a plugin-plus-sidecar that wraps what OpenClaw admits and calls, but does not alter the execution environment or impose kernel-level constraints. This is the architectural inverse of NemoClaw/OpenShell (§5), which constrains the agent from _below_, at the OS layer. The two are complementary, not competing — DefenseClaw closes the supply-chain intake vector and supplies observability; OpenShell bounds the blast radius of anything that evades admission control. The AEGIS Swiss-cheese model (§7) accommodates both: DefenseClaw at the admission and audit slices, OpenShell at the isolation slices, neither sufficient alone. For the Tinkerer (Persona A) the five-minute DefenseClaw deployment is a meaningful supply-chain gain on its own; the Corporate persona (C) under SOX/GLBA audit needs both — DefenseClaw's policy-as-code audit trail for the governance-logging obligation, OpenShell's isolation for a defensible least-privilege standard.

### 6.2 The OpenClaw-Specific Tier: A Third Project, SecureClaw

A third OpenClaw-specific project, **SecureClaw** (Adversa AI; `github.com/adversa-ai/secureclaw`), makes one design choice worth singling out: it splits enforcement between a **plugin component that lives outside the agent's context window** and a skill component carrying ~15 behavioral rules. The out-of-band placement matters, because guardrails embedded _solely_ as a skill are themselves vulnerable to the prompt injection they exist to stop — an attacker who can inject can also instruct the model to ignore a skill-resident rule. SecureClaw runs ≈55 automated checks mapped to the OWASP Agentic Security Initiative Top 10, MITRE ATLAS, and CoSAI, with its skill held to ≈1,150 tokens to avoid context saturation, and is explicit that it makes injection "significantly harder," not solved — the honest framing AEGIS's probabilistic tier (§2.5) demands. Taken together the three OpenClaw-specific projects already instantiate the AEGIS geometry: NemoClaw the deterministic containment primitive, SecureClaw out-of-band audit and skill-layer rules, DefenseClaw dynamic admission control — distributed across three codebases with no integration contract between them.

### 6.3 Cross-Runtime Guardrail Frameworks

Several model- and runtime-agnostic frameworks apply to OpenClaw even though they were not built for it.

**Meta LlamaFirewall** (May 2025; arXiv:2505.03574) is the most architecturally differentiated. Three components run in sequence: PromptGuard 2 (a fine-tuned classifier for direct and indirect injection), **Agent Alignment Checks** (a chain-of-thought auditor that inspects the _reasoning trace_ for evidence that an injected instruction has been silently accepted into the plan), and CodeShield (online static analysis of generated code). The reasoning-trace auditor addresses a blind spot in every message-level guardrail surveyed here: a subtle indirect injection can produce a compliant-looking response while corrupting the agent's internal plan.

**Invariant Guardrails** (Invariant Labs) is a transparent proxy between the agent and its MCP servers or LLM provider that evaluates a Python-inspired rule language able to express **cross-tool dataflow constraints** — e.g. "raise if a `get_inbox` call is followed by a `send_email` to an external address." This if-this-then-that-across-tool-calls formalism is something single-prompt classifiers structurally cannot do, and it is the closest open-source analogue to a runtime _behavioral-invariant_ control.

**NVIDIA NeMo Guardrails** provides content-safety, PII, jailbreak, and topic rails around the inference API (multilingual/multimodal, with enterprise AIDR integration) — strong at the I/O boundary but without cross-turn dataflow awareness. **Lakera Guard** (acquired by Check Point, Sept 2025) offers ≈98% direct/indirect injection detection at sub-50 ms, model-agnostic — but is now a commercial component, not OSS, and exposes no policy language or tool-call visibility. **Rebuff** combines heuristics, an LLM detector, a vector store of known attacks, and **canary tokens**; the project is research-grade as of mid-2026, but the canary-token primitive (a sentinel value that must never appear in output) is a lightweight deterministic detector any deployment can layer on.

### 6.4 Execution Isolation and Supply-Chain Scanning

The sandboxing layer has consolidated around hardware-virtualization and OS-isolation primitives. **E2B** (Apache 2.0) provides managed Firecracker microVM sandboxes for AI-generated code — ephemeral, per-agent, ~150 ms startup, credentials injected as env vars never written to disk. **Microsandbox** (Zerocore AI, Apache 2.0) uses full microVM isolation with, distinctively, **native MCP-server integration** — the sandbox is invocable directly as an agent tool, no orchestration shim — making it the most practical drop-in for OpenClaw-style deployments. **gVisor** interposes a user-space kernel; architecturally sound but a weaker guarantee than full virtualization for executing untrusted code. **Microsoft MXC** (Build 2026, 2 June 2026) is an OS-kernel-enforced composable sandbox spectrum with explicit agent-identity semantics — significant, but Windows/WSL-only and post-dating this paper's earlier revisions.

On the scanning side: **NVIDIA Garak** (v0.15.0, May 2026) is the closest thing to a penetration-testing tool for LLM agents — 50+ probes including a new multi-turn GOAT probe and an Agent-breaker probe that tests tool-equipped agents, not just isolated model responses; it feeds other controls rather than enforcing policy. **Protect AI Guardian / Prisma AIRS** (Palo Alto Networks) scans serialized **model artifacts** for deserialization exploits and tampering — the model-loading equivalent of image signing, a layer distinct from skill supply-chain. **Microsoft's Agent Governance Toolkit** (MIT) is the most structurally complete OSS governance framework surveyed — a stateless policy engine (OPA Rego / Cedar), Ed25519 DID agent identity with trust scoring, and Ed25519 supply-chain signing — framework-agnostic and explicitly modeled on OS privilege rings and service-mesh identity, a close conceptual cousin of AEGIS. The **OWASP "Universal Skill Format"** proposal (draft v0.5, v1.0 targeted Q3 2026) would mandate Ed25519 signing, explicit permission allowlists, and content hashes per skill publication — certificate-transparency for skill registries, and the normative codification of the provenance controls AEGIS presupposes.

### 6.5 Comparative Snapshot

| Project                         | AEGIS layer / class                   | Core mechanism                                              | Type         | Novel vs. more-of-the-same           |
| ------------------------------- | ------------------------------------- | ----------------------------------------------------------- | ------------ | ------------------------------------ |
| **NemoClaw** (NVIDIA)           | Isolation + runtime policy (2.1–2.4)  | OpenShell container hardening, egress policy, CLI lifecycle | Det.         | Baseline the others build on         |
| **DefenseClaw** (Cisco)         | Admission + audit (2.7, 2.3)          | 5-scanner engine + LLM-path proxy; <2 s dynamic revocation  | Det. + Prob. | Complementary governance layer       |
| **SecureClaw** (Adversa)        | Out-of-band audit (2.5, 2.7)          | Plugin outside context window + skill rules; 55 checks      | Det. + Prob. | Novel: injection-resistant placement |
| **LlamaFirewall** (Meta)        | Plan integrity (2.5)                  | PromptGuard 2 + reasoning-trace auditor + CodeShield        | Prob. + Det. | **Novel: reasoning-trace auditing**  |
| **Invariant Guardrails**        | Behavioral invariants (2.3, 2.5)      | Proxy + cross-tool dataflow policy language                 | Det.         | **Novel: cross-tool dataflow rules** |
| **NeMo Guardrails** (NVIDIA)    | I/O filtering (2.5)                   | Configurable rails around inference API                     | Prob. + Det. | More-of-the-same vs. Lakera          |
| **Lakera Guard** (Check Point)  | I/O filtering (2.5)                   | Real-time classifier, 98%+, <50 ms                          | Prob.        | More-of-the-same; now commercial     |
| **NVIDIA Garak**                | Red-teaming (pre-deploy)              | 50+ probes incl. agentic Agent-breaker                      | Det. (scan)  | Novel in category: agentic scanner   |
| **Protect AI / Prisma AIRS**    | Model-artifact supply chain (2.7)     | Static scan of serialized model files                       | Det.         | Distinct layer; non-redundant        |
| **E2B / Microsandbox**          | Execution isolation (2.2)             | Firecracker microVM; Microsandbox adds MCP-native           | Det.         | Microsandbox MCP integration novel   |
| **MS Agent Governance Toolkit** | Full-stack governance (2.3, 2.7, 2.8) | OPA/Cedar engine, Ed25519 DID identity, signing             | Det.         | Novel: most complete OSS governance  |

### 6.6 Verdict — Convergence, with Two Open Frontiers

The ecosystem is **converging** on four foundational mechanism classes: (1) sandbox isolation at the hardware-virtualization or OS level; (2) out-of-process policy enforcement between the agent and its tools/inference; (3) supply-chain signing and admission control; and (4) runtime I/O classification. NemoClaw, DefenseClaw, and SecureClaw between them cover all four for OpenClaw — which is precisely the AEGIS defense-in-depth prescription, just split across three projects.

Two higher-order frontiers remain only sparsely occupied. The first is **cross-turn, dataflow-aware behavioral invariants** — policies that span multiple sequential tool calls rather than judging each message in isolation (Invariant Guardrails; the OPA/Cedar rules in Microsoft's toolkit). The second is **reasoning-trace auditing** — inspecting the chain-of-thought for a silently-accepted injection before it reaches a tool call (Meta LlamaFirewall's Agent Alignment Checks is, as of this writing, the only OSS implementation). Both target failure modes that proxy-level guardrails cannot see, and — tellingly — **neither is yet integrated into the OpenClaw-specific tooling tier.** The practical implication for an AEGIS deployment is that defense-in-depth today requires _intentional composition_ across at least three of these projects, and that the two genuinely novel mechanisms are worth adopting from the cross-runtime tier rather than waiting for an OpenClaw-native equivalent.

---

## 7. AEGIS: A Defense-in-Depth Architecture

### 7.1 The Swiss Cheese Model

The Swiss cheese model (Reason, 1990) visualizes each security control as a slice of cheese with holes. Individually, each slice has weaknesses. Layered together, the holes rarely align. AEGIS proposes seven deterministic slices, with the probabilistic layer as a general-purpose filter rather than a counted control:

```
    Attack Vector
         │
         ▼
   ┌─────────────┐  Layer 1: Network Controls
   │ Swiss Slice 1│  (firewall, VPN, port binding)
   └──────┬──────┘
          ▼
   ┌─────────────┐  Layer 2: Process Isolation
   │ Swiss Slice 2│  (container, capability manifest)
   └──────┬──────┘
          ▼
   ┌─────────────┐  Layer 3: Filesystem ACLs
   │ Swiss Slice 3│  (restricted user, AppArmor)
   └──────┬──────┘
          ▼
   ┌─────────────┐  Layer 4: Programmatic Guardrails
   │ Swiss Slice 4│  (allowlists, permission gates)
   └──────┬──────┘
          ▼
   ┌─────────────┐  Layer 5: Privacy Routing
   │ Swiss Slice 5│  (local model for sensitive data)
   └──────┬──────┘
          ▼
   ┌─────────────┐  Layer 6: Config Immutability
   │ Swiss Slice 6│  (root-owned config, read-only FS)
   └──────┬──────┘
          ▼
   ┌─────────────┐  Layer 7: Audit / Monitoring
   │ Swiss Slice 7│  (logging, anomaly detection, CVE scan)
   └──────┬──────┘
     DETECTED/BLOCKED
```

### 7.2 Layer Interactions

Each layer compensates for adjacent weaknesses:

- **Network controls** stop remote exploits but not locally-delivered attacks → **Process isolation** limits local attack scope.
- **Process isolation** is bypassed by kernel exploits → **Filesystem ACLs** at kernel level catch container escapes.
- **Filesystem ACLs** only protect listed paths → **Programmatic guardrails** restrict operations even on accessible paths.
- **Programmatic guardrails** can be circumvented by creative allowed-primitive combinations → **Privacy routing** ensures sensitive data stays off external APIs regardless.
- **Privacy routing** depends on classification accuracy → **Audit logging** provides visibility into routing decisions for post-hoc review.
- **Audit logging** is detection-only → **Self-modification prevention** ensures the audit mechanism can't be disabled before detection.

### 7.3 Worked Attack Simulation

To demonstrate AEGIS layer interactions concretely, we trace 10 representative attack scenarios through a Standard Configuration deployment:

| #   | Attack Scenario                                         | L1 Net      | L2 Proc     | L3 FS       | L4 Guard    | L5 Priv     | L6 Immut    | L7 Audit     | Result      |
| --- | ------------------------------------------------------- | ----------- | ----------- | ----------- | ----------- | ----------- | ----------- | ------------ | ----------- |
| 1   | CVE-2026-25253 remote WebSocket hijack                  | **BLOCKED** | —           | —           | —           | —           | —           | —            | ✓ Prevented |
| 2   | Malicious skill exfiltrates ~/.ssh                      | pass        | **BLOCKED** | —           | —           | —           | —           | —            | ✓ Prevented |
| 3   | Prompt injection → read /etc/shadow                     | pass        | pass        | **BLOCKED** | —           | —           | —           | —            | ✓ Prevented |
| 4   | Allowed tool chain → `git hook` → arbitrary exec        | pass        | pass        | pass        | **BLOCKED** | —           | —           | —            | ✓ Prevented |
| 5   | Client PII sent to frontier model in prompt             | pass        | pass        | pass        | pass        | **BLOCKED** | —           | —            | ✓ Prevented |
| 6   | Agent modifies SOUL.md to remove safety rules           | pass        | pass        | pass        | pass        | pass        | **BLOCKED** | —            | ✓ Prevented |
| 7   | Credential exfil via DNS tunneling                      | pass        | pass        | pass        | pass        | pass        | pass        | **DETECTED** | △ Detected  |
| 8   | Delayed-action memory injection (triggers next session) | pass        | pass        | pass        | pass        | pass        | pass        | **DETECTED** | △ Detected  |
| 9   | User rubber-stamps high-risk approval                   | pass        | pass        | pass        | pass\*      | pass        | pass        | **DETECTED** | △ Detected  |
| 10  | Compromised local model exfiltrates data it processes   | pass        | pass        | pass        | pass        | pass        | pass        | pass         | ✗ Gap       |

**Results:** 6/10 prevented, 3/10 detected (enabling response), 1/10 represents a genuine gap (compromised local model — requires model integrity verification not yet in AEGIS).

\*Scenario 9 note: With approval fatigue mitigations (§2.3.1), this could be prevented rather than merely detected.

This simulation demonstrates two key properties: (a) no single layer is sufficient — each attack that passes one layer is caught by a subsequent one; (b) the architecture degrades gracefully — even when prevention fails, detection enables response.

### 7.4 Reference Configurations

Before listing configurations, one principle deserves emphasis: **removing access is often more effective than hardening access**. When an asset does not need to be in the agent's reachable set, scope reduction should take priority over layered protection. This is especially important for Persona C, where several risks are better solved by access withdrawal than by compensating controls.

**Minimal Configuration (15 minutes):**

1. Bind WebSocket to `127.0.0.1`
2. Verify all installed skills; remove unrecognized ones
3. AppArmor profile denying `~/.ssh`, `~/.gnupg`, crypto seed files
4. Set agent workspace to `~/agent-workspace` rather than home directory

**Standard Configuration (2–4 hours):**
All of Minimal, plus: 5. Dedicated `openclaw-agent` system user 6. Docker container with workspace bind-mount only 7. `iptables` egress rules: LLM API IPs only 8. Privacy routing: sensitive directories → local Ollama instance 9. Root-owned, read-only SOUL.md and AGENTS.md 10. Cron security scan for skill changes, permission drift, CVE updates

**Enterprise Configuration (formal security review):**
All of Standard, plus: 11. Out-of-process policy enforcement 12. Per-session isolation for multi-agent workflows 13. Enterprise DLP integration for data classification 14. Signed skill manifests with corporate PKI 15. Tamper-evident audit trail 16. IT security review and change management approval 17. Penetration testing of agent deployment 18. Employee prompt injection awareness training

**Cost considerations:** The Standard Configuration has negligible ongoing cost beyond initial setup. The Enterprise Configuration requires: GPU investment for local model inference (privacy routing) — approximately $2,000–$10,000 for adequate hardware; staff time for security review and ongoing governance; potential NemoClaw licensing costs. Organizations should weigh these against the cost of the risk scenarios in §4.

---

## 8. Mapping AEGIS to ISO/IEC Security Standards

A recurring practitioner question is where agent and LLM security "fits" for an organization that already holds a cybersecurity certification. This section maps AEGIS onto the ISO/IEC control vocabulary so that an ISO/IEC 27001-certified organization can see exactly which agent-security layers extend an existing control objective and which introduce a genuinely new one.

### 8.1 Bridging the AEGIS Taxonomy to the ISO/IEC Vocabulary

AEGIS stratifies its eight strategy classes along a deterministic–probabilistic axis. Deterministic controls (Classes 2.1–2.4) enforce invariants with binary, auditable outcomes regardless of model behavior; probabilistic controls (Classes 2.5–2.8) reduce likelihood or impact but cannot guarantee outcomes against all inputs. This maps naturally onto ISO/IEC 27002:2022's control _attributes_: deterministic controls correspond to _preventive_ and _detective_ attributes, probabilistic controls to _corrective_, _directive_, and _compensating_ ones. ISO/IEC 27001:2022 does not require controls to be purely technical — Clause 6.1.3 explicitly contemplates treating risk through a combination of organizational policy, technical enforcement, and continuous monitoring. AEGIS operationalizes exactly that layered treatment.

### 8.2 The Eight Strategy Classes Mapped to Annex A and ISO 42001

The table maps each AEGIS class to the most directly applicable ISO/IEC 27001:2022 Annex A controls (elaborated in ISO/IEC 27002:2022) and the corresponding ISO/IEC 42001:2023 (AI management system) control. The final column states whether the class is "new evidence for an existing objective" or a "genuinely new objective."

| AEGIS Class                          | Primary ISO 27001:2022 Annex A controls                                                                                | ISO 42001:2023 control                                                            | Evidence nature                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **2.1 Filesystem ACLs**              | A.5.15 (access control); A.5.18 (access rights); A.8.2 (privileged access); A.8.3 (information access restriction)     | A.6.1.2 (least-privilege design)                                                  | Existing objective; new evidence (agent as an access-control principal)                                                            |
| **2.2 Process Isolation**            | A.8.22 (segregation of networks); A.8.27 (secure architecture); A.8.31 (separation of environments)                    | A.6.2.5 (deployment isolation/rollback)                                           | Existing objective; new evidence (agent runtime as isolated execution context)                                                     |
| **2.3 Programmatic Guardrails**      | A.8.26 (application security requirements); A.8.28 (secure coding); A.8.29 (security testing)                          | A.6.1.3, A.6.2.4 (responsible design; verification & validation)                  | Partially new: guardrails over non-deterministic outputs are a new audit artefact                                                  |
| **2.4 Network Controls**             | A.8.20 (network security); A.8.21 (network services); A.8.22; A.8.23 (web filtering)                                   | A.6.2.6 (operation & monitoring)                                                  | Existing objective; new evidence (per-agent egress as a segment boundary)                                                          |
| **2.5 Prompt-Level Rules**           | A.8.26 (input validation); A.5.7 (threat intelligence); A.5.37 (documented operating procedures)                       | A.6.1.2; A.9.1 (responsible/acceptable use)                                       | **Genuinely new objective**: no ISO 27001 control governs natural-language policy or prompt injection                              |
| **2.6 Privacy Routing**              | A.5.34 (PII protection); A.8.11 (data masking); A.8.12 (DLP); ISO/IEC 27018 (PII in public cloud)                      | A.7.2, A.7.4 (data privacy & quality)                                             | Existing objective; new evidence (runtime PII classifier as a DLP enforcement point for model APIs)                                |
| **2.7 Audit & Supply Chain**         | A.5.19, A.5.21, A.5.23 (supplier/ICT-supply-chain/cloud); A.8.15 (logging); A.8.16 (monitoring); ISO/IEC 27017 (cloud) | A.7.5 (data provenance); A.6.2.8 (event logs); A.10.3 (AI supplier due diligence) | Existing objective; **new evidence** (model provenance and training-data lineage as supply-chain artefacts under A.5.21)           |
| **2.8 Self-Modification Prevention** | A.8.9 (configuration management); A.8.19 (software installation control); A.8.32 (change management)                   | A.6.2.3, A.6.2.7 (design record; technical documentation)                         | **Genuinely new objective**: no ISO 27001 control anticipates a component that tries to modify its own operating policy at runtime |

### 8.3 What ISO/IEC 42001:2023 Adds That ISO/IEC 27001:2022 Does Not

ISO/IEC 27001:2022 is a general-purpose ISMS standard designed for systems with deterministic, human-authored logic. An autonomous agent has four structural properties outside its control catalogue. **(1) The risk perimeter exceeds the CIA triad.** ISO 42001 introduces _fairness_, _transparency/explainability_, _safety_, and _societal impact_ as independently auditable categories (Annex A.5.4–A.5.5); bias drift in an agent making decisions about individuals is a compliance failure no asset- or event-based ISO 27005 threat scenario surfaces. **(2) The AI lifecycle needs dedicated governance.** ISO 27001 covers the SDLC (A.8.25–A.8.31), but model lifecycle — data acquisition, training, fine-tuning, evaluation, deployment, _drift monitoring_, re-evaluation, retirement — is not a subset of it; ISO 42001 A.6.2.6 requires drift detection and periodic re-evaluation, an obligation ISO 27001 (which presumes a deployed system behaves as specified) lacks. **(3) Transparency is formally required.** ISO 42001 mandates model cards, user disclosures, and decision logging (Annex A.8); ISO 27001 logs (A.8.15) but never requires _explaining a system's decisions_ to affected parties. **(4) AI-supplier due diligence exceeds SLAs.** ISO 42001 A.10.3 requires assessing a supplier's training-data provenance, bias-mitigation, and retraining cadence — so an organization using a foundation-model API must treat that model's training corpus as a supply-chain risk artefact, a requirement absent from ISO 27001.

The relationship is therefore complementary, not substitutive: ISO/IEC 27001 establishes the organizational security baseline; ISO/IEC 42001 establishes the AI-specific governance layer; neither alone is sufficient for a mature agentic deployment. ISO/IEC 23894:2023 supplies the tactical AI risk-management procedures (as ISO/IEC 27005 does for 27001), and the NIST AI RMF (2023, with a 2024 Generative-AI profile) offers a voluntary cross-reference whose Govern/Map/Measure/Manage functions map onto the plan-do-check-act structure shared by all three ISO standards.

### 8.4 Practical Guidance: New Evidence vs. New Objectives

An organization holding ISO/IEC 27001:2022 already has a Statement of Applicability (SoA) and an evidence programme. The practical question is which AEGIS controls need only _new evidence_ and which need _new control objectives_. **New evidence for existing objectives:** most deterministic AEGIS controls (2.1–2.4, partly 2.7) satisfy existing Annex A objectives — what changes is the _form_ of evidence (the principal is an agent identity; the network segment is the per-agent egress policy; the log artefact includes tool-call receipts and model-turn records; the supply-chain artefact extends to model provenance). Amend the SoA commentary, brief the certification body at the next surveillance audit, and add the agentic runtime to the scope statement — no new controls formally required. **Genuinely new objectives:** Class 2.5 (prompt-level rules) and Class 2.8 (self-modification prevention) have no precedent in ISO 27001 — prompt injection is categorically different from the input-validation flaws A.8.26 addresses, and runtime self-modification has no SDLC or configuration-management analogue. Register these as additional controls in the SoA, justified by an ISO 42001 AI system impact assessment (AIIA), with corresponding policy, technical evidence (prompt-governance procedures, integrity checks), and testing artefacts (adversarial red-team results, self-modification-barrier test logs).

For organizations not yet 42001-certified, the AIIA process is the most efficient mechanism to scope which AEGIS layers need new objectives; running ISO/IEC 23894's event-based risk identification against the agent's tool inventory and autonomy profile, then mapping results to both the 27001 SoA and the 42001 Annex A, avoids duplicating risk-assessment effort. The safety-capability-autonomy trilemma (§1.1) has a direct normative counterpart here: **ISO 27001 manages the safety floor; ISO 42001 manages the autonomy-induced risks a static floor cannot contain; ISO/IEC 23894 supplies the ongoing measurement to tell whether capability gains in successive model versions have outpaced the controls in place.**

---

## 9. Frontier APIs and the Fear of Training a Model of Your Business

A persistent concern among organizations evaluating frontier APIs is that a provider such as Anthropic or OpenAI will ingest proprietary queries and documents, distil a model of the organization's business, and eventually leak it to competitors or use it to compete directly — whereas a local model or Copilot supposedly keeps data "within." This section weighs the empirical and contractual evidence, separates the genuine risk from the misconception, and ties the residual risk to the framework's controls.

### 9.1 The Memorization Literature: What It Actually Shows

The evidence for training-data leakage from LLMs is real but systematically misread in enterprise risk discussions. The key studies concern memorization of _public training-corpus text_, not re-use of API customer inputs.

Carlini et al. (2021) established the foundational result: with enough queries and the right prompt strategy, an adversary can extract verbatim passages that appeared in a model's _pre-training corpus_. Nasr, Carlini et al. (2023, arXiv:2311.17035) scaled this to production: prompting ChatGPT to repeat a word indefinitely (the "divergence attack") broke its alignment-constrained mode and emitted pre-training text — previously public web and news content — at roughly 150× the normal rate, showing alignment suppresses but does not eliminate memorization. Cooper et al. (2025, arXiv:2505.12546) extended this to books: of 14 open-weight models across 200 titles, Llama 3.1 70B had memorized some so thoroughly — including _Harry Potter and the Sorcerer's Stone_ — that a few prompt tokens deterministically reproduced near-verbatim text. Analysis of the _New York Times v. OpenAI_ complaint (filed Dec 2023) found verbatim reproduction scales super-linearly above ~100B parameters and correlates with training-corpus duplication — but also that the plaintiff's attorneys needed tens of thousands of adversarial attempts to elicit the excerpts, and that both OpenAI and Anthropic deploy output filters to suppress verbatim reproduction even where the model has memorized the text.

**The critical distinction.** In every case, what is extracted is material the model met during _pre-training on large public datasets_ — web text, digitized books, news archives. The threat model is (a) an adversary probing a deployed model to recover previously-public data it happens to have memorized, or (b) a rightsholder demonstrating training on their works. Neither describes a provider _training on a specific organization's API inputs_ and then leaking them to a competitor. The two risks are categorically different: one is a property of the pre-training corpus; the other would require a provider to deliberately or negligently repurpose live customer traffic — which, as the next section shows, the commercial contracts prohibit. The much-cited "it can complete Harry Potter" demonstration is evidence of the _former_, and tells you nothing about the latter.

### 9.2 What the Contracts Actually Say

**Anthropic.** The commercial terms for the Claude API, Team/Enterprise plans, and Claude via Amazon Bedrock or Google Vertex contain an explicit prohibition: Anthropic does not train models on customer content from these services. API inputs/outputs are retained for a short abuse-screening window (reduced to seven days in late 2025) and never used for training; organizations with qualifying use-cases may, subject to Anthropic approval, execute a Zero Data Retention (ZDR) addendum that discards prompts and outputs immediately after each request. Anthropic's commercial offering holds ISO/IEC 27001:2022, ISO/IEC 42001:2023, and SOC 2 Type II, with a DPA incorporated for GDPR/UK-GDPR and Standard Contractual Clauses for transfers. **The crucial caveat:** Anthropic's _consumer_ terms (updated August 2025) now permit training on Claude.ai consumer conversations unless the user opts out — this does **not** apply to commercial, API, or enterprise tiers. An employee using a personal Claude.ai account for work is thus governed by the consumer policy, not the enterprise prohibition.

**OpenAI.** The API platform has not used inputs/outputs to train models by default since 1 March 2023; ChatGPT Enterprise, Teams, and the API are excluded from training by default. Default abuse logs are retained ~30 days; ZDR is available for eligible enterprise endpoints. The consumer/enterprise split mirrors Anthropic's.

**Microsoft 365 Copilot.** Microsoft states that prompts, responses, and Microsoft Graph data are not used to train the foundation models behind M365 Copilot; requests route through Azure OpenAI (not the public service), customer content is not cached or shared with OpenAI, and EU tenants are covered by the EU Data Boundary. **A material subprocessor gap, however:** when Anthropic models are used within M365 Copilot experiences, they fall _outside_ the EU Data Boundary and in-country processing commitments — EU-regulated organizations relying on residency assurances must scrutinize this before enabling Anthropic-powered Copilot features.

The pattern across all three is consistent: **enterprise/API tiers offer contractual no-training-by-default positions, DPAs, and optional zero-retention; consumer free tiers do not.** The "they will train a model of our business" fear is most accurately a **mis-tiering** risk — employees bypassing enterprise licensing for consumer products that carry weaker protections.

### 9.3 Residual Risks the Contracts Cannot Eliminate

Four residual risks remain regardless of tier. **Provider breach** — providers hold recent traffic during the retention window; an incident there exposes it. Inference-server vulnerabilities (vLLM, TensorRT-LLM, and others have had critical flaws) are not hypothetical. The privacy-routing layer (§2.6) — keeping the highest-sensitivity classes on local/on-prem inference — directly mitigates this. **Mid-flight interception** — TLS-inspected enterprise networks and boundary devices; certificate pinning and the gateway controls of §2.3 apply. **Mis-tiered usage** — a consumer account used for work; the governance controls of §2.7 and per-user agent profiles of §3.4 apply. **Subprocessor exposure** — both providers use infrastructure subprocessors; GDPR Art. 28(4) requires back-to-back obligations, so subprocessor lists should be reviewed periodically, especially for EEA transfers. In the event an exposure does occur, the incident-response checklist (§2.7.2) and the GDPR 72-hour notification obligation (§3.2.1) govern the response — this paper's earlier sections already answer "what happens in a leak."

### 9.4 The Local-Model Alternative: A Different Threat Surface, Not a Smaller One

Self-hosted inference eliminates training-data exfiltration for live traffic — there is no provider to train on prompts that never leave the premises, a genuine gain for highly regulated or genuinely-secret workloads. But it introduces an under-estimated risk surface. OWASP LLM03:2025 (Supply Chain) identifies **model-weight compromise** as a primary self-hosting threat: backdoored weights have been distributed through public repositories, and research shows as few as ~250 poisoned documents can implant a robust backdoor with no capability degradation that evaluation would catch. A compromised local model does not exfiltrate to a provider — but it may exfiltrate to an adversary, inject fabricated outputs downstream, or serve as a persistent foothold. This is precisely the residual gap in the worked simulation (§7.3, scenario 10): local inference is not equivalent to _secure_ inference. Local deployment must add weight-provenance verification (cryptographic signatures from the originating lab), integrity monitoring, and controlled fine-tuning pipelines as compensating controls.

### 9.5 Summary Assessment

The fear that frontier providers will train a proprietary model of an enterprise's business and weaponize or leak it is **not supported by current contractual or technical evidence for commercial tiers.** The strongest empirical argument for provider-side leakage — the memorization literature — concerns reproduction of _public pre-training text_, not re-use of enterprise API inputs; and the commercial no-training-by-default positions of Anthropic, OpenAI, and Microsoft are unambiguous, backed by DPAs, independent audits, and optional zero-retention. The genuine residual risks — provider breach in the retention window, mid-flight interception, employee mis-tiering, and subprocessor gaps (notably EU data residency) — are real, bounded, and addressable through the AEGIS stack (§2.6, §2.3, §2.7, §3.4). The local-model alternative _shifts_ the threat surface from training-data exfiltration to supply-chain and weight-integrity risk; it does not eliminate it.

---

## 10. Conclusions and Recommendations

### 10.1 The Fundamental Insight

**Probabilistic controls alone are insufficient for any deployment where failure consequences are materially significant.** Every behavioral rule, every system prompt, every SOUL.md guideline is a probabilistic control — effective absent adversarial pressure, unreliable under it. This does not make probabilistic controls useless; it makes them misclassified when operators treat them as if they were equivalent to sandboxing, policy separation, or filesystem denial.

The incidents in §1.3 all involved deployments where consequences were significant but architecture was probabilistic. CVE-2026-25253 was a technical vulnerability, but 40,000 exposed instances represent a governance failure. The malicious skills attack succeeded because installation required no deterministic verification. The email deletion was the predictable result of granting irreversible capability to a system with only probabilistic constraints.

### 10.2 Per-Persona Security Profiles

**Persona A — Minimum Viable (15 min):** Bind to 127.0.0.1; AppArmor denying ~/.ssh and crypto seed files. Addresses the two highest-risk scenarios.

**Persona A — Recommended:** Standard Configuration (§7.4). Docker container, workspace restriction, egress firewall, skill verification. Total: 2–3 hours.

**Persona B — Minimum Viable (3–4 hours):** All Persona A minimum plus: privacy routing for client directories to local model; per-session confirmation gate for email sends and file writes outside workspace; GDPR data inventory.

**Persona B — Recommended:** Standard Configuration plus: explicit client consent policy for AI-assisted work; quarterly agent access scope audit; regulatory mapping (§3.2.1) review.

**Persona C — No "Minimum Viable" exists.** The described configuration cannot be made acceptably secure through hardening alone. Minimum action: **restrict agent access scope** — remove corporate network shares, production credentials, privileged email — before any technical control. With properly scoped agent, apply Standard Configuration plus Enterprise egress firewall and audit logging.

**Persona C — Enterprise-Grade:** Full Enterprise Configuration (§7.4) via formal change management. Document in IT asset register, include in penetration test scope, govern through standard access control review.

### 10.3 The Trilemma as a Design Tool

Every agent deployment implicitly chooses a position in the safety-capability-autonomy trilemma (§1.1). Our per-persona recommendations:

- **Personal productivity:** High capability + High autonomy + Moderate safety (deterministic controls on highest-risk data only)
- **Professional/freelance:** High capability + Moderate autonomy (human gates on external actions) + High safety (deterministic controls on all client data)
- **Corporate/regulated:** Moderate capability (scoped action space) + Low autonomy (human approval on material actions) + High safety (full AEGIS stack)

A useful operational restatement is: **first decide what the agent is allowed to touch, then decide what it is allowed to do, and only then decide how autonomous it may be**. Reversing that order is how teams end up with highly autonomous agents whose access scope was never deliberately designed.

The agent era will not produce secure deployments by default. It will produce them by design — by deliberate architectural choices made by practitioners who understand what they are building and what failure costs. We hope this framework contributes to that understanding.

---

## 11. Limitations

This analysis has several important limitations:

1. **No empirical validation.** AEGIS has not been tested against real attack campaigns. The worked simulation (§7.3) is a thought experiment based on known attack patterns, not an empirical measurement. Future work should include red-team exercises against AEGIS-configured deployments.

2. **Qualitative risk scores.** Despite our calibration methodology (§4), probability and severity ratings remain expert judgment. They have not been validated against a statistically significant incident database. Different experts would likely assign somewhat different scores.

3. **OpenClaw-centric analysis.** The taxonomy and personas are grounded in the OpenClaw ecosystem. Applicability to other agent runtimes (LangChain, AutoGPT, CrewAI, custom enterprise frameworks) requires validation. The security strategy classes are likely generalizable; the specific implementation guidance is not.

4. **Taxonomy completeness.** We argue completeness against the STRIDE+agent threat model (§1.4), but novel threat categories may emerge as agent capabilities evolve. The taxonomy should be treated as a living framework, not a closed enumeration.

5. **Desktop/server focus.** The analysis assumes desktop or server deployments. Mobile agent deployments (OpenClaw mobile) and edge/IoT deployments have different constraint profiles — limited OS-level controls, different isolation primitives, and unique network characteristics — that are not addressed here.

6. **Snapshot in time.** Agent runtimes, model capabilities, and attack techniques evolve rapidly. Specific CVEs, tools, and architectural details will date. The framework's principles should outlast its specifics.

7. **Boundary ambiguity between control classes.** Some controls are hybrids. Privacy routing combines deterministic mediation with probabilistic classification; approval systems combine hard technical gates with soft human judgment. The deterministic/probabilistic distinction is still useful, but not perfectly binary in implementation.

8. **Case-study dependence.** The NemoClaw discussion is illustrative, not determinative. The architecture is used to surface principles, not to crown a winner among runtimes.

## 12. Future Work

Several research directions would strengthen or falsify this framework:

1. **Red-team validation.** Run controlled adversarial exercises against deployments configured according to Minimal, Standard, and Enterprise AEGIS profiles.
2. **Longitudinal incident corpus.** Build a shared database of agent incidents and near misses so risk scoring can be calibrated with stronger empirical footing.
3. **Control interaction measurement.** Quantify which layers reduce marginal risk most effectively for given personas, rather than assuming equal value across contexts.
4. **Approval UX experiments.** Measure approval fatigue, cancellation rates, and false approvals under different permission-gate designs.
5. **Model integrity verification.** Extend AEGIS to better cover the residual gap identified in §7.3: compromise of the local model or classifier itself.
6. **Cross-runtime validation.** Test whether the taxonomy transfers cleanly to LangChain-style, browser-native, mobile, and enterprise orchestrator deployments.

---

## 13. Related Work

**OWASP Top 10 for LLM Applications (2025)** provides a vulnerability-focused taxonomy for LLM-powered applications, covering prompt injection, insecure output handling, and training data poisoning. AEGIS differs in focusing specifically on _agentic_ systems (tool use, action execution, multi-step autonomy) rather than LLM applications generally, and in providing a layered defense architecture rather than a vulnerability list.

**MITRE ATT&CK for AI/ML (2025)** extends the ATT&CK framework to AI/ML systems, enumerating adversary techniques. AEGIS uses STRIDE rather than ATT&CK as its primary threat modeling framework because STRIDE better maps to the _defensive_ strategy classes we propose; ATT&CK's offensive framing is complementary but serves a different purpose.

**Perez & Ribeiro (2022)** on prompt injection attacks established the foundational understanding of why prompt-level controls are insufficient. AEGIS builds on this by providing the deterministic/probabilistic classification framework and concrete architectural alternatives.

**Reason (1990)** originated the Swiss cheese model for aviation safety. Our adaptation to agent security preserves the model's core insight — layered imperfect controls achieve what no single control can — while mapping it to a software-specific control hierarchy.

No prior work to our knowledge provides an integrated security framework specifically for autonomous AI agents that spans from OS-level controls to behavioral rules, includes formal persona-based risk analysis, and proposes a concrete defense-in-depth architecture. AEGIS aims to fill this gap.

---

## Acknowledgments

The authors thank the OpenClaw security research community, the Cisco Talos team for their supply chain attack disclosure, and the anonymous security researchers who responsibly reported CVE-2026-25253. The analysis of NemoClaw architecture is based on publicly available NVIDIA GTC 2026 presentation materials and technical documentation.

---

## References

_Reference note:_ Several sources cited here are industry reports, advisories, keynote materials, or technical documentation rather than peer-reviewed papers. That mix is deliberate because the agent security field is moving faster than the formal literature. Where claims rely on non-peer-reviewed material, the paper treats those claims as operational evidence rather than settled scientific fact.

Bau, D., et al. (2020). "Rewriting a Deep Generative Model." _ECCV 2020_.

Carlini, N., et al. (2021). "Extracting Training Data from Large Language Models." _USENIX Security 2021_.

CISCO Talos Intelligence Group. (2025). "Malicious OpenClaw Skills: Supply Chain Attack Analysis." _Talos Blog_, October 2025.

CVE-2026-25253. (2026). "OpenClaw WebSocket Origin Validation Bypass — Zero-Click Remote Code Injection." _National Vulnerability Database_, February 2026.

Gartner Research. (2026). "AI Agent Runtime Adoption in Enterprise Environments: Survey Data Q4 2025." _Gartner Technical Report_.

Huang, J. (2026). Keynote Address, GTC 2026. NVIDIA Corporation, March 2026.

Mitre ATT&CK. (2025). "Techniques for AI/ML Systems." _MITRE ATT&CK Framework v16_.

NVIDIA Corporation. (2026). "NemoClaw Security Architecture Reference Guide v1.0." _NVIDIA Developer Documentation_.

OWASP. (2025). "OWASP Top 10 for Large Language Model Applications v2.0." _Open Web Application Security Project_.

Perez, F., & Ribeiro, I. (2022). "Ignore Previous Prompt: Attack Techniques for Large Language Models." _Workshop on Trustworthy NLP, NeurIPS 2022_.

Reason, J. (1990). _Human Error_. Cambridge University Press.

Serra, O. (2026). "The Wondering Machine: Curiosity, Memory, and the Architecture of Self-Improving Language Models." _J-Series AI Research Reports_, Paper J8.

Shadowserver Foundation. (2026). "CVE-2026-25253 Patch Adoption Survey: 30-Day Follow-Up." _Shadowserver Blog_, March 2026.

Stamper, T. (2025). "Meta Internal Security Advisory: OpenClaw on Corporate Devices." _Leaked via Information Security community, January 2026_.

Yao, S., et al. (2023). "ReAct: Synergizing Reasoning and Acting in Language Models." _ICLR 2023_.

Ziegler, D., et al. (2019). "Fine-Tuning Language Models from Human Preferences." _arXiv preprint arXiv:1909.08593_.

Nasr, M., Carlini, N., et al. (2023). "Scalable Extraction of Training Data from (Production) Language Models." _arXiv:2311.17035_.

Cooper, A. F., Lemley, M., et al. (2025). "Extracting Memorized Pre-Training Data from Open-Weight Language Models." _arXiv:2505.12546_.

Anthropic. (2026). "Commercial Terms of Service" and "Trust Center." https://www.anthropic.com/legal/commercial-terms ; https://trust.anthropic.com/ (accessed June 2026).

OpenAI. (2026). "Enterprise Privacy and API Data Usage Policies." https://openai.com/enterprise-privacy/ (accessed June 2026).

Microsoft. (2026). "Data, Privacy, and Security for Microsoft 365 Copilot." _Microsoft Learn_ (accessed June 2026).

OWASP Gen AI Security Project. (2025). "LLM03:2025 — Supply Chain." _OWASP Top 10 for LLM Applications_. https://genai.owasp.org/llmrisk/llm032025-supply-chain/

Cisco. (2026). "Announcing DefenseClaw: Open-Source Security Governance for Agentic AI." _Cisco Blogs / Cisco AI Defense_, March 2026. https://github.com/cisco-ai-defense/defenseclaw

NVIDIA. (2026). "NemoClaw and OpenShell." _GitHub_. https://github.com/NVIDIA/NemoClaw ; https://github.com/NVIDIA/OpenShell (accessed June 2026).

Meta AI. (2025). "LlamaFirewall: A Guardrail Framework for AI Agents." _arXiv:2505.03574_.

Invariant Labs. (2026). "Invariant Guardrails." _GitHub_. https://github.com/invariantlabs-ai/invariant

ISO/IEC. (2022). _ISO/IEC 27001:2022 — Information security management systems — Requirements_; _ISO/IEC 27002:2022 — Information security controls_. International Organization for Standardization.

ISO/IEC. (2023). _ISO/IEC 42001:2023 — Artificial intelligence — Management system_; _ISO/IEC 23894:2023 — Artificial intelligence — Guidance on risk management_.

NIST. (2023). _AI Risk Management Framework (AI RMF 1.0)_; Generative AI Profile (2024). National Institute of Standards and Technology.

---

## Appendix A: AEGIS Quick-Reference Checklist

### Immediate Actions (Any Deployment)

- [ ] Bind WebSocket to `127.0.0.1`
- [ ] Verify all installed skills against known-good sources
- [ ] Review agent's current filesystem access scope

### Tinkerer (Persona A) — Standard

- [ ] AppArmor profile denying `~/.ssh`, `~/.gnupg`, crypto seed files
- [ ] Docker container with workspace bind-mount only
- [ ] Egress firewall: allow LLM API IPs only
- [ ] Root-owned, read-only SOUL.md and AGENTS.md

### Freelancer (Persona B) — Standard

- [ ] Privacy routing: local model for client data directories
- [ ] Human gate on all external communications
- [ ] GDPR data inventory and regulatory mapping review
- [ ] Client data in separate directory excluded from agent workspace
- [ ] Skill hash verification
- [ ] Client consent/disclosure policy for AI-assisted work

### Corporate (Persona C) — Scope First, Then Harden

- [ ] **BEFORE ANY HARDENING:** Remove agent access to corporate network shares, production credentials, privileged email
- [ ] IT security review and documentation
- [ ] Enterprise Configuration (§7.4) via formal change management
- [ ] Include in penetration test scope
- [ ] Evaluate NemoClaw out-of-process enforcement adoption
- [ ] Prompt injection awareness training for agent users

---

_Paper J9 — AEGIS: A Multi-Layered Security Framework for Autonomous AI Agents_
_Author: Oscar Serra | Date: 2026-06-23 | Version: 2.0_
_Workspace: J-Series AI Research Papers | Series: J9_agent_security_
_v2.0 changes: refreshed the NemoClaw/OpenShell case study to its June 2026 repository state; added §6 (broader open-source landscape, incl. Cisco DefenseClaw); added §8 (ISO/IEC 27001 & 42001 mapping); added §9 (frontier-API training-data evidence and contracts)._
