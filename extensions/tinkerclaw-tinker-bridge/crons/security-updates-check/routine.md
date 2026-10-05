# Routine — Security Updates Check

Nightly read-only vulnerability sweep of the machine this agent runs on. It looks at six
surfaces — pending OS package updates, dependency advisories in the operator's projects,
listening network ports, credentials sitting in plaintext, the MCP server configuration, and
public CVE news for the software actually installed here — and writes one short report. It
changes nothing: it never installs, upgrades, patches, restarts, deletes or sends anything.
Its only output is a file on disk. The operator reads that file and decides what to act on.
A first run on a fresh machine, where most of these surfaces do not exist yet, is a normal
successful run and must be reported as such.

## Steps

1. **Set up and claim the report early.** Compute today's date as `YYYY-MM-DD` (local time).
   Create `~/.openclaw/cron/reports/<YYYY-MM-DD>/` if it does not exist. Immediately write a
   stub `security-updates-check.md` there containing a `Status:` line reading `running`, plus
   the start timestamp. Every later step appends to this file. If the run dies halfway, the
   stub is what survives — that is the point of writing it first.

2. **Inventory what exists before probing.** Record which of these are present: a package
   manager (`apt`, `dnf`, `pacman`, `apk`, `zypper`, `brew`), the audit tools (`npm`, `pnpm`,
   `yarn`, `pip-audit`, `cargo-audit`, `govulncheck`), a socket lister (`ss` or `netstat`),
   and the config directory `~/.openclaw`. Anything missing is noted once and its step is
   skipped — not retried, not installed, not worked around.

3. **OS package updates (read-only).** Ask the package manager what upgrades are already
   known to be pending, using its query or simulate mode only — for example a dry-run/simulate
   upgrade, or listing upgradable packages from the cache. Do **not** refresh package indexes
   and do **not** run anything requiring elevation; the cached list may be stale and the report
   must say so. Count the pending updates and separate out those the manager itself labels as
   security. Name at most the ten most significant packages; give the total for the rest.

4. **Dependency advisories.** For each project directory the operator has configured this job
   to watch (if none is configured, scan at most a shallow depth under `$HOME` for lockfiles
   and cap the number of projects at ten), run the ecosystem's audit command in report-only
   mode: the npm/pnpm/yarn audit, `pip-audit`, `cargo audit`, `govulncheck`. Never pass a fix,
   force or update flag. Never let an audit tool write to a lockfile. Record counts by severity
   per project, and name only the critical and high findings.

5. **Listening ports.** List listening TCP and UDP sockets. Classify each as loopback-only or
   reachable from the network. Report the reachable ones with their port, protocol and owning
   process where visible. Compare against the previous run: a newly exposed port is the single
   most interesting line this job can produce, so call it out explicitly.

6. **Plaintext credentials.** Search the operator's config and dotfile locations — shell rc
   files, `~/.openclaw`, `.env` files inside the watched project directories — for patterns that
   look like live secrets: API keys, bearer tokens, private key blocks, connection strings with
   embedded passwords. **Report the file path and the kind of secret only. Never copy a secret
   value, or any fragment of one, into the report or into any log.** Also flag credential files
   whose permissions are group- or world-readable. Skip anything inside `node_modules`, `.git`
   object storage, virtualenv/site-packages directories and cache trees.

7. **MCP configuration review.** Read the MCP server definitions under `~/.openclaw`. For each
   configured server, note: whether it is pinned to a specific version or floats on a moving
   tag, whether it carries a credential inline rather than by environment reference, and whether
   it was added since the previous run. New or unpinned servers are worth a line; unchanged
   pinned ones are not.

8. **CVE watch.** Only for software this machine actually runs and whose version was observed in
   the steps above, check whether a serious advisory has been published recently. If no network
   or search capability is available in this run, skip the step and say so in the report — do
   not guess, and never state a CVE identifier that was not actually retrieved this run.

9. **Compute the delta.** Read the most recent previous report under `~/.openclaw/cron/reports/`
   if one exists. The report's job is to surface what _changed_ since then: newly exposed ports,
   new critical advisories, new plaintext secrets, new MCP servers. Items unchanged since the
   last run get a single summary count, not a re-listing.

10. **Finalise the report.** Rewrite the `Status:` line to `ok` (or `partial`, naming what was
    skipped). Finish the file, then stop. Do not act on anything found.

## Report

Write to `~/.openclaw/cron/reports/<YYYY-MM-DD>/security-updates-check.md`.

- Start with a one-line `Status:` (`ok`, `partial`, or `failed`) and a one-sentence headline the
  operator can read alone and know whether tonight needs attention.
- Then the sections: **Needs attention** first (the small number of things genuinely worth acting
  on), then **Changed since last run**, then **Steady state** as bare counts, then **Skipped**
  with the reason for each.
- Each bullet is one short plain-language sentence a non-engineer can follow. "Three of the
  packages waiting to update are security fixes" beats a raw package-manager dump. Never paste
  full command output; summarise it. Never dump file-path lists where a count and two examples
  will do.
- Keep the whole report under roughly one screen. It is a nightly note to a person, not a log.
- **If the run is dying, partial or blocked, still leave the report with an honest `Status:` line
  and whatever was gathered.** A silent night is worse than a partial one — the operator cannot
  tell a clean machine from a broken job unless the file exists and says which it is.

## Safety

- **Read-only, without exception.** No installs, upgrades, patches, config edits, permission
  changes, service restarts, package-index refreshes or privilege escalation. If a check can
  only be done by changing something, it does not get done — it gets reported as not checkable.
- **Never write outside `~/.openclaw/cron/reports/`.** Nothing else on the machine is a valid
  write target for this job.
- **Archive, never delete.** If this job ever supersedes an older report, it leaves the old file
  in place. It removes nothing, ever.
- **Nothing leaves the machine.** No email, no message, no webhook, no upload, no posting a
  finding to an issue tracker, no paid API call, no spend of any kind — unless the operator has
  explicitly asked for it in a separate instruction. Findings go in the file and wait.
- **Secrets stay secret.** A credential discovered by step 6 is never echoed, logged, copied or
  quoted. The finding is the location and the type, never the value.
- **No third parties.** Scan only this machine and the operator's own files. Do not probe other
  hosts, scan a network range, or touch a system belonging to anyone else.
- This runs unattended at night with nobody watching. When something is ambiguous, the correct
  move is always to record the ambiguity in the report and stop, never to resolve it by acting.

## Don't-regress

- Do not turn this into a patching job. The moment it applies an update it becomes something the
  operator must supervise, which defeats the purpose of running it at 05:00.
- Do not let a missing tool or directory become an error. A fresh install has almost none of
  this; the job says what was absent and exits cleanly with `Status: ok`.
- Do not skip the stub report in step 1. It is the whole reason a crashed run is still legible.
- Do not grow the report into a full inventory. Signal is the delta; the steady state is counts.
- Do not spawn another agent to do this work. It is small and runs directly in this cron turn.
