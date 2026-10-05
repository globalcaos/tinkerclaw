# `tinkerclaw-harness-id`

Every OpenClaw system prompt opens with the same sentence:

> You are a personal assistant running inside OpenClaw.

That sentence is the **harness identifier**: it's how the model, and Anthropic, see which agent harness sent the request. This plugin lets you change it:

- **Fork users** can present their own harness name (`rename`, default `TinkerClaw`), so a fork doesn't have to introduce itself as upstream.
- **Privacy-minded users** can drop the harness name entirely (`strip`): _"You are a personal assistant."_

It edits nothing else: no headers, no persona, no other part of the prompt.

**This plugin is designed to be used with an Anthropic API key only.**

---

## ⚠️ Do not combine with cc-bridge

**Using harness-id together with cc-bridge (`tinkerclaw-tinker-bridge`) could go against the terms of service of an Anthropic subscription. Do not use them at the same time.**

cc-bridge runs your agent through a Claude subscription login. Changing or removing the harness identifier on subscription traffic changes how Anthropic sees that traffic. That is not a privacy feature; it touches authorization and billing.

This plugin is designed to be used with an API key only, so it will not start next to a subscription login. At load time it stays inactive, and logs why, when:

- cc-bridge (`tinkerclaw-tinker-bridge`) is enabled, or
- any Anthropic auth profile uses `oauth` or `token` (setup-token) mode.

Names containing "Claude" or "Anthropic" are refused: the plugin will not present your harness as Anthropic's own client.

## Configuration

Off by default. In `openclaw.json`:

```json
"plugins": {
  "entries": {
    "tinkerclaw-harness-id": {
      "enabled": true,
      "config": { "mode": "rename", "name": "TinkerClaw" }
    }
  }
}
```

| key    | default      | description                                                 |
| ------ | ------------ | ----------------------------------------------------------- |
| `mode` | `rename`     | `rename` = replace OpenClaw with `name`; `strip` = no name. |
| `name` | `TinkerClaw` | Harness name for `rename`. Claude/Anthropic names refused.  |

_Not legal advice. See anthropic.com/legal for the current Consumer Terms._

## License

Apache-2.0.
