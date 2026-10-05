# cc-bridge (`tinkerclaw-tinker-bridge`)

**One Claude login for your whole agent.** cc-bridge runs your OpenClaw/TinkerClaw agent through **genuine Claude Code** (the real `claude` CLI), so every session, subagent and model tier draws from a single credential: your `claude` login (`~/.claude/.credentials.json`) or one `CLAUDE_CODE_OAUTH_TOKEN`. There are no per-provider keys to juggle and no second OAuth dance. Authentication is either an **Anthropic API key** or that Claude Code login; see the notice below, because those two are **not** in the same position.

> The plugin id stays `tinkerclaw-tinker-bridge` (config key, state dir `~/.openclaw/tinker-bridge/`, worker prefix `tinker-sp-`), so existing installs keep working. "cc-bridge" is its published name.

## ⚠️ Do not combine with harness-id

**Using cc-bridge together with harness-id (`tinkerclaw-harness-id`) could go against the terms of service of an Anthropic subscription. Do not use them at the same time.**

harness-id renames or strips the harness identifier in the system prompt. On subscription traffic, that changes how Anthropic classifies the request, and that bears on authorization and billing. harness-id enforces this itself: it refuses to load while cc-bridge is enabled.

---

## ⚖️ Authorization Notice — read before installing

**Corrected 2026-09-20.** An earlier version of this file asserted that interactive subscription use is lawful and that account exposure was the user's alone. **Both claims were wrong and are withdrawn.** What follows is the accurate position.

**API-key mode — within the express exception.** Anthropic's Consumer Terms §3(7) prohibits accessing the Services _"through automated or non-human means, whether through a bot, script, or otherwise"_ **except** _"when you are accessing our Services via an Anthropic API Key or where we otherwise explicitly permit it."_ Using this bridge with your own API key, under the terms applicable to that key, sits inside that exception. **This is the supported path.**

**Subscription / OAuth mode — NOT established as permitted.**

- "A human started the turn" does **not** make the access non-automated. An agent harness automates the calls regardless of who pressed the button; attended automation is still automation. Our earlier "interactive is therefore lawful" reasoning does not survive the text.
- Anthropic's support article _"Use the Claude Agent SDK with your Claude plan"_ (June 2026) states that _"Claude Agent SDK, `claude -p`, and third-party app usage still draw from your subscription's usage limits"_ — so programmatic third-party subscription use is **acknowledged and billed**.
- But the Agent SDK overview separately requires **prior approval** for third-party developers to _"offer claude.ai login or rate limits"_, expressly including SDK-based products.
- Those two statements address different audiences (subscribers vs. developers) and **coexist**. The result is genuinely **unresolved**, not cleared. A written clarification request has been sent to Anthropic; this file will be updated with whatever they answer.

**Do not** point crons, schedulers, heartbeats or any unattended loop at a subscription through this bridge. That is the clearest case under §3(7), and the metered API is the channel for it.

**On liability — an honest statement, not a disclaimer.** A notice cannot transfer legal exposure, and the author does not claim it does. Consumer Terms §3 binds a party not only against prohibited access but against _"help[ing] another person to access or use"_ the Services in those ways — which is a question for the author as much as for you. Nothing here is a representation that subscription mode is authorized.

**On identity.** This bridge **adds** your fork's persona; it does **not** remove or obscure harness identity. A prompt-truncation mechanism that dropped OpenClaw harness markers — whose own code comment recorded that it made requests bill the subscription rather than the metered pool — **was removed on 2026-09-20**. It is not coming back, and it is left in git history rather than scrubbed. If you want privacy features, they belong on the **user's** data (PII, secrets, local paths, hostnames), never on the client identity that bears on authorization and billing.

_Not legal advice. Anthropic's terms may change — see anthropic.com/legal for the current Consumer Terms and Usage Policy, and code.claude.com for the Agent SDK guidance._

---

## What it does

- Spawns a `claude` subprocess (the real Claude Code CLI) per gateway session and shims its NDJSON stream into OpenClaw's `StreamingEvent` interface.
- Runs that subprocess as a transient systemd user unit (`tinkerclaw-worker-<id>`) for a clean lifecycle and stdio forwarding.
- Lets your fork write the model-facing system prompt — your persona and identity, not the upstream default.

## What it does NOT do

It does **not** obscure your setup from Anthropic to change how you are billed. Anthropic's API receives your request content, auth, and client headers; it does **not** receive your process environment, PPID, or cgroup — so there is nothing there to hide, and this bridge does not try to. (Earlier revisions carried anti-detection scaffolding built on a mistaken premise; that framing has been corrected in the source, and the remaining minimal-env handling is ordinary hygiene, not evasion.)

## Privacy stance

The only thing that reaches the provider is your **request content** (system prompt + messages) plus auth and client headers. Two consequences:

- **You control your fork's identity** — what the model is told about itself is yours to define.
- A configurable **content-redaction layer** — strip file paths, host/operator identity, and PII from outbound prompts before they leave your machine — is on the roadmap. Until it ships, minimize sensitive content in your own prompts and `CLAUDE.md`. Note: privacy here means _not oversharing content the provider has no need for_ — it is **not** a mechanism to hide your usage tier or change your bill.

## What it needs

1. An active `claude` CLI install + login.
2. An OpenClaw/TinkerClaw gateway running (this fork).
3. Node 22+.

## Configuration

Optional knobs in `openclaw.json` under `plugins.entries.tinkerclaw-tinker-bridge.config`:

| key               | default                        | description                                                                                             |
| ----------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `binary`          | `claude` (PATH)                | Absolute path to the claude CLI binary.                                                                 |
| `cwd`             | `~/.openclaw/jarvis-workspace` | Working dir for each subprocess. Used for `CLAUDE.md` loading + transcript persistence.                 |
| `disallowedTools` | (permissive; see uiHint)       | Tools to disable inside claude (OpenClaw owns the tool loop). Your value replaces the default entirely. |
| `warmOnBoot`      | `[]`                           | Session keys to pre-spawn at gateway start (removes ~10s cold-start on the first turn).                 |

## Models

The `claude-code/*` models matching your subscription tier (see the plugin's catalog for the current IDs).

## Operational notes (single-user by design)

- **Cold-start.** Each new session spawns a subprocess (~10s on the first turn); `warmOnBoot` pre-spawns to avoid it.
- **OAuth serialization.** Single-user works; multi-user would need a refresh-token coordinator that doesn't exist yet.
- **Interactive scope.** Built for a human-driven gateway — see the Lawful-Use Notice above. If you automate, move that traffic to a metered API key.

## License

Apache-2.0.
