---
name: tinkerclaw-pr-request
description: "Ask the TinkerClaw maintainers for a fix or an improvement by filing a pull request on the upstream repo, with the details they need to act on it: what happened, how to reproduce it, the evidence, the environment and a check that proves it is done. Use it whenever your human finds a bug in TinkerClaw or OpenClaw (the gateway, the Tinker UI, a bundled skill, plugin or recipe), wants something improved or added, says 'report this', 'tell the developers', 'ask for a PR', 'file a bug', 'request a feature', or when you hit a TinkerClaw defect yourself and a workaround would only hide it. Works without a GitHub login (it prints a one-click link). Nothing is posted until your human has read the request and said yes."
metadata: { "openclaw": { "emoji": "📮", "requires": { "bins": ["python3"] } } }
---

# Ask for a TinkerClaw change

The upstream repo takes bug reports and requests as **pull requests** (issues are switched off). A
request-only PR adds one file, `docs/requests/<date>-<slug>.md`; its text is also the PR description.
If you already have a tested fix, the PR carries your branch and the request explains it.

A maintainer reads these every night. A vague request costs a round trip and usually dies there, so
the script will not file one with an empty or thin section.

```bash
S={baseDir}/scripts/pr_request.py
python3 -I $S similar "<3-6 words>"                               # 1. is it already asked or fixed?
python3 -I $S template --kind bug --title "<symptom>" --out /tmp/req.md   # or --kind improvement
#   2. fill every TODO: line in /tmp/req.md
python3 -I $S check /tmp/req.md                                   # 3. until it prints OK
#   4. show the whole request to your human; wait for a yes
python3 -I $S submit /tmp/req.md --yes                            # 5. file it, give them the PR link
python3 -I $S submit /tmp/req.md --yes --branch fix/x --repo-dir ~/src/tinkerclaw   # with your own fix
```

## Writing it

- **Title = the symptom or the capability**, not the guess: "Tinker chat loses the draft on reconnect",
  not "Fix websocket bug".
- **Bug:** what happened, what you expected, numbered steps from a fresh start and how often it happens,
  the exact error text or log lines (trimmed), and a "Done when" check anyone can run.
- **Improvement:** what you want, who it helps and how often, what happens today, where the change
  would go if you know (say "unknown" rather than guess), and a "Done when" check.
- Facts you observed, not theories. If you have a theory, label it as one.
- The environment block is filled in for you (commit, version, OS, Node). Add the channel and model
  involved.

## Privacy — this goes on a public website

`check` refuses emails, phone numbers, private IP addresses, home paths with a user name, tokens and
secret-looking values. It cannot see names, companies, addresses or the content of private chats:
**read the request yourself for those and generalise them** ("a colleague", "a WhatsApp group",
`~/` instead of a home path). Never paste a whole log or config file; trim to the lines that matter.

## Consent

Filing a PR is public and is posted under your human's GitHub account. Show them the full request
and file it only after they say yes; `submit` needs `--yes` for that reason. If they want changes,
edit and `check` again. Never file on a schedule or in bulk.

## Without a GitHub login

When `gh auth status` fails, `submit` prints a github.com link instead. Give it to your human: it
opens the request as a new file in the repo, and **Propose changes → Create pull request** files it
from their own account (GitHub makes the fork). Requests with a code fix need `gh auth login` first.

## Not for

- Bugs in a third-party service, a model provider or your own configuration: fix or report those where
  they live.
- Security vulnerabilities: do not file them in public. Tell your human to report them privately as
  `SECURITY.md` in the repo describes.
