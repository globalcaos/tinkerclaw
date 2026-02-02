---
name: exec-display
description: Structured command execution with security levels, color-coded output, and 4-line max summaries. Enforces transparency and visibility for all shell commands. Use when running any exec/shell commands to ensure consistent, auditable output.
homepage: https://github.com/openclaw/openclaw/tree/main/skills/exec-display
metadata:
  {
    "openclaw":
      {
        "emoji": "🛡️",
        "requires": { "bins": ["python3"] },
      },
  }
---

# Exec Display

Structured, security-aware command execution with color-coded output.

## Why This Skill?

Raw command execution lacks:
- **Visibility**: Output can be verbose or hidden
- **Classification**: No indication of command risk level
- **Consistency**: Different commands, different formats
- **Auditability**: Hard to track what was executed and why

This skill enforces:
- **4-line max output** with summarized results
- **Security levels** (🟢 SAFE → 🔴 CRITICAL)
- **Color-coded ANSI output** for terminal visibility
- **Purpose documentation** for every command

## Security Levels

| Level | Emoji | Color | Description |
|-------|-------|-------|-------------|
| SAFE | 🟢 | Green | Read-only information gathering |
| LOW | 🔵 | Blue | Project file modifications |
| MEDIUM | 🟡 | Yellow | Configuration changes |
| HIGH | 🟠 | Orange | System-level changes |
| CRITICAL | 🔴 | Red | Potential data loss, requires confirmation |

## Usage

### Basic Format

```bash
python3 {baseDir}/scripts/cmd_display.py <level> "<command>" "<purpose>" "$(<command>)"
```

### Examples

**SAFE - Information gathering:**
```bash
python3 {baseDir}/scripts/cmd_display.py safe "git status --short" "Check repository state" "$(git status --short)"
```

**LOW - File modifications:**
```bash
python3 {baseDir}/scripts/cmd_display.py low "touch newfile.txt" "Create placeholder file" "$(touch newfile.txt && echo '✓ Created')"
```

**MEDIUM - Config changes:**
```bash
python3 {baseDir}/scripts/cmd_display.py medium "npm config set registry https://registry.npmjs.org" "Set npm registry" "$(npm config set registry https://registry.npmjs.org && echo '✓ Registry set')"
```

**HIGH - System changes (show for manual execution):**
```bash
# HIGH/CRITICAL commands should be shown, not executed
python3 {baseDir}/scripts/cmd_display.py high "sudo systemctl restart nginx" "Restart web server" "⚠️ Requires manual execution"
```

### With Warning and Action

```bash
python3 {baseDir}/scripts/cmd_display.py medium "rm -rf node_modules" "Clean dependencies" "✓ Removed" "This will delete all installed packages" "Run npm install after"
```

## Output Format

```
🟢 SAFE: READ-ONLY INFORMATION GATHERING: git status --short
✓  2 modified, 5 untracked
📋 Check repository state
```

With warning:
```
🟡 MEDIUM: CONFIGURATION CHANGES: npm config set registry
✓  Registry updated
📋 Set npm registry
⚠️  This affects all npm operations
👉 Verify with: npm config get registry
```

## Agent Integration

### MANDATORY RULES

1. **ALL exec commands MUST use this wrapper** - no exceptions
2. **Classify EVERY command** by security level before execution
3. **Include purpose** - explain WHY you're running the command
4. **Summarize output** - condense verbose output to one line
5. **HIGH/CRITICAL commands** - show for manual execution, do not run

### Classification Guide

**🟢 SAFE** (execute immediately):
- `ls`, `cat`, `head`, `tail`, `grep`, `find`
- `git status`, `git log`, `git diff`
- `pwd`, `whoami`, `date`, `env`
- Any read-only command

**🔵 LOW** (execute, notify):
- `touch`, `mkdir`, `cp`, `mv` (within project)
- `git add`, `git commit`
- File edits within project scope

**🟡 MEDIUM** (execute with caution):
- `npm install`, `pip install` (dependencies)
- Config file modifications
- `git push`, `git pull`

**🟠 HIGH** (show, ask before executing):
- System service commands
- Global package installs
- Network configuration
- Anything affecting system state

**🔴 CRITICAL** (NEVER execute directly):
- `rm -rf` on important directories
- `sudo` commands
- Database drops
- Anything with data loss potential

## Customization

### Adding to SOUL.md

Add this to your agent's SOUL.md:

```markdown
## Command Execution Protocol

ALL shell commands MUST use the exec-display wrapper:

1. Classify security level (SAFE/LOW/MEDIUM/HIGH/CRITICAL)
2. Use: `python3 <skill>/scripts/cmd_display.py <level> "<cmd>" "<purpose>" "$(<cmd>)"`
3. HIGH/CRITICAL: Show command for manual execution, do not run
4. Summarize verbose output to one line
5. No exceptions - this is for transparency and auditability
```

### Colors Reference

The script uses ANSI color codes for terminal output:
- Green (32): Success, SAFE level
- Blue (34): LOW level
- Yellow (33): MEDIUM level, warnings
- Bright Yellow (93): HIGH level
- Red (31): CRITICAL level, errors
- Cyan (36): Purpose line

## Task Completion Protocol

When finishing significant work, provide a structured summary:

### Format

```
## ✅ Task Complete: [Title]

### Summary
[1-2 sentences on what was done]

### Commands Executed
🟢 ✓ command1 │ SAFE │ [purpose]
🔵 ✓ command2 │ LOW │ [purpose]
🟡 ✓ command3 │ MEDIUM │ [purpose]

### Changes
- [File 1] — [what changed]
- [File 2] — [what changed]

### Lessons
- [Abstract principle learned]

### Next Steps
- [What remains to be done]
```

### Example

```
## ✅ Task Complete: Git Repository Cleanup

### Summary
Removed large binary files from history and force-pushed clean repo.

### Commands Executed
🟢 ✓ git log --oneline -10 │ SAFE │ Verify recent commits
🟡 ✓ git filter-branch --tree-filter │ MEDIUM │ Remove binaries from history
🟠 ✓ git push --force │ HIGH │ Force-push rewritten history (confirmed)

### Changes
- `.gitignore` — Added *.bin, *.exe patterns
- `docs/` — Removed 50MB of PDFs

### Lessons
- Filter-branch rewrites ALL commit hashes — coordinate with team first

### Next Steps
- Team members need to re-clone or reset to origin/main
```

### Why This Matters

1. **Accountability** — Clear record of what was executed
2. **Auditability** — Security levels visible at a glance
3. **Knowledge transfer** — Lessons persist for future sessions
4. **Transparency** — the user sees exactly what happened

## Limitations

This skill provides **instructions and tooling** for consistent command display.
True code-level enforcement requires an OpenClaw plugin with `before_tool_call` hooks.

For maximum enforcement, also add these rules to your AGENTS.md or workspace config.
