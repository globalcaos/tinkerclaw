# company-hd — security model & write rollout

Grounded in J9 (_AEGIS: A Multi-Layered Security Framework for Autonomous AI Agents_,
`~/src/tinkerclaw/docs/papers/agent-security/agent-security.md`). Read this before proposing to
enable any write capability.

## The threat we are designing against

J9's **Inbox-Zero incident**: an agent with email access read "clear out the old stuff" as
authorization and permanently deleted ~6,500 emails. No confirmation, unrecoverable. That is the
exact failure class here — a corporate NAS where one wrong `rm`/overwrite on a Tier-1 folder
destroys engineering IP or compliance records.

J9's load-bearing finding: **probabilistic controls are insufficient where failure has material
consequences.** A "you are read-only, be careful" rule in a system prompt is rated **2/5** — it
holds absent adversarial pressure and fails under it (prompt injection, context overflow,
rationalization). A control enforced in code, outside the model, is **4/5**. So the read-only
guarantee here lives in code, not in this paragraph.

## Defense in depth (which J9 layer each piece is)

| Layer                     | Mechanism here                                                                                                | J9 §   | Rating       | Status                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------- | ------ | ------------ | ---------------------------- |
| Programmatic guardrail    | `company-hd` CLI is the only sanctioned path; **no enabled write code path exists**; write verbs refuse + log | §2.3   | 4/5          | ✅ live                      |
| Path confinement          | every path resolved + realpath-checked to stay inside the share; `..`/symlink escape denied                   | §2.1   | 4/5          | ✅ live                      |
| Audit logging             | append-only JSONL, **off the audited disk**, one line per call (incl. blocked/denied)                         | §2.7   | 3/5 (detect) | ✅ live                      |
| Scope restriction by tier | crown-jewel folders are read-only by classification, not by per-call judgement                                | §4.3   | —            | ✅ live                      |
| OS read-only mount        | mount the SMB share `ro` so even a buggy agent physically cannot write                                        | §2.1   | 4/5          | ⚠️ recommended, not yet done |
| Backups (safety net)      | daily on-prem + cloud; recover from far back. **Net, not a control** — never an excuse to act loosely         | §2.7.2 | —            | external                     |

Two honest gaps (J9 names both):

- **In-process trust.** The guard and `policy.json` live in the agent's own workspace. A
  sufficiently compromised agent could edit the policy or call raw tools. The OS read-only mount
  is the out-of-process fix (§2.2/§5.2) and is why it's the top recommended hardening.
- **Audit tampering before the act** (§2.7). The log is off-disk but on the same host. For real
  tamper-evidence, ship it to an append-only external sink later.

### Strongest single hardening available now — OS read-only mount

The GVFS/SMB share is currently mounted read-write by the desktop session; our guarantee is the
code guard. To make the OS itself refuse writes (defense in depth, removes the in-process gap),
mount the share read-only with credentials, e.g.:

```
sudo mount -t cifs //fileserver.example.internal/share /mnt/nas-ro \
  -o ro,username=<user>,uid=$(id -u),iocharset=utf8,vers=3.0
```

Then point `policy.json.mount` at `/mnt/company-hd-ro`. Needs the share credentials and sudo, so it's
a deliberate setup step, not something this skill does automatically.

## The permission ladder (the operator's design, formalized)

Escalating blast radius. **Only L0 is enabled.** Each higher level is unlocked deliberately, per
tier, by editing `policy.json` (`mode` + `enabledLevels`) — never in the heat of a task.

| Level               | Operation                                                                                                | Why it's relatively safe                    | Blast radius             | Status                          |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------ | ------------------------------- |
| **L0 READ**         | ls, tree, cat, stat, find, map                                                                           | no mutation at all                          | none                     | ✅ enabled                      |
| **L1 CREATE-NEW**   | author a brand-new file into an allowed folder; **refuses if the path already exists**                   | additive only — cannot damage existing data | tiny                     | 🔒 designed, disabled           |
| **L2 VERSION-SAVE** | "modify" by writing a **new versioned copy** alongside (`name.v2.ext`); original byte-for-byte untouched | nothing is ever overwritten or deleted      | additive                 | 🔒 designed, disabled           |
| **L3 OWN-MODIFY**   | freely modify a file **the agent itself created** (tracked in an ownership manifest)                     | we are the author/owner of these files      | bounded to our own files | 🔒 designed, disabled           |
| **⛔ NEVER (auto)** | overwrite or delete another author's file; in-place edit of T1/T2 content                                | irreversible loss of others' work           | catastrophic             | ⛔ never automatic, any version |

This ladder maps directly onto J9: additive-only and version-save are the deterministic analogue
of "no destructive action without a deterministic gate"; ownership-tracking answers "who is
responsible for this file"; and the NEVER row is J9 §4.3's _"this configuration should not
exist"_ — some capability is removed by policy, not guarded by care.

## Staged write rollout (when the operator decides to)

Recommended order, least-risky first. Each step is one `policy.json` edit + matching CLI code,
tested, then used:

1. **L1 into T4 (Marketing) only.** Smallest blast radius in the messiest, lowest-stakes folder.
   Prove create-new + the ownership manifest + audit before going wider.
2. **L1 + L2 into named T2 archive subfolders.** The concrete case the operator raised: file a sent
   offer into `03 Comercial/02 Ofertes` (and the SharePoint CRM, which is a _separate_ surface,
   out of this disk's scope). Whitelist exact subfolders in policy, require per-action confirm,
   risk-weighted (J9 §2.3.1 — don't train rubber-stamping; only novel/risky writes prompt).
3. **L3 own-modify**, gated by the ownership manifest, anywhere L1 is allowed.
4. **T1/T3** stay read-only. A T1 write is always an explicit, supervised, one-off — never a
   standing capability.

Guardrails to add **with** the first write level (not after):

- **Ownership manifest** — record every file the agent creates (`path`, `ts`, run id) so L3 can
  prove "we made this".
- **Time-delayed / confirmed execution for anything non-additive** (J9 §2.3.1) — a cancel window
  on the rare destructive op, since rubber-stamped approvals are the common real-world failure.
- **Per-action confirmation only for novel/risky writes**, auto-OK for repeated safe patterns —
  to avoid approval fatigue, not despite it.
- Keep **backups as the net, never the plan.** Confirm actual retention with IT before relying
  on "recover from long ago" — current retention depth is unverified.
