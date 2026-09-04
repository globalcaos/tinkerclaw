# Symbol map — find code without grepping the tree

**What this is for.** Answering _"where does `X` live?"_ in **one** lookup instead of a tree-wide
search. Measured cause: `~/src/tinkerclaw` was re-searched **5,914 times** across 2,159 sessions —
the largest single item in the retrieval budget. A grep costs a whole turn whatever it returns, so
the fix is fewer searches, not cheaper ones.

**How to use it — grep the TSV, never read it whole:**

```bash
grep -P '^performGatewaySessionReset\t' ~/src/tinkerclaw/docs/SYMBOLS.tsv   # exact symbol
grep -iP '^[^\t]*sessionreset' ~/src/tinkerclaw/docs/SYMBOLS.tsv           # fuzzy
```

Format: `symbol<TAB>path:line<TAB>kind`. **65,897 symbols** across
**15,293 source files**.

**Provenance.** Generated 2026-08-16 at commit `fd787c19abc` by `scripts/build-symbol-map.mjs`.
Exported declarations plus top-level `function`/`def`/`class`; excludes `node_modules`,
`dist`, `.d.ts` and files over 3 MB (1 skipped).

**How to update.** Re-run after any refactor — it is derived, not frozen (J16 Pillar 1):

```bash
node ~/src/tinkerclaw/scripts/build-symbol-map.mjs
```

**What it does NOT cover.** Local (non-exported) helpers, symbols built by string concatenation,
runtime-registered names, and anything in `dist/`. A miss here means fall back to a tree grep —
but check the map first.

## Where symbols live

| directory                              | symbols |
| -------------------------------------- | ------- |
| `src/agents`                           | 7,465   |
| `src/plugins`                          | 3,774   |
| `src/gateway`                          | 3,748   |
| `src/infra`                            | 3,507   |
| `src/commands`                         | 2,250   |
| `src/auto-reply`                       | 2,002   |
| `src/config`                           | 1,668   |
| `extensions/discord`                   | 1,551   |
| `src/cli`                              | 1,449   |
| `extensions/matrix`                    | 1,385   |
| `src/plugin-sdk`                       | 1,339   |
| `src/channels`                         | 1,278   |
| `extensions/browser`                   | 1,223   |
| `extensions/codex`                     | 1,126   |
| `extensions/telegram`                  | 1,119   |
| `extensions/qa-lab`                    | 994     |
| `extensions/qqbot`                     | 870     |
| `extensions/whatsapp.disabled-hostver` | 862     |
| `extensions/feishu`                    | 850     |
| `extensions/tinkerclaw-whatsapp`       | 816     |
| `src/memory`                           | 772     |
| `extensions/slack`                     | 735     |
| `tinker-ui/src`                        | 712     |
| `src/cron`                             | 707     |
