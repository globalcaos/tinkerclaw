# Token Burner Settings

The settings behind the Tinker **Token burner** tab. The `token-burner` skill spends a flat
subscription's spare weekly quota on a job queue; this plugin stores what that spare quota is for.

- **Objective**: one of Maximize revenue, Improve and harden my code, Research and learning,
  Clear my project backlog, or a custom one with a short name.
- **Strategy**: a few plain lines on how the objective is pursued.
- **Governing prompt**: `<stateDir>/token-burner/prompt.md` by default, copied from
  `skills/token-burner/prompts/governing-prompt.md` the first time. Edit it freely.
- **Dashboard link**: optional, shown in the tab when set.

Everything lives in `<stateDir>/token-burner/settings.json` (`~/.openclaw` by default). The
token-burner CLI reads it when it plans jobs and passes the objective and strategy to each job.

Its gateway methods all need `operator.admin`:

| Method                     | Params                                                                                      | Answer                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `tokenBurner.settings.get` | none                                                                                        | `{ settings, objectives, prompt: { path, mtime } }`               |
| `tokenBurner.settings.set` | `{ patch }` with any of `objective`, `customName`, `strategy`, `promptPath`, `dashboardUrl` | `{ ok, settings }` or `{ ok: false, error }`                      |
| `tokenBurner.suggest`      | none to start, `{ runId }` to poll                                                          | `{ status: "running" \| "done" \| "failed", proposal?, reason? }` |

`tokenBurner.suggest` starts one agent run on the gateway's default model. The agent reads recent
chats and memory notes and answers with an objective and a strategy. Nothing is saved until the
tab's Accept calls `tokenBurner.settings.set`. With no default model set it says so and starts
nothing.

The plugin has no timers and makes no network calls of its own.
