"""What the spare tokens are for. The Tinker "Token burner" tab writes one objective and a strategy to
<state dir>/token-burner/settings.json (state dir = OPENCLAW_STATE_DIR or ~/.openclaw); every job the
burner plans carries them. Prompt jobs get them appended to the system prompt, command jobs as
TOKEN_BURNER_OBJECTIVE, TOKEN_BURNER_STRATEGY and TOKEN_BURNER_PROMPT_FILE. No file, no steering: jobs run
as written. The objective ids match extensions/tinkerclaw-token-burner/src/settings.ts."""
import json
import os
from pathlib import Path

OBJECTIVES = {
    "revenue": "Maximize revenue",
    "code": "Improve and harden my code",
    "research": "Research and learning",
    "backlog": "Clear my project backlog",
    "custom": "Custom",
}


def settings_path(env=None):
    env = os.environ if env is None else env
    if env.get("TOKEN_BURNER_SETTINGS"):
        return Path(env["TOKEN_BURNER_SETTINGS"]).expanduser()
    state = Path(env.get("OPENCLAW_STATE_DIR") or Path.home() / ".openclaw").expanduser()
    return state / "token-burner" / "settings.json"


def load(path=None):
    """(steer, note). steer is None when there is no usable settings file; note says why it was skipped."""
    p = Path(path) if path else settings_path()
    if not p.exists():
        return None, None
    try:
        d = json.loads(p.read_text())
    except ValueError as e:
        return None, f"{p} not read: {e}"
    obj = d.get("objective") if isinstance(d, dict) else None
    if obj not in OBJECTIVES:
        return None, f"{p}: objective must be one of {', '.join(OBJECTIVES)}"
    name = (d.get("customName") or "").strip() if isinstance(d.get("customName"), str) else ""
    label = (name or "Custom") if obj == "custom" else OBJECTIVES[obj]
    strategy = d.get("strategy") if isinstance(d.get("strategy"), str) else ""
    prompt = d.get("promptPath") if isinstance(d.get("promptPath"), str) else ""
    return {"objective": obj, "label": label, "strategy": strategy.strip(), "prompt_path": prompt}, None


def brief(steer):
    """The text a prompt job sees: the objective, the strategy and where the governing prompt is."""
    lines = [f"Spare tokens go to: {steer['label']}."]
    if steer["strategy"]:
        lines += ["Strategy:", steer["strategy"]]
    if steer["prompt_path"]:
        lines.append(f"Governing prompt: {steer['prompt_path']}")
    return "\n".join(lines)


def apply(job, steer):
    """A copy of the job that carries the steering. Your own `system` text stays and comes first."""
    if not steer:
        return job
    out = dict(job)
    out["steer"] = steer
    if "prompt" in out:
        out["system"] = f"{out['system']}\n\n{brief(steer)}" if out.get("system") else brief(steer)
    return out


def env_of(steer):
    if not steer:
        return {}
    return {"TOKEN_BURNER_OBJECTIVE": steer["label"], "TOKEN_BURNER_STRATEGY": steer["strategy"],
            "TOKEN_BURNER_PROMPT_FILE": steer["prompt_path"]}
