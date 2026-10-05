## Description: <br>
Export your ChatGPT conversations to local files - titles, timestamps and, if you ask for it, full message text. <br>

This skill is ready for commercial/non-commercial use. <br>

It uses your logged-in ChatGPT browser session (cookie only, no token). The browser-relay path enumerates your conversation list and writes JSON and Markdown copies to a private directory; index-only (titles and timestamps, no message text) is its default, and it refuses to run unless called with `confirmed: true`, throwing an error that states destination and scope. The bookmarklet path can also find conversations inside Projects and downloads one JSON file after three dialogs. Relay destinations that resolve to a synced folder, a git repository or outside home are refused with no override. It ships a documented off switch and a validated delete command. <br>

## Publisher: <br>
[globalcaos](https://clawhub.ai/user/globalcaos) <br>

### License/Terms of Use: <br>
MIT-0 <br>


## Use Case: <br>
External users and developers use this skill to export their ChatGPT conversation history, including project conversations, timestamps, metadata, and message content, into local backup files. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: The skill can create plaintext local copies of full ChatGPT conversation history, including sensitive prompts, responses, timestamps, IDs, and project conversations. <br>
Mitigation: Both export paths ask first: the relay function throws unless called with `confirmed: true`, and the error it throws states the destination and scope; the bookmarklet opens a dialog, and two more let you skip the Projects search and drop message text. scripts/export.sh does not export. For the relay, index-only is the DEFAULT, so no message body is fetched unless asked for. Relay output goes to a dedicated private directory (~/.local/share/chatgpt-export/<date>) with directories 0700 and files 0600, re-applied on every run; a destination that resolves to a synced folder (Dropbox/Drive/OneDrive/iCloud/Nextcloud), a git repository, or outside the home directory is refused with no override, and a symlink or hard link planted inside a reused export directory is refused rather than written through. The bookmarklet's single JSON file goes to the browser's Downloads folder. An optional `redact: true` scrubs common secret formats in every relay file (best-effort, not a guarantee). Each relay export records an expiry, and `export.sh --purge` / `--purge-expired` delete it again; a bookmarklet download is deleted by hand. The off switch (CHATGPT_EXPORT_DISABLE=1 or ~/.openclaw/chatgpt-export.disabled) stops the relay and export.sh before any network call or file write; in the browser, cancelling the first dialog stops the bookmarklet. <br>
Risk: Reading your own conversation history requires authenticating against ChatGPT's private web endpoints, because no public API exists for it. This inherently involves your logged-in session. <br>
Mitigation: Both export paths (browser relay, bookmarklet) authenticate with the existing session cookie only and read no bearer token. scripts/export.sh makes no network call and handles no credential; it only vets destinations and purges exports. <br>
Risk: Discovering conversations inside Projects requires running ~65 short searches against your own history. <br>
Mitigation: That path exists only in the bookmarklet, is disclosed in a dialog before it runs, and can be declined without cancelling the export. <br>
Risk: The skill can delete a directory tree from disk via its --purge cleanup command. <br>
Mitigation: The deletion target is the exact directory named, never a parent derived from it. It is canonicalized with realpath and must be a strict descendant of the canonical home directory at least two levels deep, must contain a .chatgpt-export-manifest.json that this tool itself wrote, and must pass every check again immediately before deletion. It refuses the home directory, /, symlink escapes, directories it did not create, and any non-interactive run, and requires the operator to type PURGE. A normal export deletes nothing, except that an aborted relay write removes the empty file it had just created (Linux). The refusals are covered by scripts/purge-selftest.sh, which exercises them against a throwaway home directory. <br>


## Reference(s): <br>
- [ClawHub skill page](https://clawhub.ai/globalcaos/skills/chatgpt-exporter-ultimate) <br>
- [Project repository linked by skill](https://github.com/globalcaos/clawdbot-moltbot-openclaw) <br>
- [ChatGPT](https://chatgpt.com) <br>


## Skill Output: <br>
**Output Type(s):** [text, markdown, code, shell commands, configuration, guidance] <br>
**Output Format:** [Markdown guidance with JavaScript, TypeScript, shell commands, JSON exports, and Markdown conversation files] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Exports may include full private ChatGPT conversation history, timestamps, conversation IDs, project conversations (bookmarklet), and local summary files (relay). Written only after explicit confirmation: the relay to a vetted directory (mode 0700, files 0600), the bookmarklet to the browser's Downloads folder. Nothing is transmitted to any host other than chatgpt.com.] <br>

## Skill Version(s): <br>
1.9.2 (source: SKILL.md frontmatter) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
