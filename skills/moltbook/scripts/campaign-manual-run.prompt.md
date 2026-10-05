[Inbound Marketing Campaign — MANUAL RUN, requested by the owner. It runs headless outside the gateway scheduler, for example because the gateway has a pending restart that would kill a scheduled run. Everything else is identical to the scheduled job.]

Execute the brief at {{BRIEF}} exactly as written (in it, `{baseDir}` means {{SKILL_DIR}}). Do the work directly in this run; do NOT spawn other agents. You must write the run report the brief requires to {{REPORT}} before finishing.{{CONTRACT_LINE}} Return the full structured campaign report as your final response.

Hard limits for this run (they only restate or tighten the playbook):

- Never restart, reload or reconfigure the OpenClaw gateway, and never edit ~/.openclaw/openclaw.json or ~/.openclaw/cron/jobs.json.
- Never git commit or git push anything.
- Site articles: drafts only. With the wordpress-ultimate skill, never set WP_ALLOW_PUBLISH.
- Live writes are allowed ONLY on Moltbook as {{AGENT}}, within the caps `campaign_check.py measure` prints, and only for texts whose `campaign_check.py preflight` exited 0. GitHub, X, Reddit, HN, dev.to and awesome-lists stay drafts.
- If a mandatory check cannot run (tool error, missing credential), say so in the report and skip the step that depends on it. Never work around a check.
