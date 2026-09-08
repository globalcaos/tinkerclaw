## Description: <br>
Export all your ChatGPT conversations instantly - full context, timestamps, and metadata in seconds. <br>

This skill is ready for commercial/non-commercial use. <br>

It reads your logged-in ChatGPT session, enumerates your conversations (including those inside Projects), and writes plaintext JSON and Markdown copies to a directory you choose. It asks before writing and ships a documented off switch. <br>

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
Mitigation: Every path requires an explicit confirmation before writing (typed confirmation in the shell script, a dialog in the bookmarklet, a `confirmed: true` argument that the relay function refuses to run without). Output directories are created mode 0700 and files 0600. An index-only mode fetches no message bodies at all, and a machine-wide off switch (CHATGPT_EXPORT_DISABLE=1 or ~/.openclaw/chatgpt-export.disabled) stops every scripted path before any network call or file write. Choose a private non-synced output directory and delete exports when no longer needed. <br>
Risk: Reading your own conversation history requires authenticating against ChatGPT's private web endpoints, because no public API exists for it. This inherently involves your logged-in session. <br>
Mitigation: The recommended paths (browser relay, bookmarklet) authenticate with the existing session cookie and read no token; the bookmarklet only falls back to a bearer token if the cookie is rejected, and never logs or stores it. The headless shell path takes a token from an environment variable or a hidden prompt and refuses it as a command-line argument, so it is not exposed via `ps` or shell history. <br>
Risk: Discovering conversations inside Projects requires running ~65 short searches against your own history. <br>
Mitigation: That path exists only in the bookmarklet, is disclosed in a dialog before it runs, and can be declined without cancelling the export. <br>


## Reference(s): <br>
- [ClawHub skill page](https://clawhub.ai/globalcaos/skills/chatgpt-exporter-ultimate) <br>
- [Project repository linked by skill](https://github.com/globalcaos/clawdbot-moltbot-openclaw) <br>
- [ChatGPT](https://chatgpt.com) <br>


## Skill Output: <br>
**Output Type(s):** [text, markdown, code, shell commands, configuration, guidance] <br>
**Output Format:** [Markdown guidance with JavaScript, TypeScript, shell commands, JSON exports, and Markdown conversation files] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [Exports may include full private ChatGPT conversation history, timestamps, conversation IDs, project conversations, and local summary files. Written only after explicit confirmation, to a user-chosen directory (mode 0700, files 0600). Nothing is transmitted to any host other than chatgpt.com.] <br>

## Skill Version(s): <br>
1.4.0 (source: SKILL.md frontmatter) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
