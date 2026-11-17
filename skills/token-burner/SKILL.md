---
name: token-burner
description: Spend the weekly quota of a flat Claude subscription (Pro or Max) on a job queue you write, so it does not expire unused at the reset. It reads each Claude login's own usage meter, learns how much of the week one agent-hour costs, and picks how many agents to run in parallel so the week ends near a target (default 92 %) just before the reset, while keeping the five-hour window under its cap. With several logins (one CLAUDE_CONFIG_DIR each) only one burns at a time and the others stay free for your chats. It ships dormant, a simulation needs no account, and it never chooses work, spends money or uses an API key. Use when someone wants to "use up my Claude quota", "burn the rest of the week", "run my backlog overnight on the subscription", or schedule agent jobs against a weekly limit.
metadata:
  openclaw:
    emoji: "🔥"
    os: ["linux"]
    requires:
      bins: ["python3"]
    why: "A flat subscription's weekly allowance is lost at the reset. Running work by hand to use it up means guessing how fast an agent drains the meter; this measures it and paces the burn."
    permissions:
      network: "meter, plan and run send one GET per seat per tick to the usage endpoint (api.anthropic.com/api/oauth/usage). Nothing else goes out unless your own jobs send it."
      credentials: "Reads the access token from each seat's <config_dir>/.credentials.json and sends it only to the usage endpoint. It is never printed, logged or stored. It never reads or sets an API key."
      file_read: "config.json, queue.jsonl and state.db in its data folder (TOKEN_BURNER_HOME, default ~/.local/share/token-burner), the seat credential files above, and the objective file token-burner/settings.json in the OpenClaw state folder (OPENCLAW_STATE_DIR, default ~/.openclaw) when it exists."
      file_write: "Its data folder: state.db (meter readings, runs, job status, decisions), out/<job>.out (each job's output) and work/<job>/ for jobs without a cwd."
      process_exec: "Only with --live and TOKEN_BURNER_ALLOW_LIVE=1: `claude -p` for prompt jobs, your command for cmd jobs, your verifier, and your admission hook. No process is started otherwise."
---

# Token burner

**What it is for.** People on a flat Claude subscription who watch part of the weekly allowance expire at every reset. You keep a queue of jobs you would run anyway: refactors, test sweeps, documentation passes, research. The burner runs them on your subscription at the pace that uses the week up, and stops short of the end so your own chats still have room.

**How it was derived.** It is the scheduler of a private job runner, made generic. On a Max 20x plan, one Opus agent-hour measured about 0.7 % of a week; that is the starting guess here, and the meter replaces it within the first hours. A naive version let each seat pace itself as if it burned alone. With two seats the second one sat idle all week and missed its target by six points, which is why the width is computed across all seats (below).

**What would change it.** A documented usage API, or a plan whose weekly limit is not reported as a percentage.

## Safety

- **Dormant by default.** `run` refuses to start unless you pass `--live` and set `TOKEN_BURNER_ALLOW_LIVE=1`. `plan` shows what the next tick would start and starts nothing. `simulate` uses a fake clock and fake seats and needs no account.
- **It only runs your jobs.** The queue is a file you write. The burner never invents, picks or rewrites work.
- **It never spends money.** Prompt jobs run `claude -p` with a clean environment: `HOME`, `PATH`, `LANG` and the seat's `CLAUDE_CONFIG_DIR`, nothing else. Command jobs get your environment minus `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` and the Bedrock, Vertex and Foundry switches, so nothing bills a pay-per-token account by accident.
- **No meter, no burning.** A seat whose reading is missing or older than 45 minutes gets width 0.
- **Your jobs carry your risk.** A prompt job with `"permission_mode": "acceptEdits"` edits files the way `claude -p` would if you ran it yourself. Point `cwd` at a checkout you can throw away, and give each job a verifier.

## Quick start

```bash
B=~/.openclaw/workspace/skills/token-burner/token-burner.py   # wherever the skill lives

python3 -I "$B" simulate                     # a week on a fake clock: week % at each deadline
python3 -I "$B" init --seat main=~/.claude   # add --seat work=~/.claude-work for a second login
python3 -I "$B" meter                        # one read of each seat's meter
cp examples/queue.example.jsonl ~/.local/share/token-burner/queue.jsonl   # then edit it
python3 -I "$B" plan                         # what would start now; starts nothing
TOKEN_BURNER_ALLOW_LIVE=1 python3 -I "$B" run --live --once   # one tick, wait for its jobs, exit
TOKEN_BURNER_ALLOW_LIVE=1 python3 -I "$B" run --live          # the loop, one tick every 15 minutes
python3 -I "$B" status
```

The loop runs in the foreground. Keep it in `tmux`, or start it as a user service with `systemd-run --user`, so it outlives your terminal. A second login lives in its own folder: run `CLAUDE_CONFIG_DIR=~/.claude-work claude` once and log in there.

## The queue

`queue.jsonl` in the data folder holds one JSON object per line, run once each in file order. Lines starting with `#` are skipped, and the file is read again at every tick, so you can append while it runs. See `examples/queue.example.jsonl`.

| Field                                                                    | Meaning                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                                                     | Unique name, letters, digits, `.`, `_`, `-`. A finished id never runs again; give a rerun a new id.                                                                                |
| `prompt` or `cmd`                                                        | Exactly one. `prompt` goes to `claude -p` on stdin. `cmd` is your command, a list or a string split like a shell would, run without a shell.                                       |
| `verify`                                                                 | Optional command run in the job's folder after it succeeds. Exit 0 means done; anything else marks the job failed. `TOKEN_BURNER_OUTPUT` holds the path of the job's saved output. |
| `cwd`                                                                    | Folder to run in. Default: `work/<id>/` in the data folder.                                                                                                                        |
| `agents`                                                                 | How many agents the job runs at once (default 1). A `cmd` job that starts three agents should say 3.                                                                               |
| `timeout`                                                                | Seconds (default 3600).                                                                                                                                                            |
| `model`, `effort`, `tools`, `allowed_tools`, `permission_mode`, `system` | Prompt jobs only. They become the matching `claude -p` flags; `system` is appended to the default system prompt.                                                                   |

Command jobs also see `TOKEN_BURNER_SEAT`, `TOKEN_BURNER_SEAT_DIR` and `TOKEN_BURNER_JOB`. A job stopped by a usage-limit message goes back in the queue, up to three tries.

## Objective and strategy

The queue says which jobs run. The objective says what they are for. Pick it in the Tinker **Token burner** tab (left bar, under Recipes): one of Maximize revenue, Improve and harden my code, Research and learning, Clear my project backlog, or a custom one with a short name. Under it you write a strategy, a few lines on how the objective is pursued. The tab can also ask an agent to read your recent chats and memory and propose both; nothing is saved until you accept.

The tab saves `token-burner/settings.json` in the OpenClaw state folder (`~/.openclaw` unless `OPENCLAW_STATE_DIR` says otherwise; `TOKEN_BURNER_SETTINGS` points somewhere else). `plan` and `run` read it at every start and print the objective. Each job then carries it:

- **Prompt jobs** get the objective, the strategy and the path of the governing prompt added to the system prompt, after your own `system` text.
- **Command jobs** get `TOKEN_BURNER_OBJECTIVE`, `TOKEN_BURNER_STRATEGY` and `TOKEN_BURNER_PROMPT_FILE`.

The governing prompt is `token-burner/prompt.md` in the same folder, copied from `prompts/governing-prompt.md` the first time the tab opens. It holds the rules every job follows; edit it to fit your work. Without a settings file, jobs run exactly as written.

## How the width is chosen

Width means the number of agents running in parallel. Every 15 minutes the burner reads each seat's meter: week %, five-hour %, and both reset times.

1. **The cost of an agent-hour.** Between two readings it knows how many agent-hours ran on that seat and how far the week % moved. Their ratio is the rate. The starting guess (0.7 % per agent-hour) counts as four agent-hours of evidence, so one noisy reading cannot swing the width and a few hours of real burning replace it. Until one agent-hour has been measured the width stays at 1.
2. **What each seat still needs.** Agent-hours needed = (target − week %) ÷ rate. The deadline is the reset minus two hours, so a long last job cannot spill into your margin.
3. **One width for all seats.** Seats burn one at a time, earliest deadline first. For one steady width _w_ to meet every deadline, the work of the first _k_ seats must fit before the _k_-th deadline: _w_ ≥ (A₁ + … + A_k) ÷ H_k, with A in agent-hours and H in hours from now. The width is the largest of those ratios, rounded. With one seat this is just needed % per hour ÷ rate.
4. **Caps.** `max_width` (default 3). The five-hour window: a seat at `five_hour_cap` (default 92 %) does not burn, and the next seat with work takes over. Once the five-hour cost per agent-hour is measured, the width also leaves room in the window until the next tick.
5. **One seat at a time.** The burner is the earliest-deadline seat that can burn. When it changes, the new seat waits until the old seat's jobs finish, so two seats never run jobs at once. Jobs that finish between ticks are replaced straight away at the last width.

It reads the meter again every tick, so a slow week widens and a fast one narrows. In the bundled simulation (two seats, 0.75 % per agent-hour, your chats adding 0.03 % per hour to the free seat) both seats ended between 92.0 % and 93.2 % at their deadlines over two weeks. When the true rate was 0.3 % or 3 % instead of the guessed 0.7 %, they ended between 91.7 % and 94.5 %.

With a single seat there is no free seat for chats. What you leave above the target is all your chats get until the reset.

## Settings

`config.json` in the data folder, written by `init`. Every key is optional except `seats`.

| Key                             | Default      |                                                                                                                                                                                      |
| ------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `seats`                         | `[]`         | `[{"id": "main", "config_dir": "~/.claude"}, …]`                                                                                                                                     |
| `target_pct`                    | 92           | Where each week should end.                                                                                                                                                          |
| `lead_hours`                    | 2            | Deadline = reset minus this.                                                                                                                                                         |
| `five_hour_cap`                 | 92           | No burning above this five-hour %.                                                                                                                                                   |
| `max_width`                     | 3            | Most agents at once.                                                                                                                                                                 |
| `tick_minutes`                  | 15           |                                                                                                                                                                                      |
| `prior_rate`, `prior_weight_ah` | 0.7, 4       | Starting guess and how much it counts. On a smaller plan an agent-hour costs a bigger share of the week, so a higher `prior_rate` starts narrower; the meter corrects it either way. |
| `warmup_ah`                     | 1            | Width 1 until this many agent-hours are measured.                                                                                                                                    |
| `admission_cmd`                 | none         | See below.                                                                                                                                                                           |
| `claude_bin`, `model`, `effort` | CLI defaults |                                                                                                                                                                                      |

**Admission hook.** If your machine has its own idea of when it is busy, set `admission_cmd` to a command. It runs before each job starts, with `TOKEN_BURNER_SEAT`, `TOKEN_BURNER_JOB`, `TOKEN_BURNER_WIDTH` and `TOKEN_BURNER_AGENTS` set. Exit 0 starts the job. Anything else, or no answer within 30 seconds, holds it until the next tick. For example, `["sh", "-c", "test $(cut -d' ' -f1 /proc/loadavg | cut -d. -f1) -lt 4"]` holds jobs while the load average is 4 or more.

## Tests

```bash
cd skills/token-burner && python3 -I -m unittest discover -s tests -t .
```

They cover a simulated week ending near the target before each reset, two seats never running jobs at once, a guessed rate twice too high, the five-hour cap, the dormant gate, the clean environment, the queue format, the meter, and the objective reaching every planned job. No test calls a model or the network.

## Limits

- The usage endpoint is not a documented API. If it changes or refuses, readings stop and so does burning.
- The meter reads the login from `<config_dir>/.credentials.json`, which is where Claude Code keeps it on Linux. On macOS the login sits in the Keychain, and `meter` says the seat is not logged in.
- The rate is learned per seat from your own jobs. A queue of tiny jobs and a queue of long Opus sessions drain the week at very different speeds, and the first hours of a new mix run on the old number.
