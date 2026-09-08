## Description: <br>
Classify every shell command as SAFE, WARN, or CRIT before your agent runs it. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[globalcaos](https://clawhub.ai/user/globalcaos) <br>

### License/Terms of Use: <br>
MIT-0 <br>


## Use Case: <br>
Developers and agent operators use this skill to add pre-execution shell command classification, logging, and approval gates for OpenClaw or TinkerClaw-style agent workflows. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: The included installer script modifies source code in an OpenClaw checkout outside this skill, which is high-impact behavior for a command-classification skill. <br>
Mitigation: The patch is optional and never runs on install. Since 2.3.0 it requires a typed "yes" or an explicit --yes, offers --dry-run, refuses any tree whose package.json does not name an OpenClaw-family project, and writes a timestamped backup before editing. Review the script and the printed change before running it, and keep version-control rollback available. <br>
Risk: A rebuild executes package scripts from the target checkout. <br>
Mitigation: Since 2.3.0 neither script rebuilds by default; the build runs only with an explicit --rebuild flag. Run it only where that checkout and its dependencies are trusted. <br>
Risk: By default the SAFE/WARN/CRIT gate is enforced by the agent following instructions, not by code, so a jailbreak, a prompt injection, or a misclassification can bypass it. <br>
Mitigation: Documented explicitly in SKILL.md. For a hard guarantee, run the agent in a container or VM with non-escalatable credentials; code-level blocking additionally requires the optional patch plus a plugin implementing a before_tool_call hook, which this package does not ship. <br>
Risk: Command text passed to the display helper as command-line arguments is visible in the process table and shell history. <br>
Mitigation: Documented; do not pass secrets through it. The helper writes only to stdout and stores nothing. <br>


## Reference(s): <br>
- [ClawHub skill page](https://clawhub.ai/globalcaos/skills/shell-security-ultimate) <br>
- [TinkerClaw project](https://github.com/globalcaos/clawdbot-moltbot-openclaw) <br>


## Skill Output: <br>
**Output Type(s):** [guidance, shell commands, code, configuration] <br>
**Output Format:** [Markdown guidance with shell commands, Python helper output, and patch scripts] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Uses SAFE, WARN, and CRIT command labels; the included patch scripts modify one file in a local OpenClaw checkout only when run deliberately and confirmed, and rebuild only with --rebuild. No network access and no credential reads anywhere in the package.] <br>

## Skill Version(s): <br>
2.3.0 <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. Because the default gate is instruction-level rather than code-enforced, it should complement — not replace — sandboxing and least-privilege credentials. <br>
