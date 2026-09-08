## Description: <br>
TinkerClaw YouTube helps agents fetch YouTube transcripts, search and inspect videos, read comments and account data, and download video or audio through a local CLI workflow. <br>

This skill is ready for commercial/non-commercial use. <br>

## Publisher: <br>
[globalcaos](https://clawhub.ai/user/globalcaos) <br>

### License/Terms of Use: <br>
MIT-0 <br>


## Use Case: <br>
Developers and agents use this skill to research YouTube content, extract transcripts, collect video and channel metadata, inspect comments and playlists, and prepare local media downloads for offline analysis. <br>

### Deployment Geography for Use: <br>
Global <br>

## Known Risks and Mitigations: <br>
Risk: The skill under-discloses Google OAuth access, personal account data access, and persistent local token storage. <br>
Mitigation: Use a dedicated Google project or account where possible, review OAuth consent scopes before authentication, avoid account-data commands unless needed, and protect or revoke local files under ~/.config/youtube-skill. <br>
Risk: YouTube transcript, comment, download, and account-data commands can retrieve personal or sensitive content from YouTube and the authenticated account. <br>
Mitigation: Review requested commands before execution, prefer transcript-only or public-video workflows when possible, and handle downloaded media and account-derived data according to the user's data handling requirements. <br>


## Reference(s): <br>
- [ClawHub skill page](https://clawhub.ai/globalcaos/skills/youtube-ultimate) <br>


## Skill Output: <br>
**Output Type(s):** [text, markdown, json, shell commands, configuration, guidance] <br>
**Output Format:** [Markdown guidance with CLI commands and command output as plain text or JSON] <br>
**Output Parameters:** [1D] <br>
**Other Properties Related to Output:** [May produce local transcript, metadata, subtitle, audio, or video files; authenticated YouTube API commands use local OAuth credentials and token files.] <br>

## Skill Version(s): <br>
4.2.3 (source: server release evidence) <br>

## Ethical Considerations: <br>
Users should evaluate whether this skill is appropriate for their environment, review any generated or modified files before relying on them, and apply their organization's safety, security, and compliance requirements before deployment. <br>
