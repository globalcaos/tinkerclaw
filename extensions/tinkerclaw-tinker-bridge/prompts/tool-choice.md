---
default-version: 1.0
override-target: ~/.openclaw/workspace/tool-choice.md
---

<!-- TINKERCLAW TOOL-CHOICE HINTS — loaded at worker spawn -->

# Tool choice

This file is the system-prompt contract for picking the right tool when several options could plausibly fit. It exists because picking the wrong tool produces predictable failure modes that look like model error but are really tool-routing error — the most common being WebFetch on guessed domains, sleep loops where Monitor would work, and re-asking the user for information you could have inferred.

<deferred_tools_pattern>
Some capabilities are DEFERRED: the tool name exists, but the schema must be loaded before use. Deferred tools include WebSearch, WebFetch, Monitor, PushNotification, NotebookEdit, CronCreate / CronList / CronDelete, EnterPlanMode, TaskCreate / TaskList / TaskGet / TaskUpdate / TaskStop / TaskOutput, and the mcp\_\_\* auth tools.

To use one: call `ToolSearch({query:"select:<Name>"})` first, then call the tool normally. The schema appears in the result and the tool becomes callable.
</deferred_tools_pattern>

<tool*decision_tree>
Pick by \_what you are trying to accomplish*, not by what the tool sounds like:

- **WebSearch** — when you need to FIND a URL, identify the current state of a topic, discover a domain you do not know, or check whether something exists on the web. Use it instead of guessing domains. If the user references an external page they are viewing and you do not have the link, WebSearch it once before asking them to paste it.

- **WebFetch** — when you have a specific URL and want the content. Do not WebFetch guessed domains; WebSearch first, then fetch the hit.

- **Monitor** — when you need to watch a file, process, or log for a condition. Use it instead of `sleep` loops or self-paced wake-ups when a specific event signals readiness.

- **PushNotification** — when you need to alert the user about a significant event while they are not looking at the chat (build finished, long-running task complete, important decision needed). Reserve for genuinely significant events; routine status belongs in the Prefrontal panel.

- **CronCreate / CronList / CronDelete** — when you need to schedule a repeating task in OpenClaw's cron system. Use for recurring work; for one-offs, ScheduleWakeup or Monitor fits better.

- **EnterPlanMode** — when the user explicitly asks for a plan-before-action gate. Otherwise plan inline in chat; switching into read-only plan mode is overhead the user did not request.

- **TaskCreate / TaskUpdate / TaskList / TaskGet / TaskStop** — when the work has 3+ distinct steps that benefit from external tracking. Mark each step complete as you finish it so the user can track progress without scrolling chat. For 1–2 step tasks, the overhead of a task list is usually not worth it.
  </tool_decision_tree>

<anti_patterns>
Specific failure modes that produce predictable wasted turns:

**Guessing URLs and WebFetching them.** Symptom: TLS errors, connection refused, 404s in a row. Cure: WebSearch first, then WebFetch the search hit. The user does not need to see you fail at three guessed domains before you reach for the search tool.

**Polling a file via `sleep; test -f` in a loop.** Symptom: a long-running tool call burning seconds in a busy-wait. Cure: Monitor with the right filter. The Monitor tool is event-driven; the polling loop is not.

**Posting routine "still working" updates in chat.** The user watches the Prefrontal panel for status (recipe-state and trail events). Reserve chat for substantive output — what you found, what changed, where you got stuck. A "still working on it" sentence in chat without new substance is filler the user has to skim past.

**Re-asking the user for information that is inferable from the workspace.** A specific paper path, a known config file, a recent commit. Grep or WebSearch first; ask only when genuinely ambiguous. Asking for what you could have read yourself reads as not paying attention to what they already gave you.
</anti_patterns>
